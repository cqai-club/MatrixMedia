"use strict";

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { articleImageIds, renderWechatArticleHtml } from "./article-content.js";
import { PublisherProtocolError } from "./protocol.js";

const API = "https://api.weixin.qq.com";
const TIMEOUT_MS = 30_000;
const IMAGE_LIMIT = 1024 * 1024;
const COVER_LIMIT = 10 * 1024 * 1024;

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

function requiredResponse(value, field, action) {
  if (typeof value?.[field] !== "string" || !value[field]) {
    throw new PublisherProtocolError("wechat-api-error", `微信${action}未返回 ${field}，请到公众号后台核对`);
  }
  return value[field];
}

/** Official API only; no creator-site cookies, private endpoints, or token persistence. */
export class WechatOfficialClient {
  constructor(fetchImpl = globalThis.fetch, now = () => Date.now()) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.tokens = new Map();
  }

  async json(url, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new PublisherProtocolError("wechat-network-error", "无法连接微信官方接口，请检查网络或代理配置");
    }
    if (!response.ok) throw new PublisherProtocolError("wechat-http-error", `微信接口返回 HTTP ${response.status}`);
    let result;
    try { result = await response.json(); }
    catch { throw new PublisherProtocolError("wechat-api-error", "微信接口返回了无效响应"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new PublisherProtocolError("wechat-api-error", "微信接口返回了无效响应");
    }
    if (Number(result.errcode || 0) !== 0) {
      if (Number(result.errcode) === 40164) {
        const match = /\binvalid ip\s+(\d{1,3}(?:\.\d{1,3}){3})\b/iu.exec(String(result.errmsg || ""));
        const ip = match?.[1] && match[1].split(".").every(part => Number(part) <= 255) ? match[1] : undefined;
        throw new PublisherProtocolError("wechat-ip-not-allowed", ip
          ? `微信拒绝当前出口 IP ${ip}（40164），请加入公众号接口 IP 白名单`
          : "微信拒绝当前出口 IP（40164），请到公众号后台配置接口 IP 白名单");
      }
      // Never reflect errmsg: some gateways include request URLs or credentials.
      throw new PublisherProtocolError("wechat-api-error", `微信接口拒绝请求（错误码 ${String(result.errcode)}）`);
    }
    return result;
  }

  async token(credentials) {
    const key = `${credentials.appId}:${createHash("sha256").update(credentials.appSecret).digest("hex")}`;
    const cached = this.tokens.get(key);
    if (cached && cached.until > this.now()) return cached.value;
    const result = await this.json(`${API}/cgi-bin/stable_token`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "client_credential", appid: credentials.appId,
        secret: credentials.appSecret, force_refresh: false }),
    });
    const value = requiredResponse(result, "access_token", "授权");
    const seconds = Number(result.expires_in);
    this.tokens.set(key, { value, until: this.now() + Math.max(60, (Number.isFinite(seconds) ? seconds : 7200) - 300) * 1000 });
    return value;
  }

  forget(appId) {
    for (const key of this.tokens.keys()) if (key.startsWith(`${appId}:`)) this.tokens.delete(key);
  }

  async post(credentials, endpoint, body, token) {
    const accessToken = token || await this.token(credentials);
    const url = `${API}${endpoint}${endpoint.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
    return this.json(url, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
    });
  }

  async upload(credentials, endpoint, asset, directory, token) {
    const file = path.join(directory, "assets", asset.id);
    const bytes = fs.readFileSync(file);
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: asset.mime }), asset.mime === "image/png" ? "image.png" : "image.jpg");
    return this.json(`${API}${endpoint}${endpoint.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, { method: "POST", body: form });
  }

  validate(manifest) {
    if (manifest.title.length > 64) invalid("微信公众号文章标题不能超过 64 字");
    if (String(manifest.summary || "").length > 120) invalid("微信公众号文章摘要不能超过 120 字");
    if (!manifest.coverAssetId) invalid("微信公众号文章必须选择封面图片");
    const images = articleImageIds(manifest);
    const cover = manifest.assets.find(asset => asset.id === manifest.coverAssetId);
    if (!cover) invalid("微信公众号封面素材不存在");
    for (const asset of manifest.assets) {
      if (!["image/jpeg", "image/png"].includes(asset.mime)) invalid("微信公众号文章图片仅支持 JPEG 或 PNG");
      if (asset.id === cover.id && asset.bytes >= COVER_LIMIT) invalid("微信公众号封面不能超过 10MB");
      if (images.includes(asset.id) && asset.bytes >= IMAGE_LIMIT) invalid("微信公众号正文图片必须小于 1MB");
    }
    return { cover, images };
  }

  async submit(credentials, submission, manifest, body) {
    const { cover, images } = this.validate(manifest);
    const token = await this.token(credentials);
    const uploaded = {};
    for (const id of images) {
      const asset = manifest.assets.find(item => item.id === id);
      const result = await this.upload(credentials, "/cgi-bin/media/uploadimg", asset, submission.snapshotDirectory, token);
      const url = new URL(requiredResponse(result, "url", "正文图片上传"));
      if (url.protocol === "http:" && url.hostname === "mmbiz.qpic.cn") url.protocol = "https:";
      uploaded[id] = url.toString();
    }
    const coverResult = await this.upload(credentials, "/cgi-bin/material/add_material?type=image", cover, submission.snapshotDirectory, token);
    const coverId = requiredResponse(coverResult, "media_id", "封面上传");
    const html = renderWechatArticleHtml({ ...manifest, body }, uploaded);
    if (Buffer.byteLength(html, "utf8") >= IMAGE_LIMIT || html.length > 20_000) invalid("微信公众号文章正文超过接口限制");
    const article = {
      article_type: "news", title: manifest.title, author: "", digest: manifest.summary || "",
      content: html, content_source_url: "", thumb_media_id: coverId,
      show_cover_pic: 0, need_open_comment: 0, only_fans_can_comment: 0,
    };
    let draft;
    try { draft = await this.post(credentials, "/cgi-bin/draft/add", { articles: [article] }, token); }
    catch (error) {
      if (error?.code === "wechat-network-error") {
        return { exitCode: 1, status: "unknown", message: "公众号草稿提交结果不确定，请到后台核对；不会自动重试" };
      }
      throw error;
    }
    const mediaId = requiredResponse(draft, "media_id", "创建草稿");
    if (submission.mode === "draft") {
      await this.post(credentials, "/cgi-bin/draft/get", { media_id: mediaId }, token);
      return { exitCode: 0, status: "draft", message: "公众号草稿已创建，请到后台核对排版" };
    }
    // Submit is non-idempotent. A timeout after this point must never retry automatically.
    let submitted;
    try { submitted = await this.post(credentials, "/cgi-bin/freepublish/submit", { media_id: mediaId }, token); }
    catch (error) {
      if (error?.code === "wechat-network-error") {
        return { exitCode: 1, status: "unknown", message: "公众号发布提交结果不确定，请到后台核对；不会自动重试" };
      }
      throw error;
    }
    const publishId = requiredResponse(submitted, "publish_id", "提交发布");
    try {
      const state = await this.post(credentials, "/cgi-bin/freepublish/get", { publish_id: publishId }, token);
      if (state.publish_status === 0) return { exitCode: 0, status: "success", message: "公众号确认已发布" };
      if ([2, 3, 4, 5, 6].includes(state.publish_status)) return { exitCode: 1, status: "failed", message: `公众号发布状态 ${String(state.publish_status)}，请到后台核对` };
    } catch { /* a status-query failure must not resubmit */ }
    return { exitCode: 1, status: "unknown", message: "公众号已受理发布，最终结果请到后台核对" };
  }
}

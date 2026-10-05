"use strict";

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { articleImageIds, renderWechatArticleHtml } from "./article-content.js";
import { prepareWechatImage } from "./wechat-image.js";
import { PublisherProtocolError } from "./protocol.js";

const API = "https://api.weixin.qq.com";
const TIMEOUT_MS = 30_000;
const IMAGE_LIMIT = 1024 * 1024;
const COVER_LIMIT = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCLOSURES = {
  none: "", ai_generated: "本文包含 AI 生成内容", fiction: "虚构演绎，仅供娱乐",
  marketing: "营销推广", personal_opinion: "个人观点，仅供参考", repost: "转载",
  self_made_no_repost: "自制，禁止转载",
};

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

function invalidApiResponse(message = "微信接口返回了无效响应") {
  const error = new PublisherProtocolError("wechat-api-error", message);
  // 响应无法判读时，不能断言非幂等请求没有被微信受理。
  error.requestOutcomeUnknown = true;
  return error;
}

function mutationResultUnknown(error) {
  return error?.code === "wechat-network-error" || error?.requestOutcomeUnknown === true;
}

function requiredResponse(value, field, action) {
  if (typeof value?.[field] !== "string" || !value[field]) {
    throw new PublisherProtocolError("wechat-api-error", `微信${action}未返回 ${field}，请到公众号后台核对`);
  }
  return value[field];
}

/** 图片消息发送纯文本，图片由 image_info 表示，不能套用 news 的 HTML。 */
export function composeWechatImageNoteText(manifest, body = manifest.body) {
  const tags = [...new Set((manifest.tags || []).map(tag => String(tag).trim().replace(/^#+/u, "")).filter(Boolean))];
  const disclosure = DISCLOSURES[manifest.creativeStatement];
  return [String(body || ""), tags.map(tag => `#${tag}`).join(" "), disclosure ? `内容声明：${disclosure}` : ""]
    .filter(Boolean).join("\n\n");
}

function sameImageNoteDraft(result, article) {
  const actual = result?.news_item;
  if (!Array.isArray(actual) || actual.length !== 1 || actual[0]?.article_type !== "newspic"
    || actual[0].title !== article.title || typeof actual[0].content !== "string") return false;
  if (actual[0].content.replace(/\r\n/gu, "\n") !== article.content.replace(/\r\n/gu, "\n")) return false;
  const images = actual[0].image_info?.image_list;
  return Array.isArray(images) && images.length === article.image_info.image_list.length
    && images.every((image, index) => image?.image_media_id === article.image_info.image_list[index].image_media_id);
}

/** Official API only; no creator-site cookies, private endpoints, or token persistence. */
export class WechatOfficialClient {
  constructor(fetchImpl = globalThis.fetch, now = () => Date.now(), imageApi = null) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.tokens = new Map();
    this.imageApi = imageApi;
  }

  async json(url, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new PublisherProtocolError("wechat-network-error", "无法连接微信官方接口，请检查网络或代理配置");
    }
    if (!response || typeof response.ok !== "boolean" || typeof response.json !== "function") throw invalidApiResponse();
    if (!response.ok) {
      const status = response.status;
      if (!Number.isInteger(status) || status < 400 || status > 599) throw invalidApiResponse();
      const error = new PublisherProtocolError("wechat-http-error", `微信接口返回 HTTP ${status}`);
      error.requestOutcomeUnknown = status >= 500 || status === 408;
      throw error;
    }
    let result;
    try { result = await response.json(); }
    catch { throw invalidApiResponse(); }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw invalidApiResponse();
    }
    const rawCode = result.errcode;
    const code = rawCode === undefined ? 0 : Number(rawCode);
    if (rawCode !== undefined && (!(typeof rawCode === "number" || (typeof rawCode === "string" && /^-?\d+$/u.test(rawCode)))
      || !Number.isSafeInteger(code))) {
      throw invalidApiResponse("微信接口拒绝请求（错误码 未知）");
    }
    if (code !== 0) {
      if (code === 40164) {
        const match = /\binvalid ip\s+(\d{1,3}(?:\.\d{1,3}){3})\b/iu.exec(String(result.errmsg || ""));
        const ip = match?.[1] && match[1].split(".").every(part => Number(part) <= 255) ? match[1] : undefined;
        throw new PublisherProtocolError("wechat-ip-not-allowed", ip
          ? `微信拒绝当前出口 IP ${ip}（40164），请加入公众号接口 IP 白名单`
          : "微信拒绝当前出口 IP（40164），请到公众号后台配置接口 IP 白名单");
      }
      // Never reflect errmsg: some gateways include request URLs or credentials.
      throw new PublisherProtocolError("wechat-api-error", `微信接口拒绝请求（错误码 ${String(code)}）`);
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

  async upload(credentials, endpoint, prepared, token) {
    const form = new FormData();
    form.append("media", new Blob([prepared.bytes], { type: prepared.mime }), prepared.mime === "image/png" ? "image.png" : "image.jpg");
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
    }
    return { cover, images };
  }

  validateImageNote(manifest, body = manifest.body) {
    if (typeof manifest.title !== "string" || !manifest.title.trim()) invalid("微信公众号图文标题不能为空");
    if (Array.from(manifest.title).length > 32) invalid("微信公众号图文标题不能超过 32 字");
    if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 20) {
      invalid("微信公众号图文需要 1 至 20 张图片");
    }
    const ids = new Set();
    for (const asset of manifest.assets) {
      if (!asset || !UUID.test(asset.id) || ids.has(asset.id)
        || !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) invalid("微信公众号图文图片素材无效");
      ids.add(asset.id);
    }
    if (typeof body !== "string" || !Array.isArray(manifest.tags)
      || manifest.tags.some(tag => typeof tag !== "string")) invalid("微信公众号图文正文或标签无效");
    const content = composeWechatImageNoteText(manifest, body);
    if (content.length > 20_000 || Buffer.byteLength(content, "utf8") >= IMAGE_LIMIT) {
      invalid("微信公众号图文正文超过接口限制");
    }
    return { images: manifest.assets, content };
  }

  async submitImageNote(credentials, submission, manifest, body) {
    const { images, content } = this.validateImageNote(manifest, body);
    // 先完成全部校验与格式转换，失败时不上传半套素材。
    const prepared = [];
    for (const asset of images) {
      let bytes;
      try {
        const file = path.join(submission.snapshotDirectory, "assets", asset.id);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) invalid("公众号图片素材无效");
        bytes = fs.readFileSync(file);
      } catch { invalid("公众号图片素材不存在或无法读取"); }
      if (asset.sha256 !== undefined && (typeof asset.sha256 !== "string"
        || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)) invalid("公众号图片素材在提交前发生变化");
      prepared.push(await prepareWechatImage(asset, bytes, COVER_LIMIT, this.imageApi, { allowWebp: true }));
    }
    const token = await this.token(credentials);
    const imageList = [];
    for (const image of prepared) {
      const result = await this.upload(credentials, "/cgi-bin/material/add_material?type=image", image, token);
      imageList.push({ image_media_id: requiredResponse(result, "media_id", "图文图片上传") });
    }
    const article = { article_type: "newspic", title: manifest.title, content,
      need_open_comment: 0, only_fans_can_comment: 0, image_info: { image_list: imageList } };
    let draft;
    try { draft = await this.post(credentials, "/cgi-bin/draft/add", { articles: [article] }, token); }
    catch (error) {
      if (mutationResultUnknown(error)) {
        return { exitCode: 1, status: "unknown", message: "公众号图文草稿提交结果不确定，请到后台核对；不会自动重试" };
      }
      throw error;
    }
    if (typeof draft.media_id !== "string" || !draft.media_id) {
      return { exitCode: 1, status: "unknown", message: "公众号图文草稿未返回标识，请到后台核对；不会自动重试" };
    }
    try {
      const actual = await this.post(credentials, "/cgi-bin/draft/get", { media_id: draft.media_id }, token);
      if (!sameImageNoteDraft(actual, article)) {
        return { exitCode: 1, status: "unknown", draftMediaId: draft.media_id,
          message: "公众号图文草稿回读内容或图片顺序不一致，未继续发布，请到后台核对" };
      }
    } catch {
      return { exitCode: 1, status: "unknown", draftMediaId: draft.media_id,
        message: "公众号图文草稿已提交，但未能确认保存结果，未继续发布，请到后台核对" };
    }
    if (submission.mode === "draft") {
      return { exitCode: 0, status: "draft", draftMediaId: draft.media_id,
        message: "公众号图文草稿已保存，图片顺序已核验，首图为封面" };
    }
    return this.publishDraft(credentials, draft.media_id, token);
  }

  async publishDraft(credentials, mediaId, token) {
    // 提交发布非幂等；无论查询失败或仍审核中，均不能再次提交。
    let submitted;
    try { submitted = await this.post(credentials, "/cgi-bin/freepublish/submit", { media_id: mediaId }, token); }
    catch (error) {
      if (mutationResultUnknown(error)) {
        return { exitCode: 1, status: "unknown", draftMediaId: mediaId,
          message: "公众号发布提交结果不确定，请到后台核对；不会自动重试" };
      }
      // 已有草稿的业务拒绝也必须返回标识，供用户核查或手动发布。
      return { exitCode: 1, status: "failed", draftMediaId: mediaId,
        message: error instanceof PublisherProtocolError ? error.message : "公众号发布提交失败，请到后台核对" };
    }
    if (typeof submitted.publish_id !== "string" || !submitted.publish_id) {
      return { exitCode: 1, status: "unknown", draftMediaId: mediaId,
        message: "公众号发布未返回任务标识，请到后台核对；不会自动重试" };
    }
    const publishId = submitted.publish_id;
    try {
      const state = await this.post(credentials, "/cgi-bin/freepublish/get", { publish_id: publishId }, token);
      if (state.publish_status === 0) return { exitCode: 0, status: "success", draftMediaId: mediaId, publishId, message: "公众号确认已发布" };
      if ([2, 3, 4, 5, 6].includes(state.publish_status)) return { exitCode: 1, status: "failed", draftMediaId: mediaId, publishId,
        message: `公众号发布状态 ${String(state.publish_status)}，请到后台核对` };
    } catch { /* 查询失败不重新提交 */ }
    return { exitCode: 1, status: "unknown", draftMediaId: mediaId, publishId,
      message: "公众号已受理发布，最终结果请到后台核对" };
  }

  async submit(credentials, submission, manifest, body) {
    if (manifest.contentType === "image-note") return this.submitImageNote(credentials, submission, manifest, body);
    const { cover, images } = this.validate(manifest);
    // Finish all conversions before the first remote call so a bad image cannot
    // leave this attempt with only some materials uploaded.
    const prepared = new Map();
    for (const id of new Set([...images, cover.id])) {
      const asset = manifest.assets.find(item => item.id === id);
      const bytes = fs.readFileSync(path.join(submission.snapshotDirectory, "assets", id));
      prepared.set(id, await prepareWechatImage(asset, bytes,
        images.includes(id) ? IMAGE_LIMIT : COVER_LIMIT, this.imageApi));
    }
    const token = await this.token(credentials);
    const uploaded = {};
    for (const id of images) {
      const result = await this.upload(credentials, "/cgi-bin/media/uploadimg", prepared.get(id), token);
      const url = new URL(requiredResponse(result, "url", "正文图片上传"));
      if (url.protocol === "http:" && url.hostname === "mmbiz.qpic.cn") url.protocol = "https:";
      uploaded[id] = url.toString();
    }
    const coverResult = await this.upload(credentials, "/cgi-bin/material/add_material?type=image", prepared.get(cover.id), token);
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
      if (mutationResultUnknown(error)) {
        return { exitCode: 1, status: "unknown", message: "公众号草稿提交结果不确定，请到后台核对；不会自动重试" };
      }
      throw error;
    }
    if (typeof draft.media_id !== "string" || !draft.media_id) {
      return { exitCode: 1, status: "unknown", message: "公众号草稿未返回标识，请到后台核对；不会自动重试" };
    }
    const mediaId = draft.media_id;
    if (submission.mode === "draft") {
      try { await this.post(credentials, "/cgi-bin/draft/get", { media_id: mediaId }, token); }
      catch {
        return { exitCode: 1, status: "unknown", draftMediaId: mediaId,
          message: "公众号草稿已提交，但未能确认保存结果，请到后台核对" };
      }
      return { exitCode: 0, status: "draft", draftMediaId: mediaId, message: "公众号草稿已创建，请到后台核对排版" };
    }
    return this.publishDraft(credentials, mediaId, token);
  }
}

"use strict";

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { runSingleFilePublish } from "../services/publishVideo.js";
import ptConfig from "../config/ptConfig.js";
import { PublisherProtocolError } from "./protocol.js";
import { PublisherStore, publicSubmission } from "./store.js";
import { PublisherAccounts } from "./accounts.js";
import { accepts, platformCapabilities } from "./capabilities.js";
import { captureContentPackage, readContentPackage } from "./content-package.js";
import { runBilibiliArticle, runJuejinArticle, runXhsImageNote, runToutiaoArticle, runBaijiahaoArticle } from "./article.js";
import { articleImageIds } from "./article-content.js";
import { publisherUserAgent } from "./userAgent.js";

function text(value, label, max) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new PublisherProtocolError("invalid-submission", `${label}不能为空`);
  if (normalized.length > max) throw new PublisherProtocolError("invalid-submission", `${label}不能超过 ${max} 个字符`);
  return normalized;
}

function tags(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 8) throw new PublisherProtocolError("invalid-submission", "话题不能超过 8 个");
  const result = value.map(item => String(item || "").replace(/^#+/u, "").trim()).filter(Boolean);
  if (result.some(item => item.length > 100)) throw new PublisherProtocolError("invalid-submission", "单个话题不能超过 100 个字符");
  return [...new Set(result)];
}

const CREATIVE_STATEMENTS = new Set([
  "none", "ai_generated", "fiction", "marketing", "personal_opinion", "repost", "self_made_no_repost",
]);

export class PublisherWorkerService {
  constructor(root) {
    this.store = new PublisherStore(path.join(root, "state"));
    this.snapshotsRoot = path.join(root, "snapshots");
    this.busyAccounts = new Set();
    this.validatingAccounts = new Set();
    this.accounts = new PublisherAccounts(this.store, id => this.accountBusy(id));
    this.running = false;
    this.stopping = false;
  }

  start() {
    this.store.recoverInterrupted();
    this.kick();
  }

  capabilities() { return platformCapabilities(); }

  health() {
    return { ready: true, busy: this.running, queued: this.store.queued().length };
  }

  accountBusy(id) {
    if (!id) {
      return this.running || this.validatingAccounts.size > 0 || this.store.queued().length > 0;
    }
    if (this.busyAccounts.has(id) || this.validatingAccounts.has(id)) return true;
    return this.store.submissionsRaw().some(submission =>
      (submission.state === "queued" || submission.state === "running") &&
      submission.targets.some(target => target.accountId === id)
    );
  }

  async createSubmission(params) {
    if (this.stopping) throw new PublisherProtocolError("worker-stopping", "发布引擎正在退出");
    const contentType = params.contentType || "video";
    if (!["video", "article", "image-note"].includes(contentType)) throw new PublisherProtocolError("invalid-submission", "内容类型无效");
    const mode = params.mode === "draft" ? "draft" : params.mode === "publish" ? "publish" : "";
    if (!mode) throw new PublisherProtocolError("invalid-submission", "发布模式无效");
    if (!Array.isArray(params.accountIds) || params.accountIds.length === 0) throw new PublisherProtocolError("invalid-submission", "请至少选择一个发布账号");
    const uniqueIds = [...new Set(params.accountIds.map(String))];
    if (uniqueIds.length !== params.accountIds.length) throw new PublisherProtocolError("invalid-submission", "发布账号不能重复");
    const selected = uniqueIds.map(id => this.accounts.require(id));
    if (new Set(selected.map(account => account.platform)).size !== selected.length) throw new PublisherProtocolError("invalid-submission", "同一平台一次只能选择一个账号");
    const capabilities = this.capabilities();
    for (const account of selected) {
      if (!accepts(capabilities, account.platform, contentType, mode)) {
        throw new PublisherProtocolError("unsupported-capability", `${account.displayName}暂不支持此内容类型或提交方式`);
      }
    }

    let file = "";
    let source = null;
    let acceptedManifest = "";
    if (contentType === "video") {
      const requestedFile = text(params.file, "视频文件", 4096);
      if (!path.isAbsolute(requestedFile) || !fs.existsSync(requestedFile)) throw new PublisherProtocolError("video-not-found", "成片文件不存在");
      file = fs.realpathSync(requestedFile);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size < 1) throw new PublisherProtocolError("video-not-found", "成片文件不存在");
    } else {
      if (!Number.isSafeInteger(params.revision) || params.revision < 1) throw new PublisherProtocolError("invalid-content", "草稿修订号无效");
      source = readContentPackage(params.contentDirectory, params.contentId, params.revision, contentType);
      if (contentType === "article" && source.manifest.assets.length > 0 && !source.manifest.coverAssetId) {
        throw new PublisherProtocolError("invalid-content", "文章素材必须选择封面");
      }
      if (contentType === "article" && selected.some(account => account.platform === "tt" || account.platform === "bjh")) {
        articleImageIds(source.manifest);
      }
      if (contentType === "article" && selected.some(account => account.platform === "juejin" || account.platform === "blbl")
        && source.manifest.body.includes("ebao-asset://")) {
        throw new PublisherProtocolError("unsupported-content", "掘金和B站专栏暂不支持正文插图，请分开提交");
      }
      if (contentType === "article" && source.manifest.tags.length > 0
        && selected.some(account => account.platform === "tt" || account.platform === "bjh")) {
        throw new PublisherProtocolError("unsupported-content", "头条、百家号文章标签写入尚未验收，请先清空标签");
      }
      if (contentType === "article" && String(source.manifest.summary || "").trim()
        && selected.some(account => account.platform === "tt")) {
        throw new PublisherProtocolError("unsupported-content", "头条当前文章编辑页没有可写的独立摘要，请清空摘要后再提交");
      }
      for (const account of selected) {
        const required = capabilities.find(item => item.platform === account.platform)?.requiredFields[contentType] || [];
        const limit = capabilities.find(item => item.platform === account.platform)?.maxTitleLength[contentType];
        if (limit && source.manifest.title.length > limit) {
          throw new PublisherProtocolError("invalid-content", `${account.displayName}标题不能超过${limit}字`);
        }
        const assetLimit = capabilities.find(item => item.platform === account.platform)?.maxAssets[contentType];
        if (assetLimit && source.manifest.assets.length > assetLimit) {
          throw new PublisherProtocolError("invalid-content", `${account.displayName}素材不能超过${assetLimit}个`);
        }
        for (const field of required) {
          if (!String(source.manifest.platformFields?.[account.platform]?.[field] || "").trim()) {
            throw new PublisherProtocolError("invalid-content", `${account.displayName}缺少${field}`);
          }
        }
      }
      if (contentType === "article" && selected.some(account => account.platform === "juejin")
        && source.manifest.assets.some(asset => asset.id !== source.manifest.coverAssetId)) {
        throw new PublisherProtocolError("unsupported-content", "掘金文章正文图片暂未通过验收，请先只保留封面");
      }
      if (contentType === "article" && selected.some(account => account.platform === "blbl")
        && source.manifest.assets.some(asset => asset.id !== source.manifest.coverAssetId)) {
        throw new PublisherProtocolError("unsupported-content", "B站专栏正文图片暂未通过验收，请先只保留封面");
      }
      if (contentType === "image-note" && selected.some(account => account.platform === "xhs")
        && !["none", "ai_generated", "fiction", "marketing"].includes(source.manifest.creativeStatement)) {
        throw new PublisherProtocolError("unsupported-content", "小红书暂不支持该内容声明");
      }
      acceptedManifest = JSON.stringify(source.manifest);
    }
    selected.forEach(account => this.accounts.assertNoOpenWindow(account.id));
    selected.forEach(account => this.validatingAccounts.add(account.id));
    try {
      for (const account of selected) {
        const checked = await this.accounts.check({ id: account.id });
        if (checked.loginState !== "logged-in") throw new PublisherProtocolError("account-login-required", `${account.displayName}需要重新登录`);
      }
      const id = randomUUID();
      let snapshotDirectory = "";
      try {
        if (source) {
          // Re-read after login validation: an editor may have saved another revision.
          source = readContentPackage(params.contentDirectory, params.contentId, params.revision, contentType);
          if (JSON.stringify(source.manifest) !== acceptedManifest) {
            throw new PublisherProtocolError("invalid-content", "草稿在提交检查期间发生变化，请重新提交");
          }
          snapshotDirectory = captureContentPackage(source, this.snapshotsRoot, id);
        }
        const creativeStatement = source?.manifest.creativeStatement || String(params.creativeStatement || "none");
        if (!CREATIVE_STATEMENTS.has(creativeStatement)) throw new PublisherProtocolError("invalid-submission", "内容声明无效");
        const submission = this.store.createSubmission({
          id, contentType, revision: source?.manifest.revision, contentId: source ? params.contentId : text(params.workId, "作品 ID", 200),
          ...(source ? { snapshotDirectory } : { workId: text(params.workId, "作品 ID", 200), file }),
          title: source ? source.manifest.title : text(params.title, "标题", 120),
          description: source ? source.manifest.body : String(params.description || "").trim().slice(0, 2000),
          summary: source ? source.manifest.summary : "",
          shortTitle: String(params.shortTitle || "").trim().slice(0, 32),
          tags: source ? source.manifest.tags : tags(params.tags),
          creativeStatement,
          mode,
        }, selected);
        this.kick();
        return { accepted: true, submission: publicSubmission(submission) };
      } catch (error) {
        if (snapshotDirectory) fs.rmSync(snapshotDirectory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      selected.forEach(account => this.validatingAccounts.delete(account.id));
    }
  }

  kick() {
    if (this.running || this.stopping) return;
    setImmediate(() => { void this.drain(); });
  }

  async drain() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (;;) {
        if (this.stopping) break;
        const submission = this.store.queued()[0];
        if (!submission) break;
        const accounts = submission.targets.map(target => this.store.account(target.accountId)).filter(Boolean);
        if (accounts.length !== submission.targets.length) {
          this.store.updateSubmission(submission.id, { state: "failed", finishedAt: new Date().toISOString(), message: "目标账号已被删除" });
          continue;
        }
        accounts.forEach(account => this.busyAccounts.add(account.id));
        this.store.updateSubmission(submission.id, { state: "running", startedAt: new Date().toISOString() });
        try {
          const results = [];
          if (submission.contentType === "video" || !submission.contentType) {
            const request = accounts.map(account => ({
              platform: account.pt, partition: account.partition, phone: account.id,
              file: submission.file, title: submission.title, description: submission.description,
              shortTitle: submission.shortTitle, tags: submission.tags,
              creativeStatement: submission.creativeStatement,
              draft: submission.mode === "draft", show: false,
              closeWindowAfterPublish: true, useRealBrowser: false,
              useragent: publisherUserAgent(account.pt, ptConfig[account.pt]?.useragent),
              publisherWorker: true, proxyOverride: account.proxy,
              publishOptions: { maxAttempts: 1 },
            }));
            request.sort((left, right) => left.platform === "视频号" ? -1 : right.platform === "视频号" ? 1 : 0);
            for (const item of request) results.push(await runSingleFilePublish(item));
          } else {
            const content = readContentPackage(submission.snapshotDirectory, submission.contentId, submission.revision, submission.contentType, false);
            for (const account of accounts) {
              if (account.platform === "juejin" && submission.contentType === "article") {
                results.push(await runJuejinArticle(account, submission, content.manifest));
              } else if (account.platform === "blbl" && submission.contentType === "article") {
                results.push(await runBilibiliArticle(account, submission, content.manifest));
              } else if (account.platform === "tt" && submission.contentType === "article") {
                results.push(await runToutiaoArticle(account, submission, content.manifest));
              } else if (account.platform === "bjh" && submission.contentType === "article") {
                results.push(await runBaijiahaoArticle(account, submission, content.manifest));
              } else if (account.platform === "xhs" && submission.contentType === "image-note") {
                results.push(await runXhsImageNote(account, submission, content.manifest));
              } else {
                results.push({ exitCode: 1, status: "unsupported", message: "平台适配器尚未开放" });
              }
            }
          }
          const result = {
            success: results.every(item => item.exitCode === 0),
            total: results.length,
            succeeded: results.filter(item => item.exitCode === 0).length,
            failed: results.filter(item => item.exitCode !== 0).length,
            results,
          };
          this.store.updateSubmission(submission.id, {
            state: results.some(item => item.status === "unknown") ? "unknown" : result && result.success ? "completed" : "failed",
            finishedAt: new Date().toISOString(),
            result,
          });
        } catch (error) {
          this.store.updateSubmission(submission.id, {
            state: "failed", finishedAt: new Date().toISOString(),
            message: error && error.message ? error.message : String(error),
          });
        } finally {
          accounts.forEach(account => this.busyAccounts.delete(account.id));
        }
      }
    } finally {
      this.running = false;
    }
  }

  async dispose() {
    this.stopping = true;
    this.accounts.dispose();
  }
}

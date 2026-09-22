"use strict";

import fs from "fs";
import path from "path";
import { runSingleFilePublish } from "../services/publishVideo.js";
import { PublisherProtocolError } from "./protocol.js";
import { PublisherStore, publicSubmission } from "./store.js";
import { PublisherAccounts } from "./accounts.js";

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
    this.busyAccounts = new Set();
    this.accounts = new PublisherAccounts(this.store, id => this.busyAccounts.has(id));
    this.running = false;
    this.stopping = false;
  }

  start() {
    this.store.recoverInterrupted();
    this.kick();
  }

  health() {
    return { ready: true, busy: this.running, queued: this.store.queued().length };
  }

  async createSubmission(params) {
    if (this.stopping) throw new PublisherProtocolError("worker-stopping", "发布引擎正在退出");
    const requestedFile = text(params.file, "视频文件", 4096);
    if (!path.isAbsolute(requestedFile)) throw new PublisherProtocolError("invalid-submission", "视频文件必须使用绝对路径");
    if (!fs.existsSync(requestedFile)) throw new PublisherProtocolError("video-not-found", "成片文件不存在");
    const file = fs.realpathSync(requestedFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size < 1) {
      throw new PublisherProtocolError("video-not-found", "成片文件不存在");
    }
    const mode = params.mode === "draft" ? "draft" : params.mode === "publish" ? "publish" : "";
    if (!mode) throw new PublisherProtocolError("invalid-submission", "发布模式无效");
    if (!Array.isArray(params.accountIds) || params.accountIds.length === 0) {
      throw new PublisherProtocolError("invalid-submission", "请至少选择一个发布账号");
    }
    const uniqueIds = [...new Set(params.accountIds.map(String))];
    if (uniqueIds.length !== params.accountIds.length) throw new PublisherProtocolError("invalid-submission", "发布账号不能重复");
    const selected = uniqueIds.map(id => this.accounts.require(id));
    if (new Set(selected.map(account => account.platform)).size !== selected.length) {
      throw new PublisherProtocolError("invalid-submission", "同一平台一次只能选择一个账号");
    }
    for (const account of selected) {
      const checked = await this.accounts.check({ id: account.id });
      if (checked.loginState !== "logged-in") {
        throw new PublisherProtocolError("account-login-required", `${account.displayName}（${account.pt}）需要重新登录`);
      }
    }
    const creativeStatement = String(params.creativeStatement || "none");
    if (!CREATIVE_STATEMENTS.has(creativeStatement)) throw new PublisherProtocolError("invalid-submission", "内容声明无效");
    const submission = this.store.createSubmission({
      workId: text(params.workId, "作品 ID", 200), file,
      title: text(params.title, "标题", 120),
      description: String(params.description || "").trim().slice(0, 2000),
      shortTitle: String(params.shortTitle || "").trim().slice(0, 32),
      tags: tags(params.tags),
      creativeStatement,
      mode,
    }, selected);
    this.kick();
    return { accepted: true, submission: publicSubmission(submission) };
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
          const request = accounts.map(account => ({
            platform: account.pt,
            partition: account.partition,
            phone: account.id,
            file: submission.file,
            title: submission.title,
            description: submission.description,
            shortTitle: submission.shortTitle,
            tags: submission.tags,
            creativeStatement: submission.creativeStatement,
            draft: submission.mode === "draft",
            show: false,
            closeWindowAfterPublish: true,
            useRealBrowser: false,
            publisherWorker: true,
            publishOptions: { maxAttempts: 1 },
          }));
          request.sort((left, right) => left.platform === "视频号" ? -1 : right.platform === "视频号" ? 1 : 0);
          const results = [];
          for (const item of request) results.push(await runSingleFilePublish(item));
          const result = {
            success: results.every(item => item.exitCode === 0),
            total: results.length,
            succeeded: results.filter(item => item.exitCode === 0).length,
            failed: results.filter(item => item.exitCode !== 0).length,
            results,
          };
          this.store.updateSubmission(submission.id, {
            state: result && result.success ? "completed" : "failed",
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

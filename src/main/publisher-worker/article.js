"use strict";

import path from "path";
import ptConfig from "../config/ptConfig";
import { runPuppeteerTask } from "../services/puppeteerFile";
import { PublisherProtocolError } from "./protocol.js";

const TIMEOUT_MS = 25 * 60 * 1000;

function runWorkerTask(payload, mode) {
  const taskId = payload.taskId;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ exitCode: 1, status: "unknown", message: "内容提交超时，请到平台后台确认" }), TIMEOUT_MS);
    try {
      runPuppeteerTask(payload, {
        reply(channel, response) {
          if (channel !== "puppeteerFile-done" || response?.taskId !== taskId) return;
          if (response.publishAbnormal || response.needsAttention || response.skipped) {
            finish({ exitCode: 1, status: "unknown", message: response.message || "平台结果待确认" });
            return;
          }
          finish({
            exitCode: response.status === true ? 0 : 1,
            status: response.status === true ? mode === "draft" ? "draft" : "success" : "failed",
            message: response.message || "",
          });
        },
      }, () => {
        if (!settled) finish({ exitCode: 1, status: "unknown", message: "内容处理结束但未收到确认" });
      });
    } catch (error) {
      finish({ exitCode: 1, status: "failed", message: error?.message || String(error) });
    }
  });
}

/** Reuse MatrixMedia's article handler with the Worker's isolated account session. */
export function runJuejinArticle(account, submission, manifest) {
  if (account.platform !== "juejin") throw new PublisherProtocolError("unsupported-platform", "文章平台适配器尚未开放");
  const cfg = ptConfig[account.pt];
  const taskId = Date.now() + Math.random();
  const coverPath = manifest.coverAssetId
    ? path.join(submission.snapshotDirectory, "assets", manifest.coverAssetId)
    : "";
  const fields = manifest.platformFields?.juejin || {};
  const payload = {
    taskId,
    textType: "article",
    bookName: manifest.title,
    textOtherName: manifest.title,
    data: {
      title: manifest.title,
      content: manifest.body,
      coverPath,
      category: fields.category || "前端",
      tags: manifest.tags.join(" "),
      summary: manifest.summary || "",
    },
    coverPath,
    url: cfg.upload,
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: cfg.useragent,
    partition: account.partition,
    phone: account.id,
    pt: account.pt,
    publisherWorker: true,
    proxyOverride: account.proxy,
    publishToDraft: submission.mode === "draft",
    publishOptions: { maxAttempts: 1 },
  };
  return runWorkerTask(payload, submission.mode);
}

export function runXhsImageNote(account, submission, manifest) {
  if (account.platform !== "xhs") throw new PublisherProtocolError("unsupported-platform", "图文平台适配器尚未开放");
  const cfg = ptConfig[account.pt];
  const payload = {
    taskId: Date.now() + Math.random(),
    textType: "image-note",
    bookName: manifest.title,
    imagePaths: manifest.assets.map(asset => path.join(submission.snapshotDirectory, "assets", asset.id)),
    data: {
      title: manifest.title,
      description: manifest.body,
      tags: manifest.tags,
      creativeStatement: manifest.creativeStatement,
    },
    url: "https://creator.xiaohongshu.com/publish/publish?from=menu&target=image",
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: cfg.useragent,
    partition: account.partition,
    phone: account.id,
    pt: account.pt,
    publisherWorker: true,
    proxyOverride: account.proxy,
    publishToDraft: submission.mode === "draft",
    publishOptions: { maxAttempts: 1 },
  };
  return runWorkerTask(payload, submission.mode);
}

export function runBilibiliArticle(account, submission, manifest) {
  if (account.platform !== "blbl") throw new PublisherProtocolError("unsupported-platform", "专栏平台适配器尚未开放");
  const cfg = ptConfig[account.pt];
  const coverPath = manifest.coverAssetId
    ? path.join(submission.snapshotDirectory, "assets", manifest.coverAssetId)
    : "";
  const payload = {
    taskId: Date.now() + Math.random(),
    textType: "article",
    bookName: manifest.title,
    data: {
      title: manifest.title,
      content: manifest.body,
      summary: manifest.summary,
      tags: manifest.tags,
      coverPath,
      creativeStatement: manifest.creativeStatement,
    },
    url: "https://member.bilibili.com/york/read-editor",
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: cfg.useragent,
    partition: account.partition,
    phone: account.id,
    pt: account.pt,
    publisherWorker: true,
    proxyOverride: account.proxy,
    publishToDraft: submission.mode === "draft",
    publishOptions: { maxAttempts: 1 },
  };
  return runWorkerTask(payload, submission.mode);
}

"use strict";

import path from "path";
import ptConfig from "../config/ptConfig";
import { runPuppeteerTask } from "../services/puppeteerFile";
import { PublisherProtocolError } from "./protocol.js";

const TIMEOUT_MS = 25 * 60 * 1000;
const DISCLOSURES = {
  none: "",
  ai_generated: "本文包含 AI 生成内容",
  fiction: "虚构演绎，仅供娱乐",
  marketing: "营销推广",
  personal_opinion: "个人观点，仅供参考",
  repost: "转载",
  self_made_no_repost: "自制，禁止转载",
};

export function withDisclosure(body, statement) {
  const text = DISCLOSURES[statement] || "";
  return text ? `${body.trimEnd()}\n\n> 内容声明：${text}` : body;
}

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
      content: withDisclosure(manifest.body, manifest.creativeStatement),
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
      content: withDisclosure(manifest.summary ? `${manifest.summary}\n\n${manifest.body}` : manifest.body, manifest.creativeStatement),
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

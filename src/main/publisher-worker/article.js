"use strict";

import fs from "fs";
import os from "os";
import path from "path";
import ptConfig from "../config/ptConfig";
import { cancelPuppeteerTasks, runPuppeteerTask } from "../services/puppeteerFile";
import { afterPublishWindowClosed, hasOpenPublishWindow } from "../services/publishWindowRegistry.js";
import { PublisherProtocolError } from "./protocol.js";
import { articleImageIds } from "./article-content.js";
import { publisherUserAgent } from "./userAgent.js";
import { WechatOfficialClient } from "./wechat-official.js";

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

export function runWechatOfficialArticle(account, submission, manifest, credentials, client = new WechatOfficialClient()) {
  if (account.platform !== "wxmp") throw new PublisherProtocolError("unsupported-platform", "公众号文章适配器不可用");
  return client.submit(credentials, submission, manifest, withDisclosure(manifest.body, manifest.creativeStatement));
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
    const timer = setTimeout(() => {
      finish({ exitCode: 1, status: "unknown", message: "内容提交超时，请到平台后台确认" });
      // Do not let an old browser task overlap the next target after timeout.
      cancelPuppeteerTasks("内容提交超时，已停止浏览器任务");
    }, TIMEOUT_MS);
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
            ...(response.status === true && mode === "draft"
              && ["掘金", "头条"].includes(payload.pt) && typeof response.draftUrl === "string"
              ? { draftUrl: response.draftUrl } : {}),
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
    submissionId: submission.id,
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

export async function runXhsImageNote(account, submission, manifest) {
  if (account.platform !== "xhs") throw new PublisherProtocolError("unsupported-platform", "图文平台适配器尚未开放");
  return runImageNoteTask(account, submission, manifest,
    "https://creator.xiaohongshu.com/publish/publish?from=menu&target=image");
}

const IMAGE_NOTE_URLS = {
  dy: "https://creator.douyin.com/creator-micro/content/upload?default-tab=3",
  ks: "https://cp.kuaishou.com/article/publish/video?tabType=2",
};

export function runKuaishouImageNote(account, submission, manifest) {
  if (account.platform !== "ks" || submission.mode !== "draft") {
    throw new PublisherProtocolError("unsupported-platform", "快手图文暂只支持转存草稿");
  }
  return runImageNoteTask(account, submission, manifest, IMAGE_NOTE_URLS.ks);
}

export function runDouyinImageNote(account, submission, manifest) {
  if (account.platform !== "dy" || submission.mode !== "draft") {
    throw new PublisherProtocolError("unsupported-platform", "抖音图文暂只支持转存草稿");
  }
  return runImageNoteTask(account, submission, manifest, IMAGE_NOTE_URLS.dy);
}

async function runImageNoteTask(account, submission, manifest, url) {
  // 快照使用无扩展名 UUID；浏览器文件输入框需要扩展名识别图片 MIME。
  // 只给上传副本补后缀，保留不可变快照以及用户选择的图片顺序。
  const uploadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `ebao-${account.platform}-images-`));
  let retainedForReview = false;
  try {
    const suffixes = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
    const imagePaths = manifest.assets.map(asset => {
      const suffix = suffixes[asset.mime];
      if (!suffix) throw new PublisherProtocolError("invalid-content", "不支持的图文图片格式");
      const destination = path.join(uploadDirectory, `${asset.id}${suffix}`);
      fs.copyFileSync(path.join(submission.snapshotDirectory, "assets", asset.id), destination, fs.constants.COPYFILE_EXCL);
      return destination;
    });
    const result = await runImageNoteBrowserTask(account, submission, manifest, imagePaths, url);
    if (result.status === "unknown" && hasOpenPublishWindow(account.partition)) {
      // The browser may still be finishing an upload while the user checks an
      // uncertain result. Keep its file-input paths valid until that window closes.
      afterPublishWindowClosed(account.partition, () => {
        fs.rmSync(uploadDirectory, { recursive: true, force: true });
      });
      retainedForReview = true;
    }
    return result;
  } finally {
    if (!retainedForReview) fs.rmSync(uploadDirectory, { recursive: true, force: true });
  }
}

function runImageNoteBrowserTask(account, submission, manifest, imagePaths, url) {
  const cfg = ptConfig[account.pt];
  const payload = {
    taskId: Date.now() + Math.random(),
    submissionId: submission.id,
    textType: "image-note",
    bookName: manifest.title,
    imagePaths,
    data: {
      title: manifest.title,
      description: manifest.body,
      tags: manifest.tags,
      creativeStatement: manifest.creativeStatement,
    },
    url,
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: publisherUserAgent(account.pt, cfg.useragent),
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
    submissionId: submission.id,
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

function runWebArticle(account, submission, manifest, url) {
  const cfg = ptConfig[account.pt];
  const usedImages = new Set(articleImageIds(manifest));
  const payload = {
    taskId: Date.now() + Math.random(),
    submissionId: submission.id,
    textType: "article",
    bookName: manifest.title,
    data: {
      title: manifest.title,
      content: withDisclosure(manifest.body, manifest.creativeStatement),
      ...(account.platform === "tt" ? {} : { summary: manifest.summary || "" }),
      // 头条和百家号文章标签写入未验收；不传给页面适配器，草稿标签供其他平台使用。
      images: manifest.assets.filter(asset => usedImages.has(asset.id)).map(asset => ({
        id: asset.id, mime: asset.mime, path: path.join(submission.snapshotDirectory, "assets", asset.id),
      })),
      coverPath: manifest.coverAssetId ? path.join(submission.snapshotDirectory, "assets", manifest.coverAssetId) : "",
      coverMime: manifest.assets.find(asset => asset.id === manifest.coverAssetId)?.mime || "",
    },
    url,
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: publisherUserAgent(account.pt, cfg.useragent),
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

export function runToutiaoArticle(account, submission, manifest) {
  if (account.platform !== "tt") throw new PublisherProtocolError("unsupported-platform", "头条文章适配器不可用");
  return runWebArticle(account, submission, manifest, "https://mp.toutiao.com/profile_v4/graphic/publish?from=toutiao_pc");
}

export function runBaijiahaoArticle(account, submission, manifest) {
  if (account.platform !== "bjh") throw new PublisherProtocolError("unsupported-platform", "百家号文章适配器不可用");
  return runWebArticle(account, submission, manifest, "https://baijiahao.baidu.com/builder/rc/edit?type=news");
}

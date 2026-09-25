"use strict";

import ptConfig from "../config/ptConfig.js";
import { focusOpenPublishWindow } from "../services/publishWindowRegistry.js";
import { allowsAccountWindowUrl } from "./account-windows.js";
import { PublisherProtocolError } from "./protocol.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DRAFT_LISTS = {
  // Both routes were observed in the corresponding logged-in account session.
  juejin: { article: "https://juejin.cn/creator/content/article/drafts" },
  tt: { article: "https://mp.toutiao.com/profile_v4/manage/draft" },
};
const BACKEND_ENTRIES = {
  // The configured /login redirects a logged-in Juejin account to the feed.
  juejin: "https://juejin.cn/creator/home",
};
// These are the already configured content management pages. A route that
// does not cover the submission's content type must use the platform entry.
const CONTENT_LIST_TYPES = {
  dy: ["video"], sph: ["video"], blbl: ["article"],
  bjh: ["video", "article"], tt: ["video", "article"],
  ks: ["video"], xhs: ["video"], juejin: ["article"], fqsp: ["video"],
};

function verifiedDraftUrl(platform, value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const candidate = new URL(value);
    if (candidate.protocol !== "https:" || candidate.username || candidate.password
      || candidate.port || candidate.hash) return null;
    if (platform === "juejin" && candidate.origin === "https://juejin.cn") {
      const match = /^\/editor\/drafts\/([a-zA-Z0-9_-]{1,128})$/u.exec(candidate.pathname);
      if (match && match[1].toLowerCase() !== "new") return `https://juejin.cn/editor/drafts/${match[1]}`;
    }
    if (platform === "tt" && candidate.origin === "https://mp.toutiao.com"
      && candidate.pathname === "/profile_v4/graphic/publish") {
      const id = candidate.searchParams.getAll("pgc_id");
      if (id.length === 1 && /^[a-zA-Z0-9_-]{1,128}$/u.test(id[0])) {
        return `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${id[0]}`;
      }
    }
  } catch { /* Persisted results can come from older adapters or malformed data. */ }
  return null;
}

export function resolveSubmissionOpenTarget(submission, target, account, { allowDirect = true, allowList = true } = {}) {
  const contentType = submission.contentType || "video";
  const platform = target.platform;
  if (allowDirect && submission.mode === "draft" && contentType === "article"
    && (platform === "juejin" || platform === "tt")) {
    const results = Array.isArray(submission.result?.results)
      ? submission.result.results.filter(item => item?.accountId === account.id) : [];
    if (results.length === 1 && results[0].exitCode === 0 && results[0].status === "draft") {
      const url = verifiedDraftUrl(platform, results[0].draftUrl);
      if (url) return { kind: "draft", url };
    }
  }

  const cfg = ptConfig[account.pt];
  if (!cfg?.index) throw new PublisherProtocolError("unsupported-platform", "平台后台入口不可用");
  if (allowList && submission.mode === "draft") {
    const url = DRAFT_LISTS[platform]?.[contentType];
    if (url) return { kind: "draft-list", url };
  } else if (allowList && submission.mode === "publish"
    && CONTENT_LIST_TYPES[platform]?.includes(contentType) && cfg.listIndex) {
    return { kind: "content-list", url: cfg.listIndex };
  }
  return { kind: "backend", url: BACKEND_ENTRIES[platform] || cfg.index };
}

export async function openSubmissionTarget(service, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).length < 2 || Object.keys(params).length > 3
    || Object.keys(params).some(key => !["submissionId", "accountId", "listOnly"].includes(key))
    || !Object.hasOwn(params, "submissionId") || !Object.hasOwn(params, "accountId")
    || typeof params.submissionId !== "string" || !UUID.test(params.submissionId)
    || typeof params.accountId !== "string" || !UUID.test(params.accountId)
    || (Object.hasOwn(params, "listOnly") && typeof params.listOnly !== "boolean")) {
    throw new PublisherProtocolError("invalid-submission", "提交 ID 或账号 ID 无效");
  }
  const submission = service.store.submission(params.submissionId.toLowerCase());
  if (!submission) throw new PublisherProtocolError("submission-not-found", "提交记录不存在，请刷新发布历史");
  if (submission.state === "queued" || submission.state === "running") {
    throw new PublisherProtocolError("submission-busy", "提交仍在排队或执行，请等待任务结束后查看平台稿件");
  }
  const target = submission.targets.find(item => item.accountId === params.accountId.toLowerCase());
  if (!target) throw new PublisherProtocolError("invalid-target", "该账号不属于这条提交记录");
  const account = service.accounts.require(target.accountId);
  if (account.platform !== target.platform) {
    throw new PublisherProtocolError("invalid-target", "历史记录的平台与当前账号不一致");
  }
  if ((submission.state === "unknown" || (submission.state === "completed" || submission.state === "failed")
      && submission.mode === "draft" && (submission.contentType || "video") === "article"
      && target.platform === "tt")
    && focusOpenPublishWindow(account.partition, submission.id)) {
    return { kind: "review-window" };
  }
  service.accounts.assertIdle(account.id);
  let destination = resolveSubmissionOpenTarget(submission, target, account, {
    allowDirect: params.listOnly !== true,
  });
  for (;;) {
    if (!allowsAccountWindowUrl(account.pt, destination.url)) {
      throw new PublisherProtocolError("invalid-target", "平台稿件地址未通过安全检查");
    }
    const opened = await service.accounts.open(account, destination.url, `${account.displayName} · ${account.pt}`);
    if (!opened.navigationFailed) {
      // Never expose a stored editor URL or account session details over the RPC.
      return { kind: destination.kind };
    }
    if (destination.kind === "backend") {
      throw new PublisherProtocolError("navigation-failed", "平台后台未能打开，请稍后重试");
    }
    destination = resolveSubmissionOpenTarget(submission, target, account, {
      allowDirect: false,
      allowList: destination.kind === "draft",
    });
  }
}

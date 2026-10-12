"use strict";

// 入口与草稿参数来自官方创作者前端；草稿 ID 必须由本次页面导航取得。
export const DOUYIN_ARTICLE_ENTRY = "https://creator.douyin.com/creator-micro/content/upload?default-tab=5";

export function isDouyinArticlePageUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://creator.douyin.com" || url.username || url.password || url.port) return false;
    return url.pathname === "/creator-micro/content/post/article"
      || url.pathname === "/creator-micro/content/upload" && url.searchParams.getAll("default-tab").length === 1
        && url.searchParams.get("default-tab") === "5";
  } catch { return false; }
}

export function canonicalDouyinArticleDraftUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    if (url.origin !== "https://creator.douyin.com" || url.username || url.password || url.port || url.hash
      || url.pathname !== "/creator-micro/content/post/article") return "";
    const ids = url.searchParams.getAll("creation_id");
    const stamps = url.searchParams.getAll("init_timestamp");
    const sources = url.searchParams.getAll("enter_from");
    if (ids.length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/u.test(ids[0])
      || stamps.length !== 1 || !/^\d{1,16}$/u.test(stamps[0])
      || sources.length !== 1 || !["draft", "home_draft"].includes(sources[0])) return "";
    return `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${ids[0]}&init_timestamp=${stamps[0]}`;
  } catch { return ""; }
}

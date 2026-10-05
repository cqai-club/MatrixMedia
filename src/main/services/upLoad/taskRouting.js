"use strict";

const ARTICLE = {
  掘金: "juejin",
  哔哩哔哩: "blbl",
  头条: "tt",
  百家号: "bjh",
};

/** Never fall through from an article to a same-platform video adapter. */
export function publisherHandlerKey(data) {
  const mode = data.publishToDraft === true ? "draft" : "publish";
  if (data.textType === "article") {
    return ARTICLE[data.pt] ? `article:${ARTICLE[data.pt]}:${mode}` : "";
  }
  if (data.textType === "image-note") {
    const platform = { 小红书: "xhs", 快手: "ks", 抖音: "dy" }[data.pt];
    return platform ? `image-note:${platform}:${mode}` : "";
  }
  return !data.textType || data.textType === "local" ? `legacy:${data.pt}` : "";
}

/** 头条文章草稿运行时使用正常可见页面，任务结束由独立策略自动关窗。 */
export function usesManualToutiaoArticleWindow(data) {
  return data.publisherWorker === true && data.textType === "article"
    && data.pt === "头条" && data.publishToDraft === true;
}

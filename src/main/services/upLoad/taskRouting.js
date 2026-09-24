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
    const platform = { 小红书: "xhs", 头条: "tt", 快手: "ks", 抖音: "dy" }[data.pt];
    return platform ? `image-note:${platform}:${mode}` : "";
  }
  return !data.textType || data.textType === "local" ? `legacy:${data.pt}` : "";
}

/** 头条草稿使用可见窗口供用户核查，微头条图文沿用相同规则。 */
export function usesManualToutiaoArticleWindow(data) {
  return data.publisherWorker === true && ["article", "image-note"].includes(data.textType)
    && data.pt === "头条" && data.publishToDraft === true;
}

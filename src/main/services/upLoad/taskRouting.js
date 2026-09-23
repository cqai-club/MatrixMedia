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
    return data.pt === "小红书" ? `image-note:xhs:${mode}` : "";
  }
  return !data.textType || data.textType === "local" ? `legacy:${data.pt}` : "";
}

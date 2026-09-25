"use strict";

import { PublisherProtocolError } from "./protocol.js";
import { articleImageIds } from "./article-content.js";
import { projectContentForPlatform } from "./content-package.js";

/** Validate the exact content the selected account will receive. */
export function validateTargetContent(manifest, account, contentType, capabilities, wechatClient) {
  const content = projectContentForPlatform(manifest, account.platform);
  if (!String(content.title).trim()) throw new PublisherProtocolError("invalid-content", `${account.displayName}标题不能为空`);
  if (contentType === "image-note" && !content.assets.length) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}图文至少需要一张图片`);
  }
  if (content.coverAssetId && !content.assets.some(asset => asset.id === content.coverAssetId)) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}封面不在所选图片中`);
  }
  if (contentType === "article" && !String(content.body).trim()) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}文章正文不能为空`);
  }
  if (contentType === "article" && content.assets.length > 0 && !content.coverAssetId) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}文章素材必须选择封面`);
  }
  if (contentType === "article" && ["tt", "bjh", "wxmp"].includes(account.platform)) articleImageIds(content);
  if (contentType === "article" && account.platform === "wxmp") wechatClient.validate(content);
  if (contentType === "article" && ["juejin", "blbl"].includes(account.platform) && content.body.includes("ebao-asset://")) {
    throw new PublisherProtocolError("unsupported-content", "掘金和B站专栏暂不支持正文插图，请分开提交");
  }
  const capability = capabilities.find(item => item.platform === account.platform);
  const required = capability?.requiredFields[contentType] || [];
  const titleLimit = capability?.maxTitleLength[contentType];
  if (titleLimit && content.title.length > titleLimit) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}标题不能超过${titleLimit}字`);
  }
  const assetLimit = capability?.maxAssets[contentType];
  if (assetLimit && content.assets.length > assetLimit) {
    throw new PublisherProtocolError("invalid-content", `${account.displayName}素材不能超过${assetLimit}个`);
  }
  for (const field of required) {
    if (!String(content.platformFields?.[account.platform]?.[field] || "").trim()) {
      throw new PublisherProtocolError("invalid-content", `${account.displayName}缺少${field}`);
    }
  }
  if (contentType === "article" && ["juejin", "blbl"].includes(account.platform)
    && content.assets.some(asset => asset.id !== content.coverAssetId)) {
    throw new PublisherProtocolError("unsupported-content", `${account.displayName}文章正文图片暂未通过验收，请先只保留封面`);
  }
  if (contentType === "image-note" && account.platform === "xhs"
    && !["none", "ai_generated", "fiction", "marketing"].includes(content.creativeStatement)) {
    throw new PublisherProtocolError("unsupported-content", "小红书暂不支持该内容声明");
  }
  return content;
}

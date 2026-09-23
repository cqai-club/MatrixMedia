"use strict";

import MarkdownIt from "markdown-it";
import { PublisherProtocolError } from "./protocol.js";

const markdown = new MarkdownIt({ html: false, linkify: false });
const managedImage = /^ebao-asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

export function articleImageIds(manifest) {
  const known = new Set((manifest.assets || []).map(asset => asset.id));
  const used = new Set();
  for (const block of markdown.parse(manifest.body || "", {})) {
    for (const token of block.children || []) {
      if (token.type !== "image") continue;
      const source = token.attrGet("src") || "";
      const id = managedImage.exec(source)?.[1];
      if (!id || !known.has(id)) invalid("正文图片必须引用当前草稿中已上传的素材");
      used.add(id);
    }
  }
  if (/<img\b/iu.test(manifest.body || "")) invalid("正文不接受原始 HTML 图片，请使用素材引用");
  return [...used];
}

/** Render after platform uploads. Managed URLs never escape into the editor. */
export function renderArticleHtml(manifest, uploadedUrls) {
  const expected = articleImageIds(manifest);
  for (const id of expected) {
    if (!/^https:\/\/[^\s]+$/iu.test(uploadedUrls[id] || "")) invalid("正文图片上传未完成");
  }
  const tokens = markdown.parse(manifest.body, {});
  for (const block of tokens) {
    for (const token of block.children || []) {
      if (token.type !== "image") continue;
      const id = managedImage.exec(token.attrGet("src") || "")?.[1];
      token.attrSet("src", uploadedUrls[id]);
    }
  }
  return markdown.renderer.render(tokens, markdown.options, {});
}

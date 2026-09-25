"use strict";

import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false });
// Use the pinned MarkdownIt image rule to get exact source spans, including
// angle-wrapped destinations and quoted titles with parentheses.
const imageRule = markdown.inline.ruler.__rules__.find(rule => rule.name === "image").fn;
const MANAGED_IMAGE = /^ebao-asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const WECHAT_BODY_LIMIT = 1024 * 1024;
const WECHAT_COVER_LIMIT = 10 * 1024 * 1024;

function escaped(source, index) {
  let slashes = 0;
  for (let pos = index - 1; pos >= 0 && source[pos] === "\\"; pos--) slashes++;
  return slashes % 2 === 1;
}

function codeMask(source, env) {
  const mask = new Uint8Array(source.length);
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") starts.push(index + 1);
  const tokens = markdown.parse(source, env);
  for (const token of tokens) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      mask.fill(1, starts[token.map[0]] ?? source.length, starts[token.map[1]] ?? source.length);
    }
  }
  for (let index = 0; index < source.length; index++) {
    if (mask[index] || source[index] !== "`" || escaped(source, index)) continue;
    let size = 1;
    while (source[index + size] === "`") size++;
    let close = index + size;
    while (close < source.length) {
      if (mask[close] || source[close] !== "`" || escaped(source, close)) { close++; continue; }
      let closeSize = 1;
      while (source[close + closeSize] === "`") closeSize++;
      if (closeSize === size) break;
      close += closeSize;
    }
    if (close < source.length) {
      mask.fill(1, index, close + size);
      index = close + size - 1;
    } else index += size - 1;
  }
  return mask;
}

function markdownImageRanges(source, mask, env) {
  const ranges = [];
  for (let start = 0; start < source.length; start++) {
    if (mask[start] || source[start] !== "!" || source[start + 1] !== "[" || escaped(source, start)) continue;
    const tokens = [];
    const state = new markdown.inline.State(source, markdown, env, tokens);
    state.pos = start;
    if (!imageRule(state, false)) continue;
    const end = state.pos;
    if (mask.subarray(start, end).includes(1)) continue;
    const image = tokens.find(token => token.type === "image");
    if (!image) continue;
    ranges.push({ start, end, src: image.attrGet("src") || "", kind: "markdown" });
    start = end - 1;
  }
  return ranges;
}

function rawHtmlImageRanges(source, mask) {
  const ranges = [];
  for (const match of source.matchAll(/<img\b[^>]*>/giu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!mask.subarray(start, end).includes(1)) ranges.push({ start, end, src: "", kind: "html" });
  }
  return ranges;
}

function outsideMarkdownImages(rawRanges, markdownRanges) {
  let imageIndex = 0;
  return rawRanges.filter(raw => {
    while (imageIndex < markdownRanges.length && markdownRanges[imageIndex].end <= raw.start) imageIndex++;
    const image = markdownRanges[imageIndex];
    return !image || raw.start < image.start || raw.end > image.end;
  });
}

/** Raw HTML images outside code are unsafe in the managed-asset article flow. */
export function hasRawHtmlImage(source) {
  const body = String(source || "");
  const env = {};
  const mask = codeMask(body, env);
  return outsideMarkdownImages(rawHtmlImageRanges(body, mask), markdownImageRanges(body, mask, env)).length > 0;
}

export function modeForPreparedContent(requestedMode, contentType, adjustments) {
  return contentType === "article" && requestedMode === "publish" && adjustments.length > 0
    ? "draft" : requestedMode;
}

function removeImages(body, shouldRemove) {
  const env = {};
  const mask = codeMask(body, env);
  const images = markdownImageRanges(body, mask, env);
  const candidates = [...images, ...outsideMarkdownImages(rawHtmlImageRanges(body, mask), images)]
    .sort((left, right) => left.start - right.start);
  const removed = [];
  let output = "";
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor || !shouldRemove(candidate)) continue;
    output += body.slice(cursor, candidate.start);
    cursor = candidate.end;
    removed.push(candidate);
  }
  output += body.slice(cursor);
  return { body: output, removed };
}

function message(messages, condition, value) {
  if (condition) messages.push(value);
}

function truncateUtf16(value, limit) {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

/** Return a target-only article view; never mutate the editable package or its snapshot. */
export function prepareTargetArticle(content, platform) {
  const result = { ...content, assets: [...content.assets] };
  const messages = [];
  const assetsById = new Map(result.assets.map(asset => [asset.id, asset]));
  if (["juejin", "blbl"].includes(platform)) {
    const cleaned = removeImages(result.body, () => true);
    result.body = cleaned.body;
    message(messages, cleaned.removed.length > 0, `已移除 ${cleaned.removed.length} 张正文图片（此平台暂不支持插图）`);
    if (!assetsById.has(result.coverAssetId)) {
      if (result.assets.length) {
        result.coverAssetId = result.assets[0].id;
        messages.push("已将所选第一张图片设为封面");
      } else if (result.coverAssetId) {
        result.coverAssetId = null;
        messages.push("已清除不在所选素材中的封面");
      }
    }
    const before = result.assets.length;
    result.assets = result.assets.filter(asset => asset.id === result.coverAssetId);
    message(messages, before > result.assets.length, `已移除 ${before - result.assets.length} 张非封面素材`);
    if (platform === "juejin" && !String(result.platformFields?.juejin?.category || "").trim()) {
      result.platformFields = {
        ...result.platformFields,
        juejin: { ...result.platformFields?.juejin, category: "前端" },
      };
      messages.push("掘金分类未填写，已使用默认分类「前端」");
    }
  } else if (["tt", "bjh", "wxmp"].includes(platform)) {
    const cleaned = removeImages(result.body, image => {
      if (image.kind === "html") return true;
      const id = MANAGED_IMAGE.exec(image.src)?.[1];
      const asset = id ? assetsById.get(id) : null;
      if (!asset) return true;
      return platform === "wxmp" && (!["image/jpeg", "image/png"].includes(asset.mime) || asset.bytes >= WECHAT_BODY_LIMIT);
    });
    result.body = cleaned.body;
    message(messages, cleaned.removed.length > 0, `已移除 ${cleaned.removed.length} 张无法用于该平台的正文图片`);
    if (platform === "wxmp") {
      const validCover = asset => asset && ["image/jpeg", "image/png"].includes(asset.mime)
        && asset.bytes < WECHAT_COVER_LIMIT;
      if (!validCover(assetsById.get(result.coverAssetId))) {
        const replacement = result.assets.find(validCover);
        if (replacement) {
          result.coverAssetId = replacement.id;
          messages.push("已将第一张可用的 JPEG/PNG 图片设为公众号封面");
        }
      }
      const referenceEnv = {};
      const referenceMask = codeMask(result.body, referenceEnv);
      const keptIds = new Set([result.coverAssetId, ...markdownImageRanges(result.body, referenceMask, referenceEnv)
        .map(image => MANAGED_IMAGE.exec(image.src)?.[1]).filter(Boolean)]);
      const before = result.assets.length;
      result.assets = result.assets.filter(asset => keptIds.has(asset.id));
      message(messages, before > result.assets.length, `已排除 ${before - result.assets.length} 张未使用或不兼容的公众号素材`);
      if (result.title.length > 64) {
        result.title = truncateUtf16(result.title, 64);
        messages.push("公众号标题已截为 64 字");
      }
      if (String(result.summary || "").length > 120) {
        result.summary = truncateUtf16(result.summary, 120);
        messages.push("公众号摘要已截为 120 字");
      }
    } else if (!assetsById.has(result.coverAssetId)) {
      if (result.assets.length) {
        result.coverAssetId = result.assets[0].id;
        messages.push("已将所选第一张图片设为封面");
      } else if (result.coverAssetId) {
        result.coverAssetId = null;
        messages.push("已清除不在所选素材中的封面");
      }
    }
    if (platform === "tt" && String(result.summary || "").trim()) {
      messages.push("头条文章适配器暂不写入摘要；摘要仍保留在本地草稿");
    }
    if (Array.isArray(result.tags) && result.tags.some(tag => String(tag || "").trim())) {
      messages.push("该平台文章适配器暂不写入标签；标签仍保留在本地草稿");
    }
  }
  return { content: result, messages };
}

"use strict";

import MarkdownIt from "markdown-it";
import { PublisherProtocolError } from "./protocol.js";
import { hasRawHtmlImage } from "./article-preparation.js";

const markdown = new MarkdownIt({ html: false, linkify: false });
const wechatMarkdown = new MarkdownIt({ html: false, linkify: false });
const editorialMarkdown = new MarkdownIt({ html: false, linkify: false });
const managedImage = /^ebao-asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

const WECHAT_STYLES = {
  paragraph_open: "margin:0 0 16px;",
  blockquote_open: "border-left:3px solid #2c78e4;padding:8px 12px;margin:16px 0;color:#5b6472;background:#f5f8fc;",
  bullet_list_open: "margin:0 0 16px;padding-left:24px;",
  ordered_list_open: "margin:0 0 16px;padding-left:24px;",
  list_item_open: "margin:0 0 6px;",
  link_open: "color:#2c78e4;text-decoration:underline;",
  table_open: "width:100%;border-collapse:collapse;margin:16px 0;",
  th_open: "border:1px solid #dce3eb;padding:8px;background:#f5f8fc;text-align:left;",
  td_open: "border:1px solid #dce3eb;padding:8px;",
  hr: "border:0;border-top:1px solid #dce3eb;margin:20px 0;",
};
for (const [rule, style] of Object.entries(WECHAT_STYLES)) {
  wechatMarkdown.renderer.rules[rule] = (tokens, index, options, _env, self) => {
    tokens[index].attrSet("style", style);
    return self.renderToken(tokens, index, options);
  };
}
wechatMarkdown.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
  const size = tokens[index].tag === "h1" ? 24 : tokens[index].tag === "h2" ? 20 : 18;
  const margin = size === 24 ? "24px 0 14px" : size === 20 ? "22px 0 12px" : "20px 0 10px";
  tokens[index].attrSet("style", `font-size:${size}px;line-height:1.4;font-weight:700;color:#1f2937;margin:${margin};`);
  return self.renderToken(tokens, index, options);
};
const defaultImageRule = wechatMarkdown.renderer.rules.image;
wechatMarkdown.renderer.rules.image = (tokens, index, options, env, self) => {
  tokens[index].attrSet("style", "display:block;width:100%;max-width:100%;height:auto;margin:16px auto;");
  return defaultImageRule(tokens, index, options, env, self);
};
const escapeHtml = text => String(text).replace(/[&<>"']/gu, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const codeRule = (tokens, index) => `<pre style="background:#f5f8fc;padding:12px;margin:16px 0;white-space:pre-wrap;word-break:break-word;"><code style="font-family:monospace;font-size:14px;color:#344054;">${escapeHtml(tokens[index].content)}</code></pre>\n`;
wechatMarkdown.renderer.rules.fence = codeRule;
wechatMarkdown.renderer.rules.code_block = codeRule;
wechatMarkdown.renderer.rules.code_inline = (tokens, index) => `<code style="font-family:monospace;background:#f5f8fc;padding:2px 4px;color:#344054;">${escapeHtml(tokens[index].content)}</code>`;

const EDITORIAL_STYLES = {
  blockquote_open: "border-left:4px solid #2b7468;padding:12px 16px;margin:22px 0;background:#edf5f0;color:#3d6259;",
  bullet_list_open: "margin:4px 0 18px;padding-left:26px;line-height:1.9;",
  ordered_list_open: "margin:4px 0 18px;padding-left:26px;line-height:1.9;",
  list_item_open: "margin:0 0 8px;",
  link_open: "color:#2b7468;text-decoration:underline;",
  strong_open: "font-weight:700;color:#2b7468;",
  table_open: "width:100%;border-collapse:collapse;margin:22px 0;",
  th_open: "border:1px solid #c8ded4;padding:10px;background:#edf5f0;text-align:left;",
  td_open: "border:1px solid #c8ded4;padding:10px;",
  hr: "border:0;border-top:1px solid #c8ded4;margin:28px 0;",
};
for (const [rule, style] of Object.entries(EDITORIAL_STYLES)) {
  editorialMarkdown.renderer.rules[rule] = (tokens, index, options, _env, self) => {
    tokens[index].attrSet("style", style);
    return self.renderToken(tokens, index, options);
  };
}
editorialMarkdown.renderer.rules.paragraph_open = (tokens, index, options, _env, self) => {
  const style = index === 0
    ? "margin:0 0 24px;padding:14px 16px;border-left:4px solid #2b7468;background:#edf5f0;color:#273b35;font-size:17px;line-height:1.85;"
    : "margin:0 0 18px;line-height:1.9;";
  tokens[index].attrSet("style", style);
  return self.renderToken(tokens, index, options);
};
editorialMarkdown.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
  const level = Number(tokens[index].tag.slice(1));
  const base = level === 1
    ? "font-size:26px;line-height:1.4;font-weight:700;color:#273b35;margin:30px 0 20px;padding:0 0 12px;border-bottom:3px solid #2b7468;"
    : level === 2
      ? "font-size:20px;line-height:1.5;font-weight:700;color:#273b35;margin:28px 0 16px;padding:10px 12px;border-left:4px solid #2b7468;background:#edf5f0;"
      : "font-size:18px;line-height:1.5;font-weight:700;color:#2b7468;margin:24px 0 12px;";
  tokens[index].attrSet("style", base);
  return self.renderToken(tokens, index, options);
};
const editorialDefaultImageRule = editorialMarkdown.renderer.rules.image;
editorialMarkdown.renderer.rules.image = (tokens, index, options, env, self) => {
  tokens[index].attrSet("style", "display:block;width:100%;max-width:100%;height:auto;margin:24px auto;border-radius:10px;");
  return editorialDefaultImageRule(tokens, index, options, env, self);
};
const editorialCodeRule = (tokens, index) => `<pre style="background:#edf5f0;border-left:3px solid #c8ded4;padding:14px 16px;margin:20px 0;white-space:pre-wrap;word-break:break-word;"><code style="font-family:monospace;font-size:14px;line-height:1.7;color:#273b35;">${escapeHtml(tokens[index].content)}</code></pre>\n`;
editorialMarkdown.renderer.rules.fence = editorialCodeRule;
editorialMarkdown.renderer.rules.code_block = editorialCodeRule;
editorialMarkdown.renderer.rules.code_inline = (tokens, index) => `<code style="font-family:monospace;background:#edf5f0;padding:2px 4px;color:#2b7468;">${escapeHtml(tokens[index].content)}</code>`;

// 这三套配色使用独立编写的内联样式；公众号草稿编辑器不会保留预览页的外部样式表。
const DECORATIVE_THEMES = {
  orangeheart: {
    accent: "#ee705f", tint: "#fff3ee", border: "#f2c7bc", text: "#543d38", strong: "#b84e3e",
    section: "font-size:16px;line-height:1.9;color:#543d38;background:#fffdfa;padding:18px 16px;word-break:break-word;",
    lead: "margin:0 0 19px;padding:14px 16px;border-left:4px solid #ee705f;background:#fff3ee;color:#69453c;line-height:1.9;",
    h1: "font-size:24px;line-height:1.4;font-weight:700;color:#ad493a;margin:30px 0 20px;padding:0 0 12px;border-bottom:2px solid #f2c7bc;",
    h2: "font-size:20px;line-height:1.5;font-weight:700;color:#a84434;margin:29px 0 17px;padding:10px 14px;border-left:5px solid #ee705f;background:#fff3ee;",
    h3: "font-size:18px;line-height:1.5;font-weight:700;color:#b84e3e;margin:24px 0 12px;",
    quote: "color:#754f46;",
    image: "display:block;width:100%;max-width:100%;height:auto;margin:23px auto;border-radius:12px;",
    codeFrame: "border-left:3px solid #ee705f;",
  },
  lapis: {
    accent: "#4870ac", tint: "#edf3fb", border: "#b8c9e0", text: "#354455", strong: "#34598f", whiteH2: true,
    section: "font-size:16px;line-height:1.85;color:#354455;background:#fbfdff;padding:18px 16px;word-break:break-word;",
    lead: "margin:0 0 25px;padding:13px 16px;border-top:1px solid #b8c9e0;border-bottom:1px solid #b8c9e0;background:#edf3fb;color:#354455;line-height:1.85;",
    h1: "font-size:24px;line-height:1.4;font-weight:700;color:#34598f;margin:30px 0 20px;padding:0 0 12px;border-bottom:3px solid #4870ac;",
    h2: "font-size:20px;line-height:1.5;font-weight:700;color:#ffffff;margin:29px 0 18px;padding:10px 15px;background:#4870ac;border-radius:4px;",
    h3: "font-size:18px;line-height:1.5;font-weight:700;color:#34598f;margin:24px 0 12px;",
    quote: "color:#45617e;",
    image: "display:block;width:100%;max-width:100%;height:auto;margin:23px auto;padding:3px;border:1px solid #b8c9e0;border-radius:5px;",
    codeFrame: "border:1px solid #b8c9e0;",
  },
  purple: {
    accent: "#7656a6", tint: "#f5f0fa", border: "#d8c9e9", text: "#43384e", strong: "#6b4c96",
    section: "font-size:16px;line-height:1.9;color:#43384e;background:#fffdff;padding:18px 16px;word-break:break-word;",
    lead: "margin:0 0 25px;padding:15px 17px;border:1px solid #d8c9e9;border-radius:9px;background:#f5f0fa;color:#43384e;line-height:1.9;",
    h1: "font-size:24px;line-height:1.4;font-weight:700;color:#6b4c96;text-align:center;margin:32px 0 20px;padding:0 0 14px;border-bottom:2px solid #d8c9e9;",
    h2: "font-size:20px;line-height:1.5;font-weight:700;color:#6b4c96;margin:30px 0 18px;padding:8px 3px 11px;border-bottom:3px solid #7656a6;",
    h3: "font-size:18px;line-height:1.5;font-weight:700;color:#7656a6;margin:24px 0 12px;",
    quote: "color:#5e4c70;border-radius:0 9px 9px 0;",
    image: "display:block;width:100%;max-width:100%;height:auto;margin:24px auto;border-radius:14px;",
    codeFrame: "border:1px solid #d8c9e9;border-radius:8px;",
  },
};

function decorativeMarkdown(theme) {
  const renderer = new MarkdownIt({ html: false, linkify: false });
  const styles = {
    blockquote_open: `border-left:4px solid ${theme.accent};padding:12px 16px;margin:22px 0;background:${theme.tint};${theme.quote}`,
    bullet_list_open: "margin:4px 0 18px;padding-left:26px;line-height:1.9;",
    ordered_list_open: "margin:4px 0 18px;padding-left:26px;line-height:1.9;",
    list_item_open: "margin:0 0 8px;",
    table_open: "width:100%;border-collapse:collapse;margin:22px 0;",
    th_open: `border:1px solid ${theme.border};padding:10px;background:${theme.tint};color:${theme.accent};text-align:left;`,
    td_open: `border:1px solid ${theme.border};padding:10px;`,
    hr: `border:0;border-top:2px solid ${theme.border};margin:28px 0;`,
  };
  for (const [rule, style] of Object.entries(styles)) {
    renderer.renderer.rules[rule] = (tokens, index, options, _env, self) => {
      tokens[index].attrSet("style", style);
      return self.renderToken(tokens, index, options);
    };
  }
  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const color = theme.whiteH2 && env.decorativeHeadingLevel === 2 ? "#ffffff" : theme.accent;
    tokens[index].attrSet("style", `color:${color};text-decoration:underline;`);
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.strong_open = (tokens, index, options, env, self) => {
    const color = theme.whiteH2 && env.decorativeHeadingLevel === 2 ? "#ffffff" : theme.strong;
    tokens[index].attrSet("style", `font-weight:700;color:${color};`);
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.paragraph_open = (tokens, index, options, _env, self) => {
    const firstBodyParagraph = tokens.findIndex(token => token.type === "paragraph_open" && token.level === 0);
    tokens[index].attrSet("style", index === firstBodyParagraph ? theme.lead : "margin:0 0 18px;line-height:1.9;");
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    const level = Number(tokens[index].tag.slice(1));
    env.decorativeHeadingLevel = level;
    tokens[index].attrSet("style", level === 1 ? theme.h1 : level === 2 ? theme.h2 : theme.h3);
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.heading_close = (tokens, index, options, env, self) => {
    delete env.decorativeHeadingLevel;
    return self.renderToken(tokens, index, options);
  };
  const defaultImageRule = renderer.renderer.rules.image;
  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    tokens[index].attrSet("style", theme.image);
    return defaultImageRule(tokens, index, options, env, self);
  };
  const themedCodeRule = (tokens, index) => `<pre style="background:${theme.tint};${theme.codeFrame}padding:14px 16px;margin:20px 0;white-space:pre-wrap;word-break:break-word;"><code style="font-family:monospace;font-size:14px;line-height:1.7;color:${theme.text};">${escapeHtml(tokens[index].content)}</code></pre>\n`;
  renderer.renderer.rules.fence = themedCodeRule;
  renderer.renderer.rules.code_block = themedCodeRule;
  renderer.renderer.rules.code_inline = (tokens, index) => `<code style="font-family:monospace;background:${theme.tint};padding:2px 4px;color:${theme.accent};">${escapeHtml(tokens[index].content)}</code>`;
  return renderer;
}

const decorativeRenderers = Object.fromEntries(Object.entries(DECORATIVE_THEMES)
  .map(([name, theme]) => [name, decorativeMarkdown(theme)]));

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

function visitImages(tokens, visit) {
  for (const token of tokens) {
    if (token.type === "image") visit(token);
    if (token.children) visitImages(token.children, visit);
  }
}

export function articleImageIds(manifest) {
  const known = new Set((manifest.assets || []).map(asset => asset.id));
  const used = new Set();
  visitImages(markdown.parse(manifest.body || "", {}), token => {
    const source = token.attrGet("src") || "";
    const id = managedImage.exec(source)?.[1];
    if (!id || !known.has(id)) invalid("正文图片必须引用当前草稿中已上传的素材");
    used.add(id);
  });
  if (hasRawHtmlImage(manifest.body || "")) invalid("正文不接受原始 HTML 图片，请使用素材引用");
  return [...used];
}

/** Render after platform uploads. Managed URLs never escape into the editor. */
function renderArticle(manifest, uploadedUrls, renderer) {
  const expected = articleImageIds(manifest);
  for (const id of expected) {
    if (!/^https:\/\/[^\s]+$/iu.test(uploadedUrls[id] || "")) invalid("正文图片上传未完成");
  }
  const tokens = renderer.parse(manifest.body, {});
  visitImages(tokens, token => {
    const id = managedImage.exec(token.attrGet("src") || "")?.[1];
    token.attrSet("src", uploadedUrls[id]);
  });
  return renderer.renderer.render(tokens, renderer.options, {});
}

/** Render after platform uploads. Managed URLs never escape into the editor. */
export function renderArticleHtml(manifest, uploadedUrls) {
  return renderArticle(manifest, uploadedUrls, markdown);
}

/** WeChat strips external stylesheets; a conservative inline style survives its draft editor. */
export function renderWechatArticleHtml(manifest, uploadedUrls) {
  if (manifest.articleTheme === "editorial") {
    return `<section style="font-size:16px;line-height:1.9;letter-spacing:0.2px;color:#273b35;background:#fffdf8;padding:18px 16px;word-break:break-word;">${renderArticle(manifest, uploadedUrls, editorialMarkdown)}</section>`;
  }
  const decorativeTheme = Object.hasOwn(DECORATIVE_THEMES, manifest.articleTheme)
    ? DECORATIVE_THEMES[manifest.articleTheme] : null;
  if (decorativeTheme) {
    return `<section style="${decorativeTheme.section}">${renderArticle(manifest, uploadedUrls, decorativeRenderers[manifest.articleTheme])}</section>`;
  }
  return `<section style="font-size:16px;line-height:1.8;color:#252b32;word-break:break-word;">${renderArticle(manifest, uploadedUrls, wechatMarkdown)}</section>`;
}

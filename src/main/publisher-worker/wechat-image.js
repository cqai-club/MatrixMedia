"use strict";

import { PublisherProtocolError } from "./protocol.js";

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

/** Normalize only the upload copy; the verified content snapshot stays untouched. */
export async function prepareWechatImage(asset, bytes, limit, suppliedImageApi, options = {}) {
  const webp = options.allowWebp === true && asset.mime === "image/webp";
  if (!["image/jpeg", "image/png"].includes(asset.mime) && !webp) invalid("微信公众号文章图片仅支持 JPEG 或 PNG");
  if (bytes.length !== asset.bytes) invalid("公众号图片素材在提交前发生变化");
  if (bytes.length < limit && !webp) return { bytes, mime: asset.mime };

  const electron = suppliedImageApi ? null : await import("electron");
  const imageApi = suppliedImageApi || electron?.nativeImage || electron?.default?.nativeImage;
  if (!imageApi?.createFromBuffer) invalid("公众号图片处理组件不可用");
  const image = imageApi.createFromBuffer(bytes);
  if (image.isEmpty()) invalid("公众号图片无法解码，请更换图片");
  const size = image.getSize();
  if (!size.width || !size.height) invalid("公众号图片尺寸无效");
  const mime = webp ? "image/jpeg" : asset.mime;
  const format = mime === "image/png" ? "png" : "jpeg";
  const largestSide = Math.max(size.width, size.height);
  const minimumSide = Math.min(720, largestSide);
  for (let maxSide = Math.min(4096, largestSide);;) {
    const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
    const width = Math.max(1, Math.floor(size.width * scale));
    const height = Math.max(1, Math.floor(size.height * scale));
    const current = width === size.width && height === size.height
      ? image : image.resize({ width, height, quality: "better" });
    for (const quality of format === "png" ? [null] : [85, 72, 58, 45]) {
      const encoded = quality === null ? current.toPNG() : current.toJPEG(quality);
      if (Buffer.isBuffer(encoded) && encoded.length > 0 && encoded.length < limit) {
        return { bytes: encoded, mime };
      }
    }
    // Stop before a heavily reduced image becomes unusable in an article.
    if (maxSide <= minimumSide) break;
    maxSide = Math.max(minimumSide, Math.floor(maxSide * 0.75));
  }
  invalid(`公众号图片无法压缩到${options.allowWebp === true ? "图文 10MB" : limit < 2 * 1024 * 1024 ? "正文 1MB" : "封面 10MB"}以下且保留可用尺寸，请换一张图片`);
}

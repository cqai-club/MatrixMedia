"use strict";

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PublisherProtocolError } from "./protocol.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MANIFEST = 2 * 1024 * 1024 + 128 * 1024;
const MAX_ASSET = 20 * 1024 * 1024;

function invalid(message) {
  throw new PublisherProtocolError("invalid-content", message);
}

function fileNoSymlink(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) invalid("内容包包含无效文件");
  return stat;
}

function sniff(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

export function readContentPackage(directory, expectedId, revision, expectedType, strictIdFolder = true) {
  if (!path.isAbsolute(directory) || !UUID.test(expectedId)) invalid("内容包路径无效");
  const root = fs.realpathSync(directory);
  if ((strictIdFolder && path.basename(root) !== expectedId) || fs.lstatSync(directory).isSymbolicLink()) invalid("内容包路径无效");
  const manifestPath = path.join(root, "manifest.json");
  if (fileNoSymlink(manifestPath).size > MAX_MANIFEST) invalid("内容包过大");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.id !== expectedId || manifest.revision !== revision || manifest.contentType !== expectedType) invalid("内容包修订不匹配");
  if (!["article", "image-note"].includes(expectedType) || !String(manifest.title || "").trim() || String(manifest.title).length > 120) invalid("内容标题无效");
  if (typeof manifest.body !== "string" || Buffer.byteLength(manifest.body, "utf8") > 2 * 1024 * 1024) invalid("正文无效");
  if (expectedType === "article" && !manifest.body.trim()) invalid("文章正文不能为空");
  if (!Array.isArray(manifest.tags) || manifest.tags.length > 8 || manifest.tags.some(tag => typeof tag !== "string" || tag.length > 100)) invalid("标签无效");
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 20) invalid("素材数量无效");
  if (expectedType === "image-note" && !manifest.assets.length) invalid("图文至少需要一张图片");
  const assetsRoot = path.join(root, "assets");
  if (fs.lstatSync(assetsRoot).isSymbolicLink() || !fs.statSync(assetsRoot).isDirectory()) invalid("素材目录无效");
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!asset || !UUID.test(asset.id) || ids.has(asset.id) || !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)) invalid("素材清单无效");
    ids.add(asset.id);
    const file = path.join(assetsRoot, asset.id);
    const stat = fileNoSymlink(file);
    if (stat.size !== asset.bytes || stat.size > MAX_ASSET || stat.size < 1) invalid("素材已改变");
    if (sniff(fs.readFileSync(file)) !== asset.mime) invalid("素材格式不匹配");
  }
  if (manifest.coverAssetId && !ids.has(manifest.coverAssetId)) invalid("封面素材无效");
  return { manifest, root };
}

export function captureContentPackage(source, snapshotsRoot, submissionId) {
  const { manifest, root } = source;
  if (!UUID.test(submissionId)) invalid("提交 ID 无效");
  fs.mkdirSync(snapshotsRoot, { recursive: true, mode: 0o700 });
  const staged = path.join(snapshotsRoot, `.${submissionId}.${randomUUID()}.tmp`);
  const destination = path.join(snapshotsRoot, submissionId);
  fs.mkdirSync(staged, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(staged, "assets"), { mode: 0o700 });
    fs.writeFileSync(path.join(staged, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    for (const asset of manifest.assets) {
      fs.copyFileSync(path.join(root, "assets", asset.id), path.join(staged, "assets", asset.id), fs.constants.COPYFILE_EXCL);
    }
    readContentPackage(staged, manifest.id, manifest.revision, manifest.contentType, false);
    fs.renameSync(staged, destination);
    return destination;
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

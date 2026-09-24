"use strict";

import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { PublisherProtocolError } from "./protocol.js";
import { ALL_PLATFORMS } from "./capabilities.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MAX_ASSET = 20 * 1024 * 1024;
const VARIANT_FIELDS = new Set(["title", "body", "summary", "tags", "coverAssetId", "assetOrder"]);

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

function validatePlatformVariants(manifest, assetIds) {
  const variants = manifest.platformVariants;
  if (variants === undefined) return;
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) invalid("平台版本无效");
  for (const [platform, variant] of Object.entries(variants)) {
    if (!ALL_PLATFORMS.includes(platform) || !variant || typeof variant !== "object" || Array.isArray(variant)
      || Object.keys(variant).some(field => !VARIANT_FIELDS.has(field))) invalid("平台版本无效");
    if (Object.hasOwn(variant, "title") && (typeof variant.title !== "string" || variant.title.length > 120)) invalid("平台标题无效");
    if (Object.hasOwn(variant, "body") && (typeof variant.body !== "string" || Buffer.byteLength(variant.body, "utf8") > 2 * 1024 * 1024)) invalid("平台正文无效");
    if (Object.hasOwn(variant, "summary") && (typeof variant.summary !== "string" || variant.summary.length > 2000)) invalid("平台摘要无效");
    if (Object.hasOwn(variant, "tags") && (!Array.isArray(variant.tags) || variant.tags.length > 8
      || variant.tags.some(tag => typeof tag !== "string" || tag.length > 100))) invalid("平台标签无效");
    if (Object.hasOwn(variant, "coverAssetId") && variant.coverAssetId !== null
      && (typeof variant.coverAssetId !== "string" || !assetIds.has(variant.coverAssetId))) invalid("平台封面素材无效");
    if (Object.hasOwn(variant, "assetOrder") && (!Array.isArray(variant.assetOrder)
      || variant.assetOrder.length > assetIds.size || new Set(variant.assetOrder).size !== variant.assetOrder.length
      || variant.assetOrder.some(id => typeof id !== "string" || !assetIds.has(id)))) invalid("平台图片顺序无效");
  }
}

/** The immutable snapshot keeps every version; each target sees only its effective fields. */
export function projectContentForPlatform(manifest, platform) {
  const variant = manifest.platformVariants?.[platform] || {};
  const projected = { ...manifest };
  delete projected.platformVariants;
  for (const field of ["title", "body", "summary", "tags", "coverAssetId"]) {
    if (Object.hasOwn(variant, field)) projected[field] = variant[field];
  }
  if (Object.hasOwn(variant, "assetOrder")) {
    const assets = new Map(manifest.assets.map(asset => [asset.id, asset]));
    projected.assets = variant.assetOrder.map(id => assets.get(id));
  }
  return projected;
}

export function readContentPackage(directory, expectedId, revision, expectedType, strictIdFolder = true) {
  if (!path.isAbsolute(directory) || !UUID.test(expectedId)) invalid("内容包路径无效");
  const root = fs.realpathSync(directory);
  if ((strictIdFolder && path.basename(root) !== expectedId) || fs.lstatSync(directory).isSymbolicLink()) invalid("内容包路径无效");
  const manifestPath = path.join(root, "manifest.json");
  if (fileNoSymlink(manifestPath).size > MAX_MANIFEST) invalid("内容包过大");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.id !== expectedId || manifest.revision !== revision || manifest.contentType !== expectedType) invalid("内容包修订不匹配");
  if (!["article", "image-note"].includes(expectedType) || typeof manifest.title !== "string" || manifest.title.length > 120) invalid("内容标题无效");
  if (Object.hasOwn(manifest, "articleTheme")
    && (expectedType !== "article" || !["classic", "editorial", "orangeheart", "lapis", "purple"].includes(manifest.articleTheme))) invalid("文章排版主题无效");
  if (typeof manifest.body !== "string" || Buffer.byteLength(manifest.body, "utf8") > 2 * 1024 * 1024) invalid("正文无效");
  if (!Array.isArray(manifest.tags) || manifest.tags.length > 8 || manifest.tags.some(tag => typeof tag !== "string" || tag.length > 100)) invalid("标签无效");
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 20) invalid("素材数量无效");
  const assetsRoot = path.join(root, "assets");
  if (fs.lstatSync(assetsRoot).isSymbolicLink() || !fs.statSync(assetsRoot).isDirectory()) invalid("素材目录无效");
  const ids = new Set();
  const assetHashes = {};
  for (const asset of manifest.assets) {
    if (!asset || !UUID.test(asset.id) || ids.has(asset.id) || !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)) invalid("素材清单无效");
    ids.add(asset.id);
    const file = path.join(assetsRoot, asset.id);
    const stat = fileNoSymlink(file);
    if (stat.size !== asset.bytes || stat.size > MAX_ASSET || stat.size < 1) invalid("素材已改变");
    const data = fs.readFileSync(file);
    if (sniff(data) !== asset.mime) invalid("素材格式不匹配");
    const digest = createHash("sha256").update(data).digest("hex");
    if (asset.sha256 && (typeof asset.sha256 !== "string" || digest !== asset.sha256)) invalid("素材已改变");
    assetHashes[asset.id] = digest;
  }
  if (manifest.coverAssetId && !ids.has(manifest.coverAssetId)) invalid("封面素材无效");
  validatePlatformVariants(manifest, ids);
  return { manifest, root, assetHashes };
}

export function captureContentPackage(source, snapshotsRoot, submissionId) {
  const { manifest, root, assetHashes } = source;
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
    const verified = readContentPackage(staged, manifest.id, manifest.revision, manifest.contentType, false);
    for (const asset of manifest.assets) {
      if (verified.assetHashes[asset.id] !== assetHashes[asset.id]) invalid("复制内容快照时素材发生变化");
    }
    fs.renameSync(staged, destination);
    return destination;
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/** A finished submission owns only its captured package, never the editable source content. */
export function removeSubmissionSnapshot(snapshotsRoot, submission) {
  if (!submission || !UUID.test(submission.id) || typeof submission.snapshotDirectory !== "string") return false;
  const expected = path.join(path.resolve(snapshotsRoot), submission.id);
  if (path.resolve(submission.snapshotDirectory) !== expected) return false;
  const root = fs.lstatSync(snapshotsRoot);
  const snapshot = fs.lstatSync(expected);
  if (!root.isDirectory() || root.isSymbolicLink() || !snapshot.isDirectory() || snapshot.isSymbolicLink()) return false;
  if (fs.realpathSync(expected) !== path.join(fs.realpathSync(snapshotsRoot), submission.id)) return false;
  fs.rmSync(expected, { recursive: true, force: true });
  return true;
}

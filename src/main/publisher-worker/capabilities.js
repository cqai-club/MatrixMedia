"use strict";

export const VIDEO_PLATFORMS = ["dy", "sph", "xhs", "blbl", "ks", "tt", "bjh", "fqsp"];
export const ALL_PLATFORMS = [...VIDEO_PLATFORMS, "juejin"];

const EXPERIMENTAL = {
  "juejin:article": { requiredFields: ["category"], maxAssets: 1 },
  "blbl:article": { requiredFields: [], maxAssets: 1 },
  "xhs:image-note": { requiredFields: [], maxAssets: 20, maxTitleLength: 20 },
};

/** Only verified capabilities are advertised in production. */
export function platformCapabilities(env = process.env) {
  const enabled = new Set(String(env.EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES || "")
    .split(",").map(value => value.trim()).filter(Boolean));
  return ALL_PLATFORMS.map(platform => {
    const isVideo = VIDEO_PLATFORMS.includes(platform);
    const types = isVideo ? ["video"] : [];
    const modes = isVideo ? { video: ["publish", "draft"] } : {};
    const requiredFields = {};
    const maxAssets = {};
    const maxTitleLength = {};
    for (const [key, settings] of Object.entries(EXPERIMENTAL)) {
      const [target, type] = key.split(":");
      if (target !== platform || !enabled.has(key)) continue;
      types.push(type);
      modes[type] = ["publish", "draft"];
      requiredFields[type] = settings.requiredFields;
      maxAssets[type] = settings.maxAssets;
      if (settings.maxTitleLength) maxTitleLength[type] = settings.maxTitleLength;
    }
    return { platform, contentTypes: types, modes, requiredFields, maxAssets, maxTitleLength };
  });
}

export function accepts(capabilities, platform, contentType, mode) {
  const entry = capabilities.find(item => item.platform === platform);
  return Boolean(entry && entry.modes[contentType] && entry.modes[contentType].includes(mode));
}

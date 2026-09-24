"use strict";

export const VIDEO_PLATFORMS = ["dy", "sph", "xhs", "blbl", "ks", "tt", "bjh", "fqsp"];
export const ALL_PLATFORMS = [...VIDEO_PLATFORMS, "juejin", "wxmp"];

const CONTENT_ADAPTERS = {
  "juejin:article": { requiredFields: ["category"], maxAssets: 1 },
  "blbl:article": { requiredFields: [], maxAssets: 1 },
  "xhs:image-note": { requiredFields: [], maxAssets: 18, maxTitleLength: 20 },
  "wxmp:article": { requiredFields: [], maxAssets: 20, maxTitleLength: 64 },
};
const ARTICLE_MODES = {
  tt: { requiredFields: [], maxAssets: 20 },
  bjh: { requiredFields: [], maxAssets: 20 },
};

/** Advertise only content/mode pairs that have a concrete Worker adapter. */
export function platformCapabilities() {
  return ALL_PLATFORMS.map(platform => {
    const isVideo = VIDEO_PLATFORMS.includes(platform);
    const types = isVideo ? ["video"] : [];
    const modes = isVideo ? { video: ["publish", "draft"] } : {};
    const requiredFields = {};
    const maxAssets = {};
    const maxTitleLength = {};
    for (const [key, settings] of Object.entries(CONTENT_ADAPTERS)) {
      const [target, type] = key.split(":");
      if (target !== platform) continue;
      types.push(type);
      modes[type] = ["publish", "draft"];
      requiredFields[type] = settings.requiredFields;
      maxAssets[type] = settings.maxAssets;
      if (settings.maxTitleLength) maxTitleLength[type] = settings.maxTitleLength;
    }
    const articleSettings = ARTICLE_MODES[platform];
    if (articleSettings) {
      types.push("article");
      modes.article = ["publish", "draft"];
      requiredFields.article = articleSettings.requiredFields;
      maxAssets.article = articleSettings.maxAssets;
    }
    return {
      platform, contentTypes: types, modes, requiredFields, maxAssets, maxTitleLength,
      ...(platform === "wxmp" ? { articleThemeVersion: 2 } : {}),
    };
  });
}

export function accepts(capabilities, platform, contentType, mode) {
  const entry = capabilities.find(item => item.platform === platform);
  return Boolean(entry && entry.modes[contentType] && entry.modes[contentType].includes(mode));
}

"use strict";

export const XHS_SECOND_CLICK_DELAY_MIN_MS = 5000;
export const XHS_SECOND_CLICK_DELAY_MAX_MS = 10000;
export const XHS_PLATFORM_STAGGER_MIN_MS = 15000;
export const XHS_PLATFORM_STAGGER_MAX_MS = 30000;

export function isXhsPlatform(pt) {
  return String(pt || "").includes("小红书");
}

export function applyXhsConservativePublishOptions(payload) {
  if (!isXhsPlatform(payload && payload.pt)) return payload;
  return {
    ...payload,
    show: payload && payload.publisherWorker ? false : true,
    closeWindowAfterPublish: payload && payload.publisherWorker ? true : false,
    xhsConservativeMode: true,
  };
}

export function getPublishAttemptLimit(data, defaultLimit = 5) {
  const requested = Number(data && data.publishOptions && data.publishOptions.maxAttempts);
  if (Number.isInteger(requested) && requested >= 1 && requested <= defaultLimit) return requested;
  return isXhsPlatform(data && data.pt) ? 1 : defaultLimit;
}

export function getRandomDelayMs(min, max, random = Math.random) {
  const safeMin = Number(min) || 0;
  const safeMax = Math.max(safeMin, Number(max) || safeMin);
  return Math.round(safeMin + (safeMax - safeMin) * random());
}

export function getXhsSecondClickDelayMs(random = Math.random) {
  return getRandomDelayMs(
    XHS_SECOND_CLICK_DELAY_MIN_MS,
    XHS_SECOND_CLICK_DELAY_MAX_MS,
    random
  );
}

export function getXhsPlatformStaggerDelayMs(random = Math.random) {
  return getRandomDelayMs(
    XHS_PLATFORM_STAGGER_MIN_MS,
    XHS_PLATFORM_STAGGER_MAX_MS,
    random
  );
}

"use strict";

// 发布页与账号管理窗口共享同一个持久化 session。任务结束后仍供人工核查的
// 发布窗口也必须占用该账号，直到用户亲自关闭窗口。
const windowsByPartition = new Map();
const closeCallbacksByPartition = new Map();
const submissionIdsByWindow = new WeakMap();

export function isToutiaoWorkerTask(data) {
  return data?.publisherWorker === true && data.pt === "头条";
}

export function toutiaoFailureMessage(message, mode = "draft") {
  const text = String(message || "").trim();
  const action = mode === "draft" ? "草稿保存" : "发布";
  if (/Waiting failed|Navigation timeout|TimeoutError|timeout.*exceeded|Timed out after/iu.test(text)) {
    return `头条${action}超时，请从发布记录打开平台稿件检查`;
  }
  if (!text || /结果待确认|平台结果待确认/u.test(text)) {
    return `头条${action}未完成，请从发布记录打开平台稿件检查`;
  }
  return text;
}

export function registerPublishWindow(partition, win, submissionId = "") {
  if (!win) return;
  const key = partition || "";
  let windows = windowsByPartition.get(key);
  if (!windows) {
    windows = new Set();
    windowsByPartition.set(key, windows);
  }
  windows.add(win);
  if (typeof submissionId === "string" && submissionId) submissionIdsByWindow.set(win, submissionId);
  // 在首次导航前注册，加载或重定向期间关窗也不会留下过期占用。
  win.once("closed", () => unregisterPublishWindow(key, win));
}

export function unregisterPublishWindow(partition, win) {
  const windows = windowsByPartition.get(partition);
  if (!windows) return;
  windows.delete(win);
  submissionIdsByWindow.delete(win);
  if (windows.size === 0) {
    windowsByPartition.delete(partition);
    const callbacks = closeCallbacksByPartition.get(partition);
    closeCallbacksByPartition.delete(partition);
    for (const callback of callbacks || []) {
      try { callback(); }
      catch (error) { console.warn("发布窗口关闭后的清理失败:", error?.message || error); }
    }
  }
}

/** Keep temporary upload copies while a platform window needs manual review. */
export function afterPublishWindowClosed(partition, callback) {
  if (!hasOpenPublishWindow(partition)) {
    callback();
    return;
  }
  let callbacks = closeCallbacksByPartition.get(partition);
  if (!callbacks) {
    callbacks = new Set();
    closeCallbacksByPartition.set(partition, callbacks);
  }
  callbacks.add(callback);
}

function hasLiveWindow(partition) {
  const windows = windowsByPartition.get(partition);
  if (!windows) return false;
  for (const win of windows) {
    if (win.isDestroyed()) unregisterPublishWindow(partition, win);
  }
  return (windowsByPartition.get(partition)?.size || 0) > 0;
}

export function hasOpenPublishWindow(partition) {
  return Boolean(partition) && hasLiveWindow(partition);
}

/** Bring a retained review window forward without changing its page or session. */
export function focusOpenPublishWindow(partition, submissionId) {
  if (!partition || !submissionId || !hasLiveWindow(partition)) return false;
  const windows = windowsByPartition.get(partition);
  for (const win of windows || []) {
    if (win.isDestroyed() || submissionIdsByWindow.get(win) !== submissionId) continue;
    if (win.isMinimized?.()) win.restore();
    win.show?.();
    win.focus();
    return true;
  }
  return false;
}

export function hasAnyOpenPublishWindow() {
  for (const partition of windowsByPartition.keys()) {
    if (hasLiveWindow(partition)) return true;
  }
  return false;
}

export function destroyAllPublishWindows() {
  // Worker 退出时不保留页面，也不让站点的 beforeunload 阻塞 Supervisor。
  for (const [partition, windows] of windowsByPartition) {
    for (const win of windows) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch (error) {
        console.warn("关闭发布窗口失败:", error?.message || error);
      } finally {
        unregisterPublishWindow(partition, win);
      }
    }
  }
}

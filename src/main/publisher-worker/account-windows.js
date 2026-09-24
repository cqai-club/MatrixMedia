"use strict";

// 账号后台的编辑页可以由 window.open 或 target=_blank 创建。只允许同平台页面，
// 并让新页签继续使用该账号的 Chromium partition。
const PLATFORM_DOMAINS = {
  "抖音": "douyin.com",
  "视频号": "weixin.qq.com",
  "哔哩哔哩": "bilibili.com",
  "百家号": "baidu.com",
  "头条": "toutiao.com",
  "快手": "kuaishou.com",
  "小红书": "xiaohongshu.com",
  "掘金": "juejin.cn",
  "微信公众号": "weixin.qq.com",
  "番茄视频": "yueduwuxian.com",
};

export function allowsAccountWindowUrl(platform, target) {
  const domain = PLATFORM_DOMAINS[platform];
  if (!domain) return false;
  if (target === "about:blank") return true;
  try {
    const url = new URL(target);
    return url.protocol === "https:" && !url.port &&
      (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function accountWindowOptions(account, devTools) {
  return {
    width: 1200, height: 800, autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { tabbingIdentifier: `publisher-account:${account.partition}` } : {}),
    webPreferences: {
      partition: account.partition,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      devTools,
    },
  };
}

export function attachAccountWindowHandlers(win, account, userAgent, devTools, options = {}) {
  const { BrowserWindow, homeUrl, isPopup = false, onTabCreated } = options;
  const contents = win.webContents;
  const prepareTab = child => {
    attachAccountWindowHandlers(child, account, userAgent, devTools, { ...options, isPopup: true });
    if (onTabCreated) onTabCreated(child);
    if (userAgent) child.webContents.setUserAgent(userAgent);
    if (process.platform === "darwin" && typeof win.addTabbedWindow === "function") {
      try {
        win.addTabbedWindow(child);
      } catch (error) {
        console.warn("[publisher-worker] 账号页签合并失败:", error && error.message);
      }
    }
    if (devTools) child.webContents.openDevTools({ mode: "detach" });
    child.show();
    child.focus();
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowsAccountWindowUrl(account.pt, url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...accountWindowOptions(account, devTools),
        show: false,
      },
    };
  });
  contents.on("did-create-window", prepareTab);
  if (process.platform === "darwin" && BrowserWindow && homeUrl) {
    // 原生页签栏的「+」也打开此账号的后台页，不留下无响应的按钮。
    win.on("new-window-for-tab", () => {
      const child = new BrowserWindow({ ...accountWindowOptions(account, devTools), show: false });
      prepareTab(child);
      void child.loadURL(homeUrl).catch(error => {
        console.warn("[publisher-worker] 账号页签加载失败:", error && error.message);
      });
    });
  }
  if (isPopup) {
    // about:blank 弹窗随后可能由页面脚本跳转；重定向也必须留在同平台。
    const stopExternalNavigation = (event, url) => {
      if (!allowsAccountWindowUrl(account.pt, url)) event.preventDefault();
    };
    contents.on("will-navigate", stopExternalNavigation);
    contents.on("will-redirect", stopExternalNavigation);
  }
}

"use strict";

// Only use account chrome on the logged-in creator page. Content titles and
// arbitrary page text are never accepted as the account name.
const PROFILE_SELECTORS = {
  "抖音": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "视频号": ['[class*="account-info"] [class*="name"]', '[class*="user-info"] [class*="name"]'],
  "小红书": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "哔哩哔哩": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "快手": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "头条": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "百家号": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "番茄视频": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
  "掘金": ['[class*="user-info"] [class*="name"]', '[class*="userInfo"] [class*="name"]'],
};

const GENERIC_NAMES = new Set([
  "登录", "注册", "退出登录", "切换账号", "账号设置", "个人中心", "我的主页",
  "创作者中心", "创作中心", "创作者服务平台", "未登录", "用户昵称",
  "抖音", "视频号", "小红书", "哔哩哔哩", "快手", "头条", "百家号", "番茄视频", "掘金",
]);

export function normalizeAccountName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name || name.length > 100 || GENERIC_NAMES.has(name) || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

export function profileNameScript(platform) {
  const selectors = PROFILE_SELECTORS[platform] || [];
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (element.getClientRects().length === 0) continue;
        const value = element.textContent?.trim();
        if (value && value.length <= 100 && !value.includes('\\n')) return value;
      }
    }
    return null;
  })()`;
}

// The Douyin creator dashboard exposes its own account profile on the same
// origin. It is an undocumented endpoint, so failure simply leaves the name
// editable in e宝 rather than affecting login or publication.
export const DOUYIN_PROFILE_SCRIPT = `(async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/aweme/v1/creator/user/info/', {
      credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.status_code !== 0) return null;
    return data?.douyin_user_verify_info?.nick_name || null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
})()`;

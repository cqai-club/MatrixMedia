"use strict";

// 创作者凭据独立于 customer 站点的 SSO；后者缺失不代表创作者已退出。
export const XHS_CREATOR_COOKIE_NAMES = [
  "access-token-creator.xiaohongshu.com",
  "galaxy_creator_session_id",
  "x-user-id-creator.xiaohongshu.com",
];

const RULES = {
  抖音: [["passport_assist_user"]],
  百家号: [["BDUSS"]],
  头条: [["odin_tt", value => value.length > 65]],
  视频号: [["sessionid"]],
  番茄视频: [["sessionid"]],
  哔哩哔哩: [["SESSDATA"]],
  快手: [["userId"]],
  掘金: [["passport_csrf_token", value => value.length > 10]],
  小红书: XHS_CREATOR_COOKIE_NAMES.map(name => [name]),
};

/** 本机 Cookie 检查，不保证平台服务端尚未撤销凭据。 */
export function checkCookieLogin(pt, cookies, now = Date.now()) {
  const rules = Object.hasOwn(RULES, pt) ? RULES[pt] : null;
  if (!rules) return { loginState: "unknown", expiresAt: null, reason: "未知平台" };
  const hits = [];
  for (const [name, accept = () => true] of rules) {
    const matches = cookies.filter(item => item.name === name
      && typeof item.value === "string" && item.value && accept(item.value));
    // 无 expirationDate 的会话 Cookie 仍可用；跳过过期或异常值，避免同名 Cookie 误判。
    const hit = matches.find(item => item.expirationDate == null
      || (Number.isFinite(item.expirationDate) && item.expirationDate * 1000 > now));
    if (!hit) return { loginState: "logged-out", expiresAt: null,
      reason: matches.length ? "登录 cookie 已过期或有效期异常" : "缺少登录 cookie" };
    hits.push(hit);
  }
  const expiries = hits.filter(item => item.expirationDate != null)
    .map(item => Math.floor(item.expirationDate * 1000));
  return { loginState: "logged-in", expiresAt: expiries.length ? Math.min(...expiries) : null, reason: "" };
}

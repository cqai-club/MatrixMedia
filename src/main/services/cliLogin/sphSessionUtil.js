"use strict";

import { session } from "electron";
import { checkCookieLogin } from "../accountLoginState.js";

export const SPH_ORIGIN = "https://channels.weixin.qq.com";

/**
 * 视频号 partition 不做特殊裁剪，直接使用原值。
 */
export function normalizeSphPartition(partition) {
  return String(partition || "");
}

/**
 * 获取当前 sessionid 值（可能为 null）。
 */
export async function getSphSessionId(partition) {
  const part = normalizeSphPartition(partition);
  const ses = session.fromPartition(part);
  const cookies = await ses.cookies.get({ url: SPH_ORIGIN });
  const c = cookies.find(c => checkCookieLogin("视频号", [c]).loginState === "logged-in");
  return c ? c.value : null;
}

/**
 * 判断视频号是否已登录：检查 sessionid Cookie。
 */
export async function hasSphSession(partition) {
  return !!(await getSphSessionId(partition));
}

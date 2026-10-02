"use strict";

import { session } from "electron";
import { checkCookieLogin } from "../accountLoginState.js";

export const CREATOR_ORIGIN = "https://creator.douyin.com";

export function normalizeDouyinPartition(partition) {
  return String(partition || "");
}

export async function hasDouyinSession(partition) {
  const part = normalizeDouyinPartition(partition);
  const ses = session.fromPartition(part);
  const cookies = await ses.cookies.get({ url: CREATOR_ORIGIN });
  return checkCookieLogin("抖音", cookies).loginState === "logged-in";
}

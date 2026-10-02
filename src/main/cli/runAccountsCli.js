"use strict";

import path from "path";
import fs from "fs";
import { app, session } from "electron";
import ptConfig from "../config/ptConfig";
import { checkCookieLogin } from "../services/accountLoginState.js";

function getAccountsDir() {
  const documents = app.getPath("documents");
  return path.join(documents, "MatrixMedia", "data", "account");
}

function readAccounts() {
  const dir = getAccountsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const seen = new Map();
  for (const f of files) {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || !item.phone || !item.pt) continue;
      const key = `${item.phone}__${item.pt}`;
      const prev = seen.get(key);
      if (!prev || (item.createTime || 0) > (prev.createTime || 0)) {
        seen.set(key, item);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.phone !== b.phone) return String(a.phone).localeCompare(String(b.phone));
    return String(a.pt).localeCompare(String(b.pt));
  });
}

async function probeLogin(account) {
  const partition = account.partition || `persist:${String(account.phone).split("-")[0]}${account.pt}`;
  const cfg = ptConfig[account.pt];
  const probeUrl = account.url || (cfg && (cfg.listIndex || cfg.upload || cfg.index));
  if (!probeUrl) {
    return { loggedIn: false, loginState: "unknown", reason: "缺少探测 URL", expireMs: null };
  }
  try {
    const ses = session.fromPartition(partition);
    const cookies = await ses.cookies.get({ url: probeUrl });
    const state = checkCookieLogin(account.pt, cookies);
    return { loggedIn: state.loginState === "logged-in", loginState: state.loginState,
      reason: state.reason, expireMs: state.expiresAt };
  } catch (e) {
    return { loggedIn: false, loginState: "unknown", reason: "登录状态查询失败，请重试", expireMs: null };
  }
}

function formatExpire(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function runAccountsCli(options) {
  const accounts = readAccounts();
  const filtered = accounts.filter(a => {
    if (options.platform && a.pt !== options.platform) return false;
    if (options.phone && String(a.phone) !== String(options.phone)) return false;
    return true;
  });

  const rows = [];
  for (const a of filtered) {
    const probe = await probeLogin(a);
    if (options.onlyLoggedIn && !probe.loggedIn) continue;
    if (options.onlyLoggedOut && probe.loginState !== "logged-out") continue;
    rows.push({
      phone: a.phone,
      pt: a.pt,
      partition: a.partition || `persist:${String(a.phone).split("-")[0]}${a.pt}`,
      loggedIn: probe.loggedIn,
      loginState: probe.loginState,
      reason: probe.reason,
      expireAt: probe.expireMs,
      createdAt: a.createTime || null,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log("（无匹配账号）数据目录：" + getAccountsDir());
    return 0;
  }

  const header = ["账号", "平台", "登录态", "失效时间", "说明"];
  const lines = rows.map(r => [
    String(r.phone),
    r.pt,
    r.loginState === "unknown" ? "状态未知" : r.loggedIn ? "已登录" : "未登录",
    formatExpire(r.expireAt),
    r.loggedIn ? "-" : r.reason || "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...lines.map(row => displayWidth(row[i])))
  );
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - displayWidth(s)));
  const render = row => row.map((c, i) => pad(c, widths[i])).join("  ");
  console.log(render(header));
  console.log(widths.map(w => "-".repeat(w)).join("  "));
  lines.forEach(r => console.log(render(r)));
  const ok = rows.filter(r => r.loggedIn).length;
  const unknown = rows.filter(r => r.loginState === "unknown").length;
  console.log(`\n共 ${rows.length} 个账号，已登录 ${ok}，未登录 ${rows.length - ok - unknown}，状态未知 ${unknown}`);
  return 0;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return w;
}

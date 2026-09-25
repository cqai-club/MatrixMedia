"use strict";

import { app, BrowserWindow, safeStorage, session } from "electron";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import ptConfig from "../config/ptConfig";
import { applyAccountProxyToSession } from "../services/proxyConfig.js";
import { hasOpenPublishWindow } from "../services/publishWindowRegistry.js";
import { PublisherProtocolError } from "./protocol.js";
import { publicAccount } from "./store.js";
import { publisherUserAgent } from "./userAgent.js";
import { accountWindowOptions, attachAccountWindowHandlers, allowsAccountWindowUrl } from "./account-windows.js";
import { DOUYIN_PROFILE_SCRIPT, normalizeAccountName, profileNameScript } from "./account-name.js";
import { WechatOfficialClient } from "./wechat-official.js";

export const PLATFORM_TO_PT = {
  dy: "抖音", sph: "视频号", xhs: "小红书", blbl: "哔哩哔哩",
  ks: "快手", tt: "头条", bjh: "百家号", fqsp: "番茄视频", juejin: "掘金", wxmp: "微信公众号",
};
const PT_TO_PLATFORM = Object.fromEntries(Object.entries(PLATFORM_TO_PT).map(([key, value]) => [value, key]));

const LOGIN_RULES = {
  抖音: cookies => cookie(cookies, "passport_assist_user"),
  百家号: cookies => cookie(cookies, "BDUSS"),
  头条: cookies => cookie(cookies, "odin_tt", value => value.length > 65),
  视频号: cookies => cookie(cookies, "sessionid"),
  番茄视频: cookies => cookie(cookies, "sessionid"),
  哔哩哔哩: cookies => cookie(cookies, "SESSDATA"),
  快手: cookies => cookie(cookies, "userId"),
  掘金: cookies => cookie(cookies, "passport_csrf_token", value => value.length > 10),
  小红书: cookies => {
    const names = [
      "access-token-creator.xiaohongshu.com", "customer-sso-sid",
      "galaxy_creator_session_id", "x-user-id-creator.xiaohongshu.com",
    ];
    // Keep MatrixMedia's existing login rule: every creator cookie must carry
    // a real expiry so a stale/session-only partial login is not accepted.
    const hits = names.map(name => cookies.find(item =>
      item.name === name && item.value && Number.isFinite(item.expirationDate)
    ));
    if (hits.some(item => !item)) return null;
    return hits.reduce((earliest, item) => {
      if (!earliest || !item.expirationDate) return earliest || item;
      return item.expirationDate < earliest.expirationDate ? item : earliest;
    }, null);
  },
};

function cookie(cookies, name, accept = () => true) {
  return cookies.find(item => item.name === name && item.value && accept(item.value));
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new PublisherProtocolError("invalid-account", `${label}不能为空`);
  return text;
}

function accountFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(file => file.endsWith(".json")).sort();
}

function legacyPartition(item) {
  return item.partition || `persist:${String(item.phone).split("-")[0]}${item.pt}`;
}

function readLegacyAccounts(directory) {
  const rows = [];
  for (const file of accountFiles(directory)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch { /* malformed legacy buckets are skipped */ }
  }
  const unique = new Map();
  for (const item of rows) {
    if (!item || !item.phone || !PT_TO_PLATFORM[item.pt]) continue;
    const platform = PT_TO_PLATFORM[item.pt];
    const partition = legacyPartition(item);
    // Newer daily account buckets override older duplicate snapshots.
    unique.set(`${platform}\0${partition}`, item);
  }
  return [...unique.values()];
}

function runningFromSingletonLock(profile) {
  const lock = path.join(profile, "SingletonLock");
  try {
    const value = fs.readlinkSync(lock);
    const match = /-(\d+)$/u.exec(value);
    if (!match) return false;
    process.kill(Number(match[1]), 0);
    return true;
  } catch { return false; }
}

export class PublisherAccounts {
  constructor(store, busy) {
    this.store = store;
    this.busy = busy;
    this.windows = new Map();
    this.wechat = new WechatOfficialClient();
  }

  list() { return this.store.listAccounts(); }

  create(params) {
    const platform = requiredText(params.platform, "平台");
    const pt = PLATFORM_TO_PT[platform];
    if (!pt) throw new PublisherProtocolError("unsupported-platform", `不支持的平台：${platform}`);
    if (params.displayName !== undefined && typeof params.displayName !== "string") {
      throw new PublisherProtocolError("invalid-account", "账号名称格式无效");
    }
    const requestedName = (params.displayName || "").trim();
    if (requestedName.length > 100) throw new PublisherProtocolError("invalid-account", "账号名称不能超过 100 个字符");
    const displayName = platform === "wxmp" ? requiredText(requestedName, "账号名称") : requestedName || `待识别的${pt}账号`;
    if (platform === "wxmp") {
      const appId = requiredText(params.appId, "公众号 AppID");
      const appSecret = requiredText(params.appSecret, "公众号 AppSecret");
      if (!/^wx[a-z0-9]{16}$/iu.test(appId) || !/^[a-z0-9]{32}$/iu.test(appSecret)) {
        throw new PublisherProtocolError("invalid-account", "公众号 AppID 或 AppSecret 格式无效");
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new PublisherProtocolError("secure-storage-unavailable", "本机安全存储不可用，无法保存公众号密钥");
      }
      const credentialCiphertext = safeStorage.encryptString(appSecret).toString("base64");
      return publicAccount(this.store.addAccount({ id: randomUUID(), displayName, platform, pt, appId, credentialCiphertext }));
    }
    if (params.appId !== undefined || params.appSecret !== undefined) {
      throw new PublisherProtocolError("invalid-account", "此平台不接受公众号密钥");
    }
    return publicAccount(this.store.addAccount({ id: randomUUID(), displayName, platform, pt, autoName: !requestedName }));
  }

  wechatCredentials(id) {
    const account = this.require(id);
    if (account.platform !== "wxmp" || !account.appId || !account.credentialCiphertext || !safeStorage.isEncryptionAvailable()) {
      throw new PublisherProtocolError("account-login-required", "公众号密钥不可用，请删除账号后重新添加");
    }
    try {
      return { appId: account.appId, appSecret: safeStorage.decryptString(Buffer.from(account.credentialCiphertext, "base64")) };
    } catch {
      throw new PublisherProtocolError("account-login-required", "公众号密钥无法解密，请删除账号后重新添加");
    }
  }

  update(params) {
    const account = this.require(params.id);
    const displayName = requiredText(params.displayName, "账号名称");
    return publicAccount(this.store.updateAccount(account.id, { displayName, autoName: false }));
  }

  async remove(params) {
    const account = this.require(params.id);
    this.assertIdle(account.id);
    if (account.platform === "wxmp") this.wechat.forget(account.appId);
    const win = this.windows.get(account.partition);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(account.partition);
    const ses = session.fromPartition(account.partition);
    await Promise.allSettled([ses.clearCache(), ses.clearStorageData()]);
    this.store.deleteAccount(account.id);
    return { ok: true };
  }

  async check(params) {
    const account = this.require(params.id);
    if (account.platform === "wxmp") {
      try {
        await this.wechat.token(this.wechatCredentials(account.id));
        return publicAccount(this.store.updateAccount(account.id, { loginState: "logged-in", expiresAt: undefined, loginError: undefined }));
      } catch (error) {
        const loginError = error instanceof PublisherProtocolError
          ? error.message
          : "公众号接口检查失败，请重试";
        return publicAccount(this.store.updateAccount(account.id, { loginState: "logged-out", expiresAt: undefined, loginError }));
      }
    }
    const cfg = ptConfig[account.pt];
    const ses = session.fromPartition(account.partition);
    try {
      const cookies = await ses.cookies.get({ url: cfg.listIndex || cfg.index });
      const hit = LOGIN_RULES[account.pt] && LOGIN_RULES[account.pt](cookies);
      const expiresAt = hit && hit.expirationDate ? Math.floor(hit.expirationDate * 1000) : undefined;
      const loggedIn = Boolean(hit && (!expiresAt || expiresAt > Date.now()));
      const patch = {
        loginState: loggedIn ? "logged-in" : "logged-out",
        ...(expiresAt ? { expiresAt } : { expiresAt: undefined }),
      };
      if (loggedIn && account.autoName) {
        const detectedName = await this.detectName(account);
        // A manual rename or deletion may have happened while the page was read.
        if (detectedName && this.store.account(account.id)?.autoName) {
          patch.displayName = detectedName;
          patch.autoName = false;
        }
      }
      const current = this.store.account(account.id);
      if (!current) throw new PublisherProtocolError("account-not-found", "账号不存在或已删除");
      return publicAccount(this.store.updateAccount(account.id, patch));
    } catch {
      if (!this.store.account(account.id)) throw new PublisherProtocolError("account-not-found", "账号不存在或已删除");
      return publicAccount(this.store.updateAccount(account.id, { loginState: "unknown", expiresAt: undefined }));
    }
  }

  async detectName(account) {
    const win = this.windows.get(account.partition);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    const url = win.webContents.getURL();
    if (!allowsAccountWindowUrl(account.pt, url) || !url.startsWith("https://")) return null;
    try {
      if (account.platform === "dy" && new URL(url).hostname === "creator.douyin.com") {
        const name = normalizeAccountName(await win.webContents.executeJavaScript(DOUYIN_PROFILE_SCRIPT));
        if (name) return name;
      }
      return normalizeAccountName(await win.webContents.executeJavaScript(profileNameScript(account.pt)));
    } catch { return null; }
  }

  async openLogin(params) {
    const account = this.require(params.id);
    this.assertIdle(account.id);
    if (account.platform === "wxmp") throw new PublisherProtocolError("unsupported-operation", "公众号使用 AppID 和 AppSecret 授权，请检查接口状态");
    return this.open(account, ptConfig[account.pt].index, `登录 ${account.displayName}`);
  }

  async openDashboard(params) {
    const account = this.require(params.id);
    this.assertIdle(account.id);
    const cfg = ptConfig[account.pt];
    return this.open(account, cfg.listIndex || cfg.index, `${account.displayName} · ${account.pt}`);
  }

  async open(account, url, title) {
    for (const [partition, win] of this.windows) {
      if (win.isDestroyed()) this.windows.delete(partition);
    }
    const existing = this.windows.get(account.partition);
    if (existing && !existing.isDestroyed()) {
      // Login and dashboard intentionally share one account window/session.
      // Reusing the window must still navigate to the action the user chose.
      let navigationFailed = false;
      if (existing.webContents.getURL() !== url) {
        try {
          await existing.loadURL(url);
        } catch (error) {
          navigationFailed = true;
          console.warn("[publisher-worker] 账号窗口导航失败:", error && error.message);
        }
      }
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { ok: true, reused: true, navigationFailed };
    }
    const ses = session.fromPartition(account.partition);
    await applyAccountProxyToSession({
      electronSession: ses,
      partition: account.partition,
      phone: account.id,
      pt: account.pt,
      proxyOverride: account.proxy,
      preservePartition: true,
    });
    // Another RPC may have accepted a publish while proxy setup yielded.
    // Re-check before creating a window so login/dashboard and upload never
    // share this account session concurrently.
    this.assertIdle(account.id);
    const cfg = ptConfig[account.pt];
    const debugAccountWindow = process.env.EBAO_PUBLISHER_ACCOUNT_DEVTOOLS === "1";
    const win = new BrowserWindow({ ...accountWindowOptions(account, debugAccountWindow), title });
    const tabs = new Set();
    this.windows.set(account.partition, win);
    win.webContents.on("did-finish-load", () => {
      if (this.store.account(account.id)?.autoName) {
        void this.check({ id: account.id }).catch(() => {});
      }
    });
    win.on("closed", () => {
      for (const tab of tabs) if (!tab.isDestroyed()) tab.destroy();
      tabs.clear();
      if (this.windows.get(account.partition) === win) this.windows.delete(account.partition);
    });
    const userAgent = publisherUserAgent(account.pt, cfg.useragent);
    if (userAgent) win.webContents.setUserAgent(userAgent);
    attachAccountWindowHandlers(win, account, userAgent, debugAccountWindow, {
      BrowserWindow, homeUrl: url,
      onTabCreated(tab) {
        tabs.add(tab);
        tab.on("closed", () => tabs.delete(tab));
      },
    });
    if (debugAccountWindow) win.webContents.openDevTools({ mode: "detach" });
    let navigationFailed = false;
    try {
      await win.loadURL(url);
    } catch (error) {
      navigationFailed = true;
      // Creator sites frequently abort the initial navigation while redirecting
      // to their login host. MatrixMedia treats that as a usable open window.
      console.warn("[publisher-worker] 账号窗口加载发生重定向:", error && error.message);
    }
    return { ok: true, reused: false, navigationFailed };
  }

  legacyImportSource() {
    const sourceData = path.join(app.getPath("documents"), "MatrixMedia", "data", "account");
    const sourceProfile = path.join(app.getPath("appData"), "matrix-video");
    const rows = readLegacyAccounts(sourceData);
    return {
      sourceData,
      sourceProfile,
      running: runningFromSingletonLock(sourceProfile),
      accounts: rows.map(item => ({ displayName: String(item.phone), platform: PT_TO_PLATFORM[item.pt], platformName: item.pt })),
    };
  }

  importPreview() {
    const { running, accounts } = this.legacyImportSource();
    return { running, accounts };
  }

  importApply() {
    if (this.busy()) {
      throw new PublisherProtocolError("publisher-busy", "仍有发布任务排队或执行中，请稍后再导入账号");
    }
    const preview = this.legacyImportSource();
    if (preview.running) throw new PublisherProtocolError("matrixmedia-running", "请先完全退出独立 MatrixMedia，再重新导入");
    const rows = readLegacyAccounts(preview.sourceData);
    const imported = [];
    const destinationPartitions = path.join(app.getPath("userData"), "Partitions");
    const stagingRoot = path.join(app.getPath("userData"), `.publisher-import-${randomUUID()}`);
    fs.mkdirSync(stagingRoot, { recursive: true });
    try {
      const prepared = rows.map(item => {
        const platform = PT_TO_PLATFORM[item.pt];
        const partition = legacyPartition(item);
        const existing = this.store.findImported(platform, partition);
        if (existing) return { item, platform, partition, existing };
        const suffix = partition.replace(/^persist:/u, "");
        if (!suffix || suffix.includes("/") || suffix.includes("\\") || suffix.includes("..")) {
          throw new PublisherProtocolError("invalid-import", "旧账号包含无效的 session partition");
        }
        const source = path.join(preview.sourceProfile, "Partitions", suffix);
        const staged = path.join(stagingRoot, suffix);
        if (fs.existsSync(source)) fs.cpSync(source, staged, { recursive: true, errorOnExist: true });
        return { item, platform, partition, suffix, staged, hasSession: fs.existsSync(staged) };
      });
      fs.mkdirSync(destinationPartitions, { recursive: true });
      const installed = [];
      const added = [];
      try {
        for (const entry of prepared) {
          if (entry.existing) { imported.push(publicAccount(entry.existing)); continue; }
          if (entry.hasSession) {
            const destination = path.join(destinationPartitions, entry.suffix);
            if (!fs.existsSync(destination)) {
              fs.renameSync(entry.staged, destination);
              installed.push(destination);
            }
          }
          const account = this.store.addAccount({
            displayName: String(entry.item.phone), platform: entry.platform, pt: entry.item.pt,
            partition: entry.partition, importedFrom: "MatrixMedia", proxy: entry.item.proxy,
            loginState: "unknown",
          });
          added.push(account.id);
          imported.push(publicAccount(account));
        }
      } catch (error) {
        for (const id of added.reverse()) this.store.deleteAccount(id);
        for (const destination of installed.reverse()) fs.rmSync(destination, { recursive: true, force: true });
        throw error;
      }
      return { imported };
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  require(id) {
    const account = this.store.account(requiredText(id, "账号 ID"));
    if (!account) throw new PublisherProtocolError("account-not-found", "账号不存在或已删除");
    return account;
  }

  assertIdle(id) {
    if (this.busy(id)) throw new PublisherProtocolError("account-busy", "当前账号正在提交内容，请稍后再试");
    const account = this.require(id);
    if (hasOpenPublishWindow(account.partition)) {
      throw new PublisherProtocolError("account-window-open", "该账号的发布窗口仍在打开，请核查内容并关闭窗口后再操作");
    }
  }

  assertNoOpenWindow(id) {
    const account = this.require(id);
    if (hasOpenPublishWindow(account.partition)) {
      throw new PublisherProtocolError("account-window-open", "该账号的发布窗口仍在打开，请核查内容并关闭窗口后再提交");
    }
    const win = this.windows.get(account.partition);
    if (win && win.isDestroyed()) this.windows.delete(account.partition);
    else if (win) {
      throw new PublisherProtocolError("account-window-open", "请先关闭该账号的登录页或平台后台，再提交发布");
    }
  }

  dispose() {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
  }
}

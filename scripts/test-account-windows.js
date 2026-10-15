"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { transformSync } = require("@babel/core");

class FakeWebContents extends EventEmitter {
  getURL() { return this.url || ""; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  setUserAgent(value) { this.userAgent = value; }
  openDevTools(options) { this.devTools = options; }
}

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.tabs = [];
    this.calls = [];
    this.shown = false;
    this.focused = false;
    this.minimized = false;
    this.destroyed = false;
  }
  addTabbedWindow(child) { this.tabs.push(child); }
  loadURL(url) {
    this.calls.push("load");
    this.visibleWhenLoading = this.shown;
    this.loadedUrl = url;
    return this.navigation || Promise.resolve();
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.shown; }
  restore() { this.calls.push("restore"); this.minimized = false; }
  show() {
    this.calls.push("show");
    if (this.neverShow) return;
    if (this.ignoreFirstShow) { this.ignoreFirstShow = false; return; }
    this.shown = true;
  }
  focus() { this.calls.push("focus"); if (this.shown && !this.minimized) this.focused = true; }
}

(async () => {
  const root = path.join(__dirname, "..");
  const accountWindows =
    await import(pathToFileURL(path.join(root, "src/main/publisher-worker/account-windows.js")));
  const { accountWindowOptions, allowsAccountWindowUrl, attachAccountWindowHandlers, revealAccountWindow } = accountWindows;
  const { default: ptConfig } = await import(pathToFileURL(path.join(root, "src/main/config/ptConfig.js")));

  const hidden = new FakeWindow();
  hidden.focus();
  assert.strictEqual(hidden.focused, false, "focus alone must not reveal a hidden window");
  hidden.calls = [];
  hidden.ignoreFirstShow = true;
  assert.strictEqual(revealAccountWindow(hidden), true);
  assert.strictEqual(hidden.shown, true);
  assert.strictEqual(hidden.focused, true);
  assert.deepStrictEqual(hidden.calls, ["show", "show", "focus"]);

  const minimized = new FakeWindow();
  minimized.minimized = true;
  assert.strictEqual(revealAccountWindow(minimized), true);
  assert.strictEqual(minimized.minimized, false);
  assert.strictEqual(minimized.shown, true);
  assert.strictEqual(minimized.focused, true);
  assert.deepStrictEqual(minimized.calls, ["restore", "show", "focus"]);

  const destroyed = new FakeWindow();
  destroyed.destroyed = true;
  assert.strictEqual(revealAccountWindow(destroyed), false);
  assert.deepStrictEqual(destroyed.calls, []);

  const invisible = new FakeWindow();
  invisible.neverShow = true;
  assert.strictEqual(revealAccountWindow(invisible), false);
  assert.strictEqual(invisible.focused, false);

  // 执行真实 accounts.open 分支，仅替换 Electron 与外部服务，保持测试无 GUI。
  const accountsCode = transformSync(fs.readFileSync(path.join(root, "src/main/publisher-worker/accounts.js"), "utf8"), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
  }).code;
  for (const reused of [false, true]) {
    for (const scenario of ["pending", "rejected", "invisible"]) {
      const rejected = scenario === "rejected";
      let completeNavigation;
      const navigation = new Promise((resolve, reject) => { completeNavigation = rejected ? reject : resolve; });
      const windows = [];
      class LoginWindow extends FakeWindow {
        constructor(options) {
          super(options);
          this.navigation = navigation;
          this.ignoreFirstShow = true;
          this.neverShow = scenario === "invisible";
          windows.push(this);
        }
      }
      const loginAccount = { id: "test-account", platform: "xhs", pt: "小红书", partition: "persist:login-test" };
      const mocks = {
        electron: { BrowserWindow: LoginWindow, session: { fromPartition: () => ({}) } },
        fs, path, crypto: require("crypto"),
        "../config/ptConfig": ptConfig,
        "../services/proxyConfig.js": { applyAccountProxyToSession: async () => {} },
        "../services/publishWindowRegistry.js": { hasOpenPublishWindow: () => false },
        "./protocol.js": { PublisherProtocolError: class extends Error {
          constructor(code, message) { super(message); this.code = code; }
        } },
        "./store.js": { publicAccount: value => value },
        "./userAgent.js": { publisherUserAgent: () => undefined },
        "./account-windows.js": accountWindows,
        "./account-name.js": {},
        "./wechat-official.js": { WechatOfficialClient: class {} },
        "../services/accountLoginState.js": {},
      };
      const module = { exports: {} };
      vm.runInNewContext(`(function(require, module, exports) { ${accountsCode}\n })`, {
        process, console: { warn() {} },
      })(name => {
        if (!Object.hasOwn(mocks, name)) throw new Error(`Unexpected account dependency: ${name}`);
        return mocks[name];
      }, module, module.exports);
      const accounts = new module.exports.PublisherAccounts({ account: () => loginAccount }, () => false);
      if (reused) {
        const existing = new LoginWindow();
        existing.minimized = true;
        accounts.windows.set(loginAccount.partition, existing);
      }
      const opening = accounts.open(loginAccount, "https://creator.xiaohongshu.com/", "登录测试");
      let settled = false;
      opening.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      const loginWindow = windows[0];
      assert.strictEqual(windows.length, 1);
      if (scenario === "invisible") {
        await assert.rejects(opening, error => error.code === "account-window-not-visible");
        assert.strictEqual(loginWindow.shown, false);
        assert.strictEqual(loginWindow.loadedUrl, undefined);
        assert.strictEqual(accounts.windows.get(loginAccount.partition), loginWindow);
        continue;
      }
      assert.strictEqual(loginWindow.shown, true, `reused=${reused}: window must show before navigation finishes`);
      assert.strictEqual(loginWindow.focused, true);
      assert.strictEqual(loginWindow.minimized, false);
      assert.strictEqual(loginWindow.visibleWhenLoading, true);
      assert.strictEqual(settled, false, "navigation is still pending while the login window is visible");
      completeNavigation(rejected ? new Error("ERR_ABORTED") : undefined);
      const result = await opening;
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.reused, reused);
      assert.strictEqual(result.navigationFailed, rejected);
      assert.strictEqual(loginWindow.shown, true, "a failed navigation must not hide the login window");
    }
  }

  for (const [platform, config] of Object.entries(ptConfig)) {
    for (const target of [config.index, config.listIndex, config.upload].filter(Boolean)) {
      assert.strictEqual(allowsAccountWindowUrl(platform, target), true, `${platform}: ${target}`);
    }
    assert.strictEqual(allowsAccountWindowUrl(platform, "about:blank"), true, platform);
    assert.strictEqual(allowsAccountWindowUrl(platform, "https://outside.example/edit"), false, platform);
  }
  assert.strictEqual(allowsAccountWindowUrl("unknown", "about:blank"), false);
  for (const target of [
    "http://mp.weixin.qq.com/edit",
    "https://mp.weixin.qq.com.evil.example/edit",
    "https://mp.weixin.qq.com:8443/edit",
    "https://creator.douyin.com/edit",
    "javascript:alert(1)",
    "file:///tmp/edit.html",
    "data:text/html,hello",
    "not a url",
  ]) {
    assert.strictEqual(allowsAccountWindowUrl("微信公众号", target), false, target);
  }

  const account = { pt: "微信公众号", partition: "persist:account-one" };
  const rootWindow = new FakeWindow();
  const createdTabs = [];
  attachAccountWindowHandlers(rootWindow, account, "test-agent", true, {
    BrowserWindow: FakeWindow, homeUrl: "https://mp.weixin.qq.com/",
    onTabCreated(tab) { createdTabs.push(tab); },
  });
  const popup = rootWindow.webContents.openHandler({ url: "https://mp.weixin.qq.com/editor" });
  assert.strictEqual(popup.action, "allow");
  assert.strictEqual(popup.overrideBrowserWindowOptions.show, false);
  assert.strictEqual(popup.overrideBrowserWindowOptions.webPreferences.partition, account.partition);
  assert.strictEqual(popup.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.strictEqual(popup.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  if (process.platform === "darwin") {
    assert.strictEqual(accountWindowOptions(account, true).tabbingIdentifier,
      popup.overrideBrowserWindowOptions.tabbingIdentifier);
  }
  assert.strictEqual(rootWindow.webContents.openHandler({ url: "about:blank" }).action, "allow");
  assert.strictEqual(rootWindow.webContents.openHandler({ url: "https://outside.example" }).action, "deny");
  assert.strictEqual(rootWindow.webContents.listenerCount("will-navigate"), 0);

  const child = new FakeWindow();
  rootWindow.webContents.emit("did-create-window", child);
  assert.strictEqual(child.shown, true);
  assert.strictEqual(child.focused, true);
  assert.strictEqual(child.webContents.userAgent, "test-agent");
  assert.deepStrictEqual(child.webContents.devTools, { mode: "detach" });
  assert.strictEqual(rootWindow.tabs.includes(child), process.platform === "darwin");
  assert.deepStrictEqual(createdTabs, [child]);
  assert.strictEqual(child.webContents.openHandler({ url: "https://mp.weixin.qq.com/editor/next" }).action, "allow");
  if (process.platform === "darwin") {
    rootWindow.emit("new-window-for-tab");
    assert.strictEqual(rootWindow.tabs.length, 2);
    assert.strictEqual(rootWindow.tabs[1].loadedUrl, "https://mp.weixin.qq.com/");
    assert.deepStrictEqual(createdTabs, rootWindow.tabs);
  }
  for (const eventName of ["will-navigate", "will-redirect"]) {
    let blocked = false;
    child.webContents.emit(eventName, { preventDefault() { blocked = true; } }, "https://outside.example");
    assert.strictEqual(blocked, true, eventName);
    blocked = false;
    child.webContents.emit(eventName, { preventDefault() { blocked = true; } }, "https://mp.weixin.qq.com/editor");
    assert.strictEqual(blocked, false, eventName);
  }
  console.log("test-account-windows passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

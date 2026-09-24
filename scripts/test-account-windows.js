"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");
const path = require("path");

class FakeWebContents extends EventEmitter {
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
  }
  addTabbedWindow(child) { this.tabs.push(child); }
  loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
  show() { this.shown = true; }
  focus() { this.focused = true; }
}

(async () => {
  const root = path.join(__dirname, "..");
  const { accountWindowOptions, allowsAccountWindowUrl, attachAccountWindowHandlers } =
    await import(pathToFileURL(path.join(root, "src/main/publisher-worker/account-windows.js")));
  const { default: ptConfig } = await import(pathToFileURL(path.join(root, "src/main/config/ptConfig.js")));

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

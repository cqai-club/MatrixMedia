"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { build } = require("esbuild");

async function main() {
  const root = path.join(__dirname, "..");
  const { checkCookieLogin, XHS_CREATOR_COOKIE_NAMES } = await import(pathToFileURL(
    path.join(root, "src/main/services/accountLoginState.js")));
  const now = Date.now();
  const future = Math.floor(now / 1000) + 3600;
  const expired = Math.floor(now / 1000) - 3600;
  const creator = XHS_CREATOR_COOKIE_NAMES.map(name => ({ name, value: "fixture", expirationDate: future }));
  const samples = [
    ["小红书", creator],
    ["抖音", [{ name: "passport_assist_user", value: "fixture" }]],
    ["百家号", [{ name: "BDUSS", value: "fixture" }]],
    ["头条", [{ name: "odin_tt", value: "x".repeat(66) }]],
    ["视频号", [{ name: "sessionid", value: "fixture" }]],
    ["番茄视频", [{ name: "sessionid", value: "fixture" }]],
    ["哔哩哔哩", [{ name: "SESSDATA", value: "fixture" }]],
    ["快手", [{ name: "userId", value: "fixture" }]],
    ["掘金", [{ name: "passport_csrf_token", value: "x".repeat(11) }]],
  ];
  for (const [pt, cookies] of samples) {
    assert.strictEqual(checkCookieLogin(pt, cookies, now).loginState, "logged-in", pt);
    assert.strictEqual(checkCookieLogin(pt, [], now).loginState, "logged-out", pt);
    assert.strictEqual(checkCookieLogin(pt, cookies.map(c => ({ ...c, value: "" })), now).loginState, "logged-out", pt);
    for (const bad of [expired, 0, NaN, Infinity]) {
      assert.strictEqual(checkCookieLogin(pt, cookies.map(c => ({ ...c, expirationDate: bad })), now).loginState, "logged-out", pt);
    }
    assert.strictEqual(checkCookieLogin(pt, cookies.map(({ expirationDate, ...c }) => c), now).loginState, "logged-in", pt);
    assert.strictEqual(checkCookieLogin(pt, cookies.map(({ expirationDate, ...c }) => c), now).expiresAt, null, pt);
    assert.strictEqual(checkCookieLogin(pt, [
      ...cookies.map(c => ({ ...c, expirationDate: expired })), ...cookies,
    ], now).loginState, "logged-in", pt);
  }
  assert.strictEqual(checkCookieLogin("未知平台", [], now).loginState, "unknown");
  assert.strictEqual(checkCookieLogin("头条", [{ name: "odin_tt", value: "short" }], now).loginState, "logged-out");
  assert.strictEqual(checkCookieLogin("掘金", [{ name: "passport_csrf_token", value: "short" }], now).loginState, "logged-out");
  for (const required of XHS_CREATOR_COOKIE_NAMES) {
    assert.strictEqual(checkCookieLogin("小红书", creator.filter(c => c.name !== required), now).loginState, "logged-out");
  }
  assert.strictEqual(checkCookieLogin("小红书", [...creator,
    { name: "customer-sso-sid", value: "fixture", expirationDate: expired }], now).expiresAt, future * 1000);
  assert.strictEqual(checkCookieLogin("小红书", creator.map((c, i) => ({ ...c, expirationDate: future + i })), now).expiresAt, future * 1000);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "account-login-test-"));
  const output = path.join(temporary, "entry.cjs");
  const stubs = new Map([
    ["electron", `export const session = { fromPartition(partition) {
      globalThis.__loginFixture.partitions.push(partition);
      return { cookies: { get: async () => {
        if (globalThis.__loginFixture.fail) throw new Error('fixture read failure');
        return globalThis.__loginFixture.cookies;
      } } };
    } }; export const app = { getPath: () => globalThis.__loginFixture.documents };
    export const ipcMain = { on: (_channel, handler) => { globalThis.__loginFixture.handler = handler; } };
    export const safeStorage = {}; export class BrowserWindow {}`],
    ["../services/proxyConfig.js", "export const applyAccountProxyToSession = async () => {};"],
    ["../services/publishWindowRegistry.js", "export const hasOpenPublishWindow = () => false;"],
    ["./wechat-official.js", "export class WechatOfficialClient {}"],
  ]);
  const originalLog = console.log;
  try {
    await build({ stdin: { contents: `
      export { PublisherAccounts } from './src/main/publisher-worker/accounts.js';
      export { PublisherProtocolError } from './src/main/publisher-worker/protocol.js';
      export { default as registerCookieHandler } from './src/main/services/getCookie.js';
      export { runAccountsCli } from './src/main/cli/runAccountsCli.js';
      export { exportXhsCookies } from './src/main/services/upLoad/xhsCookieBridge.js';
      export { hasDouyinSession, normalizeDouyinPartition } from './src/main/services/cliLogin/douyinSessionUtil.js';
      export { getSphSessionId, normalizeSphPartition } from './src/main/services/cliLogin/sphSessionUtil.js';
    `, resolveDir: root }, outfile: output, bundle: true, platform: "node", format: "cjs",
    plugins: [{ name: "login-stubs", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "stub" } : null);
      builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs.get(args.path), loader: "js" }));
    } }] });
    const tools = require(output);
    const directory = path.join(temporary, "MatrixMedia/data/account");
    fs.mkdirSync(directory, { recursive: true });
    const fixture = globalThis.__loginFixture = { documents: temporary, cookies: creator, partitions: [], fail: false };
    let account = { id: "fixture", platform: "xhs", pt: "小红书", partition: "persist:account-with-hyphens", autoName: false };
    const store = { account: () => account, updateAccount(_id, patch) { account = { ...account, ...patch }; return account; } };
    const accounts = new tools.PublisherAccounts(store, () => false);
    tools.registerCookieHandler();
    const logs = [];
    console.log = value => logs.push(value);
    async function cli(options = {}) {
      logs.length = 0;
      await tools.runAccountsCli({ json: true, ...options });
      return JSON.parse(logs[0]);
    }
    async function gui() {
      let reply;
      await fixture.handler({ reply(_channel, payload) { reply = payload; } }, {
        partition: account.partition, pt: account.pt, url: "https://creator.xiaohongshu.com", name: "fixture-login",
      });
      return reply;
    }
    for (const [pt, cookies] of samples) {
      account.pt = pt;
      fixture.cookies = cookies;
      fs.writeFileSync(path.join(directory, "accounts.json"), JSON.stringify([{ phone: "fixture", pt, partition: account.partition }]));
      assert.strictEqual((await accounts.check({ id: account.id })).loginState, "logged-in", pt);
      assert.strictEqual((await gui()).result.startsWith("fixture-login=true;"), true, pt);
      assert.strictEqual((await cli())[0].loginState, "logged-in", pt);
      fixture.cookies = cookies.map(c => ({ ...c, expirationDate: expired }));
      assert.strictEqual((await accounts.check({ id: account.id })).loginState, "logged-out", pt);
      assert.strictEqual((await gui()).result, "", pt);
      assert.strictEqual((await cli())[0].loggedIn, false, pt);
      fixture.cookies = cookies.map(({ expirationDate, ...c }) => c);
      assert.strictEqual((await accounts.check({ id: account.id })).loginState, "logged-in", pt);
      const sessionReply = await gui();
      assert.strictEqual(sessionReply.loginExpiresAtMs, null, pt);
      assert.ok(!sessionReply.result.includes("expires="), pt);
      assert.strictEqual((await cli())[0].loginState, "logged-in", pt);
      fixture.cookies = [];
      assert.strictEqual((await accounts.check({ id: account.id })).loginState, "logged-out", pt);
      assert.strictEqual((await gui()).result, "", pt);
      assert.strictEqual((await cli())[0].loggedIn, false, pt);
    }
    assert.ok(fixture.partitions.every(partition => partition === account.partition));
    fixture.fail = true;
    assert.strictEqual((await accounts.check({ id: account.id })).loginState, "unknown");
    assert.strictEqual((await cli())[0].loginState, "unknown");
    assert.deepStrictEqual(await cli({ onlyLoggedOut: true }), []);
    fixture.fail = false;
    assert.strictEqual(tools.normalizeDouyinPartition(account.partition), account.partition);
    assert.strictEqual(tools.normalizeSphPartition(account.partition), account.partition);
    fixture.cookies = [{ name: "passport_assist_user", value: "fixture", expirationDate: expired }];
    assert.strictEqual(await tools.hasDouyinSession(account.partition), false);
    fixture.cookies.push({ name: "passport_assist_user", value: "fixture" });
    assert.strictEqual(await tools.hasDouyinSession(account.partition), true);
    fixture.cookies = [{ name: "sessionid", value: "stale", expirationDate: expired },
      { name: "sessionid", value: "active" }];
    assert.strictEqual(await tools.getSphSessionId(account.partition), "active");
    assert.ok(fixture.partitions.every(partition => partition === account.partition));
    fixture.cookies = creator.map(({ expirationDate, ...c }) => c);
    const bridged = await tools.exportXhsCookies(account.partition);
    assert.strictEqual(bridged.length, 3);
    assert.ok(bridged.every(c => !Object.hasOwn(c, "expires")));
    account.platform = "wxmp";
    accounts.wechatCredentials = () => ({});
    for (const code of ["wechat-network-error", "wechat-http-error", "account-login-required"]) {
      accounts.wechat.token = async () => { throw new tools.PublisherProtocolError(code, "fixture error"); };
      assert.strictEqual((await accounts.check({ id: account.id })).loginState,
        code === "account-login-required" ? "logged-out" : "unknown");
    }
    accounts.wechat.token = async () => "fixture token";
    assert.strictEqual((await accounts.check({ id: account.id })).loginState, "logged-in");
    assert.strictEqual(account.loginError, undefined);
  } finally {
    console.log = originalLog;
    delete globalThis.__loginFixture;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-account-login-state passed (9 platforms, Worker/GUI/CLI)");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

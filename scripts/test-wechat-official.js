"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

(async () => {
  const root = path.join(__dirname, "..");
  const { WechatOfficialClient } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/wechat-official.js")));
  const { PublisherStore } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/store.js")));
  const { platformCapabilities } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/capabilities.js")));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-wechat-test-"));
  const assetId = "22222222-2222-4222-8222-222222222222";
  const credentials = { appId: "wx1234567890123456", appSecret: "a".repeat(32) };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  fs.mkdirSync(path.join(temporary, "assets"));
  fs.writeFileSync(path.join(temporary, "assets", assetId), png);
  const manifest = {
    title: "测试文章", summary: "摘要", body: `# 标题\n\n![图](ebao-asset://${assetId})`, tags: [], creativeStatement: "none",
    coverAssetId: assetId, assets: [{ id: assetId, mime: "image/png", bytes: png.length }],
  };
  const requests = [];
  const response = value => ({ ok: true, json: async () => value });
  const mock = async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, options });
    if (pathname === "/cgi-bin/stable_token") return response({ access_token: "token", expires_in: 7200 });
    if (pathname === "/cgi-bin/media/uploadimg") return response({ url: "http://mmbiz.qpic.cn/image.png" });
    if (pathname === "/cgi-bin/material/add_material") return response({ media_id: "cover-id" });
    if (pathname === "/cgi-bin/draft/add") return response({ media_id: "draft-id" });
    if (pathname === "/cgi-bin/draft/get") return response({ news_item: [{ title: "测试文章" }] });
    if (pathname === "/cgi-bin/freepublish/submit") return response({ publish_id: "publish-id" });
    if (pathname === "/cgi-bin/freepublish/get") return response({ publish_status: 0, article_id: "article-id" });
    throw new Error(`Unexpected endpoint ${pathname}`);
  };
  try {
    const client = new WechatOfficialClient(mock);
    const submission = { snapshotDirectory: temporary, mode: "draft" };
    const taggedManifest = { ...manifest, tags: ["AI", "科技"] };
    const draft = await client.submit(credentials, submission, taggedManifest, taggedManifest.body);
    assert.strictEqual(draft.status, "draft");
    assert.deepStrictEqual(requests.map(item => item.pathname), [
      "/cgi-bin/stable_token", "/cgi-bin/media/uploadimg", "/cgi-bin/material/add_material", "/cgi-bin/draft/add", "/cgi-bin/draft/get",
    ]);
    const article = JSON.parse(requests[3].options.body).articles[0];
    assert.strictEqual(article.thumb_media_id, "cover-id");
    assert.strictEqual(article.article_type, "news");
    assert.strictEqual(Object.hasOwn(article, "tags"), false);
    assert.deepStrictEqual(taggedManifest.tags, ["AI", "科技"]);
    assert.match(article.content, /<section style="font-size:16px;line-height:1\.8;/u);
    assert.match(article.content, /<h1 style="font-size:24px;[^"]*">标题<\/h1>/u);
    assert.match(article.content, /https:\/\/mmbiz\.qpic\.cn\/image\.png/u);
    assert.match(article.content, /<img [^>]+style="display:block;/u);
    requests.length = 0;
    const themedManifest = { ...manifest, articleTheme: "editorial", body: `导语。\n\n## 小节\n\n![图](ebao-asset://${assetId})` };
    const themedDraft = await client.submit(credentials, submission, themedManifest, themedManifest.body);
    assert.strictEqual(themedDraft.status, "draft");
    const themedArticle = JSON.parse(requests.find(item => item.pathname === "/cgi-bin/draft/add").options.body).articles[0];
    assert.match(themedArticle.content, /<section style="font-size:16px;line-height:1\.9;letter-spacing:0\.2px;/u);
    assert.match(themedArticle.content, /<p style="margin:0 0 24px;padding:14px 16px;border-left:4px solid #2b7468;/u);
    assert.match(themedArticle.content, /<h2 style="font-size:20px;[^"]*border-left:4px solid #2b7468;/u);
    requests.length = 0;
    await client.submit(credentials, submission, { ...themedManifest, articleTheme: "lapis" }, themedManifest.body);
    const lapisArticle = JSON.parse(requests.find(item => item.pathname === "/cgi-bin/draft/add").options.body).articles[0];
    assert.match(lapisArticle.content, /<h2 style="font-size:20px;[^"]*color:#ffffff;[^"]*background:#4870ac;/u);
    assert.match(lapisArticle.content, /https:\/\/mmbiz\.qpic\.cn\/image\.png/u);
    requests.length = 0;
    const published = await client.submit(credentials, { ...submission, mode: "publish" }, manifest, manifest.body);
    assert.strictEqual(published.status, "success");
    assert.deepStrictEqual(requests.map(item => item.pathname), [
      "/cgi-bin/media/uploadimg", "/cgi-bin/material/add_material", "/cgi-bin/draft/add", "/cgi-bin/freepublish/submit", "/cgi-bin/freepublish/get",
    ]);
    requests.length = 0;
    await client.token({ ...credentials, appSecret: "b".repeat(32) });
    assert.deepStrictEqual(requests.map(item => item.pathname), ["/cgi-bin/stable_token"]);
    client.forget(credentials.appId);
    requests.length = 0;
    await client.token(credentials);
    assert.deepStrictEqual(requests.map(item => item.pathname), ["/cgi-bin/stable_token"]);
    const rejected = new WechatOfficialClient(async () => response({
      errcode: 40164, errmsg: "invalid ip 203.0.113.42 ipv6 ::ffff:203.0.113.42; secret=should-not-leak",
    }));
    await assert.rejects(rejected.token(credentials), error =>
      error.code === "wechat-ip-not-allowed"
      && error.message.includes("40164")
      && error.message.includes("203.0.113.42")
      && !error.message.includes("should-not-leak"));
    const noReplay = new WechatOfficialClient(async (url) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname });
      if (pathname === "/cgi-bin/stable_token") return response({ access_token: "token", expires_in: 7200 });
      if (pathname === "/cgi-bin/media/uploadimg") return response({ url: "http://mmbiz.qpic.cn/image.png" });
      if (pathname === "/cgi-bin/material/add_material") return response({ media_id: "cover-id" });
      if (pathname === "/cgi-bin/draft/add") return response({ media_id: "draft-id" });
      if (pathname === "/cgi-bin/freepublish/submit") throw new Error("timeout");
      throw new Error(`Unexpected endpoint ${pathname}`);
    });
    requests.length = 0;
    const uncertain = await noReplay.submit(credentials, { ...submission, mode: "publish" }, manifest, manifest.body);
    assert.strictEqual(uncertain.status, "unknown");
    assert.strictEqual(requests.filter(item => item.pathname === "/cgi-bin/freepublish/submit").length, 1);
    await assert.rejects(client.submit(credentials, submission, { ...manifest, assets: [{ ...manifest.assets[0], mime: "image/webp" }] }, manifest.body), /仅支持 JPEG 或 PNG/u);
    const store = new PublisherStore(path.join(temporary, "store"));
    const account = store.addAccount({ displayName: "公众号", platform: "wxmp", pt: "微信公众号", appId: credentials.appId, credentialCiphertext: "encrypted" });
    store.updateAccount(account.id, { loginState: "logged-out", loginError: "微信接口拒绝请求（错误码 40164）" });
    assert.strictEqual(store.listAccounts()[0].loginError, "微信接口拒绝请求（错误码 40164）");
    assert.strictEqual(store.listAccounts()[0].appId, undefined);
    assert.strictEqual(store.listAccounts()[0].credentialCiphertext, undefined);
    assert.deepStrictEqual(platformCapabilities().find(item => item.platform === "wxmp").modes.article, ["publish", "draft"]);
    assert.strictEqual(fs.statSync(path.join(temporary, "store", "accounts.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-wechat-official passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");

(async () => {
  const preparation = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/article-preparation.js")));
  const targets = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/target-content.js")));
  const capabilities = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/capabilities.js")));
  const { PublisherStore } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/store.js")));
  const first = "22222222-2222-4222-8222-222222222222";
  const second = "55555555-5555-4555-8555-555555555555";
  const third = "66666666-6666-4666-8666-666666666666";
  const fourth = "77777777-7777-4777-8777-777777777777";
  const assets = [
    { id: first, mime: "image/webp", bytes: 128 },
    { id: second, mime: "image/jpeg", bytes: 10 * 1024 * 1024 },
    { id: third, mime: "image/png", bytes: 128 },
    { id: fourth, mime: "image/png", bytes: 1024 * 1024 },
  ];
  const body = `# 正文\n\n开头 ![保留](ebao-asset://${third}) 和 ![外链](https://example.com/a.png)\n\n`+
    `![WebP](ebao-asset://${first}) ![大图](ebao-asset://${fourth})\n\n`+
    "`![行内代码](https://example.com/code.png)`\n\n```md\n![围栏代码](https://example.com/fence.png)\n<img src='code'>\n```\n"+
    "\n<img src='https://example.com/raw.png'>";
  const original = { title: "标".repeat(70), body, summary: "摘".repeat(125), tags: [],
    assets, coverAssetId: first, platformFields: {} };
  const unchanged = JSON.stringify(original);

  const juejin = preparation.prepareTargetArticle(original, "juejin");
  assert.ok(!juejin.content.body.includes(`![保留](ebao-asset://${third})`));
  assert.ok(!juejin.content.body.includes("![外链]"));
  assert.ok(juejin.content.body.includes("`![行内代码](https://example.com/code.png)`"));
  assert.ok(juejin.content.body.includes("![围栏代码](https://example.com/fence.png)"));
  assert.ok(juejin.content.body.includes("<img src='code'>"));
  assert.ok(!juejin.content.body.includes("raw.png"));
  assert.deepStrictEqual(juejin.content.assets.map(asset => asset.id), [first]);
  assert.strictEqual(juejin.content.platformFields.juejin.category, "前端");
  assert.ok(juejin.messages.some(value => value.includes("默认分类")));
  assert.ok(juejin.messages.some(value => value.includes("非封面素材")));
  const bilibili = preparation.prepareTargetArticle(original, "blbl");
  assert.ok(!bilibili.content.body.includes("![保留]"));
  assert.strictEqual(bilibili.content.platformFields.juejin, undefined);

  const toutiao = preparation.prepareTargetArticle({ ...original, assets: [assets[2]], coverAssetId: first }, "tt");
  assert.strictEqual(toutiao.content.coverAssetId, third);
  assert.ok(toutiao.content.body.includes(`![保留](ebao-asset://${third})`));
  assert.ok(!toutiao.content.body.includes("![外链]"));
  assert.ok(!toutiao.content.body.includes("![WebP]"));
  assert.ok(toutiao.content.body.includes("![围栏代码]"));
  assert.ok(!toutiao.content.body.includes("raw.png"));
  const trickyUrls = preparation.prepareTargetArticle({ ...original, body:
    '前 ![标题](https://example.com/a.png "has ) paren") 中 ![尖括号](<https://example.com/a).png>) 后' }, "juejin");
  assert.strictEqual(trickyUrls.content.body, "前  中  后");
  assert.ok(trickyUrls.messages.some(value => value.includes("2 张正文图片")));
  for (const platform of ["juejin", "blbl", "tt", "bjh"]) {
    const noSelectedAssets = preparation.prepareTargetArticle({ ...original,
      title: "标题", body: "正文", assets: [], coverAssetId: first }, platform);
    assert.strictEqual(noSelectedAssets.content.coverAssetId, null);
    assert.ok(noSelectedAssets.messages.some(value => value.includes("已清除不在所选素材中的封面")));
  }

  const wechat = preparation.prepareTargetArticle(original, "wxmp");
  assert.strictEqual(wechat.content.coverAssetId, third);
  assert.deepStrictEqual(wechat.content.assets.map(asset => asset.id), [third]);
  assert.ok(wechat.content.body.includes(`![保留](ebao-asset://${third})`));
  assert.ok(!wechat.content.body.includes("![WebP]"));
  assert.ok(!wechat.content.body.includes("![大图]"));
  assert.strictEqual(wechat.content.title.length, 64);
  assert.strictEqual(wechat.content.summary.length, 120);
  const emojiBoundary = preparation.prepareTargetArticle({ ...original,
    title: `${"标".repeat(63)}😀后续`, summary: `${"摘".repeat(119)}😀后续` }, "wxmp");
  assert.strictEqual(emojiBoundary.content.title, "标".repeat(63));
  assert.strictEqual(emojiBoundary.content.summary, "摘".repeat(119));
  assert.ok(wechat.messages.some(value => value.includes("公众号封面")));
  assert.ok(wechat.messages.some(value => value.includes("64 字")));
  assert.ok(preparation.prepareTargetArticle({ ...original, title: "标题", summary: "独立摘要", tags: ["话题"] }, "tt")
    .messages.some(value => value.includes("暂不写入摘要")));
  for (const platform of ["tt", "bjh", "wxmp"]) {
    assert.ok(preparation.prepareTargetArticle({ ...original, title: "标题", tags: ["话题"] }, platform)
      .messages.some(value => value.includes("暂不写入标签")));
  }
  assert.strictEqual(JSON.stringify(original), unchanged);

  const advertised = capabilities.platformCapabilities();
  assert.throws(() => targets.validateTargetContent({ ...original, title: "标题", body: "正文", assets: [assets[0]], coverAssetId: first },
    { platform: "wxmp", displayName: "公众号" }, "article", advertised, { validate: () => {} }), /需要一张 JPEG\/PNG/u);
  assert.strictEqual(preparation.modeForPreparedContent("publish", "article", [{ accountId: "x", messages: ["已修整"] }]), "draft");
  assert.strictEqual(preparation.modeForPreparedContent("publish", "article", []), "publish");
  assert.strictEqual(preparation.modeForPreparedContent("publish", "image-note", [{ accountId: "x", messages: ["已修整"] }]), "publish");
  assert.strictEqual(preparation.hasRawHtmlImage("`<img src='code'>`\n\n```html\n<img src='code'>\n```"), false);
  assert.strictEqual(preparation.hasRawHtmlImage(`![<img src='alt'>](ebao-asset://${third})`), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "article-preparation-test-"));
  try {
    const store = new PublisherStore(directory);
    const account = store.addAccount({ displayName: "掘金", platform: "juejin", pt: "掘金" });
    const saved = store.createSubmission({ contentType: "article", contentId: "content", revision: 1,
      title: "标题", mode: "draft", requestedMode: "publish",
      adjustments: [{ accountId: account.id, messages: juejin.messages }] }, [account]);
    const publicSaved = store.listSubmissions().find(item => item.id === saved.id);
    assert.strictEqual(publicSaved.mode, "draft");
    assert.strictEqual(publicSaved.requestedMode, "publish");
    assert.deepStrictEqual(publicSaved.adjustments, [{ accountId: account.id, messages: juejin.messages }]);

    // Exercise the real service acceptance path while replacing only browser/account I/O.
    const serviceBundle = path.join(directory, "service.cjs");
    const articleFunctions = ["runBilibiliArticle", "runJuejinArticle", "runXhsImageNote", "runToutiaoArticle",
      "runKuaishouImageNote", "runDouyinImageNote", "runBaijiahaoArticle", "runWechatOfficialArticle"];
    const articleStub = articleFunctions.map(name => name === "runJuejinArticle"
      ? `export async function ${name}(account, submission, manifest) {
          globalThis.__articleDispatch = { account, submission, manifest };
          return { exitCode: 0, status: 'draft', message: '已保存模拟草稿' };
        }`
      : `export async function ${name}() { throw new Error('browser dispatch is not expected'); }`).join("\n");
    const stubs = new Map([
      ["../services/publishVideo.js", "export async function runSingleFilePublish() { throw new Error('browser dispatch is not expected'); }"],
      ["./article.js", articleStub],
      ["./accounts.js", `export class PublisherAccounts {
        constructor(store) { this.store = store; this.wechat = { validate() {} }; }
        require(id) { const account = this.store.account(id); if (!account) throw new Error('account missing'); return account; }
        async check() { return { loginState: 'logged-in' }; }
        assertNoOpenWindow() {}
        dispose() {}
      }`],
    ]);
    await build({
      entryPoints: [path.join(root, "src/main/publisher-worker/service.js")],
      bundle: true, platform: "node", format: "cjs", outfile: serviceBundle,
      plugins: [{ name: "article-service-io-stubs", setup(builder) {
        builder.onResolve({ filter: /.*/u }, args => stubs.has(args.path)
          ? { path: args.path, namespace: "test-stub" } : null);
        builder.onLoad({ filter: /.*/u, namespace: "test-stub" }, args => ({ contents: stubs.get(args.path), loader: "js" }));
      } }],
    });
    const { PublisherWorkerService } = require(serviceBundle);
    const serviceRoot = path.join(directory, "service");
    const service = new PublisherWorkerService(serviceRoot);
    service.kick = () => {}; // Leave the accepted task queued; no platform call is needed here.
    const juejinAccount = service.store.addAccount({ displayName: "掘金账号", platform: "juejin", pt: "掘金" });
    const contentId = "88888888-8888-4888-8888-888888888888";
    const source = path.join(directory, "source", contentId);
    fs.mkdirSync(path.join(source, "assets"), { recursive: true });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    fs.writeFileSync(path.join(source, "assets", third), png);
    const sourceManifest = { id: contentId, contentType: "article", revision: 1,
      title: "待转草稿文章", body: `正文 ![插图](ebao-asset://${third})`, summary: "", tags: [],
      creativeStatement: "none", assets: [{ id: third, mime: "image/png", bytes: png.length }],
      coverAssetId: third, platformFields: {} };
    const originalManifest = JSON.stringify(sourceManifest);
    fs.writeFileSync(path.join(source, "manifest.json"), originalManifest);
    const accepted = await service.createSubmission({ contentType: "article", mode: "publish",
      accountIds: [juejinAccount.id], contentDirectory: source, contentId, revision: 1 });
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.submission.mode, "draft");
    assert.strictEqual(accepted.submission.requestedMode, "publish");
    assert.ok(accepted.submission.adjustments[0].messages.some(value => value.includes("正文图片")));
    assert.ok(accepted.submission.adjustments[0].messages.some(value => value.includes("默认分类")));
    const stored = service.store.submission(accepted.submission.id);
    assert.strictEqual(stored.state, "queued");
    assert.strictEqual(stored.mode, "draft");
    assert.deepStrictEqual(service.store.listSubmissions().find(item => item.id === stored.id).adjustments,
      accepted.submission.adjustments);
    assert.strictEqual(fs.readFileSync(path.join(source, "manifest.json"), "utf8"), originalManifest);
    assert.strictEqual(fs.readFileSync(path.join(stored.snapshotDirectory, "manifest.json"), "utf8"), originalManifest);
    assert.deepStrictEqual(fs.readFileSync(path.join(stored.snapshotDirectory, "assets", third)), png);
    globalThis.__articleDispatch = null;
    await service.drain();
    assert.strictEqual(service.store.submission(stored.id).state, "completed");
    assert.strictEqual(globalThis.__articleDispatch.submission.mode, "draft");
    assert.strictEqual(globalThis.__articleDispatch.account.id, juejinAccount.id);
    assert.strictEqual(globalThis.__articleDispatch.manifest.platformFields.juejin.category, "前端");
    assert.ok(!globalThis.__articleDispatch.manifest.body.includes("![插图]"));
    assert.strictEqual(globalThis.__articleDispatch.manifest.body, "正文 ");
    assert.strictEqual(fs.readFileSync(path.join(stored.snapshotDirectory, "manifest.json"), "utf8"), originalManifest);
    const coverlessToutiao = targets.validateTargetContent({ ...sourceManifest,
      platformVariants: { tt: { assetOrder: [] } } },
    { platform: "tt", displayName: "头条" }, "article", capabilities.platformCapabilities(), null);
    assert.deepStrictEqual(coverlessToutiao.assets, []);
    assert.strictEqual(coverlessToutiao.coverAssetId, null);
  } finally {
    delete globalThis.__articleDispatch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("article preparation checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

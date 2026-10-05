"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

(async () => {
  const root = path.join(__dirname, "..");
  const { WechatOfficialClient, composeWechatImageNoteText } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/wechat-official.js")));
  const { prepareWechatImage } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/wechat-image.js")));
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
    // An oversized body image is normalized before either material upload.
    const oversized = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
    const converted = Buffer.from(png);
    const imageApi = { createFromBuffer: () => ({
      isEmpty: () => false, getSize: () => ({ width: 2400, height: 1600 }),
      toPNG: () => oversized,
      resize: () => ({ toPNG: () => converted }),
    }) };
    const normalized = await prepareWechatImage({ mime: "image/png", bytes: oversized.length },
      oversized, 1024 * 1024, imageApi);
    assert.strictEqual(normalized.mime, "image/png");
    assert.strictEqual(normalized.bytes.length, converted.length);
    const oversizedCover = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    assert.strictEqual((await prepareWechatImage({ mime: "image/png", bytes: oversizedCover.length },
      oversizedCover, 10 * 1024 * 1024, imageApi)).bytes.length, oversized.length);
    const smallImage = { createFromBuffer: () => ({
      isEmpty: () => false, getSize: () => ({ width: 8, height: 8 }),
      toPNG: () => converted,
    }) };
    assert.strictEqual((await prepareWechatImage({ mime: "image/png", bytes: oversized.length },
      oversized, 1024 * 1024, smallImage)).bytes.length, converted.length);
    const jpegAttempts = [];
    const jpegImage = { createFromBuffer: () => ({
      isEmpty: () => false, getSize: () => ({ width: 1800, height: 1200 }),
      toJPEG: quality => {
        jpegAttempts.push(quality);
        return Buffer.alloc(quality === 72 ? 700_000 : 1_100_000);
      },
    }) };
    const jpegBytes = Buffer.alloc(1_100_000);
    const jpegResult = await prepareWechatImage({ mime: "image/jpeg", bytes: jpegBytes.length },
      jpegBytes, 1024 * 1024, jpegImage);
    assert.strictEqual(jpegResult.mime, "image/jpeg");
    assert.strictEqual(jpegResult.bytes.length, 700_000);
    assert.deepStrictEqual(jpegAttempts, [85, 72]);
    const resizedWidths = [];
    await assert.rejects(prepareWechatImage({ mime: "image/png", bytes: oversized.length },
      oversized, 1024 * 1024, { createFromBuffer: () => ({
        isEmpty: () => false, getSize: () => ({ width: 2400, height: 1600 }),
        toPNG: () => oversized,
        resize: ({ width }) => { resizedWidths.push(width); return { toPNG: () => oversized }; },
      }) }), /保留可用尺寸/u);
    assert.strictEqual(Math.min(...resizedWidths), 720);
    const largeManifest = { ...manifest, assets: [{ ...manifest.assets[0], bytes: oversized.length }] };
    fs.writeFileSync(path.join(temporary, "assets", assetId), oversized);
    requests.length = 0;
    const convertedDraft = await new WechatOfficialClient(mock, () => Date.now(), imageApi)
      .submit(credentials, submission, largeManifest, largeManifest.body);
    assert.strictEqual(convertedDraft.status, "draft");
    const uploadRequests = requests.filter(item => ["/cgi-bin/media/uploadimg", "/cgi-bin/material/add_material"].includes(item.pathname));
    assert.deepStrictEqual(uploadRequests.map(item => item.options.body.get("media").size),
      [converted.length, converted.length]);
    assert.strictEqual(fs.readFileSync(path.join(temporary, "assets", assetId)).length, oversized.length);
    requests.length = 0;
    await assert.rejects(new WechatOfficialClient(mock, () => Date.now(), {
      createFromBuffer: () => ({ isEmpty: () => true }),
    }).submit(credentials, submission, largeManifest, largeManifest.body), /无法解码/u);
    assert.strictEqual(requests.length, 0, "bad images must fail before any remote call");
    fs.writeFileSync(path.join(temporary, "assets", assetId), png);
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
    await assert.rejects(new WechatOfficialClient(async () => response({ errcode: "secret=should-not-leak", errmsg: "secret=should-not-leak" })).token(credentials), error =>
      error.code === "wechat-api-error" && error.message.includes("未知") && !error.message.includes("should-not-leak"));
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
    assert.strictEqual(uncertain.draftMediaId, "draft-id");
    assert.strictEqual(requests.filter(item => item.pathname === "/cgi-bin/freepublish/submit").length, 1);
    await assert.rejects(client.submit(credentials, submission, { ...manifest, assets: [{ ...manifest.assets[0], mime: "image/webp" }] }, manifest.body), /仅支持 JPEG 或 PNG/u);

    // 图片消息使用永久素材，保留所选顺序，与既有 news 文章上传路径分开。
    const webpId = "33333333-3333-4333-8333-333333333333";
    const jpegId = "44444444-4444-4444-8444-444444444444";
    const webp = Buffer.from("RIFF1234WEBPoriginal", "ascii");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2]);
    fs.writeFileSync(path.join(temporary, "assets", webpId), webp);
    fs.writeFileSync(path.join(temporary, "assets", jpegId), jpeg);
    const note = { ...manifest, contentType: "image-note", title: "图片图文", body: "第一行\n第二行", tags: ["AI", "#旅行", "AI"],
      creativeStatement: "ai_generated", coverAssetId: jpegId,
      assets: [manifest.assets[0], { id: webpId, mime: "image/webp", bytes: webp.length }, { id: jpegId, mime: "image/jpeg", bytes: jpeg.length }] };
    const webpImageApi = { createFromBuffer: bytes => {
      assert.deepStrictEqual(bytes, webp);
      return { isEmpty: () => false, getSize: () => ({ width: 600, height: 400 }), toJPEG: () => jpeg };
    } };
    const expectedNoteBody = "第一行\n第二行\n\n#AI #旅行\n\n内容声明：本文包含 AI 生成内容";
    assert.strictEqual(composeWechatImageNoteText(note), expectedNoteBody);
    assert.strictEqual(composeWechatImageNoteText({ ...note, tags: [], creativeStatement: "none" }), note.body);
    const makeImageNoteMock = (options = {}) => {
      const calls = [];
      let saved;
      let uploads = 0;
      const fetcher = async (url, request) => {
        const pathname = new URL(url).pathname;
        calls.push({ pathname, options: request });
        if (pathname === "/cgi-bin/stable_token") return response({ access_token: "image-token", expires_in: 7200 });
        if (pathname === "/cgi-bin/material/add_material") {
          assert.strictEqual(new URL(url).searchParams.get("type"), "image");
          return response({ media_id: `image-${++uploads}` });
        }
        if (pathname === "/cgi-bin/draft/add") {
          saved = JSON.parse(request.body).articles[0];
          if (options.draftThrows) throw new Error("secret=must-not-leak");
          return response({ media_id: "image-draft" });
        }
        if (pathname === "/cgi-bin/draft/get") {
          assert.deepStrictEqual(JSON.parse(request.body), { media_id: "image-draft" });
          if (options.readThrows) throw new Error("secret=must-not-leak");
          const actual = JSON.parse(JSON.stringify(saved));
          return response({ news_item: [options.transform ? options.transform(actual) : actual] });
        }
        if (pathname === "/cgi-bin/freepublish/submit") {
          assert.deepStrictEqual(JSON.parse(request.body), { media_id: "image-draft" });
          if (options.publishThrows) throw new Error("secret=must-not-leak");
          if (options.publishRejected) return response({ errcode: 48001, errmsg: "secret=must-not-leak" });
          return response(options.missingPublishId ? { errcode: 0 } : { publish_id: "image-publish" });
        }
        if (pathname === "/cgi-bin/freepublish/get") {
          assert.deepStrictEqual(JSON.parse(request.body), { publish_id: "image-publish" });
          if (options.queryThrows) throw new Error("secret=must-not-leak");
          return response({ publish_status: options.publishStatus ?? 0 });
        }
        throw new Error(`Unexpected image-note endpoint ${pathname}`);
      };
      return { calls, fetcher };
    };
    const noteMock = makeImageNoteMock();
    const noteClient = new WechatOfficialClient(noteMock.fetcher, () => Date.now(), webpImageApi);
    const noteDraft = await noteClient.submit(credentials, submission, note, note.body);
    assert.strictEqual(noteDraft.status, "draft");
    assert.strictEqual(noteDraft.draftMediaId, "image-draft");
    assert.strictEqual(noteDraft.publishId, undefined);
    assert.match(noteDraft.message, /首图为封面/u);
    assert.deepStrictEqual(noteMock.calls.map(call => call.pathname), [
      "/cgi-bin/stable_token", "/cgi-bin/material/add_material", "/cgi-bin/material/add_material", "/cgi-bin/material/add_material", "/cgi-bin/draft/add", "/cgi-bin/draft/get",
    ]);
    const imageArticle = JSON.parse(noteMock.calls.find(call => call.pathname === "/cgi-bin/draft/add").options.body).articles[0];
    assert.strictEqual(imageArticle.article_type, "newspic");
    assert.strictEqual(imageArticle.content, expectedNoteBody);
    assert.strictEqual(Object.hasOwn(imageArticle, "thumb_media_id"), false, "首图封面不额外上传或重排");
    assert.strictEqual(Object.hasOwn(imageArticle, "digest"), false);
    assert.deepStrictEqual(imageArticle.image_info.image_list, [{ image_media_id: "image-1" }, { image_media_id: "image-2" }, { image_media_id: "image-3" }]);
    const noteUploads = noteMock.calls.filter(call => call.pathname === "/cgi-bin/material/add_material");
    assert.deepStrictEqual(noteUploads.map(call => call.options.body.get("media").type), ["image/png", "image/jpeg", "image/jpeg"]);
    assert.deepStrictEqual(await Promise.all(noteUploads.map(async call => Buffer.from(await call.options.body.get("media").arrayBuffer()))), [png, jpeg, jpeg]);
    assert.deepStrictEqual(fs.readFileSync(path.join(temporary, "assets", webpId)), webp, "转换仅影响上传副本");
    assert.deepStrictEqual(note.tags, ["AI", "#旅行", "AI"]);
    assert.strictEqual(note.assets[0].id, assetId);
    assert.ok(noteUploads.every(call => call.options.body.get("media").size < 10 * 1024 * 1024));
    const transformedNoteImage = await prepareWechatImage({ mime: "image/webp", bytes: webp.length }, webp,
      10 * 1024 * 1024, webpImageApi, { allowWebp: true });
    assert.strictEqual(transformedNoteImage.mime, "image/jpeg");
    const atImageLimit = Buffer.alloc(10 * 1024 * 1024);
    const largeNoteImage = await prepareWechatImage({ mime: "image/jpeg", bytes: atImageLimit.length }, atImageLimit,
      10 * 1024 * 1024, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 600, height: 400 }), toJPEG: () => jpeg }) }, { allowWebp: true });
    assert.ok(largeNoteImage.bytes.length < 10 * 1024 * 1024, "10MB边界必须转换至上限以下");
    assert.doesNotThrow(() => noteClient.validateImageNote({ ...note, title: "😀".repeat(32) }));
    for (const rejectedNote of [
      { ...note, title: "😀".repeat(33) }, { ...note, title: " " }, { ...note, assets: [] },
      { ...note, assets: Array.from({ length: 21 }, (_, index) => ({ ...note.assets[0], id: `${index}` })) },
      { ...note, assets: [note.assets[0], note.assets[0]] }, { ...note, assets: [{ ...note.assets[0], id: "../escape" }] },
      { ...note, assets: [{ ...note.assets[0], mime: "image/gif" }] }, { ...note, body: "a".repeat(20_001) },
    ]) {
      const invalidMock = makeImageNoteMock();
      await assert.rejects(new WechatOfficialClient(invalidMock.fetcher, () => Date.now(), webpImageApi)
        .submit(credentials, submission, rejectedNote, rejectedNote.body), error => error.code === "invalid-content");
      assert.strictEqual(invalidMock.calls.length, 0, "预检失败不得调用远端");
    }
    const invalidDecodeMock = makeImageNoteMock();
    await assert.rejects(new WechatOfficialClient(invalidDecodeMock.fetcher, () => Date.now(), {
      createFromBuffer: () => ({ isEmpty: () => true }),
    }).submit(credentials, submission, note, note.body), /无法解码/u);
    assert.strictEqual(invalidDecodeMock.calls.length, 0);
    const changedMock = makeImageNoteMock();
    await assert.rejects(new WechatOfficialClient(changedMock.fetcher, () => Date.now(), webpImageApi)
      .submit(credentials, submission, { ...note, assets: [{ ...note.assets[0], sha256: "f".repeat(64) }] }, note.body), /发生变化/u);
    assert.strictEqual(changedMock.calls.length, 0);
    const missingMock = makeImageNoteMock();
    await assert.rejects(new WechatOfficialClient(missingMock.fetcher, () => Date.now(), webpImageApi)
      .submit(credentials, submission, { ...note, assets: [{ ...note.assets[0], id: "55555555-5555-4555-8555-555555555555" }] }, note.body), /不存在或无法读取/u);
    assert.strictEqual(missingMock.calls.length, 0);
    for (const transform of [
      item => ({ ...item, article_type: "news" }), item => ({ ...item, title: "错误标题" }),
      item => ({ ...item, content: "错误正文" }), item => ({ ...item, image_info: { image_list: [...item.image_info.image_list].reverse() } }),
    ]) {
      const mismatchMock = makeImageNoteMock({ transform });
      const mismatch = await new WechatOfficialClient(mismatchMock.fetcher, () => Date.now(), webpImageApi)
        .submit(credentials, { ...submission, mode: "publish" }, note, note.body);
      assert.strictEqual(mismatch.status, "unknown");
      assert.strictEqual(mismatch.draftMediaId, "image-draft");
      assert.strictEqual(mismatch.publishId, undefined);
      assert.match(mismatch.message, /未继续发布/u);
      assert.ok(mismatchMock.calls.every(call => !call.pathname.includes("freepublish")));
    }
    for (const option of ["draftThrows", "readThrows", "publishThrows", "queryThrows", "missingPublishId"]) {
      const uncertainMock = makeImageNoteMock({ [option]: true });
      const result = await new WechatOfficialClient(uncertainMock.fetcher, () => Date.now(), webpImageApi)
        .submit(credentials, { ...submission, mode: "publish" }, note, note.body);
      assert.strictEqual(result.status, "unknown");
      assert.strictEqual(result.draftMediaId, option === "draftThrows" ? undefined : "image-draft");
      assert.strictEqual(result.publishId, option === "queryThrows" ? "image-publish" : undefined);
      assert.ok(!result.message.includes("must-not-leak"));
      const submissions = uncertainMock.calls.filter(call => call.pathname === "/cgi-bin/freepublish/submit");
      assert.strictEqual(submissions.length, ["draftThrows", "readThrows"].includes(option) ? 0 : 1);
      assert.strictEqual(uncertainMock.calls.filter(call => call.pathname === "/cgi-bin/draft/add").length, 1);
    }
    const deniedMock = makeImageNoteMock({ publishRejected: true });
    const denied = await new WechatOfficialClient(deniedMock.fetcher, () => Date.now(), webpImageApi)
      .submit(credentials, { ...submission, mode: "publish" }, note, note.body);
    assert.strictEqual(denied.status, "failed");
    assert.strictEqual(denied.draftMediaId, "image-draft", "发布被拒仍可核查已保存草稿");
    assert.strictEqual(denied.publishId, undefined);
    assert.match(denied.message, /48001/u);
    assert.ok(!denied.message.includes("must-not-leak"));
    assert.strictEqual(deniedMock.calls.filter(call => call.pathname === "/cgi-bin/freepublish/submit").length, 1);
    assert.ok(deniedMock.calls.every(call => call.pathname !== "/cgi-bin/freepublish/get"));
    // 非幂等请求可能已经落库；网关异常和无法判读的返回不能误报为可重试的失败。
    const mutationFaults = [
      ["HTTP 500", () => ({ ok: false, status: 500, json: async () => ({ errcode: 48001 }) }), "unknown"],
      ["HTTP 502", () => ({ ok: false, status: 502, json: async () => ({}) }), "unknown"],
      ["HTTP 408", () => ({ ok: false, status: 408, json: async () => ({}) }), "unknown"],
      ["bad JSON", () => ({ ok: true, json: async () => { throw new Error("secret=must-not-leak"); } }), "unknown"],
      ["null JSON", () => response(null), "unknown"],
      ["array JSON", () => response([]), "unknown"],
      ["scalar JSON", () => response("secret=must-not-leak"), "unknown"],
      ["invalid response", () => null, "unknown"],
      ["invalid HTTP status", () => ({ ok: false, status: "secret=must-not-leak", json: async () => ({}) }), "unknown"],
      ["invalid errcode", () => response({ errcode: "secret=must-not-leak", errmsg: "secret=must-not-leak" }), "unknown"],
      ["null errcode", () => response({ errcode: null }), "unknown"],
      ["missing identifier", () => response({ errcode: 0 }), "unknown"],
      ["HTTP 403", () => ({ ok: false, status: 403, json: async () => ({}) }), "failed"],
      ["permission rejected", () => response({ errcode: 48001, errmsg: "secret=must-not-leak" }), "failed"],
      ["IP rejected", () => response({ errcode: 40164, errmsg: "secret=must-not-leak" }), "failed"],
      ["business busy", () => response({ errcode: -1, errmsg: "secret=must-not-leak" }), "failed"],
    ];
    for (const [content, expectedDraftId] of [[manifest, "draft-id"], [note, "image-draft"]]) {
      for (const endpoint of ["/cgi-bin/draft/add", "/cgi-bin/freepublish/submit"]) {
        for (const [label, fault, expectedStatus] of mutationFaults) {
          const calls = [];
          const baseFetcher = content.contentType === "image-note" ? makeImageNoteMock().fetcher : mock;
          const fetcher = async (url, options) => {
            const pathname = new URL(url).pathname;
            calls.push(pathname);
            return pathname === endpoint ? fault() : baseFetcher(url, options);
          };
          let result;
          let failure;
          try {
            result = await new WechatOfficialClient(fetcher, () => Date.now(), webpImageApi)
              .submit(credentials, { ...submission, mode: "publish" }, content, content.body);
          } catch (error) { failure = error; }
          const context = `${content.contentType || "article"} ${endpoint} ${label}`;
          if (expectedStatus === "failed" && endpoint === "/cgi-bin/draft/add") {
            assert.ok(failure, context);
            assert.notStrictEqual(failure.requestOutcomeUnknown, true, context);
            assert.ok(!failure.message.includes("must-not-leak"), context);
          } else {
            assert.strictEqual(failure, undefined, context);
            assert.strictEqual(result.status, expectedStatus, context);
            assert.strictEqual(result.draftMediaId, endpoint === "/cgi-bin/draft/add" ? undefined : expectedDraftId, context);
            assert.strictEqual(result.publishId, undefined, context);
            assert.ok(!result.message.includes("must-not-leak"), context);
          }
          assert.strictEqual(calls.filter(item => item === endpoint).length, 1, `${context}: must not replay`);
          assert.strictEqual(calls.filter(item => item === "/cgi-bin/draft/add").length, 1, context);
          assert.ok(!calls.includes("/cgi-bin/freepublish/get"), `${context}: no query without publish ID`);
          if (endpoint === "/cgi-bin/draft/add") {
            assert.ok(!calls.includes("/cgi-bin/draft/get"), `${context}: no read without draft ID`);
            assert.ok(!calls.includes("/cgi-bin/freepublish/submit"), `${context}: no publish after uncertain creation`);
          }
        }
      }
    }
    const readCalls = [];
    const unreadDraft = await new WechatOfficialClient(async (url, options) => {
      const pathname = new URL(url).pathname;
      readCalls.push(pathname);
      if (pathname === "/cgi-bin/draft/get") throw new Error("secret=must-not-leak");
      return mock(url, options);
    }).submit(credentials, submission, manifest, manifest.body);
    assert.strictEqual(unreadDraft.status, "unknown");
    assert.strictEqual(unreadDraft.draftMediaId, "draft-id", "回读失败也保留已知的文章草稿标识");
    assert.strictEqual(readCalls.filter(endpoint => endpoint === "/cgi-bin/draft/add").length, 1);
    assert.ok(readCalls.every(endpoint => !endpoint.includes("freepublish")));
    assert.ok(!unreadDraft.message.includes("must-not-leak"));
    for (const [publishStatus, expected] of [[0, "success"], [1, "unknown"], [4, "failed"]]) {
      const publishMock = makeImageNoteMock({ publishStatus });
      const result = await new WechatOfficialClient(publishMock.fetcher, () => Date.now(), webpImageApi)
        .submit(credentials, { ...submission, mode: "publish" }, note, note.body);
      assert.strictEqual(result.status, expected);
      assert.strictEqual(result.draftMediaId, "image-draft");
      assert.strictEqual(result.publishId, "image-publish");
      const endpoints = publishMock.calls.map(call => call.pathname);
      assert.ok(endpoints.indexOf("/cgi-bin/draft/get") < endpoints.indexOf("/cgi-bin/freepublish/submit"));
      assert.strictEqual(endpoints.filter(endpoint => endpoint === "/cgi-bin/freepublish/submit").length, 1);
      assert.strictEqual(endpoints.filter(endpoint => endpoint === "/cgi-bin/freepublish/get").length, 1);
    }
    const store = new PublisherStore(path.join(temporary, "store"));
    const account = store.addAccount({ displayName: "公众号", platform: "wxmp", pt: "微信公众号", appId: credentials.appId, credentialCiphertext: "encrypted" });
    store.updateAccount(account.id, { loginState: "logged-out", loginError: "微信接口拒绝请求（错误码 40164）" });
    assert.strictEqual(store.listAccounts()[0].loginError, "微信接口拒绝请求（错误码 40164）");
    assert.strictEqual(store.listAccounts()[0].appId, undefined);
    assert.strictEqual(store.listAccounts()[0].credentialCiphertext, undefined);
    assert.deepStrictEqual(platformCapabilities().find(item => item.platform === "wxmp").modes.article, ["publish", "draft"]);
    // Windows reports synthesized POSIX mode bits; access is governed by its ACL.
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(path.join(temporary, "store", "accounts.json")).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-wechat-official passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

function fakePage({ wrongText = false, mergedParagraph = false, missingImages = false, localPreviewsOnly = false,
  unrelatedRemoteImages = false, toolbarImagesOnly = false, lostImagesAfterText = false,
  reorderedImagesAfterText = false,
  saveFeedback = "草稿保存成功" } = {}) {
  const actions = [];
  const state = { images: [], imageInputVisible: false, saveClicks: 0, clock: 0,
    paragraphs: [""], imagesMutated: false };
  const attributes = new Map();
  const element = (text, width = 100, height = 40, x = 100, y = 100) => ({
    textContent: text, children: [],
    getBoundingClientRect: () => ({ width, height, left: x, right: x + width, top: y, bottom: y + height }),
    contains() { return false; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) || null; },
  });
  const root = {
    ...element("", 800, 800),
    contains(item) { return item === save; },
    querySelectorAll(selector) { return selector === "img" ? state.images : []; },
    querySelector(selector) {
      if (selector === ".ProseMirror[contenteditable='true']") return editor;
      if (selector === "button.save-draft") return save;
      return null;
    },
  };
  const editor = { ...element("", 700, 150, 100, 100), parentElement: root, children: [],
    closest: selector => selector === ".publish-box" ? root : null };
  const syncEditor = () => {
    editor.children = state.paragraphs.map(value => ({ tagName: "P", textContent: value }));
    editor.textContent = state.paragraphs.join("");
  };
  syncEditor();
  const imageButton = element("图片");
  const save = { ...element("存草稿", 100, 40, 700, 650), disabled: false };
  const input = {
    uploadFile: async (...paths) => {
      actions.push(`upload:${paths.length}`);
      if (!missingImages) state.images = paths.map((_, index) => ({
        src: localPreviewsOnly ? `blob:preview-${index}` : `https://p3.toutiaoimg.com/uploaded-${index}`,
        currentSrc: localPreviewsOnly ? `blob:preview-${index}` : `https://p3.toutiaoimg.com/uploaded-${index}`,
        complete: true, naturalWidth: 300,
        closest: () => toolbarImagesOnly ? imageButton : null,
        getAttribute: () => localPreviewsOnly ? `blob:preview-${index}` : `https://p3.toutiaoimg.com/uploaded-${index}`,
        getBoundingClientRect: () => ({ width: 100, height: 100,
          left: unrelatedRemoteImages ? 1600 : 100 + 120 * index,
          right: unrelatedRemoteImages ? 1700 : 200 + 120 * index,
          top: unrelatedRemoteImages ? 100 : 360,
          bottom: unrelatedRemoteImages ? 200 : 460 }),
      }));
    },
  };
  const lookup = selector => {
    if (selector === ".ProseMirror[contenteditable='true']") return editor;
    if (selector === "button.save-draft") return save;
    if (selector === "[data-ebao-tt-note-root='true']") return attributes.get("data-ebao-tt-note-root") ? root : null;
    if (selector === "[data-ebao-tt-note-image='true']") return attributes.get("data-ebao-tt-note-image") ? imageButton : null;
    if (selector === "[data-ebao-tt-note-save='true']") return attributes.get("data-ebao-tt-note-save") ? save : null;
    if (selector === "input[type='file'][accept='image/*'][multiple]:not(#upload-drag-input)") return state.imageInputVisible ? input : null;
    return null;
  };
  const document = {
    body: element(""),
    querySelector: lookup,
    querySelectorAll(selector) {
      if (selector === ".syl-toolbar-button") return [imageButton];
      if (selector === "button.save-draft") return [save];
      if (selector.includes("[role='alert']")) return state.saveClicks && saveFeedback ? [element(saveFeedback)] : [];
      return [];
    },
  };
  const page = {
    url: () => "https://mp.toutiao.com/profile_v4/weitoutiao/publish",
    waitForSelector: async selector => {
      const found = lookup(selector);
      if (!found) throw new Error(`selector missing: ${selector}`);
      return found;
    },
    $: async selector => lookup(selector),
    click: async selector => {
      if (selector === "[data-ebao-tt-note-image='true']") {
        state.imageInputVisible = true;
        actions.push("open-images");
      } else if (selector === ".ProseMirror[contenteditable='true']") {
        actions.push("focus-editor");
      } else if (selector === "[data-ebao-tt-note-save='true']") {
        state.saveClicks += 1;
        actions.push("save-draft");
      } else throw new Error(`unexpected click: ${selector}`);
    },
    keyboard: {
      sendCharacter: async value => {
        state.paragraphs[state.paragraphs.length - 1] += wrongText ? "错误内容" : value;
        syncEditor();
        if (!state.imagesMutated && lostImagesAfterText) {
          state.images = state.images.slice(0, -1);
          state.imagesMutated = true;
        } else if (!state.imagesMutated && reorderedImagesAfterText) {
          state.images.reverse();
          state.imagesMutated = true;
        }
        actions.push("type-editor");
      },
      press: async key => {
        if (key !== "Enter") throw new Error(`unexpected key: ${key}`);
        if (!mergedParagraph) state.paragraphs.push("");
        syncEditor();
        actions.push("enter-editor");
      },
    },
    evaluate: async (callback, ...args) => {
      const previousDocument = global.document;
      const previousStyle = global.getComputedStyle;
      const previousLocation = global.location;
      global.document = document;
      global.getComputedStyle = () => ({ visibility: "visible" });
      global.location = { href: "https://mp.toutiao.com/profile_v4/weitoutiao/publish" };
      try { return callback(...args); }
      finally {
        global.document = previousDocument;
        global.getComputedStyle = previousStyle;
        global.location = previousLocation;
      }
    },
    waitForFunction: async (callback, _options, ...args) => {
      if (!await page.evaluate(callback, ...args)) throw new Error("page condition false");
    },
    waitForTimeout: async ms => { state.clock += ms; },
  };
  return { page, state, actions, editor };
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tt-image-adapter-test-"));
  const realNow = Date.now;
  try {
    const bundle = path.join(temporary, "adapter.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/services/upLoad/ttImageNote.js")],
      bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{
        name: "mock-tt-image-adapter-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(?:publishOutcome|uploadTimeouts)\.js$/u }, args => ({
            path: args.path, namespace: "tt-image-test",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "tt-image-test" }, args => ({
            contents: args.path === "./publishOutcome.js" ? `
              export const readPageUrl = page => page.url();
              export const replyPublishOutcome = async ({event}) => event.reply("puppeteerFile-done", {status:true});
              export const replyPublishFailure = async ({event,message,extraPayload}) =>
                event.reply("puppeteerFile-done", {status:false,message,...extraPayload});
            ` : "export const WAIT_SELECTOR_APPEAR_MS = 20;",
            loader: "js",
          }));
        },
      }],
    });
    const adapter = require(bundle);
    assert.strictEqual(adapter.composeToutiaoImageNoteText({
      title: "  行程标题  ", description: "路线内容", tags: ["徒步", "#户外", "徒步"],
    }), "行程标题\n\n路线内容\n\n#徒步 #户外");
    assert.strictEqual(adapter.composeToutiaoImageNoteText({
      title: "行程标题", description: "第一段\r\n第二段", tags: [],
    }), "行程标题\n\n第一段\n第二段");
    assert.throws(() => adapter.composeToutiaoImageNoteText({ title: "标题\n下一段" }), /标题不能换行/u);
    assert.strictEqual(adapter.classifyToutiaoImageNoteFeedback(["草稿保存成功"]), "saved");
    assert.strictEqual(adapter.classifyToutiaoImageNoteFeedback(["保存草稿失败"]), "failed");
    assert.strictEqual(adapter.classifyToutiaoImageNoteFeedback(["已上传 2 张"]), "");

    const data = {
      imagePaths: ["one.png", "two.png"], publishToDraft: true,
      data: { title: "测试标题", description: "完整图文正文", tags: ["路线"] },
    };
    for (const scenario of [{}, { wrongText: true }, { mergedParagraph: true }, { missingImages: true },
      { localPreviewsOnly: true }, { unrelatedRemoteImages: true }, { toolbarImagesOnly: true },
      { lostImagesAfterText: true }, { reorderedImagesAfterText: true },
      { saveFeedback: "" }, { saveFeedback: "存草稿失败" }]) {
      const fixture = fakePage(scenario);
      Date.now = () => fixture.state.clock;
      const replies = [];
      await adapter.default(fixture.page, data, null, { reply: (_channel, payload) => replies.push(payload) });
      assert.strictEqual(replies.length, 1);
      if (scenario.wrongText || scenario.mergedParagraph) {
        assert.strictEqual(replies[0].status, false);
        assert.strictEqual(replies[0].needsAttention, true);
        assert.match(replies[0].message, /文案未按段落完整进入/u);
        assert.strictEqual(fixture.state.saveClicks, 0);
      } else if (scenario.missingImages || scenario.localPreviewsOnly
        || scenario.unrelatedRemoteImages || scenario.toolbarImagesOnly) {
        assert.strictEqual(replies[0].status, false);
        assert.strictEqual(replies[0].needsAttention, true);
        assert.match(replies[0].message, /图片上传未在编辑页完整确认/u);
        assert.strictEqual(fixture.state.saveClicks, 0);
      } else if (scenario.lostImagesAfterText || scenario.reorderedImagesAfterText) {
        assert.strictEqual(replies[0].status, false);
        assert.strictEqual(replies[0].needsAttention, true);
        assert.match(replies[0].message, /图片在写入文案后数量或顺序发生变化/u);
        assert.strictEqual(fixture.state.saveClicks, 0);
      } else if (scenario.saveFeedback === "") {
        assert.strictEqual(replies[0].status, false);
        assert.strictEqual(replies[0].needsAttention, true);
        assert.strictEqual(replies[0].publishAbnormal, true);
        assert.strictEqual(fixture.state.saveClicks, 1);
      } else if (scenario.saveFeedback === "存草稿失败") {
        assert.strictEqual(replies[0].status, false);
        assert.strictEqual(replies[0].needsAttention, true);
        assert.match(replies[0].message, /草稿保存失败/u);
        assert.strictEqual(fixture.state.saveClicks, 1);
      } else {
        assert.strictEqual(replies[0].status, true, replies[0].message);
        assert.strictEqual(fixture.state.saveClicks, 1);
        assert.deepStrictEqual(fixture.state.paragraphs,
          adapter.composeToutiaoImageNoteText(data.data).split("\n"));
        assert.ok(fixture.actions.indexOf("upload:2") < fixture.actions.indexOf("type-editor"));
        assert.ok(fixture.actions.indexOf("type-editor") < fixture.actions.indexOf("save-draft"));
      }
    }

    const publish = fakePage();
    const publishReplies = [];
    await adapter.default(publish.page, { ...data, publishToDraft: false }, null,
      { reply: (_channel, payload) => publishReplies.push(payload) });
    assert.strictEqual(publishReplies[0].status, false);
    assert.match(publishReplies[0].message, /直接发布尚未验收/u);
    assert.deepStrictEqual(publish.actions, [], "publish mode must not touch the platform editor");

    const overLimit = fakePage();
    const overLimitReplies = [];
    await adapter.default(overLimit.page, {
      ...data, imagePaths: Array.from({ length: 10 }, (_, index) => `${index}.png`),
    }, null, { reply: (_channel, payload) => overLimitReplies.push(payload) });
    assert.strictEqual(overLimitReplies[0].status, false);
    assert.match(overLimitReplies[0].message, /图片数量无效/u);
    assert.deepStrictEqual(overLimit.actions, [], "over-limit task must not upload files");
    console.log("test-tt-image-note-adapter passed");
  } finally {
    Date.now = realNow;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

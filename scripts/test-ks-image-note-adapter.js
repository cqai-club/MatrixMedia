"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

function editorPage({ url = "https://cp.kuaishou.com/article/publish/video?tabType=2", wrongText = false } = {}) {
  const actions = [];
  const editor = { value: "旧内容" };
  let selected = false;
  const input = { uploadFile: async (...files) => actions.push({ type: "upload", files }) };
  const page = {
    url: () => url,
    waitForSelector: async selector => {
      if (selector.includes("accept*='image'")) return input;
      if (selector === "#work-description-edit") return editor;
      throw new Error(`unexpected selector: ${selector}`);
    },
    click: async selector => {
      assert.strictEqual(selector, "#work-description-edit");
      actions.push({ type: "focus" });
    },
    keyboard: {
      down: async () => {}, up: async () => {},
      press: async key => {
        if (key === "A") selected = true;
        if (key === "Backspace" && selected) editor.value = "";
        if (key === "Tab") actions.push({ type: "blur" });
      },
      type: async text => {
        editor.value += wrongText ? "写入不完整" : text;
        actions.push({ type: "type", text });
      },
    },
    evaluate: async (callback, ...args) => {
      const previous = global.document;
      global.document = { querySelector: selector => selector === "#work-description-edit" ? editor : null };
      try { return callback(...args); }
      finally { global.document = previous; }
    },
  };
  const window = {
    isDestroyed: () => false,
    show: () => actions.push({ type: "show" }),
    focus: () => actions.push({ type: "window-focus" }),
  };
  return { page, window, editor, actions };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ks-image-note-test-"));
  try {
    const outfile = path.join(directory, "adapter.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/services/upLoad/ksImageNote.js")],
      bundle: true, platform: "node", format: "cjs", outfile,
      plugins: [{
        name: "mock-ks-image-note-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(?:publishOutcome|failureScreenshot|uploadTimeouts)\.js$/u }, args => ({
            path: args.path, namespace: "ks-test",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "ks-test" }, args => ({
            contents: args.path.endsWith("publishOutcome.js") ? `
              export const readPageUrl = page => page.url();
              export const replyPublishFailure = async ({event, message, extraPayload, closeWindow}) =>
                event.reply("puppeteerFile-done", { status: false, message, ...extraPayload, closeWindow });
            ` : args.path.endsWith("failureScreenshot.js")
              ? "export const capturePublishFailureScreenshot = async () => '/tmp/screenshot.png';"
              : "export const WAIT_SELECTOR_APPEAR_MS = 20;",
            loader: "js",
          }));
        },
      }],
    });
    const { default: publish, buildKsImageNoteDescription, isKsImageNoteEditorUrl } = require(outfile);
    assert.strictEqual(isKsImageNoteEditorUrl("https://cp.kuaishou.com/article/publish/video?tabType=2&foo=bar"), true);
    assert.strictEqual(isKsImageNoteEditorUrl("https://cp.kuaishou.com/article/publish/video?tabType=1"), false);
    assert.strictEqual(isKsImageNoteEditorUrl("https://evil.example/article/publish/video?tabType=2"), false);
    const content = { title: "旅行标题", description: "图文正文", tags: ["旅行", "#周末"] };
    assert.strictEqual(buildKsImageNoteDescription(content), "旅行标题\n\n图文正文\n\n#旅行 #周末");
    const files = ["/tmp/first.png", "/tmp/second.jpg"];
    const data = { publishToDraft: true, imagePaths: files, data: content };

    const success = editorPage();
    const replies = [];
    await publish(success.page, data, success.window, { reply: (_, payload) => replies.push(payload) });
    assert.strictEqual(success.editor.value, buildKsImageNoteDescription(content));
    assert.deepStrictEqual(success.actions.find(action => action.type === "upload")?.files, files);
    assert.ok(success.actions.some(action => action.type === "show"));
    assert.strictEqual(replies[0].status, false, "没有平台草稿回执时不能宣称保存成功");
    assert.strictEqual(replies[0].needsAttention, true);
    assert.match(replies[0].message, /尚未确认/u);
    assert.strictEqual(replies[0].failScreenshot, "/tmp/screenshot.png");
    assert.strictEqual(success.window._mmRetainedForInspection, true);
    assert.ok(!success.actions.some(action => action.type === "publish"));

    for (const [fixture, task, expected] of [
      [editorPage(), { ...data, publishToDraft: false }, /立即发布尚未验收/u],
      [editorPage({ url: "https://cp.kuaishou.com/article/publish/video?tabType=1" }), data, /不是快手图文编辑页/u],
      [editorPage(), { ...data, imagePaths: Array(32).fill("/tmp/image.jpg") }, /1 至 31 张/u],
    ]) {
      const failures = [];
      await publish(fixture.page, task, fixture.window, { reply: (_, payload) => failures.push(payload) });
      assert.strictEqual(failures[0].status, false);
      assert.match(failures[0].message, expected);
      assert.strictEqual(failures[0].needsAttention, undefined);
      assert.strictEqual(failures[0].closeWindow, true);
      assert.ok(!fixture.actions.some(action => action.type === "upload"), "预检查失败不能上传");
    }

    const mismatch = editorPage({ wrongText: true });
    const mismatchReplies = [];
    await publish(mismatch.page, data, mismatch.window, { reply: (_, payload) => mismatchReplies.push(payload) });
    assert.strictEqual(mismatchReplies[0].status, false);
    assert.match(mismatchReplies[0].message, /未完整写入/u);
    assert.strictEqual(mismatchReplies[0].needsAttention, true);
    console.log("test-ks-image-note-adapter passed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

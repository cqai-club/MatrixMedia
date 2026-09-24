"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

function editorPage({ url = "https://creator.douyin.com/creator-micro/content/upload?default-tab=3", wrongField = "" } = {}) {
  const actions = [];
  const title = { value: "旧标题" };
  const body = { innerText: "旧正文", textContent: "旧正文" };
  let active = null;
  let selected = false;
  const imageInput = { uploadFile: async (...files) => actions.push({ type: "upload", files }) };
  const page = {
    url: () => url,
    waitForSelector: async selector => {
      if (selector.includes("accept*=\"image\"")) return imageInput;
      if (selector.includes("placeholder*=")) return title;
      if (selector.includes("contenteditable")) return body;
      throw new Error(`unexpected selector: ${selector}`);
    },
    click: async selector => {
      active = selector.includes("placeholder*=") ? title : body;
      actions.push({ type: "focus", field: active === title ? "title" : "body" });
    },
    keyboard: {
      down: async () => {}, up: async () => {},
      press: async key => {
        if (key === "A") selected = true;
        if (key === "Backspace" && selected) {
          if (active === title) title.value = "";
          if (active === body) body.innerText = body.textContent = "";
        }
      },
      type: async text => {
        if (active === title) title.value += wrongField === "title" ? "错误标题" : text;
        else if (active === body) body.innerText = body.textContent += wrongField === "body" ? "错误正文" : text;
        else throw new Error("no focused field");
        actions.push({ type: "type", field: active === title ? "title" : "body" });
      },
    },
    evaluate: async (callback, ...args) => {
      const previous = global.document;
      global.document = {
        querySelector: selector => selector.includes("placeholder*=") ? title
          : selector.includes("contenteditable") ? body : null,
      };
      try { return callback(...args); }
      finally { global.document = previous; }
    },
  };
  const window = {
    isDestroyed: () => false,
    show: () => actions.push({ type: "show" }),
    focus: () => actions.push({ type: "window-focus" }),
  };
  return { page, window, actions, title, body };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dy-image-note-test-"));
  try {
    const outfile = path.join(directory, "adapter.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/services/upLoad/dyImageNote.js")],
      bundle: true, platform: "node", format: "cjs", outfile,
      plugins: [{
        name: "mock-dy-image-note-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(?:publishOutcome|failureScreenshot|uploadTimeouts)\.js$/u }, args => ({
            path: args.path, namespace: "dy-test",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "dy-test" }, args => ({
            contents: args.path.endsWith("publishOutcome.js") ? `
              export const readPageUrl = page => page.url();
              export const replyPublishFailure = async ({event,message,closeWindow}) =>
                event.reply("puppeteerFile-done", {status:false,message,closeWindow});
            ` : args.path.endsWith("failureScreenshot.js")
              ? "export const capturePublishFailureScreenshot = async () => '/tmp/screenshot.png';"
              : "export const WAIT_SELECTOR_APPEAR_MS = 20;",
            loader: "js",
          }));
        },
      }],
    });
    const { default: publish, buildDouyinImageNoteBody, isDouyinImageNoteEditorUrl } = require(outfile);
    assert.strictEqual(isDouyinImageNoteEditorUrl("https://creator.douyin.com/creator-micro/content/upload?default-tab=3&foo=1"), true);
    assert.strictEqual(isDouyinImageNoteEditorUrl("https://creator.douyin.com/creator-micro/content/upload?default-tab=1"), false);
    assert.strictEqual(isDouyinImageNoteEditorUrl("https://evil.example/creator-micro/content/upload?default-tab=3"), false);
    const content = { title: "周末旅行", description: "完整正文", tags: ["旅行", "#周末"] };
    assert.strictEqual(buildDouyinImageNoteBody(content), "完整正文\n\n#旅行 #周末");
    const files = ["/tmp/first.png", "/tmp/second.jpg"];
    const data = { publishToDraft: true, imagePaths: files, data: content };

    const fixture = editorPage();
    const replies = [];
    await publish(fixture.page, data, fixture.window, {
      reply(_channel, payload) {
        assert.strictEqual(fixture.window._mmRetainedForInspection, true, "回执前必须保留窗口");
        replies.push(payload);
      },
    });
    assert.strictEqual(fixture.title.value, content.title);
    assert.strictEqual(fixture.body.innerText, buildDouyinImageNoteBody(content));
    assert.deepStrictEqual(fixture.actions.find(action => action.type === "upload")?.files, files);
    assert.ok(fixture.actions.some(action => action.type === "show"));
    assert.strictEqual(replies[0].status, false, "没有草稿回执时不能宣称成功");
    assert.strictEqual(replies[0].needsAttention, true);
    assert.match(replies[0].message, /尚未确认/u);
    assert.strictEqual(replies[0].failScreenshot, "/tmp/screenshot.png");
    assert.ok(fixture.actions.every(action => action.type !== "publish"), "不能点击发布");

    for (const [scenario, task, expected] of [
      [editorPage(), { ...data, publishToDraft: false }, /立即发布尚未验收/u],
      [editorPage({ url: "https://creator.douyin.com/creator-micro/content/upload?default-tab=1" }), data, /不是抖音图文编辑页/u],
      [editorPage(), { ...data, imagePaths: Array(36).fill("/tmp/image.jpg") }, /1 至 35 张/u],
    ]) {
      const failures = [];
      await publish(scenario.page, task, scenario.window, { reply: (_, payload) => failures.push(payload) });
      assert.strictEqual(failures[0].status, false);
      assert.match(failures[0].message, expected);
      assert.strictEqual(failures[0].needsAttention, undefined);
      assert.strictEqual(failures[0].closeWindow, true);
      assert.ok(!scenario.actions.some(action => action.type === "upload"));
    }

    for (const wrongField of ["title", "body"]) {
      const mismatch = editorPage({ wrongField });
      const failures = [];
      await publish(mismatch.page, data, mismatch.window, { reply: (_, payload) => failures.push(payload) });
      assert.strictEqual(failures[0].status, false);
      assert.strictEqual(failures[0].needsAttention, true);
      assert.match(failures[0].message, wrongField === "title" ? /标题未完整写入/u : /正文未完整写入/u);
      assert.strictEqual(mismatch.window._mmRetainedForInspection, true);
    }
    console.log("test-dy-image-note-adapter passed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

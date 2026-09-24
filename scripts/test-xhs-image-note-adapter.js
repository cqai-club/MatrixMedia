"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

function fakeEditorPage({ wrongBody = false, wrongTitle = false } = {}) {
  const actions = [];
  const title = {
    value: "",
    textContent: "",
    getBoundingClientRect: () => ({ x: 100, y: 500, width: 500, height: 40 }),
    focus() { document.activeElement = this; },
  };
  const editor = {
    textContent: "",
    innerText: "",
    innerHTML: "",
    isContentEditable: true,
    getBoundingClientRect: () => ({ x: 100, y: 560, width: 500, height: 220 }),
    focus() { document.activeElement = this; },
  };
  const overlay = {
    textContent: "我知道了",
    innerText: "我知道了",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] || null; },
    getBoundingClientRect: () => state.overlayVisible
      ? ({ x: 300, y: 800, width: 160, height: 50 })
      : ({ x: 0, y: 0, width: 0, height: 0 }),
    click() { state.overlayVisible = false; actions.push("dismiss-guide"); },
  };
  const host = {
    getAttribute: name => name === "save-disabled" || name === "submit-disabled" ? "false" : null,
    boundingBox: async () => ({ x: 100, y: 1300, width: 500, height: 80 }),
    getBoundingClientRect: () => ({ x: 100, y: 1300, width: 500, height: 80 }),
  };
  const input = { uploadFile: async (...files) => { actions.push(`upload:${files.length}`); } };
  const state = { overlayVisible: true, saved: false, saveClicks: 0, focused: null };
  const candidates = () => [input, title, editor, host, ...(state.overlayVisible ? [overlay] : [])];
  const lookup = selector => {
    if (selector.includes("data-ebao-") && selector.startsWith("[")) {
      return state.overlayVisible && overlay.getAttribute("data-ebao-xhs-tip-dismiss") === "true" ? overlay : null;
    }
    if (selector.includes("upload-input") || selector.includes("input[type='file']")) return input;
    if (selector.includes("input.d-text") || selector.includes("placeholder*='标题'")) return title;
    if (selector.includes(".tiptap.ProseMirror")) return editor;
    if (selector.includes("xhs-publish-btn")) return state.saved ? null : host;
    if (selector.includes("我知道了")) return state.overlayVisible ? overlay : null;
    return null;
  };
  const document = {
    activeElement: null,
    body: {
      get innerText() {
        return `图片编辑 3/18\n${state.overlayVisible ? "图片可以编辑啦，快来试试吧\n我知道了" : ""}\n${title.value}\n${editor.textContent}`;
      },
      get textContent() { return this.innerText; },
    },
    querySelector: lookup,
    querySelectorAll(selector) {
      if (selector.includes(".img-card") || selector.includes(".image-card")
        || selector.includes(".upload-image-item") || selector.includes(".image-item")) return [];
      if (selector.includes("data-ebao-xhs-tip-dismiss")) return state.overlayVisible && overlay.getAttribute("data-ebao-xhs-tip-dismiss") ? [overlay] : [];
      if (selector === "*") return candidates();
      if (selector.includes("button") || selector.includes("[role='button']")) return state.overlayVisible ? [overlay] : [];
      const found = lookup(selector);
      return found ? [found] : [];
    },
    execCommand(command, _ui, value) {
      if ((command === "insertText" || command === "insertHTML") && document.activeElement === editor) {
        editor.textContent += wrongBody ? "错误正文" : value;
        editor.innerText = editor.textContent;
        editor.innerHTML = editor.textContent;
      }
      return true;
    },
  };
  const page = {
    url: () => state.saved ? "https://creator.xiaohongshu.com/creator/notes" : "https://creator.xiaohongshu.com/publish/publish",
    waitForSelector: async selector => {
      const element = lookup(selector);
      if (!element) throw new Error(`selector missing: ${selector}`);
      return element;
    },
    waitForFunction: async (predicate, _options, ...args) => {
      const result = await page.evaluate(predicate, ...args);
      if (!result) throw new Error("page condition false");
      return { dispose: async () => {} };
    },
    $: async selector => lookup(selector),
    $eval: async (selector, callback, ...args) => callback(lookup(selector), ...args),
    click: async selector => {
      const element = lookup(selector);
      if (!element) throw new Error(`cannot click: ${selector}`);
      if (element === overlay) overlay.click();
      else if (element === title || element === editor) {
        if (state.overlayVisible) throw new Error("guide obscures editor");
        state.focused = element;
        document.activeElement = element;
        actions.push(element === title ? "focus-title" : "focus-body");
      } else if (element === host) {
        state.saved = true;
        state.saveClicks += 1;
        actions.push("save");
      }
    },
    type: async (selector, text) => {
      const element = lookup(selector);
      if (element !== title) throw new Error(`cannot type: ${selector}`);
      title.value += wrongTitle ? "错误标题" : text;
      actions.push("type-title");
    },
    keyboard: {
      press: async key => {
        if (key === "Backspace" && document.activeElement === title) title.value = "";
      },
      type: async text => {
        if (document.activeElement !== editor) throw new Error("body editor not focused");
        actions.push("type-body");
        editor.textContent += wrongBody ? "错误正文" : text;
        editor.innerText = editor.textContent;
        editor.innerHTML = editor.textContent;
      },
      sendCharacter: async text => {
        if (document.activeElement !== editor) throw new Error("body editor not focused");
        actions.push("type-body");
        editor.textContent += wrongBody ? "错误正文" : text;
        editor.innerText = editor.textContent;
        editor.innerHTML = editor.textContent;
      },
    },
    mouse: {
      click: async () => { state.saved = true; state.saveClicks += 1; actions.push("save"); },
      move: async () => {},
    },
    evaluate: async (callback, ...args) => {
      const previous = global.document;
      global.document = document;
      try {
        if (typeof callback === "function") return callback(...args);
        return Function(`return (${callback})`)();
      } finally {
        global.document = previous;
      }
    },
    waitForTimeout: async () => {},
  };
  return { page, state, actions, title, editor, document };
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-image-adapter-test-"));
  try {
    const bundle = path.join(temporary, "adapter.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/services/upLoad/xhsImageNote.js")],
      bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{
        name: "mock-xhs-image-adapter-dependencies",
        setup(builder) {
          const names = ["publishOutcome.js", "uploadTimeouts.js", "xhs.js"];
          builder.onResolve({ filter: /^\.\/(?:publishOutcome|uploadTimeouts|xhs)\.js$/u }, args => ({
            path: names.find(name => args.path.endsWith(name)), namespace: "xhs-image-test",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "xhs-image-test" }, args => ({
            contents: args.path === "publishOutcome.js" ? `
              export const readPageUrl = page => page.url();
              export const replyPublishOutcome = async ({event}) => event.reply("puppeteerFile-done", {status:true});
              export const replyPublishFailure = async ({event,message}) => event.reply("puppeteerFile-done", {status:false,message});
            ` : args.path === "uploadTimeouts.js" ? `
              export const WAIT_SELECTOR_APPEAR_MS = 20;
              export const WAIT_UPLOAD_PROCESSING_MS = 20;
              export async function pollPageUntil(page, predicate, _total, _step, message) {
                if (!await page.evaluate(predicate)) throw new Error(message);
              }
            ` : `export const selectXhsCreativeStatement = async () => true;`,
            loader: "js",
          }));
        },
      }],
    });
    const publish = require(bundle).default;
    const data = {
      imagePaths: ["one.png", "two.png", "three.png"],
      data: { title: "测试标题", description: "完整测试正文", tags: [], creativeStatement: "none" },
      publishToDraft: true,
    };
    for (const scenario of [{}, { wrongBody: true }, { wrongTitle: true }]) {
      const fixture = fakeEditorPage(scenario);
      assert.strictEqual(fixture.document.querySelectorAll(".img-card,.image-card,.upload-image-item,.image-item").length, 0);
      assert.match(fixture.document.body.innerText, /图片编辑 3\/18/u);
      const replies = [];
      await publish(fixture.page, data, null, { reply: (_channel, payload) => replies.push(payload) });
      if (!scenario.wrongBody && !scenario.wrongTitle) {
        assert.strictEqual(replies[0]?.status, true, replies[0]?.message);
        assert.strictEqual(fixture.title.value, data.data.title);
        assert.ok(fixture.editor.textContent.includes(data.data.description));
        assert.strictEqual(fixture.state.saveClicks, 1);
        assert.ok(fixture.actions.indexOf("dismiss-guide") < fixture.actions.indexOf("focus-title"));
        assert.ok(fixture.actions.indexOf("type-body") < fixture.actions.indexOf("save"));
      } else {
        assert.strictEqual(replies[0]?.status, false);
        assert.match(replies[0]?.message || "", scenario.wrongBody ? /正文/u : /标题/u);
        assert.strictEqual(fixture.state.saveClicks, 0, "文字不匹配时不能暂存");
      }
    }
    console.log("test-xhs-image-note-adapter passed");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const webpack = require("webpack");
const { build } = require("esbuild");

const EDITOR_URL = "https://creator.douyin.com/creator-micro/content/upload?default-tab=3";
const FILES = ["/tmp/first.png", "/tmp/second.jpg"];
const CONTENT = { title: "周末旅行", description: "完整正文", tags: ["旅行", "#周末"], creativeStatement: "none" };

function element(text = "", { visible = true, attrs = {}, children = [] } = {}) {
  return {
    textContent: text, innerText: text, children, disabled: false,
    getBoundingClientRect: () => ({ width: visible ? 200 : 0, height: visible ? 100 : 0 }),
    getAttribute: name => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
}

/** 执行真实的浏览器函数，隔离 Node 闭包，页面查询通过可见 DOM fixture 返回。 */
function inBrowser(callback, args, document) {
  return vm.runInNewContext("(" + callback.toString() + ")(...__args)", { document, __args: args });
}

function editorPage({
  url = EDITOR_URL, wrongField = "", uploadState = "ready", previewNames = FILES.map(file => path.basename(file)),
  selectedNames, titleLimit = 30, result = "success", mode = "draft", submitButtons,
  statement = false, statementPicked = true, statementSaved = true, clickError = false, readyAfter = 0,
  preexistingNotice = "", resultRows = false, noBody = false,
  hiddenFields = false, multipleFields = false, fileInputCount = 1,
  noFilename = false, initialOldRemote = false, appendMode = "append", newUrlChanges = false, oldUrlChanges = false,
  mutateAfterStatement = false, statementCheckDelay = 0, statementSaveDelay = 0, inputReplaced = false,
  inputCountAfterFirst, clearedFiles = false,
} = {}) {
  const actions = [];
  const title = { ...element(), value: "旧标题", maxLength: titleLimit };
  const body = { ...element("旧正文") };
  const targetButton = element(mode === "draft" ? "保存草稿" : "发布");
  const buttons = submitButtons || [targetButton, element("取消")];
  let active = null;
  let selected = false;
  let submitted = false;
  let closed = false;
  let pollCount = 0;
  let pollingTime = 0;
  let uploadRound = 0;
  let modalOpen = false;
  let radioChecked = false;
  let radioCheckReads = 0;
  let statementSaveReads = 0;
  let statementConfirmed = false;
  const statementControl = element("请选择自主声明");
  const radio = element();
  radio.click = () => { radioChecked = statementPicked; actions.push({ type: "statement-pick" }); };
  radio.querySelector = () => radioChecked && radioCheckReads++ >= statementCheckDelay ? element() : null;
  const option = element("内容由AI生成");
  option.closest = () => radio;
  const confirm = element("确认");
  const modal = element();
  modal.closest = () => modal;
  modal.querySelectorAll = selector => selector === "button" ? [confirm] : [option];
  confirm.closest = () => modal;
  confirm.click = () => {
    actions.push({ type: "statement-confirm" });
    statementConfirmed = true;
    if (statementSaved && !statementSaveDelay) statementControl.textContent = statementControl.innerText = "内容由AI生成";
    if (mutateAfterStatement && activePreviews.length > 1) activePreviews.reverse();
    modalOpen = false;
  };
  const previewRoot = element();
  const previews = previewNames.map((name, index) => {
    const item = element("", { attrs: noFilename ? {} : { "data-file-name": name } });
    const image = element("", { attrs: { src: "https://p3.douyinpic.com/remote-" + index, alt: noFilename ? "图片预览" : name } });
    image.complete = true; image.naturalWidth = 200;
    image.closest = () => item;
    return image;
  });
  let activePreviews = initialOldRemote ? [previews[0]] : [];
  previewRoot.querySelectorAll = selector => selector === "img" ? activePreviews
    : uploadRound && uploadState === "busy" ? [element()] : [];
  if (uploadState === "local") for (const image of previews) image.currentSrc = "blob:local-preview";
  if (uploadState === "broken") for (const image of previews) image.naturalWidth = 0;
  const makeFileInput = generation => {
    const input = {
      files: [],
      uploadFile: async (...files) => {
        if (inputReplaced && generation !== uploadRound) throw new Error("旧图片input已经被替换");
        actions.push({ type: "upload", files });
        assert.strictEqual(files.length, 1, "每轮必须只分发一张图片");
        input.files = clearedFiles ? [] : (selectedNames || files.map(file => path.basename(file))).map(name => ({ name }));
        uploadRound += 1;
        pollCount = 0;
        const next = previews[uploadRound - 1];
        if (next) activePreviews = appendMode === "replace" ? [next] : [...activePreviews, next];
        if (appendMode === "reorder" && uploadRound > 1) activePreviews.reverse();
        if (appendMode === "extra") activePreviews = [...activePreviews, previews[1]];
        if (oldUrlChanges && uploadRound > 1) activePreviews[0].currentSrc = "https://p3.douyinpic.com/replaced-old";
        if (uploadState === "failed") previewRoot.innerText = "上传失败";
      },
      evaluate: async callback => inBrowser(callback, [input], document),
    };
    return input;
  };
  const fileInput = makeFileInput(0);
  const document = {
    querySelector: selector => {
      if (selector.includes("placeholder*=") || selector.includes("data-ebao-dy-image-title")) return title;
      if (selector.includes("contenteditable") || selector.includes("data-ebao-dy-image-body")) return noBody ? null : body;
      if (selector === ".semi-modal-body") return modalOpen ? modal : null;
      if (selector.includes("data-ebao-dy-statement")) {
        if (statementConfirmed && statementSaved && statementSaveReads++ >= statementSaveDelay) {
          statementControl.textContent = statementControl.innerText = "内容由AI生成";
        }
        return statement ? statementControl : null;
      }
      return null;
    },
    querySelectorAll: selector => {
      if (selector.includes("placeholder*=") || selector.includes("contenteditable")) {
        const primary = selector.includes("placeholder*=") ? title : body;
        if (noBody && primary === body) return [];
        return hiddenFields ? [element("旧隐藏输入框", { visible: false }), primary]
          : multipleFields ? [primary, element("另一个可见输入框")] : [primary];
      }
      if (selector.startsWith(".semi-upload-file-list")) {
        actions.push({ type: "upload-check", round: uploadRound });
        pollCount += 1;
        if (uploadRound && activePreviews.length) {
          const newest = activePreviews[activePreviews.length - 1];
          if (uploadState !== "local") newest.currentSrc = pollCount <= readyAfter ? "blob:still-uploading"
            : newUrlChanges && pollCount === readyAfter + 1 ? "https://p3.douyinpic.com/temporary-" + uploadRound
              : newest.getAttribute("src");
        }
        return [previewRoot];
      }
      if (selector.startsWith('[role="alert"]')) {
        if (!submitted) return preexistingNotice ? [element(preexistingNotice)] : [];
        if (result === "failure") return [element("发布失败：请完成验证")];
        if (result === "success" && !resultRows) return [element(mode === "draft" ? "草稿保存成功" : "图文发布成功")];
        return [];
      }
      if (selector.startsWith("tr,")) {
        if (!submitted || !resultRows) return [];
        const row = element();
        row.querySelectorAll = () => [element(CONTENT.title), element(mode === "draft" ? "草稿" : "已发布")];
        return [row];
      }
      if (selector.startsWith('[class*="selectText"]')) return statement ? [statementControl, ...buttons] : buttons;
      if (selector.startsWith("button,")) return modalOpen ? [...buttons, confirm] : buttons;
      return [];
    },
  };
  const page = {
    url: () => url,
    $$: async () => Array(uploadRound && inputCountAfterFirst !== undefined ? inputCountAfterFirst : fileInputCount)
      .fill(inputReplaced ? makeFileInput(uploadRound) : fileInput),
    waitForSelector: async selector => {
      if (selector.includes("accept*=")) return fileInput;
      if (selector.includes("placeholder*=")) return title;
      if (selector.includes("contenteditable")) {
        if (noBody) throw new Error("editor missing");
        return body;
      }
      if (selector.includes("semi-radio-addon") && modalOpen) return option;
      throw new Error("unexpected selector: " + selector);
    },
    click: async selector => {
      if (selector.includes("data-ebao-dy-image-submit")) {
        submitted = true;
        actions.push({ type: mode === "draft" ? "draft" : "publish" });
        if (result === "navigate-only") url = "https://creator.douyin.com/creator-micro/content/manage";
        if (result === "login") url = "https://creator.douyin.com/login";
        if (clickError) throw new Error("浏览器连接中断");
        return;
      }
      if (selector.includes("data-ebao-dy-statement")) {
        modalOpen = true; actions.push({ type: "statement-open" }); return;
      }
      active = selector.includes("placeholder*=") || selector.includes("data-ebao-dy-image-title") ? title : body;
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
        if (key === "Space") {
          body.innerText = body.textContent += " ";
          actions.push({ type: "tag-commit" });
        }
      },
      type: async text => {
        if (active === title) title.value += wrongField === "title" ? "错误标题" : text;
        else if (active === body) body.innerText = body.textContent += wrongField === "body" ? "错误正文" : text;
        else throw new Error("no focused field");
        actions.push({ type: "type", field: active === title ? "title" : "body" });
      },
    },
    evaluate: async (callback, ...args) => inBrowser(callback, args, document),
    // 每次页面轮询推进 1 ms 测试时间，不依赖操作系统的真实定时器精度。
    waitForTimeout: async () => { pollingTime += 1; },
  };
  const window = {
    isDestroyed: () => closed,
    show: () => actions.push({ type: "show" }),
    focus: () => actions.push({ type: "window-focus" }),
    close: () => { closed = true; actions.push({ type: "close" }); },
  };
  return { page, window, actions, title, body, document, targetButton, now: () => pollingTime };
}

async function publishWithFixtureClock(publish, fixture, task, event) {
  const realNow = Date.now;
  Date.now = fixture.now;
  try {
    await publish(fixture.page, task, fixture.window, event);
  } finally {
    Date.now = realNow;
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dy-image-note-test-"));
  let scenarios = 0;
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
              export const replyPublishFailure = async ({event,message,closeWindow,data}) =>
                event.reply("puppeteerFile-done", {...data,status:false,message,closeWindow});
            ` : args.path.endsWith("failureScreenshot.js")
              ? "export const capturePublishFailureScreenshot = async () => '/tmp/screenshot.png';"
              : "export const WAIT_SELECTOR_APPEAR_MS = 30; export const WAIT_UPLOAD_PROCESSING_MS = 30;",
            loader: "js",
          }));
        },
      }],
    });
    const { default: publish, buildDouyinImageNoteBody, isDouyinImageNoteEditorUrl, readDouyinImageUploadState, readDouyinImageNoteReceipt } = require(outfile);
    assert.strictEqual(isDouyinImageNoteEditorUrl(EDITOR_URL + "&foo=1"), true);
    assert.strictEqual(isDouyinImageNoteEditorUrl(EDITOR_URL.replace("tab=3", "tab=1")), false);
    assert.strictEqual(isDouyinImageNoteEditorUrl("https://evil.example/creator-micro/content/upload?default-tab=3"), false);
    assert.strictEqual(buildDouyinImageNoteBody(CONTENT), "完整正文\n\n#旅行 #周末");
    const data = { publisherWorker: true, publishToDraft: true, imagePaths: FILES, data: CONTENT };
    const run = async (fixture, task = data) => {
      const replies = [];
      await publishWithFixtureClock(publish, fixture, task, { reply: (_channel, payload) => replies.push(payload) });
      assert.strictEqual(replies.length, 1, "每次必须只交付一个结果");
      assert.ok(fixture.actions.filter(action => ["publish", "draft"].includes(action.type)).length <= 1, "最终提交不得重复");
      scenarios += 1;
      return replies[0];
    };
    for (const mode of ["draft", "publish"]) {
      const fixture = editorPage({ mode, readyAfter: 2 });
      const result = await run(fixture, { ...data, publishToDraft: mode === "draft" });
      assert.strictEqual(result.status, true);
      assert.strictEqual(result.needsAttention, undefined, result.message);
      assert.strictEqual(result.outcome, mode === "draft" ? "draft_saved" : "published");
      assert.ok(fixture.window.isDestroyed(), "明确成功必须自动关闭窗口");
      assert.strictEqual(fixture.title.value, CONTENT.title);
      assert.strictEqual(fixture.body.innerText.trim(), buildDouyinImageNoteBody(CONTENT));
      assert.deepStrictEqual(fixture.actions.filter(action => action.type === "upload").map(action => action.files), FILES.map(file => [file]));
      const bodyAt = fixture.actions.findIndex(action => action.type === "type" && action.field === "body");
      const pollAt = fixture.actions.findIndex(action => action.type === "upload-check" && action.round > 0);
      const submitAt = fixture.actions.findIndex(action => action.type === mode);
      assert.ok(bodyAt < pollAt && pollAt < submitAt, "填正文无需先等图片，最终提交必须等待全部图片");
    }
    for (const mode of ["draft", "publish"]) {
      const fixture = editorPage({ mode, resultRows: true });
      const result = await run(fixture, { ...data, publishToDraft: mode === "draft" });
      assert.strictEqual(result.needsAttention, true, "同标题历史记录不能证明本次提交成功");
      assert.strictEqual(result.outcome, "unknown");
    }
    const emptyBody = editorPage();
    const emptyResult = await run(emptyBody, { ...data, data: { ...CONTENT, description: "", tags: [] } });
    assert.strictEqual(emptyResult.outcome, "draft_saved", "纯图片标题贴文允许空正文");
    assert.strictEqual(emptyBody.body.innerText, "");
    const hiddenFields = editorPage({ hiddenFields: true });
    assert.strictEqual((await run(hiddenFields)).outcome, "draft_saved", "隐藏在前的旧输入框不得取代可见编辑框");
    for (const settings of [
      { noFilename: true }, { noFilename: true, newUrlChanges: true },
      { noFilename: true, inputReplaced: true }, { noFilename: true, clearedFiles: true },
    ]) {
      const fixture = editorPage(settings);
      assert.strictEqual((await run(fixture)).outcome, "draft_saved", "无文件名时必须通过逐张追加远端URL绑定");
      const uploads = fixture.actions.filter(action => action.type === "upload");
      assert.deepStrictEqual(uploads.map(action => action.files), FILES.map(file => [file]));
      const secondUploadAt = fixture.actions.findIndex(action => action === uploads[1]);
      assert.ok(fixture.actions.slice(0, secondUploadAt).filter(action => action.type === "upload-check" && action.round === 1).length >= 3,
        "下一张必须在前一张URL稳定并复核后才开始");
    }
    const ai = editorPage({ statement: true });
    assert.strictEqual((await run(ai, { ...data, data: { ...CONTENT, creativeStatement: "ai_generated" } })).needsAttention, undefined);
    assert.ok(ai.actions.some(action => action.type === "statement-pick"));
    assert.ok(ai.actions.some(action => action.type === "statement-confirm"));
    const delayedAi = editorPage({ noFilename: true, statement: true, statementCheckDelay: 3, statementSaveDelay: 3 });
    assert.strictEqual((await run(delayedAi, { ...data, data: { ...CONTENT, creativeStatement: "ai_generated" } })).outcome, "draft_saved",
      "自主声明需等待React异步选中与保存完成");

    for (const [settings, expected] of [
      [{ wrongField: "title" }, /标题未完整写入/u],
      [{ wrongField: "body" }, /正文未完整写入/u],
      [{ titleLimit: 2 }, /超过页面限制/u],
      [{ multipleFields: true }, /多个可见标题/u],
      [{ noBody: true }, /正文输入框/u],
      [{ selectedNames: ["second.jpg", "first.png"] }, /未接收本轮唯一图片/u],
      [{ previewNames: ["second.jpg", "first.png"] }, /显示身份或顺序/u],
      [{ previewNames: ["图片1", "图片2"] }, /显示身份或顺序/u],
      [{ uploadState: "local" }, /上传完成未确认/u],
      [{ uploadState: "broken" }, /上传完成未确认/u],
      [{ uploadState: "busy" }, /上传完成未确认/u],
      [{ uploadState: "failed" }, /图片上传失败/u],
      [{ previewNames: ["first.png"] }, /上传完成未确认/u],
      [{ noFilename: true, appendMode: "replace" }, /被替换或重排/u],
      [{ noFilename: true, appendMode: "reorder" }, /被替换或重排/u],
      [{ noFilename: true, oldUrlChanges: true }, /被替换或重排/u],
      [{ noFilename: true, appendMode: "extra" }, /出现额外图片/u],
      [{ inputCountAfterFirst: 2 }, /唯一的.*图片上传入口/u],
      [{ submitButtons: [element("发布")] }, /保存草稿.*按钮/u],
      [{ submitButtons: [element("保存草稿"), element("存草稿")] }, /唯一可用/u],
      [{ preexistingNotice: "草稿保存成功" }, /已有结果提示/u],
    ]) {
      const fixture = editorPage(settings);
      const result = await run(fixture);
      assert.strictEqual(result.needsAttention, true, expected);
      assert.strictEqual(result.outcome, "failed", expected);
      assert.match(result.message, expected);
      assert.ok(!fixture.actions.some(action => ["publish", "draft"].includes(action.type)), "检查失败前不得提交");
      assert.ok(!fixture.window.isDestroyed(), "编辑失败需保留页面核对");
    }
    const disabled = element("保存草稿"); disabled.disabled = true;
    const disabledFixture = editorPage({ submitButtons: [disabled] });
    assert.match((await run(disabledFixture)).message, /唯一可用/u);
    const hidden = element("保存草稿", { visible: false });
    assert.match((await run(editorPage({ submitButtons: [hidden] }))).message, /唯一可用/u);

    for (const settings of [
      { statement: false }, { statement: true, statementPicked: false }, { statement: true, statementSaved: false },
    ]) {
      const fixture = editorPage(settings);
      const result = await run(fixture, { ...data, data: { ...CONTENT, creativeStatement: "ai_generated" } });
      assert.strictEqual(result.needsAttention, true);
      assert.match(result.message, /自主声明/u);
      assert.ok(!fixture.actions.some(action => action.type === "draft"));
    }
    const unsupportedStatement = editorPage();
    assert.match((await run(unsupportedStatement, { ...data, data: { ...CONTENT, creativeStatement: "self_made_no_repost" } })).message, /不支持所选内容声明/u);
    const changedAfterStatement = editorPage({ noFilename: true, statement: true, mutateAfterStatement: true });
    const changedResult = await run(changedAfterStatement, { ...data, data: { ...CONTENT, creativeStatement: "ai_generated" } });
    assert.match(changedResult.message, /已绑定的图片状态.*发生变化/u);
    assert.ok(!changedAfterStatement.actions.some(action => action.type === "draft"), "声明期间重排后不得提交");
    for (const settings of [
      { result: "pending" }, { result: "navigate-only" }, { result: "login" }, { clickError: true },
    ]) {
      const fixture = editorPage({ mode: "publish", ...settings });
      const result = await run(fixture, { ...data, publishToDraft: false });
      assert.strictEqual(result.needsAttention, true);
      assert.strictEqual(result.publishAbnormal, true);
      assert.strictEqual(result.outcome, "unknown");
      assert.strictEqual(result.status, true, "不确定回执不得触发旧 GUI 的 status:false 自动重试");
      assert.strictEqual(fixture.actions.filter(action => action.type === "publish").length, 1);
      assert.ok(!fixture.window.isDestroyed());
      assert.strictEqual(fixture.window._mmRetainedForInspection, true);
    }
    const rejected = editorPage({ mode: "publish", result: "failure" });
    const rejectedResult = await run(rejected, { ...data, publishToDraft: false });
    assert.strictEqual(rejectedResult.outcome, "failed");
    assert.match(rejectedResult.message, /发布失败.*不会自动重试/u);
    assert.strictEqual(rejectedResult.needsAttention, true);
    assert.strictEqual(rejected.actions.filter(action => action.type === "publish").length, 1);

    for (const [task, settings, expected] of [
      [data, { url: EDITOR_URL.replace("tab=3", "tab=1") }, /不是抖音图文编辑页/u],
      [{ ...data, imagePaths: Array(36).fill("/tmp/image.jpg") }, {}, /1 至 35 张/u],
      [{ ...data, imagePaths: ["relative.jpg"] }, {}, /有效图片/u],
      [{ ...data, imagePaths: ["/tmp/first.png", "/other/first.png"] }, {}, /文件名重复/u],
      [{ ...data, data: { ...CONTENT, title: "" } }, {}, /标题不能为空/u],
      [data, { fileInputCount: 2 }, /唯一的.*图片上传入口/u],
      [data, { initialOldRemote: true }, /编辑页已有图片/u],
    ]) {
      const fixture = editorPage(settings);
      const result = await run(fixture, task);
      assert.strictEqual(result.status, false);
      assert.match(result.message, expected);
      assert.ok(!fixture.actions.some(action => action.type === "upload"));
    }

    // 快照函数还需拒绝隐藏回执、错误内容行及隐藏错误提示；使用真实函数执行而非直接 mock 成功。
    const visibleNotice = element("发布成功");
    const hiddenNotice = element("发布成功", { visible: false });
    const receiptDoc = notices => ({ querySelectorAll: selector => selector.startsWith('[role="alert"]') ? notices : [] });
    assert.strictEqual(inBrowser(readDouyinImageNoteReceipt, [false, CONTENT.title], receiptDoc([visibleNotice])).state, "success");
    assert.strictEqual(inBrowser(readDouyinImageNoteReceipt, [false, CONTENT.title], receiptDoc([hiddenNotice])).state, "pending");
    assert.strictEqual(inBrowser(readDouyinImageNoteReceipt, [true, CONTENT.title], receiptDoc([visibleNotice])).state, "pending");
    assert.strictEqual(inBrowser(readDouyinImageNoteReceipt, [true], receiptDoc([element("保存成功")])).state, "pending", "普通保存提示不能证明草稿成功");
    const uploadFixture = editorPage({ uploadState: "local" });
    assert.strictEqual(inBrowser(readDouyinImageUploadState, [".semi-upload-file-list", ["first.png", "second.jpg"]], uploadFixture.document).ready, false);
    const deliveryFailure = editorPage({ mode: "publish" });
    let attempts = 0;
    await publishWithFixtureClock(publish, deliveryFailure, { ...data, publishToDraft: false }, {
      reply() { attempts += 1; throw new Error("IPC disconnected"); },
    });
    assert.strictEqual(attempts, 1, "回执通道失效不得发送第二份结果或再次提交");
    assert.strictEqual(deliveryFailure.actions.filter(action => action.type === "publish").length, 1);
    scenarios += 1;

    // 沿用正式 esbuild-loader 和 production 压缩，再把注入函数字符串放入独立 VM。
    // Node mock 只隔离网络/截图和缩短等待，不替代任何 DOM 判断。
    const mockDirectory = path.join(directory, "mocks");
    fs.mkdirSync(mockDirectory);
    fs.writeFileSync(path.join(mockDirectory, "publishOutcome.js"), `
      export const readPageUrl = page => page.url();
      export const replyPublishFailure = async ({event,message,closeWindow,data}) =>
        event.reply("puppeteerFile-done", {...data,status:false,message,closeWindow});
    `);
    fs.writeFileSync(path.join(mockDirectory, "failureScreenshot.js"), "export const capturePublishFailureScreenshot = async () => '/tmp/screenshot.png';");
    fs.writeFileSync(path.join(mockDirectory, "uploadTimeouts.js"), "export const WAIT_SELECTOR_APPEAR_MS = 30; export const WAIT_UPLOAD_PROCESSING_MS = 30;");
    const root = path.join(__dirname, "..");
    const config = require(path.join(root, ".electron-vue/webpack.main.config.js"));
    const compiled = path.join(directory, "webpack", "adapter.cjs");
    await new Promise((resolve, reject) => {
      const compiler = webpack({
        mode: "production", target: config.target, context: root,
        entry: path.join(root, "src/main/services/upLoad/dyImageNote.js"),
        module: config.module, externals: config.externals, resolve: config.resolve,
        output: { path: path.dirname(compiled), filename: path.basename(compiled), library: { type: "commonjs2" } },
        optimization: { minimize: true }, infrastructureLogging: { level: "error" },
        plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/(?:publishOutcome|failureScreenshot|uploadTimeouts)\.js$/u, resource => {
          resource.request = path.join(mockDirectory, path.basename(resource.request));
        })],
      });
      compiler.run((error, stats) => compiler.close(closeError => {
        if (error || closeError) return reject(error || closeError);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve();
      }));
    });
    const production = require(compiled);
    for (const settings of [
      { mode: "draft" }, { mode: "publish" }, { mode: "draft", statement: true },
      { mode: "draft", hiddenFields: true },
      { mode: "draft", noFilename: true, inputReplaced: true },
      { mode: "draft", noFilename: true, newUrlChanges: true },
    ]) {
      const fixture = editorPage(settings);
      const replies = [];
      await publishWithFixtureClock(production.default, fixture, {
        ...data, publishToDraft: settings.mode === "draft",
        data: { ...CONTENT, creativeStatement: settings.statement ? "ai_generated" : "none" },
      }, { reply: (_channel, payload) => replies.push(payload) });
      assert.strictEqual(replies.length, 1);
      assert.strictEqual(replies[0].status, true);
      assert.strictEqual(replies[0].needsAttention, undefined, "正式打包后的浏览器注入也必须无 Node 闭包");
      assert.strictEqual(fixture.actions.filter(action => action.type === settings.mode).length, 1);
      assert.strictEqual(fixture.window.isDestroyed(), true);
      scenarios += 1;
    }
    console.log("test-dy-image-note-adapter passed (" + scenarios + " adapter scenarios; DOM upload/receipt checks; production webpack isolated VM)");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");
const path = require("path");

const worker = path.join(__dirname, "..", "src", "main", "publisher-worker");
const id = {
  submission: "11111111-1111-4111-8111-111111111111",
  juejin: "22222222-2222-4222-8222-222222222222",
  toutiao: "33333333-3333-4333-8333-333333333333",
  other: "44444444-4444-4444-8444-444444444444",
};

function makeSubmission(platform = "juejin", accountId = id.juejin, overrides = {}) {
  return {
    id: id.submission, state: "completed", mode: "draft", contentType: "article",
    targets: [{ accountId, platform }], result: { results: [] }, ...overrides,
  };
}

function makeService(submission, account) {
  const calls = [];
  const service = {
    store: { submission: value => value === submission.id ? submission : null },
    accounts: {
      require: value => {
        if (value !== account.id) throw Object.assign(new Error("账号不存在或已删除"), { code: "account-not-found" });
        return account;
      },
      assertIdle: value => calls.push({ idle: value }),
      open: async (_account, url) => {
        calls.push({ url });
        return { ok: true, navigationFailed: false };
      },
    },
  };
  return { service, calls };
}

class FakeWindow extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.minimized = true; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; this.restored = true; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  close() { this.destroyed = true; this.emit("closed"); }
}

(async () => {
  const { openSubmissionTarget, resolveSubmissionOpenTarget } = await import(pathToFileURL(path.join(worker, "submission-open-target.js")));
  const { registerPublishWindow, hasOpenPublishWindow } = await import(pathToFileURL(path.join(worker, "..", "services", "publishWindowRegistry.js")));
  const juejin = { id: id.juejin, platform: "juejin", pt: "掘金", partition: "persist:test_juejin", displayName: "掘金号" };
  const toutiao = { id: id.toutiao, platform: "tt", pt: "头条", partition: "persist:test_toutiao", displayName: "头条号" };
  const saved = makeSubmission("juejin", id.juejin, { result: { results: [
    { accountId: id.juejin, exitCode: 0, status: "draft", draftUrl: "https://juejin.cn/editor/drafts/123456" },
  ] } });
  let { service, calls } = makeService(saved, juejin);
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin }), { kind: "draft" });
  assert.deepStrictEqual(calls.at(-1), { url: "https://juejin.cn/editor/drafts/123456" });
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin, listOnly: true }), { kind: "backend" });
  assert.deepStrictEqual(calls.at(-1), { url: "https://juejin.cn/login" });

  const invalidUrls = [
    "https://juejin.cn.evil.example/editor/drafts/123456",
    "http://juejin.cn/editor/drafts/123456",
    "https://juejin.cn/editor/drafts/new",
    "https://juejin.cn/editor/drafts/NEW",
    "https://juejin.cn/editor/drafts/123456#unsafe",
    "https://juejin.cn/editor/drafts/%2Fadmin",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=123",
  ];
  for (const draftUrl of invalidUrls) {
    const unsafe = makeSubmission("juejin", id.juejin, { result: { results: [
      { accountId: id.juejin, exitCode: 0, status: "draft", draftUrl },
    ] } });
    assert.strictEqual(resolveSubmissionOpenTarget(unsafe, unsafe.targets[0], juejin).kind, "backend", draftUrl);
  }
  for (const outcome of [
    { accountId: id.other, exitCode: 0, status: "draft", draftUrl: "https://juejin.cn/editor/drafts/123456" },
    { accountId: id.juejin, exitCode: 1, status: "draft", draftUrl: "https://juejin.cn/editor/drafts/123456" },
    { accountId: id.juejin, exitCode: 0, status: "unknown", draftUrl: "https://juejin.cn/editor/drafts/123456" },
    { exitCode: 0, status: "draft", draftUrl: "https://juejin.cn/editor/drafts/123456" },
  ]) {
    const oldOrFailed = makeSubmission("juejin", id.juejin, { result: { results: [outcome] } });
    assert.strictEqual(resolveSubmissionOpenTarget(oldOrFailed, oldOrFailed.targets[0], juejin).kind, "backend");
  }
  const ttDraft = makeSubmission("tt", id.toutiao, { result: { results: [
    { accountId: id.toutiao, exitCode: 0, status: "draft", draftUrl: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1&from=list" },
  ] } });
  assert.deepStrictEqual(resolveSubmissionOpenTarget(ttDraft, ttDraft.targets[0], toutiao), {
    kind: "draft", url: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1",
  });
  const multiTarget = makeSubmission("juejin", id.juejin, {
    targets: [
      { accountId: id.juejin, platform: "juejin" },
      { accountId: id.toutiao, platform: "tt" },
    ],
    result: { results: [
      { accountId: id.juejin, exitCode: 0, status: "draft", draftUrl: "https://juejin.cn/editor/drafts/123456" },
      { accountId: id.toutiao, exitCode: 0, status: "draft", draftUrl: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=123" },
    ] },
  });
  assert.strictEqual(resolveSubmissionOpenTarget(multiTarget, multiTarget.targets[0], juejin).url,
    "https://juejin.cn/editor/drafts/123456");
  assert.strictEqual(resolveSubmissionOpenTarget(multiTarget, multiTarget.targets[1], toutiao).url,
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=123");
  for (const url of [
    "https://mp.toutiao.com/profile_v4/graphic/publish",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=bad%2Fid",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=123&pgc_id=456",
    `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${"a".repeat(129)}`,
  ]) {
    const invalid = makeSubmission("tt", id.toutiao, { result: { results: [
      { accountId: id.toutiao, exitCode: 0, status: "draft", draftUrl: url },
    ] } });
    assert.strictEqual(resolveSubmissionOpenTarget(invalid, invalid.targets[0], toutiao).kind, "draft-list");
  }

  // Existing records have no per-account result URL and still get the right list.
  const old = makeSubmission("tt", id.toutiao);
  ({ service, calls } = makeService(old, toutiao));
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "draft-list" });
  assert.deepStrictEqual(calls.at(-1), { url: "https://mp.toutiao.com/profile_v4/manage/draft" });
  const published = makeSubmission("tt", id.toutiao, { mode: "publish", contentType: "video" });
  assert.deepStrictEqual(resolveSubmissionOpenTarget(published, published.targets[0], toutiao), {
    kind: "content-list", url: "https://mp.toutiao.com/profile_v4/manage/content/all",
  });
  const bilibili = { id: id.other, platform: "blbl", pt: "哔哩哔哩", partition: "persist:test_blbl" };
  const video = makeSubmission("blbl", id.other, { mode: "publish", contentType: "video" });
  assert.strictEqual(resolveSubmissionOpenTarget(video, video.targets[0], bilibili).kind, "backend");
  const xhs = { id: id.other, platform: "xhs", pt: "小红书", partition: "persist:test_xhs" };
  const imageDraft = makeSubmission("xhs", id.other, { contentType: "image-note" });
  assert.strictEqual(resolveSubmissionOpenTarget(imageDraft, imageDraft.targets[0], xhs).kind, "backend");

  ({ service, calls } = makeService(saved, juejin));
  service.accounts.open = async (_account, url) => {
    calls.push({ url });
    return { navigationFailed: calls.filter(item => item.url).length === 1 };
  };
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin }), { kind: "backend" });
  assert.deepStrictEqual(calls.filter(item => item.url), [
    { url: "https://juejin.cn/editor/drafts/123456" }, { url: "https://juejin.cn/login" },
  ]);
  ({ service, calls } = makeService(ttDraft, toutiao));
  service.accounts.open = async (_account, url) => {
    calls.push({ url });
    return { navigationFailed: calls.filter(item => item.url).length === 1 };
  };
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "draft-list" });
  assert.deepStrictEqual(calls.filter(item => item.url), [
    { url: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1" },
    { url: "https://mp.toutiao.com/profile_v4/manage/draft" },
  ]);
  service.accounts.open = async (_account, url) => {
    calls.push({ url });
    return { navigationFailed: true };
  };
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), error => error.code === "navigation-failed");
  assert.deepStrictEqual(calls.filter(item => item.url).slice(-3), [
    { url: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1" },
    { url: "https://mp.toutiao.com/profile_v4/manage/draft" },
    { url: "https://mp.toutiao.com/profile_v4/index" },
  ]);

  for (const state of ["queued", "running"]) {
    const pending = makeSubmission("juejin", id.juejin, { state });
    const fake = makeService(pending, juejin);
    await assert.rejects(openSubmissionTarget(fake.service, { submissionId: id.submission, accountId: id.juejin }), error => error.code === "submission-busy");
    assert.strictEqual(fake.calls.length, 0);
  }
  ({ service, calls } = makeService(makeSubmission("tt", id.toutiao, { state: "unknown" }), toutiao));
  const retained = new FakeWindow();
  registerPublishWindow(toutiao.partition, retained, id.submission);
  assert.strictEqual(hasOpenPublishWindow(toutiao.partition), true);
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "review-window" });
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao, listOnly: true }), { kind: "review-window" });
  assert.strictEqual(retained.restored, true);
  assert.strictEqual(retained.shown, true);
  assert.strictEqual(retained.focused, true);
  assert.strictEqual(calls.length, 0);
  retained.close();
  assert.strictEqual(hasOpenPublishWindow(toutiao.partition), false);
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "draft-list" });

  // A completed Toutiao article draft can retain its editor for inspection.
  ({ service, calls } = makeService(ttDraft, toutiao));
  const completedDraftWindow = new FakeWindow();
  registerPublishWindow(toutiao.partition, completedDraftWindow, id.submission);
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "review-window" });
  assert.strictEqual(completedDraftWindow.focused, true);
  assert.strictEqual(calls.length, 0);
  completedDraftWindow.close();

  ({ service, calls } = makeService(makeSubmission("tt", id.toutiao, { state: "failed" }), toutiao));
  const failedDraftWindow = new FakeWindow();
  registerPublishWindow(toutiao.partition, failedDraftWindow, id.submission);
  assert.deepStrictEqual(await openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), { kind: "review-window" });
  assert.strictEqual(failedDraftWindow.focused, true);
  assert.strictEqual(calls.length, 0);
  failedDraftWindow.close();

  // A window retained by another submission must never be surfaced for this one.
  ({ service, calls } = makeService(makeSubmission("tt", id.toutiao, { state: "unknown" }), toutiao));
  const unrelatedWindow = new FakeWindow();
  registerPublishWindow(toutiao.partition, unrelatedWindow, id.other);
  service.accounts.assertIdle = () => {
    throw Object.assign(new Error("该账号的发布窗口仍在打开"), { code: "account-window-open" });
  };
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.toutiao }), error => error.code === "account-window-open");
  assert.strictEqual(unrelatedWindow.focused, undefined);
  assert.strictEqual(calls.length, 0);
  unrelatedWindow.close();

  ({ service } = makeService(saved, juejin));
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.other }), error => error.code === "invalid-target");
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.other, accountId: id.juejin }), error => error.code === "submission-not-found");
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin, listOnly: "yes" }), error => error.code === "invalid-submission");
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin, extra: true }), error => error.code === "invalid-submission");
  const mismatched = makeService(saved, { ...juejin, platform: "tt" });
  await assert.rejects(openSubmissionTarget(mismatched.service, { submissionId: id.submission, accountId: id.juejin }), error => error.code === "invalid-target");
  assert.strictEqual(mismatched.calls.length, 0);
  service.accounts.require = () => { throw Object.assign(new Error("账号不存在或已删除"), { code: "account-not-found" }); };
  await assert.rejects(openSubmissionTarget(service, { submissionId: id.submission, accountId: id.juejin }), error => error.code === "account-not-found");
  console.log("test-submission-open-target passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

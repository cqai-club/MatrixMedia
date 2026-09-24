"use strict";

const assert = require("assert");
const {
  shouldSaveToutiaoDraft,
} = require("../src/main/services/upLoad/ttPublishMode");

assert.strictEqual(
  shouldSaveToutiaoDraft({ requestedDraft: true, hasTagSelector: true }),
  true,
  "有保存草稿入口时，草稿请求应继续保存草稿"
);

for (const hasTagSelector of [false, undefined]) {
  assert.throws(
    () => shouldSaveToutiaoDraft({ requestedDraft: true, hasTagSelector }),
    /没有保存草稿入口.*未点击发布/,
    "草稿入口缺失时，必须终止请求，不能改为直接发布"
  );
}

for (const hasTagSelector of [true, false]) {
  assert.strictEqual(
    shouldSaveToutiaoDraft({ requestedDraft: false, hasTagSelector }),
    false,
    "用户明确选择立即发布时，应保留发布路径"
  );
}

console.log("test-tt-publish-mode passed");

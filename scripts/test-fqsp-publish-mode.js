"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
});

const assert = require("assert");
const { fqspActionLabels } = require("../src/main/services/upLoad/fqsp");

assert.deepStrictEqual(fqspActionLabels(false), ["一键发布"]);
assert.deepStrictEqual(fqspActionLabels(true), ["存草稿", "保存草稿", "暂存"]);
assert.ok(!fqspActionLabels(true).includes("一键发布"), "草稿模式绝不能回退为直接发布");

console.log("test-fqsp-publish-mode passed");

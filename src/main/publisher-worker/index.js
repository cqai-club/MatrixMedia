"use strict";

import { app } from "electron";
import path from "path";
import util from "util";
import pie from "puppeteer-in-electron";
import { initializeElectronRuntime } from "../services/electronStartup.js";
import { startNdjsonServer } from "./protocol.js";
import { PublisherWorkerService } from "./service.js";

function option(name) {
  const direct = process.argv.find(arg => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function log(...args) {
  process.stderr.write(`${util.format(...args).replace(/\r?\n/gu, " ")}\n`);
}

console.log = log;
console.info = log;
console.warn = log;
console.error = log;

const dataRoot = path.resolve(option("--data-dir") || path.join(app.getPath("appData"), "eBao Studio", "publisher"));
app.name = "ebao-publisher-worker";
app.setPath("userData", path.join(dataRoot, "user-data"));
process.env.MATRIXMEDIA_DATA_DIR = path.join(dataRoot, "matrix-data");

async function main() {
  if (!process.argv.includes("--publisher-worker")) {
    log("Publisher Worker 只能由 e宝工坊启动");
    app.exit(2);
    return;
  }
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  if (!app.requestSingleInstanceLock()) {
    process.stderr.write("Publisher Worker 已在运行\n");
    app.exit(2);
    return;
  }
  await initializeElectronRuntime({ app, pie, logger: { log } });
  const service = new PublisherWorkerService(dataRoot);
  service.start();
  const handlers = {
    "system.handshake": () => ({
      protocolVersion: 2,
      workerVersion: "0.2.0",
      platforms: service.capabilities().map(item => item.platform),
      modes: ["publish", "draft"],
    }),
    "system.capabilities": () => service.capabilities(),
    "system.health": () => service.health(),
    "system.shutdown": () => {
      setImmediate(() => { void service.dispose().finally(() => app.quit()); });
      return { ok: true };
    },
    "accounts.list": () => service.accounts.list(),
    "accounts.create": params => service.accounts.create(params),
    "accounts.update": params => service.accounts.update(params),
    "accounts.delete": params => service.accounts.remove(params),
    "accounts.openLogin": params => service.accounts.openLogin(params),
    "accounts.checkLogin": params => service.accounts.check(params),
    "accounts.openDashboard": params => service.accounts.openDashboard(params),
    "accounts.importPreview": () => service.accounts.importPreview(),
    "accounts.importApply": () => service.accounts.importApply(),
    "submissions.create": params => service.createSubmission(params),
    "submissions.list": () => service.store.listSubmissions(),
  };
  const stopProtocol = startNdjsonServer({ input: process.stdin, output: process.stdout, handlers });
  process.stdin.resume();
  process.stdin.once("end", () => {
    stopProtocol();
    void service.dispose().finally(() => app.quit());
  });
}

main().catch(error => {
  log("Publisher Worker 启动失败:", error && error.stack ? error.stack : error);
  app.exit(1);
});

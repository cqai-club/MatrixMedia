"use strict";

import { app } from "electron";
import fs from "fs";
import net from "net";
import path from "path";
import util from "util";
import pie from "puppeteer-in-electron";
import { initializeElectronRuntime } from "../services/electronStartup.js";
import { startNdjsonServer } from "./protocol.js";
import { PublisherWorkerService } from "./service.js";
import { openSubmissionTarget } from "./submission-open-target.js";

function option(name) {
  const direct = process.argv.find(arg => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function log(...args) {
  try {
    process.stderr?.write(`${util.format(...args).replace(/\r?\n/gu, " ")}\n`);
  } catch {
    // A packaged Windows GUI executable may have no usable stderr handle.
  }
}

console.log = log;
console.info = log;
console.warn = log;
console.error = log;

const dataRoot = path.resolve(option("--data-dir") || path.join(app.getPath("appData"), "eBao Studio", "publisher"));
const publisherPipe = process.platform === "win32" ? process.env.EBAO_PUBLISHER_PIPE : "";
const publisherPipeToken = process.platform === "win32" ? process.env.EBAO_PUBLISHER_PIPE_TOKEN : "";
if (process.platform === "win32") {
  delete process.env.EBAO_PUBLISHER_PIPE;
  delete process.env.EBAO_PUBLISHER_PIPE_TOKEN;
}
const bootTraceEnabled = process.env.EBAO_PUBLISHER_WORKER_BOOT_TRACE === "1";
function traceBoot(stage) {
  if (!bootTraceEnabled) return;
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.appendFileSync(path.join(dataRoot, "boot-trace.log"), `${stage}\n`);
  } catch {
    // Startup diagnostics must never prevent the Worker from running.
  }
}

traceBoot("entry");
app.on("before-quit", () => traceBoot("before-quit"));
process.once("exit", code => traceBoot(`exit:${code}`));
app.name = "ebao-publisher-worker";
app.setPath("userData", path.join(dataRoot, "user-data"));
process.env.MATRIXMEDIA_DATA_DIR = path.join(dataRoot, "matrix-data");
// A publish/login BrowserWindow can be the only window. Closing it must not
// terminate the NDJSON Worker while later targets remain in the serial queue.
app.on("window-all-closed", () => {
  log("[publisher-worker] 所有窗口已关闭，继续等待发布队列或 Supervisor 指令");
});

async function main() {
  if (!process.argv.includes("--publisher-worker")) {
    traceBoot("invalid-launch");
    log("Publisher Worker 只能由 e宝工坊启动");
    app.exit(2);
    return;
  }
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  if (!app.requestSingleInstanceLock()) {
    traceBoot("lock-denied");
    log("Publisher Worker 已在运行");
    app.exit(2);
    return;
  }
  traceBoot("lock");
  if (process.platform === "win32" && (!publisherPipe || !/^[0-9a-f]{64}$/iu.test(publisherPipeToken || ""))) {
    traceBoot("pipe-config-invalid");
    throw new Error("Publisher Worker 缺少有效的本地管道配置");
  }
  await initializeElectronRuntime({ app, pie, logger: { log } });
  traceBoot("electron-ready");
  const service = new PublisherWorkerService(dataRoot);
  service.start();
  traceBoot("service-ready");
  let stopProtocol = () => {};
  let disposing = false;
  const disposeAndQuit = () => {
    if (disposing) return;
    disposing = true;
    stopProtocol();
    void service.dispose().catch(error => log("Publisher Worker 清理失败:", error)).finally(() => app.quit());
  };
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
      traceBoot("shutdown");
      setImmediate(disposeAndQuit);
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
    "submissions.delete": params => service.deleteSubmission(params),
    "submissions.openTarget": params => openSubmissionTarget(service, params),
  };
  let input = process.stdin;
  let output = process.stdout;
  if (process.platform === "win32") {
    const socket = net.createConnection(publisherPipe);
    try {
      await new Promise((resolve, reject) => {
        const onConnect = () => {
          socket.removeListener("error", onError);
          resolve();
        };
        const onError = error => {
          socket.removeListener("connect", onConnect);
          reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
    } catch (error) {
      traceBoot("pipe-connect-error");
      socket.destroy();
      throw error;
    }
    traceBoot("pipe-connect");
    socket.on("error", () => { traceBoot("pipe-error"); disposeAndQuit(); });
    socket.once("end", () => { traceBoot("pipe-end"); disposeAndQuit(); });
    socket.once("close", () => { traceBoot("pipe-close"); disposeAndQuit(); });
    socket.write(`${JSON.stringify({ auth: publisherPipeToken })}\n`);
    traceBoot("pipe-auth-write");
    input = socket;
    output = socket;
  } else {
    process.stdin.once("end", () => { traceBoot("stdin-end"); disposeAndQuit(); });
  }
  stopProtocol = startNdjsonServer({ input, output, handlers });
  traceBoot("protocol-ready");
  input.resume();
}

main().catch(error => {
  traceBoot("startup-error");
  log("Publisher Worker 启动失败:", error && error.stack ? error.stack : error);
  app.exit(1);
});

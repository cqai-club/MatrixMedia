"use strict";

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PublisherProtocolError } from "./protocol.js";

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function publicAccount(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    platform: account.platform,
    loginState: account.loginState || "unknown",
    ...(typeof account.loginError === "string" && account.loginError ? { loginError: account.loginError } : {}),
    ...(Number.isFinite(account.expiresAt) ? { expiresAt: account.expiresAt } : {}),
  };
}

export function publicSubmission(submission) {
  const state = ["queued", "running", "completed", "failed", "unknown"].includes(submission.state)
    ? submission.state : "unknown";
  const diagnostic = typeof submission.message === "string" && submission.message.trim()
    ? submission.message
    : state === "unknown" && Array.isArray(submission.result?.results)
      ? submission.result.results.find(item => item?.status === "unknown" && typeof item.message === "string")?.message
      : undefined;
  const message = typeof diagnostic === "string"
    ? diagnostic.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200)
    : "";
  return {
    id: submission.id,
    createdAt: submission.createdAt,
    contentId: submission.contentId || submission.workId,
    contentType: submission.contentType || "video",
    ...(submission.workId ? { workId: submission.workId } : {}),
    title: submission.title,
    mode: submission.mode,
    state,
    ...(message ? { message } : {}),
    targets: submission.targets.map(target => ({
      accountId: target.accountId,
      platform: target.platform,
      accountName: target.accountName,
    })),
  };
}

export class PublisherStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.accountsFile = path.join(this.root, "accounts.json");
    this.submissionsFile = path.join(this.root, "submissions.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.accountsState = readJson(this.accountsFile, { schemaVersion: 2, accounts: [] });
    this.submissionsState = readJson(this.submissionsFile, { schemaVersion: 2, submissions: [] });
    if (!Array.isArray(this.accountsState.accounts)) this.accountsState.accounts = [];
    if (!Array.isArray(this.submissionsState.submissions)) this.submissionsState.submissions = [];
    if (this.accountsState.schemaVersion !== 2) {
      this.accountsState.schemaVersion = 2;
      this.saveAccounts();
    }
    if (this.submissionsState.schemaVersion !== 2 || this.submissionsState.submissions.some(item => !item.contentType || !item.contentId)) {
      for (const item of this.submissionsState.submissions) {
        item.contentType ||= "video";
        item.contentId ||= item.workId;
      }
      this.submissionsState.schemaVersion = 2;
      this.saveSubmissions();
    }
  }

  listAccountsRaw() { return [...this.accountsState.accounts]; }
  listAccounts() { return this.listAccountsRaw().map(publicAccount); }
  account(id) { return this.accountsState.accounts.find(item => item.id === id); }

  addAccount(input) {
    const id = input.id || randomUUID();
    const account = {
      id,
      displayName: input.displayName,
      platform: input.platform,
      pt: input.pt,
      // MatrixMedia's legacy upload path strips suffixes after a dash. Keep the
      // UUID as the public identity, but use a dash-free Chromium partition so
      // two e宝 accounts can never collapse onto the same `persist:ebao` session.
      partition: input.partition || `persist:ebao_${id.replace(/-/gu, "")}`,
      loginState: input.loginState || "unknown",
      ...(input.autoName ? { autoName: true } : {}),
      createdAt: input.createdAt || new Date().toISOString(),
      ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
      ...(input.proxy ? { proxy: input.proxy } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.credentialCiphertext ? { credentialCiphertext: input.credentialCiphertext } : {}),
    };
    this.accountsState.accounts.push(account);
    this.saveAccounts();
    return account;
  }

  updateAccount(id, patch) {
    const account = this.account(id);
    if (!account) return null;
    Object.assign(account, patch);
    this.saveAccounts();
    return account;
  }

  deleteAccount(id) {
    const before = this.accountsState.accounts.length;
    this.accountsState.accounts = this.accountsState.accounts.filter(item => item.id !== id);
    if (before === this.accountsState.accounts.length) return false;
    this.saveAccounts();
    return true;
  }

  findImported(platform, partition) {
    return this.accountsState.accounts.find(item => item.platform === platform && item.partition === partition);
  }

  saveAccounts() { atomicWrite(this.accountsFile, this.accountsState); }

  createSubmission(input, accounts) {
    const submission = {
      id: input.id || randomUUID(),
      createdAt: new Date().toISOString(),
      contentType: input.contentType || "video",
      contentId: input.contentId || input.workId,
      ...(input.revision ? { revision: input.revision } : {}),
      ...(input.workId ? { workId: input.workId } : {}),
      ...(input.file ? { file: input.file } : {}),
      ...(input.snapshotDirectory ? { snapshotDirectory: input.snapshotDirectory } : {}),
      title: input.title,
      description: input.description || "",
      summary: input.summary || "",
      shortTitle: input.shortTitle || "",
      tags: input.tags || [],
      creativeStatement: input.creativeStatement || "none",
      mode: input.mode,
      state: "queued",
      targets: accounts.map(account => ({
        accountId: account.id,
        platform: account.platform,
        accountName: account.displayName,
      })),
    };
    const next = { ...this.submissionsState, submissions: [...this.submissionsState.submissions, submission] };
    atomicWrite(this.submissionsFile, next);
    this.submissionsState = next;
    return submission;
  }

  submissionsRaw() { return [...this.submissionsState.submissions]; }
  listSubmissions() {
    return this.submissionsRaw()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicSubmission);
  }
  queued() { return this.submissionsState.submissions.filter(item => item.state === "queued"); }
  submission(id) { return this.submissionsState.submissions.find(item => item.id === id); }
  updateSubmission(id, patch) {
    const submission = this.submission(id);
    if (!submission) return null;
    Object.assign(submission, patch);
    this.saveSubmissions();
    return submission;
  }
  deleteFinishedSubmission(id, acknowledgeUnknown = false) {
    const submission = this.submission(id);
    if (!submission) throw new PublisherProtocolError("submission-not-found", "提交记录不存在，请刷新发布历史");
    if (submission.state === "queued" || submission.state === "running") {
      throw new PublisherProtocolError("submission-busy", "提交仍在排队或执行，不能删除；删除历史不会取消发布任务");
    }
    if (submission.state === "unknown" && acknowledgeUnknown !== true) {
      throw new PublisherProtocolError("submission-unknown", "提交结果尚未确认，不能删除；请先到平台后台核对");
    }
    if (submission.state !== "completed" && submission.state !== "failed" && submission.state !== "unknown") {
      throw new PublisherProtocolError("submission-not-finished", "只能删除已完成或已失败的提交记录");
    }
    const next = { ...this.submissionsState, submissions: this.submissionsState.submissions.filter(item => item.id !== id) };
    atomicWrite(this.submissionsFile, next);
    this.submissionsState = next;
    return submission;
  }
  recoverInterrupted() {
    let changed = false;
    for (const submission of this.submissionsState.submissions) {
      if (submission.state === "running") {
        submission.state = "unknown";
        submission.finishedAt = new Date().toISOString();
        submission.message = "上次运行被中断，未自动重试，请到平台后台确认";
        changed = true;
      }
    }
    if (changed) this.saveSubmissions();
  }
  saveSubmissions() { atomicWrite(this.submissionsFile, this.submissionsState); }
}

export { atomicWrite };

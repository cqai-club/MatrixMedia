"use strict";

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

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
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

export function publicAccount(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    platform: account.platform,
    loginState: account.loginState || "unknown",
    ...(Number.isFinite(account.expiresAt) ? { expiresAt: account.expiresAt } : {}),
  };
}

export function publicSubmission(submission) {
  return {
    id: submission.id,
    createdAt: submission.createdAt,
    workId: submission.workId,
    title: submission.title,
    mode: submission.mode,
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
    this.accountsState = readJson(this.accountsFile, { schemaVersion: 1, accounts: [] });
    this.submissionsState = readJson(this.submissionsFile, { schemaVersion: 1, submissions: [] });
    if (!Array.isArray(this.accountsState.accounts)) this.accountsState.accounts = [];
    if (!Array.isArray(this.submissionsState.submissions)) this.submissionsState.submissions = [];
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
      createdAt: input.createdAt || new Date().toISOString(),
      ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
      ...(input.proxy ? { proxy: input.proxy } : {}),
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
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      workId: input.workId,
      file: input.file,
      title: input.title,
      description: input.description || "",
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
    this.submissionsState.submissions.push(submission);
    this.saveSubmissions();
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

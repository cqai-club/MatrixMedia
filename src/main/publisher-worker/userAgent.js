"use strict";

/** Keep Toutiao's Worker UA consistent with the bundled Chromium and UA-CH. */
export function publisherUserAgent(platform, configured, chromeVersion = process.versions.chrome, os = process.platform) {
  if (platform !== "头条" || !/^\d+\.\d+\.\d+\.\d+$/u.test(String(chromeVersion || ""))) return configured;
  const system = os === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : os === "win32" ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  const major = String(chromeVersion).split(".")[0];
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

import { ipcMain, session } from "electron";
import { checkCookieLogin } from "./accountLoginState.js";

export default function () {
  ipcMain.on("getCookie", async (event, args) => {
    try {
      const ses = session.fromPartition(args.partition);
      const cookies = await ses.cookies.get({ url: args.url });
      const state = checkCookieLogin(args.pt, cookies);
      const loginExpiresAtMs = state.expiresAt;
      const expiry = loginExpiresAtMs == null ? "" : ` expires=${new Date(loginExpiresAtMs).toUTCString()};`;
      const result = state.loginState === "logged-in" ? `${args.name}=true;${expiry} path=/` : "";

      event.reply("getCookie-done", {
        taskId: args.taskId,
        success: true,
        result: result,
        flagName: args.name,
        loginExpiresAtMs,
        pt: args.pt,
        cookies,
      });
    } catch (err) {
      console.error("获取 cookie 失败:", err);
      event.reply("getCookie-done", {
        taskId: args.taskId,
        success: false,
        error: err.message,
        flagName: args.name,
      });
    }
  });
}

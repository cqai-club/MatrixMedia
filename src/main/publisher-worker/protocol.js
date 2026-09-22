"use strict";

const MAX_FRAME_BYTES = 1024 * 1024;

export class PublisherProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublisherProtocolError";
    this.code = code;
  }
}

export function encodeResponse(id, result) {
  return `${JSON.stringify({ id, result })}\n`;
}

export function encodeError(id, error) {
  const code = error && error.code ? String(error.code) : "worker-error";
  const message = error && error.message ? String(error.message) : "发布引擎发生未知错误";
  return `${JSON.stringify({ id, error: { code, message } })}\n`;
}

export function createFrameDecoder(onFrame, onError) {
  let pending = "";
  return chunk => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) {
          pending = "";
          onError(new PublisherProtocolError("frame-too-large", "Publisher Worker 请求超过 1 MB"));
        }
        break;
      }
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        onError(new PublisherProtocolError("frame-too-large", "Publisher Worker 请求超过 1 MB"));
        continue;
      }
      try {
        onFrame(JSON.parse(line));
      } catch {
        onError(new PublisherProtocolError("invalid-json", "Publisher Worker 收到无效 JSON"));
      }
    }
  };
}

export function startNdjsonServer({ input, output, handlers }) {
  let writeTail = Promise.resolve();
  const write = payload => {
    writeTail = writeTail.then(() => new Promise((resolve, reject) => {
      output.write(payload, error => (error ? reject(error) : resolve()));
    }));
    return writeTail;
  };
  const dispatch = async frame => {
    const id = frame && typeof frame.id === "string" ? frame.id : "";
    const method = frame && typeof frame.method === "string" ? frame.method : "";
    if (!id || !method) {
      await write(encodeError(id, new PublisherProtocolError("invalid-request", "请求缺少 id 或 method")));
      return;
    }
    const handler = handlers[method];
    if (typeof handler !== "function") {
      await write(encodeError(id, new PublisherProtocolError("method-not-found", `不支持的方法：${method}`)));
      return;
    }
    try {
      await write(encodeResponse(id, await handler(frame.params || {})));
    } catch (error) {
      await write(encodeError(id, error));
    }
  };
  const decode = createFrameDecoder(
    frame => { void dispatch(frame); },
    error => { void write(encodeError("", error)); }
  );
  input.on("data", decode);
  return () => input.removeListener("data", decode);
}

export { MAX_FRAME_BYTES };

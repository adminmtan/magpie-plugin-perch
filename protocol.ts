/** Shared text, bounded JSON and SSE parsing. */
export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
    public readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
const MAX_TEXT = 1_048_576;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("upstream_protocol", "上游返回了不支持的数据结构。");
  }
  return value as Record<string, unknown>;
}

function parse(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    throw new ProviderError("upstream_protocol", "上游响应不是预期的 JSON 对象。");
  }
}

export async function readObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProviderError("upstream_protocol", "上游响应正文为空。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TEXT) throw new ProviderError("upstream_limit", "上游响应超过大小限制。");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Parses complete SSE events, independent of transport chunk and UTF-8 boundaries. */
export async function* readEvents(response: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new ProviderError("upstream_protocol", "上游流正文为空。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let eventSize = 0;

  function dispatch() {
    const body = data.join("\n");
    const eventName = event;
    data = [];
    event = "";
    eventSize = 0;
    return { event: eventName, data: body };
  }

  try {
    let ended = false;
    while (!ended) {
      const chunk = await reader.read();
      ended = chunk.done;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // EOF dispatches a final unterminated event; do not discard buffered content.
      if (ended) buffer += "\n\n";
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        eventSize += encoder.encode(line).byteLength;
        if (eventSize > MAX_TEXT) throw new ProviderError("upstream_limit", "上游事件超过大小限制。");
        if (!line) {
          const item = dispatch();
          if (item.data || item.event) yield item;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          if (field === "event") event = value;
        }
      }
      if (buffer.length + eventSize > MAX_TEXT) {
        throw new ProviderError("upstream_limit", "上游事件超过大小限制。");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}


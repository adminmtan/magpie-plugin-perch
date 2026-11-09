import { afterAll, beforeEach, expect, test } from "bun:test";
import magpie from "../magpie";

const encoder = new TextEncoder();
let scenario = "normal";
let calls: { path: string; body: Record<string, unknown>; cookie: string | null; origin: string | null; authorization: string | null }[] = [];
let created = 0;
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const body = await request.json() as Record<string, unknown>;
  calls.push({ path, body, cookie: request.headers.get("cookie"), origin: request.headers.get("origin"), authorization: request.headers.get("authorization") });
  if (path === "/api/perchai/threads") {
    if (scenario === "auth") return new Response("PRIVATE_SESSION", { status: 401 });
    if (scenario === "forbidden") return new Response("PRIVATE_SESSION", { status: 403 });
    if (scenario === "redirect") return new Response(null, { status: 307, headers: { Location: "/should-not-follow" } });
    if (scenario === "html") return new Response("PRIVATE_SESSION", { headers: { "Content-Type": "text/html" } });
    if (scenario === "bad-thread") return Response.json({ ok: true, thread: { id: 123 } });
    return Response.json({ ok: true, thread: { id: `thread-${++created}` } });
  }
  if (path === "/api/perchai/chat/stop") return Response.json({ ok: true });
  if (path !== "/api/perchai/chat") return new Response("wrong endpoint", { status: 404 });
  if (scenario === "rate") return new Response("PRIVATE_SESSION", { status: 429, headers: { "Retry-After": "7" } });
  if (scenario === "bad-rate") return new Response("PRIVATE_SESSION", { status: 429, headers: { "Retry-After": "PRIVATE_SESSION" } });
  if (["bad-json", "unknown", "big-event", "event-error"].includes(scenario)) {
    const wire = scenario === "bad-json" ? "data: PRIVATE_SESSION\n\n"
      : scenario === "unknown" ? 'data: {"type":"unknown","text":"PRIVATE_SESSION"}\n\n'
      : scenario === "event-error" ? 'event: error\ndata: {"message":"PRIVATE_SESSION"}\n\n'
      : `data: ${"a".repeat(1_048_577)}\n\n`;
    return new Response(wire, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (scenario === "slow") return new Response(new ReadableStream<Uint8Array>({ start(output) {
    output.enqueue(encoder.encode('data: {"type":"status","phase":"thinking"}\n\n'));
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const events = scenario === "eof" ? [{ type: "answer_delta", text: "不完整" }]
    : scenario === "error" ? [{ type: "done", ok: false, error: "PRIVATE_SESSION" }]
    : scenario === "final" ? [{ type: "done", ok: true, text: "最终正文" }]
    : scenario === "rewrite" ? [{ type: "answer_delta", text: "草稿" }, { type: "done", ok: true, text: "修订" }]
    : scenario === "promo" ? [{ type: "done", ok: false, errorCode: "promo_overflow_decision", error: "PRIVATE_SESSION" }]
    : [
      { type: "status", phase: "thinking" }, { type: "reasoning_delta", text: "PRIVATE_REASONING" },
      { type: "answer_delta", text: "你好" }, { type: "citations", citations: [] },
      { type: "answer_delta", text: "😀" }, { type: "done", ok: true, text: "你好😀" },
    ];
  const bytes = encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(output) {
    if (offset === bytes.length) return output.close();
    output.enqueue(bytes.slice(offset, ++offset));
  } }), { headers: { "Content-Type": "text/event-stream" } });
} });
afterAll(() => upstream.stop(true));
beforeEach(() => { scenario = "normal"; calls = []; created = 0; });

async function client(timeoutMs = 1000) {
  const hooks = await magpie(undefined, { fixtureBaseUrl: `http://127.0.0.1:${upstream.port}`, requestTimeoutMs: timeoutMs } as Parameters<typeof magpie>[1]);
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "session=local-only" }));
  return (messages: unknown = [{ role: "user", content: "你好" }], stream = false, signal?: AbortSignal, extra = {}) => loader.fetch("https://chat.perchai.app/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer gateway-secret", "x-magpie-session": "local-session" },
    body: JSON.stringify({ model: "perch-default", messages, stream, ...extra }), signal,
  });
}

test("真实网页流程先建 thread，再发送 message，非流式聚合 answer_delta", async () => {
  const send = await client();
  const response = await send();
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe("你好😀");
  expect(calls.map(call => call.path)).toEqual(["/api/perchai/threads", "/api/perchai/chat"]);
  expect(calls[0]!.body).toEqual({});
  expect(calls[1]!.body).toMatchObject({ threadId: "thread-1", message: "你好", webSearch: false, roostChoice: "standard", manualModelOptionId: null, promoOverflowAccepted: false });
  expect(typeof calls[1]!.body.clientMessageId).toBe("string");
  expect(calls.every(call => call.cookie === "session=local-only" && call.authorization === null && call.origin === `http://127.0.0.1:${upstream.port}`)).toBe(true);
});

test("流式转换只输出答案，稳定 id，必须收到 done 才输出 stop/DONE", async () => {
  const send = await client();
  const response = await send(undefined, true);
  expect(response.status).toBe(200);
  const wire = await response.text();
  const events = wire.trim().split("\n\n").map(event => event.slice(6));
  expect(events.pop()).toBe("[DONE]");
  const chunks = events.map(event => JSON.parse(event));
  expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(1);
  expect(chunks.map(chunk => chunk.choices[0].delta.content ?? "").join("")).toBe("你好😀");
  expect(new Set(chunks.map(chunk => chunk.created)).size).toBe(1);
  expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
  expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  expect(wire).not.toContain("PRIVATE_REASONING");
});

test("成功后沿原 thread 续聊，不重放历史", async () => {
  const send = await client();
  await (await send()).text();
  const next = await send([{ role: "user", content: "你好" }, { role: "assistant", content: "你好😀" }, { role: "user", content: "继续" }]);
  expect(next.status).toBe(200);
  await next.text();
  expect(created).toBe(1);
  expect(calls.filter(call => call.path === "/api/perchai/chat").map(call => [call.body.threadId, call.body.message])).toEqual([["thread-1", "你好"], ["thread-1", "继续"]]);
});

test("未知历史和 system 不静默展平，不发上游调用", async () => {
  const send = await client();
  expect((await send([{ role: "system", content: "规则" }, { role: "user", content: "你好" }])).status).toBe(400);
  expect((await send([{ role: "user", content: "之前" }, { role: "assistant", content: "答" }, { role: "user", content: "继续" }])).status).toBe(409);
  expect(calls).toHaveLength(0);
});

test("缺少 done、失败 done 和后台修订不输出假成功", async () => {
  for (const value of ["eof", "error", "rewrite"]) {
    scenario = value;
    const send = await client();
    const response = await send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("PRIVATE_SESSION");
  }
});

test("done 单独携带正文也能输出", async () => {
  scenario = "final";
  const send = await client();
  expect((await (await send()).json()).choices[0].message.content).toBe("最终正文");
});

test("上游鉴权、权限、限流和额外额度确认均明确失败且不重试", async () => {
  for (const [value, status, code] of [["auth", 401, "upstream_auth"], ["forbidden", 403, "upstream_forbidden"], ["rate", 429, "upstream_rate_limit"], ["promo", 402, "upstream_allowance_confirmation"]] as const) {
    scenario = value;
    calls = [];
    const send = await client();
    const response = await send();
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(response.headers.get("x-magpie-sign-in")).toBe(value === "auth" ? "expired" : null);
    expect(response.headers.get("retry-after")).toBe(value === "rate" ? "7" : null);
    expect(calls.filter(call => call.path === "/api/perchai/chat").length).toBeLessThanOrEqual(1);
    expect(calls.filter(call => call.path === "/api/perchai/threads")).toHaveLength(1);
  }
});

test("不转发畸形的上游 Retry-After，本地账号忙给出短暂等待提示", async () => {
  scenario = "bad-rate";
  const send = await client();
  expect((await send()).headers.get("retry-after")).toBeNull();
  scenario = "slow";
  const active = await send(undefined, true);
  expect((await send()).headers.get("retry-after")).toBe("1");
  await active.body!.cancel();
});

test("超时会停止已发出的远程生成", async () => {
  scenario = "slow";
  const send = await client(60);
  const response = await send();
  expect(response.status).toBe(504);
  expect(calls.some(call => call.path === "/api/perchai/chat/stop" && call.body.threadId === "thread-1")).toBe(true);
});

test("不支持的温度与工具参数在创建会话前被拒绝", async () => {
  const send = await client();
  expect((await send(undefined, false, undefined, { temperature: 1 })).status).toBe(400);
  expect((await send(undefined, false, undefined, { tools: [] })).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("兼容 Magpie v0.1.3337 的最小模型探测参数", async () => {
  const send = await client();
  expect((await send(undefined, false, undefined, { max_tokens: 16 })).status).toBe(200);
  expect((await send(undefined, false, undefined, { max_tokens: 32 })).status).toBe(400);
  expect((await send(undefined, false, undefined, { max_completion_tokens: 16 })).status).toBe(400);
  expect(calls.filter(call => call.path === "/api/perchai/chat")).toHaveLength(1);
});

test("流中断会失败，不输出成功结束帧", async () => {
  for (const value of ["eof", "error", "rewrite"]) {
    scenario = value;
    const send = await client();
    const reader = (await send(undefined, true)).body!.getReader();
    let wire = "";
    let failed = false;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        wire += new TextDecoder().decode(item.value);
      }
    } catch { failed = true; }
    finally { reader.releaseLock(); }
    expect(failed).toBe(true);
    expect(wire).not.toContain("[DONE]");
    expect(wire).not.toContain('"finish_reason":"stop"');
  }
});

test("下游取消会停止生成并释放账号并发限制", async () => {
  scenario = "slow";
  const send = await client();
  const response = await send(undefined, true);
  expect((await send()).status).toBe(429);
  await response.body!.cancel();
  expect(calls.filter(call => call.path === "/api/perchai/chat/stop")).toHaveLength(1);
  scenario = "normal";
  expect((await (await send()).json()).choices[0].message.content).toBe("你好😀");
});

test("不读取响应的流也受总超时限制并释放账号", async () => {
  scenario = "slow";
  const send = await client(60);
  const response = await send(undefined, true);
  for (let attempt = 0; attempt < 60 && !calls.some(call => call.path.endsWith("/stop")); attempt++) await Bun.sleep(5);
  expect(calls.some(call => call.path.endsWith("/stop"))).toBe(true);
  await expect(response.text()).rejects.toMatchObject({ code: "upstream_timeout" });
  scenario = "normal";
  expect((await send()).status).toBe(200);
});

test("历史按凭据和客户端会话隔离，失败续聊不能重放", async () => {
  const hooks = await magpie(undefined, { fixtureBaseUrl: `http://127.0.0.1:${upstream.port}` });
  let cookie = "session=first";
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: cookie }));
  const first = [{ role: "user", content: "你好" }];
  const history = [...first, { role: "assistant", content: "你好😀" }, { role: "user", content: "继续" }];
  const send = (messages: typeof first, session = "one") => loader.fetch("https://chat.perchai.app/v1/chat/completions", {
    method: "POST", headers: { "x-magpie-session": session }, body: JSON.stringify({ model: "perch-default", messages }),
  });
  await (await send(first)).text();
  cookie = "session=second";
  expect((await send(history)).status).toBe(409);
  cookie = "session=first";
  expect((await send(history, "two")).status).toBe(409);
  expect(calls.filter(call => call.path.endsWith("/chat"))).toHaveLength(1);
  scenario = "error";
  expect((await send(history)).status).toBe(502);
  scenario = "normal";
  expect((await send(history)).status).toBe(409);
});

test("重定向、HTML、错误 thread 与畸形事件安全失败", async () => {
  for (const value of ["redirect", "html", "bad-thread", "bad-json", "unknown", "big-event", "event-error"]) {
    scenario = value;
    calls = [];
    const send = await client();
    const response = await send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("PRIVATE_SESSION");
    expect(calls.some(call => call.path === "/should-not-follow")).toBe(false);
    if (["redirect", "html", "bad-thread"].includes(value)) expect(calls).toHaveLength(1);
  }
});

test("调用前或读取过程中可以取消", async () => {
  const send = await client();
  expect((await send(undefined, false, AbortSignal.abort())).status).toBe(499);
  expect(calls).toHaveLength(0);
  scenario = "slow";
  const abort = new AbortController();
  const response = await send(undefined, true, abort.signal);
  const content = response.text();
  abort.abort();
  await expect(content).rejects.toMatchObject({ code: "request_cancelled" });
  expect(calls.filter(call => call.path.endsWith("/stop"))).toHaveLength(1);
});

test("无效模型、消息角色、额外字段和多模态在出站前拒绝", async () => {
  const send = await client();
  for (const messages of [[], [{ role: "assistant", content: "end" }], [{ role: "user", content: [{ type: "image_url" }] }], [{ role: "user", content: "x", tool_calls: [] }]]) {
    expect((await send(messages)).status).toBe(400);
  }
  expect((await send(undefined, false, undefined, { model: "unknown" })).status).toBe(400);
  expect((await send(undefined, false, undefined, { stream: "yes" })).status).toBe(400);
  expect(calls).toHaveLength(0);
});

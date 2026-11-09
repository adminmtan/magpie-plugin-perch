import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// Runs the unmodified host.js from a separately obtained Magpie source checkout.
const host = process.argv[2];
if (!host || !await Bun.file(host).exists()) throw new Error("用法：npm run test:magpie -- <Magpie v0.1.3337 的 internal/plugin/host.js 绝对路径>");
const workspace = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "perch-host-probe-"));
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(request.headers.get("cookie"), "local-fixture-only");
  assert.equal(request.headers.get("authorization"), null);
  const body = await request.json();
  if (new URL(request.url).pathname === "/api/perchai/threads") {
    assert.deepEqual(body, {});
    return Response.json({ ok: true, thread: { id: crypto.randomUUID() } });
  }
  assert.ok(body.message === "你好" || body.message === "继续");
  const answer = body.message === "你好" ? "你好" : "继续回答";
  return new Response(`data: ${JSON.stringify({ type: "answer_delta", text: answer })}\n\ndata: ${JSON.stringify({ type: "done", ok: true, text: answer })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
} });
try {
const child = Bun.spawn([process.execPath, resolve(host)], {
  cwd: temporary, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
// Drain diagnostics without writing third-party content or credentials to logs.
const diagnostics = new Response(child.stderr).text();
const timer = setTimeout(() => child.kill(), 10_000);
const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
let buffered = "";
let nextId = 0;

async function rpc(method: string, params: unknown) {
  const id = ++nextId;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  await child.stdin.flush();
  const frames: Record<string, any>[] = [];
  while (true) {
    let newline = buffered.indexOf("\n");
    if (newline < 0) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Magpie 宿主提前关闭，请检查目标源码与运行时版本。");
      buffered += chunk.value;
      continue;
    }
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.id !== id) continue;
    if (frame.error) throw new Error("Magpie 宿主拒绝了兼容性测试请求。");
    frames.push(frame);
    if ("result" in frame) return { result: frame.result, frames };
  }
}

try {
  const initialized = await rpc("init", {
    authPath: join(temporary, "fixture-auth.json"), directory: temporary,
    plugins: [{ spec: workspace, target: workspace, options: { fixtureBaseUrl: `http://127.0.0.1:${fixture.port}/fixture` } }],
  });
  assert.equal(initialized.result.plugins[0].error, undefined);
  assert.deepEqual(initialized.result.plugins[0].provides, ["perch-ai"]);
  const providers = await rpc("providers", {});
  const provider = providers.result.find((entry: { id?: string }) => entry.id === "perch-ai");
  assert.ok(provider?.models.some((model: { id?: string }) => model.id === "perch-default"));
  assert.equal(provider.maxConcurrency, 1);
  const signed = await rpc("apiKey", { provider: "perch-ai", method: 0, key: "local-fixture-only" });
  assert.equal(signed.result.ok, true);
  const account = signed.result.account;
  const loaded = await rpc("load", { provider: "perch-ai", account });
  assert.equal(loaded.result.fetch, true);
  assert.equal(loaded.result.baseURL, "https://chat.perchai.app/v1");
  for (const stream of [false, true]) {
    const reply = await rpc("fetch", {
      provider: "perch-ai", account, model: "perch-default", npm: "@ai-sdk/openai-compatible",
      url: "https://chat.perchai.app/v1/chat/completions", method: "POST", headers: {},
      body: Buffer.from(JSON.stringify({ model: "perch-default", messages: [{ role: "user", content: "你好" }], stream })).toString("base64"),
    });
    assert.equal(reply.frames.find(frame => frame.event === "head")?.status, 200);
    const content = reply.frames.filter(frame => frame.event === "chunk").map(frame => Buffer.from(frame.data, "base64").toString("utf8")).join("");
    if (stream) { assert.ok(content.includes("你好")); assert.ok(content.includes("data: [DONE]")); }
    else assert.equal(JSON.parse(content).choices[0].message.content, "你好");
  }
  const first = await rpc("fetch", {
    provider: "perch-ai", account, model: "perch-default", npm: "@ai-sdk/openai-compatible",
    url: "https://chat.perchai.app/v1/chat/completions", method: "POST", headers: {}, session: "host-session-1",
    body: Buffer.from(JSON.stringify({ model: "perch-default", messages: [{ role: "user", content: "你好" }], stream: false })).toString("base64"),
  });
  assert.equal(first.frames.find(frame => frame.event === "head")?.status, 200);
  const continued = await rpc("fetch", {
    provider: "perch-ai", account, model: "perch-default", npm: "@ai-sdk/openai-compatible",
    url: "https://chat.perchai.app/v1/chat/completions", method: "POST", headers: {}, session: "host-session-1",
    body: Buffer.from(JSON.stringify({ model: "perch-default", messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "你好" }, { role: "user", content: "继续" }], stream: false })).toString("base64"),
  });
  assert.equal(continued.frames.find(frame => frame.event === "head")?.status, 200);
  console.log("Magpie 原版宿主验证通过：加载、模型发现、模拟凭据、session 续聊、自定义 fetch、JSON 与 SSE（仅本机夹具）。");
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  await child.exited;
  await diagnostics;
  reader.releaseLock();
}
} finally {
  fixture.stop(true);
  await rm(temporary, { recursive: true, force: true });
}

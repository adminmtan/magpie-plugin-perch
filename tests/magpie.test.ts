import { afterAll, expect, test } from "bun:test";
import magpie from "../magpie";

const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  expect(request.headers.get("cookie")).toBe("session=fixture");
  expect(request.headers.get("authorization")).toBeNull();
  const body = await request.json();
  if (new URL(request.url).pathname === "/api/perchai/threads") {
    expect(body).toEqual({});
    return Response.json({ ok: true, thread: { id: crypto.randomUUID() } });
  }
  expect(body.message).toBe("你好");
  return new Response('data: {"type":"answer_delta","text":"你好"}\n\ndata: {"type":"done","ok":true,"text":"你好"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
} });
afterAll(() => upstream.stop(true));

test("真实宿主入口只导出插件工厂，不把错误类识别成工厂", async () => {
  expect(Object.keys(await import("../magpie"))).toEqual(["default"]);
  const hooks = await magpie();
  const config: { provider?: Record<string, any> } = {};
  await hooks.config(config);
  expect(config.provider?.["perch-ai"].npm).toBe("@ai-sdk/openai-compatible");
  expect(config.provider?.["perch-ai"].models["perch-default"].tool_call).toBe(false);
  expect(hooks.auth.provider).toBe("perch-ai");
  const output = { headers: {} as Record<string, string> };
  await hooks["chat.headers"]({ sessionID: "conversation-1", model: { providerID: "perch-ai" } }, output);
  expect(output.headers).toEqual({ "X-Magpie-Session": "conversation-1" });
});

test("插件默认配置不覆盖用户已有的 Perch Provider", async () => {
  const hooks = await magpie();
  const existing = { name: "用户配置", api: "http://127.0.0.1:9999/v1", models: {} };
  const config: { provider?: Record<string, any> } = { provider: { "perch-ai": existing } };
  await hooks.config(config);
  expect(config.provider?.["perch-ai"]).toBe(existing);
});

test("包声明 GitHub 来源、插件发现信息和单账号并发限制", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(pkg.version).toBe("0.0.2");
  expect(pkg.repository).toEqual({ type: "git", url: "https://github.com/adminmtan/magpie-plugin-perch.git" });
  expect(pkg.keywords).toEqual(expect.arrayContaining(["opencode", "opencode-plugin", "provider", "magpie", "perch"]));
  expect(pkg.magpie).toMatchObject({
    name: "Perch AI",
    summary: { zh: "通过 Perch 网页会话提供实验性文本对话", en: "Experimental Perch web text provider" },
    maxConcurrency: 1,
  });
});

test("默认不向未经验证的 Perch 端点发送凭据", async () => {
  const hooks = await magpie();
  const loader = await hooks.auth.loader(async () => { throw new Error("should not request credentials"); });
  const response = await loader.fetch("https://chat.perchai.app/v1/chat/completions", { method: "POST", body: "{}" });
  expect(response.status).toBe(501);
  expect((await response.json()).error.code).toBe("perch_protocol_unverified");
});

test("宿主 fetch → 本机协议夹具 → OpenAI JSON/SSE", async () => {
  const hooks = await magpie(undefined, { fixtureBaseUrl: `http://127.0.0.1:${upstream.port}/fixture` });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "session=fixture" }));
  for (const stream of [false, true]) {
    const response = await loader.fetch("https://chat.perchai.app/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer gateway-key-must-not-leak" },
      body: JSON.stringify({ model: "perch-default", messages: [{ role: "user", content: "你好" }], stream }),
    });
    expect(response.status).toBe(200);
    if (stream) expect(await response.text()).toContain("data: [DONE]");
    else expect((await response.json()).choices[0].message.content).toBe("你好");
  }
});

test("模拟入口不可指定远程站点，错误请求安全失败", async () => {
  await expect(magpie(undefined, { fixtureBaseUrl: "https://chat.perchai.app" })).rejects.toThrow("仅允许本机");
  const hooks = await magpie(undefined, { fixtureBaseUrl: `http://127.0.0.1:${upstream.port}/fixture` });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "session=fixture" }));
  const response = await loader.fetch("https://elsewhere.invalid/v1/chat/completions", { method: "POST", body: "{}" });
  expect(response.status).toBe(400);
});

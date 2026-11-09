import { afterAll, expect, test } from "bun:test";
import { startDemo } from "../demo";

const demo = await startDemo(0);
const base = `http://127.0.0.1:${demo.port}`;
afterAll(() => demo.stop(true));
const send = (messages: unknown, extra = {}) => fetch(`${base}/v1/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", "x-magpie-session": "demo-test" },
  body: JSON.stringify({ model: "perch-default", messages, ...extra }),
});

test("本地启动提供健康状态、模型、普通与流式对话", async () => {
  expect((await (await fetch(`${base}/health`)).json()).mode).toBe("local-mock");
  expect((await (await fetch(`${base}/v1/models`)).json()).data[0].id).toBe("perch-default");
  for (const stream of [false, true]) {
    const response = await send([{ role: "user", content: "你好" }], { stream });
    expect(response.status).toBe(200);
    if (stream) {
      const wire = await response.text();
      expect(wire).toContain("data: [DONE]");
      const text = wire.split("\n\n").filter(frame => frame.startsWith("data: {")).map(frame => JSON.parse(frame.slice(6)).choices[0].delta.content ?? "").join("");
      expect(text).toBe("模拟回复：你好");
    } else expect((await response.json()).choices[0].message.content).toBe("模拟回复：你好");
  }
});

test("演示沿正式入口续聊，并拒绝非法请求", async () => {
  const first = [{ role: "user", content: "第一条" }];
  const result = await (await send(first)).json();
  const next = await send([...first, result.choices[0].message, { role: "user", content: "第二条" }]);
  expect((await next.json()).choices[0].message.content).toBe("模拟回复：第二条");
  expect((await send(first, { temperature: 0.5 })).status).toBe(400);
  expect((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "bad json" })).status).toBe(400);
});

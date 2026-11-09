import magpie from "./magpie";
import { ProviderError } from "./protocol";

/** Production hooks against a local thread/chat fixture, without real credentials. */
export async function startDemo(port = 8787) {
  let forward: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    maxRequestBodySize: 1_048_576,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok", mode: "local-mock" });
      if (path === "/v1/models" && request.method === "GET") {
        return Response.json({ object: "list", data: [{ id: "perch-default", object: "model", created: 0, owned_by: "local-mock" }] });
      }
      if (path.startsWith("/api/perchai/") && request.method === "POST") {
        if (request.headers.get("cookie") !== "session=local-demo-only") return new Response("Unauthorized", { status: 401 });
        if (path === "/api/perchai/threads") return Response.json({ ok: true, thread: { id: crypto.randomUUID() } });
        if (path === "/api/perchai/chat/stop") return Response.json({ ok: true });
        if (path !== "/api/perchai/chat") return new Response("Not found", { status: 404 });
        const payload = await request.json() as { message: string };
        const reply = `模拟回复：${payload.message}`;
        const encoder = new TextEncoder();
        const parts = Array.from(reply);
        return new Response(new ReadableStream<Uint8Array>({
          pull(output) {
            const text = parts.shift();
            const event = text === undefined ? { type: "done", ok: true, text: reply } : { type: "answer_delta", text };
            output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            if (text === undefined) output.close();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (path !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!forward) return new Response("Starting", { status: 503 });
      return forward(request);
    },
  });
  try {
    const hooks = await magpie(undefined, { fixtureBaseUrl: `http://127.0.0.1:${server.port}` });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "session=local-demo-only" }));
    forward = async request => {
      const response = await loader.fetch("https://chat.perchai.app/v1/chat/completions", {
        method: "POST", body: await request.text(), signal: request.signal,
        headers: { "x-magpie-session": request.headers.get("x-magpie-session") ?? "" },
      });
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) return response;
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const item = await reader.read();
            if (item.done) { reader.releaseLock(); output.close(); }
            else output.enqueue(item.value);
          } catch (error) {
            const safe = error instanceof ProviderError ? error : new ProviderError("upstream_stream", "上游流中断。");
            output.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error: { code: safe.code, message: safe.message } })}\n\n`));
            reader.releaseLock();
            output.close();
          }
        },
        async cancel() { await reader.cancel(); reader.releaseLock(); },
      });
      return new Response(stream, { headers: response.headers });
    };
    return server;
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

if (import.meta.main) {
  const server = await startDemo();
  console.log(`本地模拟演示已启动：http://127.0.0.1:${server.port}（未连接真实 Perch / Magpie）`);
}

import magpie from "../magpie";

/** Live smoke test for an already authenticated Perch tab. No credentials are
 * exported: the browser supplies its own cookies. This does NOT test standalone
 * Bun Cookie authentication or the NAS gateway. Invoking run creates one thread
 * and two generations; invoking cancel creates a separate generation to stop.
 */
const scope = globalThis as unknown as Record<string, any>;
const previousBun = scope.Bun;
// The adapter's only Bun-specific operation is hashing its in-memory keys.
// This test-only exact-string interner preserves equality without pretending to
// validate Bun's SHA-256 implementation. It receives only a dummy auth marker.
const keys = new Map<string, string>();
scope.Bun = { CryptoHasher: class {
  private value = "";
  constructor(_algorithm: string) {}
  update(value: string) { this.value += value; return this; }
  digest(_encoding: string) {
    if (!keys.has(this.value)) keys.set(this.value, String(keys.size + 1));
    return keys.get(this.value)!;
  }
} };

async function loader() {
  if (location.origin !== "https://chat.perchai.app") throw new Error("Only run on Perch.");
  const hooks = await magpie(undefined, { experimentalWeb: true });
  return hooks.auth.loader(async () => ({ type: "api", key: "browser-session-marker" }));
}
const messages = (content: string) => [{ role: "user", content }];
scope.__perchLiveTest = {
  cleanup() {
    keys.clear();
    if (previousBun === undefined) delete scope.Bun; else scope.Bun = previousBun;
    delete scope.__perchLiveTest;
    return { temporaryStateCleared: true };
  },
  async run() {
    const client = await loader();
    const send = (history: { role: string; content: string }[], stream = false) => client.fetch("https://chat.perchai.app/v1/chat/completions", {
      method: "POST", headers: { "x-magpie-session": "browser-live" },
      body: JSON.stringify({ model: "perch-default", messages: history, stream }),
    });
    const history = messages("接口测试：请记住测试词‘青竹’，只回复‘已记住青竹’。");
    const first = await send(history);
    const json = await first.json();
    if (!first.ok) return { phase: "json", status: first.status, error: json.error };
    history.push(json.choices[0].message, { role: "user", content: "上轮记住的测试词是什么？请只回复测试词。" });
    const second = await send(history, true);
    if (!second.ok) return { phase: "stream", status: second.status, error: await second.json() };
    const reader = second.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    let reads = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        reads++;
        wire += decoder.decode(item.value, { stream: true });
      }
      wire += decoder.decode();
    } finally { reader.releaseLock(); }
    const frames = wire.trim().split("\n\n").map(frame => frame.slice(6));
    const done = frames.pop() === "[DONE]";
    const chunks = frames.map(frame => JSON.parse(frame));
    const answer = chunks.map(chunk => chunk.choices[0].delta.content ?? "").join("");
    const wrongSession = await client.fetch("https://chat.perchai.app/v1/chat/completions", {
      method: "POST", headers: { "x-magpie-session": "another-session" },
      body: JSON.stringify({ model: "perch-default", messages: history }),
    });
    return {
      json: { status: first.status, object: json.object, answer: json.choices[0].message.content, fabricatedUsage: "usage" in json },
      stream: { status: second.status, reads, answer, done, stableId: new Set(chunks.map(chunk => chunk.id)).size === 1,
        stableCreated: new Set(chunks.map(chunk => chunk.created)).size === 1,
        role: chunks[0]?.choices[0].delta.role, finishReason: chunks.at(-1)?.choices[0].finish_reason },
      historyRemembered: answer.includes("青竹"), differentSessionStatus: wrongSession.status,
      authScope: "browser-managed cookies; standalone Bun Cookie auth unverified",
    };
  },
  async cancel() {
    const client = await loader();
    const abort = new AbortController();
    const response = await client.fetch("https://chat.perchai.app/v1/chat/completions", {
      method: "POST", signal: abort.signal,
      body: JSON.stringify({ model: "perch-default", messages: messages("取消测试，请逐条写出一百个简单的中文成语。"), stream: true }),
    });
    if (!response.ok) return { status: response.status, error: await response.json() };
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    reader.releaseLock();
    return { status: response.status, cancellationCompleted: true };
  },
};

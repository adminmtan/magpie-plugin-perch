import { ProviderError, readEvents, readObject, type TextMessage } from "./protocol";

interface WebRequest {
  body: unknown;
  cookie: string;
  signal?: AbortSignal;
  session?: string;
}

interface WebOptions {
  baseUrl: string;
  timeoutMs: number;
}

interface ChatBody {
  model: "perch-default";
  messages: TextMessage[];
  stream?: boolean;
}

function badRequest(message: string): never { throw new ProviderError("invalid_request", message, 400); }

function validate(body: unknown): ChatBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) badRequest("请求必须为 JSON 对象。");
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some(key => !["model", "messages", "stream"].includes(key))) badRequest("网页接口不支持这些参数，第一版仅接受 model/messages/stream。");
  if (data.model !== "perch-default") badRequest("不支持该模型。");
  if (data.stream !== undefined && typeof data.stream !== "boolean") badRequest("stream 必须为布尔值。");
  if (!Array.isArray(data.messages) || !data.messages.length || data.messages.length > 256) badRequest("messages 必须包含 1 至 256 条文本消息。");
  let size = 0;
  for (let index = 0; index < data.messages.length; index++) {
    const message: unknown = data.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) badRequest("仅支持文本消息。");
    const entry = message as Record<string, unknown>;
    if (entry.role !== (index % 2 === 0 ? "user" : "assistant") || typeof entry.content !== "string") badRequest("仅支持以 user 开始、交替排列的 user/assistant 文本，暂不支持 system 或工具。");
    if (Object.keys(entry).some(key => !["role", "content"].includes(key))) badRequest("消息包含不支持的字段。");
    size += entry.content.length;
  }
  const last = data.messages.at(-1) as TextMessage;
  if (last.role !== "user" || !last.content.trim() || size > 1_048_576) badRequest("最后一条必须为非空 user 文本，且历史不能超过大小限制。");
  return data as unknown as ChatBody;
}

function protocol(message: string): never { throw new ProviderError("upstream_protocol", message); }

function retryAfter(response: Response): string | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d{1,6}$/.test(value)) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.now() && time <= Date.now() + 7 * 24 * 60 * 60_000 ? new Date(time).toUTCString() : undefined;
}

/** Owns account isolation, thread continuity and the stateful Perch web wire protocol. */
export function createWebClient(options: WebOptions) {
  const threads = new Map<string, { id: string; until: number }>();
  const busy = new Set<string>();
  const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
  const key = (account: string, session: string, messages: TextMessage[]) => hash([account, session, messages.map(({ role, content }) => [role, content])]);

  return async function completion(request: WebRequest): Promise<Response> {
    const body = validate(request.body);
    if (typeof request.cookie !== "string" || !request.cookie.trim() || /[\r\n]/.test(request.cookie)) {
      throw new ProviderError("invalid_auth", "请配置不含换行的 Perch Cookie。", 401);
    }
    const account = hash(request.cookie);
    const session = request.session ?? "";
    for (const [entry, thread] of threads) if (thread.until <= Date.now()) threads.delete(entry);
    const previousKey = key(account, session, body.messages.slice(0, -1));
    const previous = body.messages.length > 1 ? threads.get(previousKey) : undefined;
    if (body.messages.length > 1 && !previous) throw new ProviderError("history_unavailable", "未找到匹配的 Perch 会话，请用单条 user 消息开启新会话；不自动重放历史。", 409);
    if (busy.has(account)) throw new ProviderError("account_busy", "该 Perch 账号已有进行中的请求。", 429, { "Retry-After": "1" });
    if (request.signal?.aborted) throw new ProviderError("request_cancelled", "请求已取消。", 499);
    busy.add(account);
    const abort = new AbortController();
    let timeout = false;
    let cancelled = false;
    let threadId = previous?.id;
    let generation = false;
    let remoteFinished = false;
    let disposed: Promise<void> | undefined;
    let response: Response | undefined;
    const cancel = () => { cancelled = true; abort.abort(); };
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timeout = true; abort.abort(); }, options.timeoutMs);
    const headers = {
      "Content-Type": "application/json", Accept: "text/event-stream",
      Cookie: request.cookie, Origin: options.baseUrl, Referer: `${options.baseUrl}/`,
    };
    function safe(error: unknown) {
      if (timeout) return new ProviderError("upstream_timeout", "上游请求超时。", 504);
      if (cancelled) return new ProviderError("request_cancelled", "请求已取消。", 499);
      return error instanceof ProviderError ? error : new ProviderError("upstream_connection", "上游连接或响应读取失败。");
    }
    const dispose = () => disposed ??= (async () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      abort.abort();
      await response?.body?.cancel().catch(() => {});
      if (generation && !remoteFinished && threadId) {
        // Cancel only the thread this request started/continued; never retry generation.
        await fetch(`${options.baseUrl}/api/perchai/chat/stop`, {
          method: "POST", headers, body: JSON.stringify({ threadId }),
          redirect: "manual", signal: AbortSignal.timeout(3000),
        }).then(reply => reply.body?.cancel()).catch(() => {});
      }
      busy.delete(account);
    })();
    abort.signal.addEventListener("abort", () => { queueMicrotask(() => { void dispose(); }); }, { once: true });
    async function post(path: string, payload: unknown, contentType: string): Promise<Response> {
      const reply = await fetch(`${options.baseUrl}${path}`, {
        method: "POST", headers: { ...headers, Accept: contentType }, body: JSON.stringify(payload),
        signal: abort.signal, redirect: "manual",
      });
      if (!reply.ok || reply.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== contentType) {
        await reply.body?.cancel().catch(() => {});
        if (!reply.ok) {
          const status = reply.status;
          const code = status === 401 ? "upstream_auth" : status === 403 ? "upstream_forbidden" : status === 429 ? "upstream_rate_limit" : "upstream_http";
          const responseHeaders: Record<string, string> = {};
          if (status === 401) responseHeaders["X-Magpie-Sign-In"] = "expired";
          const wait = status === 429 ? retryAfter(reply) : undefined;
          if (wait) responseHeaders["Retry-After"] = wait;
          throw new ProviderError(code, `Perch 请求失败（HTTP ${status}）。`, [401, 403, 429].includes(status) ? status : 502, responseHeaders);
        }
        protocol("Perch 响应类型不符合网页协议。");
      }
      return reply;
    }

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let answer = "";
    let saved = false;
    async function* deltas(): AsyncGenerator<string> {
      try {
        for await (const item of readEvents(response!)) {
          if (item.event === "error") throw new ProviderError("upstream_error", "Perch 返回错误事件。");
          if (!item.data || ["ping", "heartbeat"].includes(item.event)) continue;
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(item.data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            event = parsed as Record<string, unknown>;
          } catch { protocol("Perch 流事件不是预期的 JSON 对象。"); }
          if (["status", "reasoning_delta", "citations", "ping", "heartbeat"].includes(String(event.type))) continue;
          if (event.type === "answer_delta") {
            if (typeof event.text !== "string") protocol("Perch 答案事件缺少文本。");
            answer += event.text;
            if (answer.length > 1_048_576) throw new ProviderError("upstream_limit", "Perch 回复超过大小限制。");
            if (event.text) yield event.text;
          } else if (event.type === "done") {
            remoteFinished = true;
            if (event.ok !== true) {
              if (event.errorCode === "promo_overflow_decision") throw new ProviderError("upstream_allowance_confirmation", "Perch 要求在网页中确认额外额度，本插件不会自动确认。", 402);
              throw new ProviderError("upstream_error", "Perch 生成失败。");
            }
            if (event.stopped === true) throw new ProviderError("upstream_stopped", "Perch 生成已被停止。");
            if (event.text !== undefined && typeof event.text !== "string") protocol("Perch 完成事件文本格式错误。");
            if (typeof event.text === "string" && event.text !== answer) {
              if (answer) protocol("Perch 完成文本与已输出的增量不一致。");
              answer = event.text;
              if (answer.length > 1_048_576) throw new ProviderError("upstream_limit", "Perch 回复超过大小限制。");
              if (answer) yield answer;
            }
            saved = true;
            return;
          } else protocol("Perch 返回了尚不支持的事件类型。");
        }
        protocol("Perch 流在 done 事件前结束，回复可能不完整。");
      } finally {
        if (saved) {
          const history = [...body.messages, { role: "assistant" as const, content: answer }];
          threads.set(key(account, session, history), { id: threadId!, until: Date.now() + 30 * 60_000 });
          while (threads.size > 128) threads.delete(threads.keys().next().value!);
        }
      }
    }

    try {
      if (!threadId) {
        const result = await readObject(await post("/api/perchai/threads", {}, "application/json"));
        const thread = result.thread as { id?: unknown } | undefined;
        if (result.ok !== true || !thread || typeof thread.id !== "string" || !thread.id || thread.id.length > 512) protocol("Perch 未返回有效的会话 ID。");
        threadId = thread.id;
      }
      // Continuing spends this exact history once, even if the network outcome is unknown.
      if (previous) threads.delete(previousKey);
      generation = true;
      response = await post("/api/perchai/chat", {
        threadId, message: body.messages.at(-1)!.content, clientMessageId: crypto.randomUUID(),
        webSearch: false, roostChoice: "standard", manualModelOptionId: null, promoOverflowAccepted: false,
      }, "text/event-stream");
      if (!body.stream) {
        for await (const _text of deltas()) { /* The validated final answer is collected above. */ }
        await dispose();
        return Response.json({ id, object: "chat.completion", created, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
      }
      const encode = new TextEncoder();
      const frame = (delta: object, finish_reason: "stop" | null = null) => encode.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      async function* chunks() {
        try {
          yield frame({ role: "assistant" });
          for await (const text of deltas()) yield frame({ content: text });
          await dispose();
          yield frame({}, "stop");
          yield encode.encode("data: [DONE]\n\n");
        } finally { await dispose(); }
      }
      const iterator = chunks();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const item = await iterator.next();
            if (item.done) output.close(); else output.enqueue(item.value);
          } catch (error) {
            // Do not turn a broken upstream into a successful stop/DONE sequence.
            const failure = safe(error);
            await dispose();
            output.error(failure);
          }
        },
        async cancel() {
          cancel();
          await iterator.return(undefined);
          await response?.body?.cancel().catch(() => {});
          await dispose();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    } catch (error) {
      const failure = safe(error);
      await response?.body?.cancel().catch(() => {});
      await dispose();
      throw failure;
    }
  };
}

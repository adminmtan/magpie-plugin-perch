import { ProviderError } from "./protocol";
import { createWebClient } from "./perch-web";

const ID = "perch-ai";
const SITE = "https://chat.perchai.app";

interface PluginOptions {
  /** Local contract fixture only; never an alternative production endpoint. */
  fixtureBaseUrl?: string;
  experimentalWeb?: boolean;
  requestTimeoutMs?: number;
}

interface StoredAuth {
  type: string;
  key?: string;
}

interface ChatHeadersInput {
  sessionID?: string;
  model?: { providerID?: string };
  provider?: { info?: { id?: string } };
}

/** OpenCode hooks used by Magpie v0.1.3337. Export only this factory at runtime. */
export default async function magpiePerch(input?: { magpie?: { option(provider: string, key: string): unknown } }, options: PluginOptions = {}) {
  let fixture: URL | undefined;
  if (options.fixtureBaseUrl !== undefined) {
    try {
      fixture = new URL(options.fixtureBaseUrl);
      if (fixture.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(fixture.hostname) || fixture.username || fixture.password) throw new Error();
    } catch {
      throw new Error("fixtureBaseUrl 仅允许本机 HTTP 模拟服务。");
    }
  }
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("requestTimeoutMs 必须为 1 至 300000 毫秒。");
  const completion = createWebClient({ baseUrl: fixture?.origin ?? SITE, timeoutMs });

  return {
    async config(config: { provider?: Record<string, unknown> }) {
      config.provider ??= {};
      config.provider[ID] = {
        name: "Perch AI (接入待验证)",
        npm: "@ai-sdk/openai-compatible",
        api: `${SITE}/v1`,
        models: {
          "perch-default": {
            name: "Perch Web Assistant",
            toolcall: false,
            reasoning: false,
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      };
    },
    async "chat.headers"(request: ChatHeadersInput, output: { headers: Record<string, string> }) {
      const provider = request.model?.providerID ?? request.provider?.info?.id;
      if (provider !== ID || !request.sessionID || request.sessionID.length > 512 || /[\r\n]/.test(request.sessionID)) return;
      output.headers["X-Magpie-Session"] = request.sessionID;
    },
    auth: {
      provider: ID,
      options: [{ key: "experimental-web", label: "实验性网页接入（尚未真实联调）", default: false }],
      methods: [{ type: "api" as const, label: "Perch Cookie", placeholder: "完整 Cookie；不要粘贴到聊天或代码" }],
      async loader(getAuth: () => Promise<StoredAuth | undefined>) {
        return {
          apiKey: "perch-local-placeholder",
          baseURL: `${SITE}/v1`,
          async fetch(target: string | URL | Request, init?: RequestInit): Promise<Response> {
            try {
              const url = new URL(target instanceof Request ? target.url : target);
              if (url.origin !== SITE || url.pathname !== "/v1/chat/completions" || (init?.method ?? (target instanceof Request ? target.method : "GET")) !== "POST") {
                throw new ProviderError("invalid_request", "仅支持文本 chat/completions 请求。", 400);
              }
              // Live Cookie/CSRF behavior is unverified; require an explicit opt-in.
              if (!fixture && options.experimentalWeb !== true && input?.magpie?.option(ID, "experimental-web") !== true) {
                throw new ProviderError("perch_protocol_unverified", "真实账号尚未联调，请先在插件设置中开启实验性网页接入。", 501);
              }
              const auth = await getAuth();
              if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) {
                throw new ProviderError("invalid_auth", "请配置 Perch Cookie。", 401);
              }
              let body: unknown;
              try {
                const raw = typeof init?.body === "string" ? init.body : target instanceof Request && init?.body === undefined ? await target.clone().text() : undefined;
                if (raw === undefined || raw.length > 1_048_576) throw new Error();
                body = JSON.parse(raw);
                if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
              } catch {
                throw new ProviderError("invalid_request", "请求必须为大小受限的 JSON 对象。", 400);
              }
              const headers = new Headers(init?.headers ?? (target instanceof Request ? target.headers : undefined));
              return await completion({ body, cookie: auth.key,
                signal: init?.signal ?? (target instanceof Request ? target.signal : undefined),
                session: headers.get("x-magpie-session") ?? "",
              });
            } catch (error) {
              const safe = error instanceof ProviderError ? error : new ProviderError("provider_error", "插件请求处理失败。");
              return Response.json({ error: { type: "provider_error", code: safe.code, message: safe.message } }, { status: safe.status, headers: safe.headers });
            }
          },
        };
      },
    },
  };
}

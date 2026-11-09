# magpie-plugin-perch

Perch 文本对话适配原型，目标为群晖 NAS 上的 Magpie **v0.1.3337**。
当前发布版本：**v0.0.3**。
已依据该版本源码实现 OpenCode 插件入口，按 Perch 公开前端实现 thread/chat 网页协议，并通过原版 host.js 的本机模拟验收。
**正式插件代码已在登录浏览器中验证真实 JSON/SSE 转换、续聊、会话隔离和取消请求；独立 Bun Cookie 鉴权与 NAS 链路尚未验收，实验接入仍默认关闭（501）。**

第一版范围、验收矩阵与真实接入所缺材料见 [docs/v1.md](docs/v1.md)。
实际版本、源码提交和已发现的 Perch thread/SSE 协议见 [docs/integration.md](docs/integration.md)。

## 安装

在 Magpie 的 Plugins 页面输入以下地址并点击安装：

```text
github:adminmtan/magpie-plugin-perch#v0.0.3
```

固定 tag 不会自动切换到未验证代码。新版本发布后，需将末尾 tag 改为对应版本。安装完成后添加 Perch 账号、填写 Cookie，并显式开启 `experimental-web`；真实请求可能消耗账号额度。

## 运行

需要 Node.js 20+ 和 npm；Bun 已作为锁定版本的项目开发工具，无需全局安装。

```powershell
npm ci
npm test
npm run typecheck
npm start
```

演示只监听 `127.0.0.1:8787`，无需真实凭据，通过正式插件 hooks 访问本机模拟 Perch thread/chat；不会连接 NAS 或真实 Perch。

```powershell
$body = @{ model = 'perch-default'; messages = @(@{ role = 'user'; content = '你好' }); stream = $false } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/v1/chat/completions' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

流式示例：

```powershell
$body = '{"model":"perch-default","messages":[{"role":"user","content":"Hello"}],"stream":true}'
$body | curl.exe -N 'http://127.0.0.1:8787/v1/chat/completions' -H 'Content-Type: application/json' --data-binary '@-'
```

`GET /health` 显示 `local-mock`；`GET /v1/models` 返回模拟环境的模型声明。
`npm run dev` 可监听变更。Ctrl+C 停止演示。

## 第一版支持范围

仅接受 `model: perch-default`、文本 `messages` 与 `stream`。首次传单条 user；续聊传回此前完整的 user/assistant 历史，插件沿已确认的 thread 继续。未知历史返回 409，不自动重放或丢弃；system、工具、多模态、temperature 等参数返回 400。

会话映射仅存内存，最多 128 条，30 分钟有效；重启、凭据变化、淘汰或失败续聊后需新开对话。账号路由须保持同一账号。插件通过 `chat.headers` 接收 Magpie/OpenCode 的 sessionID，并转换为内部 `x-magpie-session`；直接调用仍兼容该头。没有会话标识时按账号和精确历史匹配，不支持同一历史分支并行续写。

Perch 总是返回 SSE；插件按 `answer_delta` 聚合或转发，收到成功 `done` 才输出完成标记。不输出推理，不虚构 token usage；未完成、错误、额外额度确认均明确失败。默认使用网页的 standard 选择，关闭联网搜索，不自动同意额外额度。

总超时默认 60 秒，每账号单生成，不排队、不重试；本地并发拒绝返回短暂 `Retry-After`，上游 429 只转发格式安全的 `Retry-After`。确认的 401 标记登录失效，403 保持为独立权限错误。取消时尽力调用 Perch chat/stop，清理最多额外 3 秒。Cookie 由 Magpie 账号配置传入，出站代理沿用 Magpie 作用域，禁止跟随重定向。完整边界见 [第一版验收文档](docs/v1.md)。

已移除被替代的示例适配器，只保留正式 hooks 与 thread/chat 链路。原需求文档中的 prompt/history、Bearer、temperature 示例不作为真实 Perch 的能力依据。

## Magpie 宿主兼容性验证

`package.json` 的 main 已指向 `magpie.ts`，它提供 `config`、`chat.headers`、`auth.loader` 和返回 Response 的 custom fetch。
如已单独取得目标版本源码，可运行：

```powershell
npm run test:magpie -- 'D:\path\to\magpie\internal\plugin\host.js'
```

脚本启动原版宿主，仅用独立临时配置与本机 thread/chat 夹具验证加载、模型发现、模拟凭据、普通和流式对话；不会改动 NAS。
本机 Bun 为 1.4.4，目标宿主默认下载 1.4.2，实际 NAS 仍需验证。

## 接入真实环境

1. 已确认 yetone/magpie v0.1.3337，源码提交见集成记录，无需为了本项目先升级 NAS。
2. 在测试部署中挂载插件目录，并用 `magpie plugin add <容器内插件路径>` 或 Settings → Plugins 注册；容器需能读取 package.json、magpie.ts、perch-web.ts、protocol.ts。仅挂载目录不代表已安装；无需复制 Windows 的 node_modules 到 NAS。
3. 添加 Perch 账号，在 Magpie 设置填写本人完整 Cookie、按需设置出口代理，每账号并发从 1 开始。默认 501；准备真实测试时，在 Provider 设置开启“实验性网页接入（尚未真实联调）”。此操作会向 Perch 创建真实会话并生成回复，可能消耗账号额度。关闭此选项恢复 501。
4. 用 Magpie API Key 验收 `/v1/chat/completions` 的普通、流式和续聊，另测凭据过期与取消。Cookie 是否足够、是否需要 CSRF/刷新仍未证实；失败时仅提供脱敏结构与错误码用于核对，勿发送凭据。

不要提交真实 Cookie、Token、HAR 或个人会话。遇到验证页面会明确失败；本版不提供自动登录或浏览器会话方案。

## 项目规则

从 [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) 安装到 `.agents/skills/`：
`a-philosophy-of-software-design` 使用 full 规则；`release-it` 用于网络边界的超时、取消和校验。
保留上游技能目录与来源许可，见 `THIRD_PARTY_NOTICES.md`。项目约定与实际命令见 `AGENTS.md`。

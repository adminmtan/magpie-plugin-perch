# 真实环境核对记录

核对日期：2026-11-09。

## 部署目标

| 项目 | 已知信息 | 证据 / 限制 |
| --- | --- | --- |
| Magpie | 群晖 NAS，`http://10.10.10.250:8003`，Docker | 用户提供；未登录 GET `/` 返回 401，未改动 NAS |
| 当前版本 | **v0.1.3337** | 用户截图右上角；提示可更新的 0.1.3373 不是当前版本 |
| 镜像 | `ghcr.io/yetone/magpie` | 截图的更新说明；未执行拉取、升级或重建 |
| 源码 | `https://github.com/yetone/magpie`，tag `v0.1.3337` | tag 对应提交 `b1e8eb15a668bbccfcd46977c75602ceaa4d66b3` |
| Perch | `https://chat.perchai.app/` | 用户提供；公开首页 HTTP 200 |

## Magpie 接口纠正

源码证据（均为目标 tag，而非 main）：

- [host.js](https://github.com/yetone/magpie/blob/v0.1.3337/internal/plugin/host.js)：`servers` 会把每个运行时导出的函数识别为工厂；因此实际入口仅导出默认工厂，不能连同错误类一起导出。
- 同一文件的 `loadPlugins` 调用工厂 `(input, options)`，再调用 `config(config)`。Provider 从 `config.provider` 和 `auth.provider` 注册。
- `options` 调用 `auth.loader(getAuth, provider)`，并缓存 loader 结果；自定义 `fetch(url, init)` 返回 **Response**，不是裸 completion 或 ReadableStream。`init.signal` 由宿主提供。
- `fetchAs` 通过 loader 的 fetch 调用插件，宿主把 Response 的状态、响应头和正文传回 Go 网关；代理在宿主的账号作用域中处理。
- 同一 `fetchAs` 会把 RPC 的 `session` 提供给 `chat.headers`；插件将其写入仅供插件读取的 `X-Magpie-Session`，宿主不会把该内部头发送给供应商。
- [reference.md](https://github.com/yetone/magpie/blob/v0.1.3337/docs/reference.md#plugins)：支持本地路径插件；命令为 `magpie plugin add <path>`，管理位置为 Settings → Plugins。
- [bun.go](https://github.com/yetone/magpie/blob/v0.1.3337/internal/plugin/bun.go)：宿主下载的 Bun 版本为 **1.4.2**；本项目本地测试使用 **1.4.4**。本机源代码宿主验证不等于 NAS 二进制和其运行时已验收。

`magpie.ts` 为 package main，运行时只导出默认工厂。`perch-web.ts` 已实现下述网页协议，本地演示与源码宿主测试均使用 thread/chat 夹具。真实入口默认返回 `501 / perch_protocol_unverified`；显式开启 auth.options 的 `experimental-web` 后才允许真实请求。`fixtureBaseUrl` 仅允许本机 HTTP。注册的 `https://chat.perchai.app/v1` 是自定义 fetch 拦截的宿主路由占位，**不是已发现的 Perch OpenAI API**。

## Perch 公开前端证据

最初仅下载公开脚本作静态阅读；随后在用户登录的 Chrome 中完成下述真实请求验证。没有导出或记录 Cookie、Token、个人资料或完整抓包。

- [公开聊天脚本](https://chat.perchai.app/_next/static/chunks/0a4w22v9u.xew.js)，SHA-256：`0973C643F426E5FD0EE1F4D6C54FC18282DD9D8741C3B7B17957D954A3CCE204`。这是当日发布文件，之后可能失效。
- 创建会话：`POST /api/perchai/threads`，正文 `{}`；前端检查 `{ok, thread: {id}}`。
- 对话：`POST /api/perchai/chat`，Accept 为 `text/event-stream`。普通发送的正文包括 `threadId`、`message`、`clientMessageId`、`webSearch`、`roostChoice`、`manualModelOptionId` 和 `promoOverflowAccepted`，可选附件、编辑、重试字段。
- 当前前端默认 webSearch=false、roostChoice=standard、manualModelOptionId=null、promoOverflowAccepted=false。插件使用这些值，不自动同意额外额度；done.errorCode 为 promo_overflow_decision 时返回 402。
- 停止生成：`POST /api/perchai/chat/stop`，正文 `{threadId}`。插件取消/超时后只尽力停止自己操作的 thread，不重试生成。
- 流正文以 `type` 区分 `status`、`reasoning_delta`、`answer_delta`、`citations`、`artifact` 和 `done`；文本增量来自 `answer_delta.text`。
- `done.ok === true` 才成功；它可带最终 `text`、`messageId`、`stopped` 等。`done.ok === false` 为失败，不能把 error 当回答；未收到 done 就 EOF 是连接中断。
- 网页请求没有显式拼装 Bearer，使用浏览器会话。**这只说明需验证 Cookie 会话，并不能证明复制 Cookie 就足够**；刷新、CSRF、附加校验及账号权限均待实际样本核实。
- 真实流程是有状态 thread，原示例的 `history/parts/prompt` 不适用。尚无证据支持导入结构化完整历史或 system role；不自动重放历史来产生额外生成调用，也不静默丢弃或改变消息角色。

## 已完成的验证

使用单独下载的原版 v0.1.3337 `internal/plugin/host.js`，在独立临时配置目录、本机 Bun 1.4.4 下启动，完成：

1. 根据 package.json 加载实际入口，识别 perch-ai。
2. 发现 perch-default 模型。
3. 经宿主 API key 流程保存纯模拟 Cookie，再读取 loader。
4. 经宿主 RPC、custom fetch、本机 thread/chat 夹具输出 OpenAI JSON 和 SSE。
5. RPC 的相同 session 经 `chat.headers` 进入插件会话隔离键，并沿同一 thread 完成续聊。

当前 `npm test`：28 项通过；`npm run typecheck` 通过。覆盖网页协议转换、宿主 session 传递、精确历史续聊、账号/客户端会话隔离、用户 Provider 配置保留、模型工具能力声明、宿主单账号并发声明、401 登录失效提示、403 权限区分、429 Retry-After 筛选、失败历史失效、并发拒绝、取消/超时停止、无人读取流的超时释放、缺少/失败 done、正文修订、重定向、畸形数据及大小限制。已移除旧示例实现，将相关边界测试迁入唯一业务链路；这些测试使用本机夹具，不证明真实账号接入成功。

复验命令：`npm run test:magpie -- <目标版本源码的 internal/plugin/host.js 绝对路径>`。源码不作为业务依赖或副本提交；脚本会建立临时配置，并在结束后删除自身的模拟凭据。

## 真实验收仍未完成

2026-11-09，用户完成登录后，使用新的 Chrome DevTools 连接在 Perch 同源页面中实测：

- `POST /api/perchai/threads` 返回 HTTP 200、ok=true 和有效 thread.id。
- 首轮请求沿用插件中的默认字段，HTTP 200，Content-Type 为 text/event-stream; charset=utf-8，答案为“Perch连接成功”。出现 status/citations/reasoning_delta/answer_delta/done；done.ok=true，done.text 与答案增量一致。
- 同一 thread 发送续聊，HTTP 200、done.ok=true；答案引用了上轮测试指令，表明上下文已承接。模型返回的是完整原指令，并未严格遵循“只回复指定短语”，不将这个措辞差异当作传输故障。
- 共创建 1 个真实会话、生成 2 次，未自动删除。未测试真实取消、凭据过期或额外额度确认。

首次尝试加载项目内测试包曾被工具的工作区路径限制拒绝。后续改用工具支持的内联脚本参数，将本地打包结果直接传入，成功运行项目正式 magpie.ts/perch-web.ts/protocol.ts，未修改正式业务实现。

后续正式代码验证结果：

- 普通调用返回 HTTP 200、object=chat.completion、答案“已记住青竹”，没有伪造 usage。
- 精确历史续聊以流式返回 HTTP 200、答案“青竹”；role=assistant、finish_reason=stop、[DONE]、稳定 id/created 均通过。消费到 4 次流读取；不据此推断网络层的逐 token 到达速度。
- 相同历史换客户端 session 返回 409，无额外生成。
- 单独创建取消测试会话，取消完成；网络列表确认 POST /api/perchai/chat/stop 返回 200。这证明停止请求成功到达，不保证服务端实际停止时点或计费状态。
- credentials=omit 创建 thread 返回 401，没有重定向，符合缺少鉴权应失败的预期；不是过期 Cookie 测试。
- 本轮额外创建 2 个真实会话、发起 3 次生成（其中 1 次取消）；累计创建 3 个会话、发起 5 次生成，均未删除。

测试脚本为 scripts/live-browser.ts：只在真实 Perch 同源页面显式执行；登录 Cookie 由浏览器自动携带，不导出。测试包用仅作用于内存键比较的字符串编号代替 Bun.CryptoHasher，未改变正式代码；该替代不验证 Bun 哈希或独立鉴权。临时页面状态已清理。以上不等于 Magpie/Bun 独立 Cookie 鉴权通过。

复验需先用项目 Bun 将 scripts/live-browser.ts 打包为 browser/IIFE（输出 .local/live-browser.js），在已登录 Perch 页通过 Chrome DevTools evaluate_script 内联执行，再调用 window.__perchLiveTest.run()，按需调用 cancel()，最后 cleanup()。每次 run 会真实生成两次，cancel 会额外创建一次；不加入自动测试或默认启动流程。

下一步须通过宿主账号配置传入 Cookie，验证浏览器外的插件普通/流式回复、续聊、过期凭据和取消。凭据只填在 Magpie 设置；若失败，使用脱敏请求结构与错误码核对。

历史按本插件已有成功会话承接，不提供任意历史导入。没有部署或升级 NAS，没有导出真实凭据，也没有声称 Magpie→Perch 端到端验收成功。

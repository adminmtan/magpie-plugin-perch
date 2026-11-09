# 项目约定

- 目标：为 Magpie 提供 Perch 文本对话适配；目标为 NAS 上 v0.1.3337（不是截图提示的新版），仓库 yetone/magpie。Perch 为 https://chat.perchai.app/。证据见 `docs/integration.md`，不得将本地宿主/模拟验收称为 NAS 或 Perch 接入成功。
- 设计、实现、审查前读取 `.agents/skills/a-philosophy-of-software-design/a-philosophy-of-software-design.md`（full，而非默认 mini）；网络可靠性同时使用 `.agents/skills/release-it/release-it.mini.md`。
- 使用 Bun、严格 TypeScript、Web Fetch/Streams。唯一入口 `magpie.ts` 使用 OpenCode config/auth.loader/fetch，运行时只导出默认工厂，fetch 返回 Response。保持简单结构，不恢复原文的假定接口。
- 优先交付可验证的文本对话链路；仅对影响方案的重要缺失信息提问，其余记录默认值并推进。
- Cookie、Token、代理口令及真实抓包不得进入代码、日志、错误响应或测试夹具。真实凭据仅由宿主配置传入。
- 网络调用必须有超时和取消；不自动重试生成请求；流式保持稳定 id、背压、完成帧与资源释放。不伪造 token 用量。
- 测试验证公开行为与协议边界。修改后运行 `npm test` 和 `npm run typecheck`。
- 原版源码宿主复验：`npm run test:magpie -- <v0.1.3337 源码中的 internal/plugin/host.js 绝对路径>`，使用独立临时配置与本机夹具；宿主默认 Bun 1.4.2，本地为 1.4.4，NAS 运行时仍需联调。
- `perch-web.ts` 实现公开前端的 thread→chat→answer_delta/done 协议；真实接入默认关闭（501），仅显式开启 experimental-web 后调用真实站点，仍须标注登录鉴权未经验证。首次单条 user；续聊必须精确匹配本插件成功历史，否则 409，不重放或展平。暂拒绝 system/tools/temperature。
- 会话映射仅存内存中的历史摘要与 threadId，按凭据及宿主 session 隔离；`chat.headers` 将 Magpie/OpenCode sessionID 转为内部 `x-magpie-session`，直接调用仍兼容该头。最多 128 条、30 分钟；重启/凭据变化会失效。每账号只允许 1 个生成。
- 安装：`npm ci`。启动本地模拟演示：`npm start`；监听变更：`npm run dev`。本地 Bun 通过 npm scripts 调用，无需全局安装。
- `demo.ts` 仅供本机模拟验收，监听 `127.0.0.1`；不替代 Magpie 的认证、计费、凭证管理和路由。

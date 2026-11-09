# Changelog

## v0.0.1 - 2026-11-09

首个实验版本，面向 Magpie v0.1.3337。

- 提供 `config`、`chat.headers`、`auth.loader` 和自定义 `fetch` 宿主入口。
- 适配 Perch 公开前端的 thread -> chat -> SSE 文本对话流程。
- 支持 OpenAI 兼容的普通响应、流式响应和同 session 精确历史续聊。
- 提供超时、取消、单账号并发限制、有界解析和安全错误响应。
- 区分 401 登录失效、403 权限错误和 429 限流，并处理安全的 `Retry-After`。

限制：真实接入默认关闭。登录浏览器中的 Perch 协议已验证，但独立 Bun Cookie 鉴权和 NAS 端到端链路尚未验收。

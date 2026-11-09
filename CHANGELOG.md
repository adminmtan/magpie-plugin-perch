# Changelog

## v0.0.3 - 2026-11-09

- 改用轻量 Git 标签发布，使 Magpie/Bun 看到的标签 SHA 与提交 SHA 一致，避免更新后持续提示仓库版本不同。

## v0.0.2 - 2026-11-09

- 使用 Magpie/OpenCode 识别的 `tool_call: false` 声明模型不支持工具调用。
- 不再覆盖用户在 `plugins.json` 中已有的 `perch-ai` Provider 配置。
- 声明 GitHub 来源、插件发现信息和每账号单请求并发限制。
- 增加固定 Git tag 的安装说明和 GitHub CI。

## v0.0.1 - 2026-11-09

首个实验版本，面向 Magpie v0.1.3337。

- 提供 `config`、`chat.headers`、`auth.loader` 和自定义 `fetch` 宿主入口。
- 适配 Perch 公开前端的 thread -> chat -> SSE 文本对话流程。
- 支持 OpenAI 兼容的普通响应、流式响应和同 session 精确历史续聊。
- 提供超时、取消、单账号并发限制、有界解析和安全错误响应。
- 区分 401 登录失效、403 权限错误和 429 限流，并处理安全的 `Retry-After`。

限制：真实接入默认关闭。登录浏览器中的 Perch 协议已验证，但独立 Bun Cookie 鉴权和 NAS 端到端链路尚未验收。

# dsh-session-agent-cat

[English](README.md) · 简体中文

一个 DeepSeek Harness 插件，让 Agent Cat 桌面宠物实时响应 DeepSeek Harness 的工作状态。它直接订阅 `session/event` 事件流（不注册 `sessionTelemetry` 服务，因此能与基础部署的遥测后端共存），把生命周期事件映射为 Agent Cat 的事件词汇，并只通过本地 socket 转发脱敏后的元数据。工具参数、文件内容和终端输出不会离开 harness 进程。

## 安装

把插件写入用户补丁层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）：

```yaml
- insert:
    - id: session-agent-cat
      name: 'dsh-session-agent-cat'
      config:
        enabled: true
```

插件包需要能解析到 `$DSH_HOME/profiles/node_modules/dsh-session-agent-cat`。在 Agent Cat 的「设置 → 智能体 → DeepSeek Harness」点「连接」会自动完成这两步。补丁改动会热重载，但插件包只在启动时加载 —— 首次安装或更新后请重启 DeepSeek Harness。

`enabled` 默认为 `true`，设为 `false` 可停止转发；`endpoint` 可覆盖默认本地端点（macOS 为 `~/.config/agent-cat/agent-cat.sock`，Windows 为 `%APPDATA%\io.github.agent-cat\agent-cat.endpoint`）。

## 事件映射

| DSH `event.type`                    | Agent Cat 事件        |
| ----------------------------------- | --------------------- |
| `turn/start`                        | `SessionStart`        |
| `user/message`（用户输入或目标续行）   | `UserPromptSubmit`    |
| `tool/call`                         | `PreToolUse`          |
| `tool/call`（`ask_user_question`）   | `PermissionRequest`   |
| `tool/result`（成功）                | `PostToolUse`         |
| `tool/result`（失败）                | `PostToolUseFailure`  |
| `approval/asked`                    | `PermissionRequest`   |
| `approval/decided`（`allowed-once`） | `PostToolUse`         |
| `compaction/start`                  | `PreCompact`          |
| `compaction/end`                    | `PostCompact`         |
| `turn/end`（完成）                   | `Stop`                |
| `turn/end`（错误/阻塞/`max-tokens`）  | `StopFailure`         |
| `turn/end`（中断）                   | `TurnInterrupted`     |
| `session/disposed`                  | `SessionEnd`          |

`tool/result` 本身不带工具名，插件会通过 `callId` 从配对的 `tool/call` 找回。未授权的审批结果（`rejected`、`cancelled`、`unavailable`）和其余事件类型不触发反应。

## 隐私

事件只发往 Agent Cat 的回环 socket。插件只读取身份字段、经过清理的工具名称和用户提示的首个非空行（最多 80 个字符），绝不复制或转发载荷内容。

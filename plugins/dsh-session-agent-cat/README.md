# dsh-session-agent-cat

English · [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that makes the Agent Cat desktop pet react to
DeepSeek Harness activity. It subscribes to the `session/event` firehose (not
the `sessionTelemetry` service, so it coexists with the base telemetry
backend), maps lifecycle events onto Agent Cat's event vocabulary, and forwards
only sanitized metadata over Agent Cat's local socket. Tool arguments, file
contents, and terminal output never leave the harness process.

## Install

Add the plugin to a user patch layer
(`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: session-agent-cat
      name: 'dsh-session-agent-cat'
      config:
        enabled: true
```

The package must resolve under
`$DSH_HOME/profiles/node_modules/dsh-session-agent-cat`. Agent Cat's
Settings → Agents → DeepSeek Harness → **Connect** does both steps
automatically. Patch changes hot-reload, but the plugin package is only loaded
at startup — restart DeepSeek Harness after the first install or an update.

`enabled` defaults to `true`; set it to `false` to stop forwarding. `endpoint`
overrides the default local endpoint (`~/.config/agent-cat/agent-cat.sock` on
macOS, `%APPDATA%\io.github.agent-cat\agent-cat.endpoint` on Windows).

## Event mapping

| DSH `event.type`                    | Agent Cat event        |
| ----------------------------------- | ---------------------- |
| `turn/start`                        | `SessionStart`         |
| `user/message` (human or goal round) | `UserPromptSubmit`    |
| `tool/call`                         | `PreToolUse`           |
| `tool/call` (`ask_user_question`)   | `PermissionRequest`    |
| `tool/result` (ok)                  | `PostToolUse`          |
| `tool/result` (error)               | `PostToolUseFailure`   |
| `approval/asked`                    | `PermissionRequest`    |
| `approval/decided` (`allowed-once`) | `PostToolUse`          |
| `compaction/start`                  | `PreCompact`           |
| `compaction/end`                    | `PostCompact`          |
| `turn/end` (completed)              | `Stop`                 |
| `turn/end` (error/blocked/max-tokens) | `StopFailure`        |
| `turn/end` (aborted/interrupted)    | `TurnInterrupted`      |
| `session/disposed`                  | `SessionEnd`           |

`tool/result` has no tool name of its own; the plugin recovers it from the
paired `tool/call` via `callId`. Non-grant approval outcomes (`rejected`,
`cancelled`, `unavailable`) and all other event types produce no reaction.

## Privacy

Events go only to Agent Cat's loopback socket. The plugin reads only identity
fields, sanitized tool names, and the first non-empty prompt line (up to 80
characters); payload contents are never copied or forwarded.

---
name: clawguard
version: 0.1.0
description: >
  Staging layer that shows file change diffs before applying.
  Approve or reject agent changes via Telegram, Discord, or Web UI.
  Tracks token spending and enforces budget limits.
author: ClawGuard Contributors
license: MIT
homepage: https://github.com/your-org/clawguard

triggers:
  - file_write
  - file_edit
  - apply_patch
  - exec

tools_required:
  - write
  - edit
  - apply_patch

hooks:
  - name: onBeforeToolExecution
    tools: [write, edit, apply_patch, exec]
    behavior: block_until_approved

channels:
  - telegram
  - discord
  - web_ui

config_file: config.json5
---

# ClawGuard

ClawGuard is an **approval gateway** for OpenClaw AI agents. Every file write, edit, or patch is intercepted, staged, and sent to you for review before it touches the real filesystem.

## How It Works

1. The agent attempts a `write`, `edit`, or `apply_patch` operation.
2. ClawGuard intercepts via `onBeforeToolExecution`.
3. The new content is written to a staging directory (`/tmp/clawguard/staging/{changeId}/`).
4. A unified diff is generated comparing the original file to the proposed change.
5. The diff is sent to your configured channels (Telegram, Discord, Web UI).
6. ClawGuard waits for your decision.
7. **Approve** → the staged content is written to the real filesystem; the agent continues.
8. **Reject** → the staged content is discarded; the agent receives a rejection message.

## Budget Control

ClawGuard tracks token usage per model and enforces daily spending limits. When the limit is reached, further agent operations are blocked until the next day or the limit is raised.

## Configuration

Copy `config.example.json5` to `config.json5` and set your credentials:

```json5
{
  channels: {
    telegram: { enabled: true, token: "...", chatId: "..." },
    web: { enabled: true, port: 3847 },
  },
  budget: {
    daily_limit_usd: 10.00,
    hard_stop: true,
  },
}
```

## Plugin Registration

```typescript
import ClawGuardPlugin from 'clawguard/src/openclaw/plugin';

openClaw.registerPlugin(ClawGuardPlugin);
```

## Approval Channels

| Channel  | Setup                            | Approval Method          |
|----------|----------------------------------|--------------------------|
| Telegram | @BotFather → create bot + token  | Inline keyboard buttons  |
| Discord  | Developer Portal → bot + token   | Message component buttons|
| Web UI   | Auto-starts on configured port   | Browser approve/reject   |

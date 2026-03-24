```
   ______  __                  ______                         __
  / ____/ / /  ____ _ _      /  ____/ __  __ ____ _ _____  / /
 / /     / /  / __ `// | /| / / / __ / / / // __ `// ___/ / /
/ /___  / /  / /_/ / | |/ |/ / / /_/ // /_/ // /_/ / /    / /___
\____/ /_/   \__,_/  |__/|__/  \____/ \__,_/ \__,_//_/   /_____/

                v0.1.0 — Staging layer & budget control for OpenClaw agents
```

**Your AI agent wants to overwrite a file. ClawGuard stops it, shows you exactly what changes, and waits for your go-ahead.**

---

## The Problem

AI agents that edit files are powerful — and dangerous. Without oversight:

- **Files get overwritten** without you seeing the diff
- **Costs spiral** with no per-session or daily cap
- **Mistakes are applied immediately** with no undo

ClawGuard fixes all three.

---

## Features

- **Intercepts writes** — Every `write`, `edit`, `apply_patch`, and `exec` call is captured before it hits the real filesystem
- **Staged diffs** — Changes are written to `/tmp/clawguard/staging/` and shown as unified diffs
- **Multi-channel approval** — Approve or reject via Telegram inline buttons, Discord components, or the web dashboard
- **Budget enforcement** — Per-model token cost tracking with daily limits, alert thresholds, and hard stops
- **SQLite-backed queue** — Pending changes survive restarts; history is preserved indefinitely
- **Real-time dashboard** — Live update via SSE; dark-themed, responsive web UI
- **Zero JS framework** — Web UI uses vanilla JS + htmx; no React, no bundler required

---

## Quick Start

```bash
# 1. Clone / install
git clone https://github.com/your-org/clawguard
cd clawguard
npm install

# 2. Configure
cp config.example.json5 config.json5
# Edit config.json5 — add your Telegram token, set budget, etc.

# 3. Run (dev mode with hot reload)
npm run dev

# OR build and run production
npm run build
npm start
```

The web dashboard is available at **http://localhost:3847** by default.

---

## Screenshots

```
┌─────────────────────────────────────────────────────────────────┐
│  ClawGuard Dashboard                              ↻ Refresh      │
├────────────┬────────────┬────────────┬────────────┬─────────────┤
│  Pending   │  Approved  │  Rejected  │   Uptime   │             │
│    [3]     │    [47]    │    [12]    │   2h 14m   │             │
├─────────────────────────────────────────────────────────────────┤
│  Today's Budget                          $2.41 / $10.00         │
│  ████████████░░░░░░░░░░░░░░░░░░  24.1%                          │
├─────────────────────────────────────────────────────────────────┤
│  Recent Activity                                   View all     │
│  src/utils/config.ts        Approved    2m ago                  │
│  src/core/staging.ts        Rejected    5m ago                  │
│  README.md                  Approved    12m ago                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
OpenClaw Agent
      │
      │ tool call: write("src/app.ts", newContent)
      ▼
┌─────────────────────────────────────────────────────┐
│                   ClawGuard Plugin                   │
│                                                      │
│  onBeforeToolExecution()                             │
│    ├─ Budget check ──────────────── BudgetTracker   │
│    ├─ Stage change ─────────────── StagingEngine    │
│    │     └── /tmp/clawguard/staging/{uuid}/         │
│    ├─ Generate diff ────────────── DiffGenerator    │
│    ├─ Queue entry ──────────────── SQLite DB        │
│    └─ Notify channels ──────────┬─ Telegram         │
│                                 ├─ Discord           │
│                                 └─ Web UI (SSE)      │
│                                                      │
│  await user decision...                              │
│    ├─ Approved ──── staging.apply() ──► real FS    │
│    └─ Rejected ──── staging.reject() ──► discarded │
└─────────────────────────────────────────────────────┘
```

---

## Configuration Reference

Copy `config.example.json5` to `config.json5`:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",    // @BotFather
      chatId: "YOUR_CHAT_ID",
    },
    discord: {
      enabled: false,
      token: "YOUR_BOT_TOKEN",    // Discord Developer Portal
      channelId: "YOUR_CHANNEL_ID",
    },
    web: {
      enabled: true,
      port: 3847,
      host: "127.0.0.1",
    },
  },
  budget: {
    daily_limit_usd: 10.00,       // Hard cap per day
    alert_threshold_pct: 80,      // Alert at 80% of cap
    hard_stop: true,              // Block agent when cap reached
  },
  staging: {
    directory: "/tmp/clawguard/staging",
    auto_approve_read: true,      // Skip approval for read ops
    require_approval: ["write", "edit", "apply_patch", "exec"],
    timeout_seconds: 300,         // Auto-reject after 5 min (0 = never)
  },
  logging: {
    level: "info",                // "debug" | "info" | "warn" | "error"
    file: "~/.clawguard/clawguard.log",
  },
}
```

---

## Approval Channels

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) — copy the token
2. Get your chat ID (message [@userinfobot](https://t.me/userinfobot))
3. Set `channels.telegram.enabled: true` in config

When a change arrives, you'll receive:

```
✏️ MODIFIED `src/core/staging.ts`
+12 / -3

```diff
@@ -45,7 +45,19 @@
   apply(changeId: string): void {
-    fs.copyFileSync(staged, real);
+    // Ensure parent directory exists
+    const dir = path.dirname(change.filePath);
+    if (!fs.existsSync(dir)) {
+      fs.mkdirSync(dir, { recursive: true });
+    }
+    fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
```

[✅ Apply]  [❌ Reject]
```

**Commands:** `/budget` · `/pending` · `/history`

### Discord

1. Create an app at the [Discord Developer Portal](https://discord.com/developers/applications)
2. Add a bot, enable Message Content Intent
3. Invite the bot to your server with `Send Messages` + `Use Slash Commands`
4. Set `channels.discord.enabled: true` in config

### Web UI

Access the dashboard at `http://localhost:3847` (or your configured port). No login required by default — bind to `127.0.0.1` to keep it local.

---

## Plugin Integration

```typescript
import ClawGuardPlugin, { notifyResolution } from 'clawguard';

// Register with OpenClaw
openClaw.registerPlugin(ClawGuardPlugin);

// When a user approves via external trigger (webhook, etc.)
notifyResolution(changeId, true);   // approved
notifyResolution(changeId, false);  // rejected
```

---

## Docker

```bash
# Build
docker build -f docker/Dockerfile -t clawguard .

# Run (mount config + data)
docker run -d \
  -p 3847:3847 \
  -v $(pwd)/config.json5:/app/config.json5:ro \
  -v clawguard-data:/root/.clawguard \
  --name clawguard \
  clawguard
```

---

## Monetization

**Free for personal use.** Pro features coming soon:

- Multi-agent support with per-agent budgets
- Slack & email notification channels
- Audit log export (CSV / JSON)
- Team approval workflows (require N approvals)
- REST API for third-party integrations
- Self-hosted dashboard with auth

---

## License

MIT © ClawGuard Contributors — see [LICENSE](LICENSE)

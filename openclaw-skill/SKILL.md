---
name: clawguard
description: "Review file changes before applying them. Shows diffs and waits for human approval via Web UI, Telegram, or Discord."
version: 0.1.0
metadata:
  openclaw:
    emoji: "🛡️"
    requires:
      bins:
        - node
      env:
        - CLAWGUARD_URL
---

# ClawGuard — File Change Approval Gateway

You MUST use ClawGuard for ALL file modifications. Never write, edit, or patch files directly. Instead, send proposed changes to ClawGuard for human review.

## Rules

1. **NEVER use the `write`, `edit`, or `apply_patch` tools directly** on important files.
2. Instead, use `shell.execute` to call the ClawGuard CLI to propose changes.
3. Wait for the human to approve or reject before continuing.
4. If rejected, acknowledge and ask the user what they want instead.

## How to Propose a File Change

### For creating or overwriting a file:

```bash
curl -s -X POST "${CLAWGUARD_URL}/api/stage" \
  -H "Content-Type: application/json" \
  -d '{
    "file_path": "/absolute/path/to/file.txt",
    "new_content": "the full new file content here",
    "agent_name": "openclaw"
  }'
```

### For editing an existing file (patch):

```bash
curl -s -X POST "${CLAWGUARD_URL}/api/stage" \
  -H "Content-Type: application/json" \
  -d '{
    "file_path": "/absolute/path/to/file.txt",
    "new_content": "the full updated file content here",
    "agent_name": "openclaw"
  }'
```

### Check if a change was approved:

```bash
curl -s "${CLAWGUARD_URL}/api/changes/CHANGE_ID"
```

The response will have `"status": "pending"`, `"approved"`, or `"rejected"`.

### Wait for approval:

After staging a change, tell the user:
> "I've proposed a change to `{file_path}`. Please review the diff in ClawGuard and approve or reject it."

Then poll the status every 10 seconds:

```bash
curl -s "${CLAWGUARD_URL}/api/changes/CHANGE_ID" | grep -o '"status":"[^"]*"'
```

### Check budget before expensive operations:

```bash
curl -s "${CLAWGUARD_URL}/api/budget"
```

If `blocked` is `true`, stop and inform the user that the daily budget limit has been reached.

## Response Format

When you stage a change, ClawGuard returns:
```json
{
  "id": "uuid-of-change",
  "file_path": "/path/to/file",
  "status": "pending",
  "additions": 5,
  "deletions": 2
}
```

Use the `id` to poll for approval status.

## Important

- The human reviews diffs in ClawGuard's Web UI (or Telegram/Discord)
- You cannot bypass this — all file writes go through ClawGuard
- If ClawGuard is unreachable, inform the user and do NOT write files directly
- Always show the user what you intend to change before staging

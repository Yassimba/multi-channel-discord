# /discord:access

Manage Discord access control — approve pairings, edit allowlists, set policy.

State file: `~/.claude/channels/discord/access.json`

## Commands

### `pair <code>`

Validate a pending pairing code and add the user to the allowlist.

```bash
# When someone DMs the bot and gets a pairing code:
# "Pairing required — run in Claude Code: /discord:access pair abc123"
```

Usage: Look up the code in `access.json`, verify it's not expired, add the user ID to `allowFrom`, remove the code from `pending`. Then write the user's ID to `~/.claude/channels/discord/approved/<userId>` with the DM channel ID as content, so the router can send a confirmation message.

### `policy <pairing|allowlist|disabled>`

Set the DM policy:

- **pairing** (default) — Unknown senders get a 6-char hex code to approve in terminal
- **allowlist** — Only pre-approved user IDs can message (no pairing flow)
- **disabled** — Reject all incoming messages

### `allow <userId>`

Manually add a Discord user ID to the allowlist.

### `remove <userId>`

Remove a Discord user ID from the allowlist.

### `list`

Show current access state:

- DM policy
- Allowed user IDs
- Pending pairing codes (with expiry)
- Guild channel policies
- Ack reaction emoji

## Implementation

All commands delegate to functions in `src/access.ts`:

- `loadAccess()` / `saveAccess()` — read/write `access.json`
- `gate(msg)` — check if a sender is allowed
- `defaultAccess()` — create fresh default config

The skill reads the current config, applies the change, and saves back.

# Discord Multi-Instance Channel for Claude Code

Connect multiple Claude Code sessions to a single Discord bot. Switch between them with slash commands, broadcast to all, buffer messages from inactive sessions, and spawn new instances — all from your phone.

Built on top of Anthropic's [Claude Code Channels](https://code.claude.com/docs/en/channels) protocol. Extends the [official single-instance plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) with a router that manages multiple sessions.

## Why?

The official Discord plugin connects **one** Claude Code session to your bot. If you're working across multiple projects, you have to restart Claude Code each time.

This plugin runs a **router** that sits between Discord and your sessions. Multiple Claude Code instances connect to the router via WebSocket, and you switch between them with `/switch` — no restarts, no lost context.

## Prerequisites

- [Bun](https://bun.sh) — install with `curl -fsSL https://bun.sh/install | bash`
- A Discord account

## Quick Setup

### 1. Create a Discord bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it whatever you want.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

### 2. Generate a bot token

Still on the **Bot** page, scroll up and press **Reset Token**. Copy the token — it's only shown once.

### 3. Invite the bot to a server

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2 → URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Copy the **Generated URL**, open it, and add the bot to any server you're in.

### 4. Install the plugin

Clone this repo and install dependencies:

```bash
git clone https://github.com/YassinCh/multi-channel-discord.git
cd multi-channel-discord
bun install
```

Deploy to Claude Code's plugin cache:

```bash
./deploy.sh
```

### 5. Save the bot token

Start a Claude Code session and configure the token:

```
/discord:configure <your-token>
```

This writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand.

### 6. Start the router

The router is the Discord bot process. Start it in a terminal and leave it running:

```bash
cd multi-channel-discord
bun run src/router.ts
```

You should see:
```
discord channel: WS server listening on port 8789
discord channel: gateway connected as YourBot#1234
discord channel: registered 6 slash commands
```

> **Tip:** Run this in a tmux/screen session or as a background service so it survives terminal closes.

### 7. Launch Claude Code with channels

In any project directory:

```bash
claude --dangerously-load-development-channels plugin:discord@multi-channel-discord
```

The session auto-registers with the router using your git branch or project name.

### 8. Pair

DM your bot on Discord — it replies with a pairing code. In your Claude Code session:

```
/discord:access pair <code>
```

Your next DM reaches Claude.

### 9. Lock it down

Pairing is for capturing your Discord user ID. Once you're in, switch to `allowlist` so strangers can't trigger pairing codes:

```
/discord:access policy allowlist
```

## Usage

### Slash commands

All commands work in DMs with the bot. Responses are ephemeral (only you see them).

| Command | Description |
| --- | --- |
| `/switch <session>` | Switch the active session. Autocompletes session names. Flushes buffered messages. |
| `/list` | Show all connected sessions with status (active, buffered, idle). |
| `/status` | Show router uptime, instance count, and queued messages. |
| `/kill <session>` | Terminate a session. Use `/kill all` to terminate all. |
| `/broadcast <message>` | Send a message to all connected sessions. |
| `/spawn <project>` | Launch a new Claude Code instance in a recent project. |

### Multi-session workflow

```
You: /switch frontend        → "Switched to frontend"
You: fix the CSS bug          → routes to frontend session
You: /switch backend          → "Switched to backend"
You: add the API endpoint     → routes to backend session

[frontend 📪] 1 new message   → frontend replied while inactive
You: /switch frontend         → flushes buffered reply
```

### Session naming

Sessions are automatically named from:
1. Git branch (if not `main`/`master`/`develop`)
2. `package.json` name
3. Directory name

Name collisions are resolved with suffixes: `frontend`, `frontend-2`, `frontend-3`.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send a message to Discord. Supports `reply_to` for threading and `files` for attachments (max 10 files, 25MB each). Auto-chunks at 2000 chars. |
| `react` | Add an emoji reaction to a message. |
| `edit_message` | Edit a previously sent message. Useful for progress updates. |
| `fetch_messages` | Pull recent history from a channel (max 100). |
| `download_attachment` | Download attachments from a message to `~/.claude/channels/discord/inbox/`. |

## Access control

See `/discord:access` for full management. Quick reference:

```
/discord:access                    # show current status
/discord:access pair <code>        # approve a pairing
/discord:access allow <userId>     # add a user by ID
/discord:access remove <userId>    # remove a user
/discord:access policy allowlist   # lock down (recommended)
/discord:access policy pairing     # re-enable pairing temporarily
```

IDs are Discord **snowflakes** (numeric). Enable Developer Mode (User Settings → Advanced), then right-click any user → Copy User ID.

## Architecture

```
Discord ←→ Router (Discord bot + WS server)
              ├─ Session: frontend (Claude Code instance)
              ├─ Session: backend  (Claude Code instance)
              └─ Session: devops   (Claude Code instance)
```

- **Router** (`src/router.ts`): Discord bot that receives DMs, runs access control, routes messages to the active session, handles slash commands, and buffers replies from inactive sessions.
- **Plugin** (`src/plugin.ts`): MCP server that runs inside each Claude Code instance. Connects to the router via WebSocket. Exposes reply/react/edit/download/fetch tools to Claude.

The router and plugins communicate over a WebSocket protocol. The plugin is Discord-unaware — all Discord API calls happen in the router.

## Updating

After code changes:

```bash
./deploy.sh
```

Then restart your Claude Code sessions. The router can stay running.

If Claude Code re-syncs the marketplace and overwrites the cache, run `./deploy.sh` again.

## Development

```bash
bun test          # 73 tests
bun run check     # TypeScript type checking
```

## License

Apache-2.0 — forked from [Anthropic's official Discord plugin](https://github.com/anthropics/claude-plugins-official).

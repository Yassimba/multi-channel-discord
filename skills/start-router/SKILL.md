---
name: start-router
description: Start the Discord router (bot) process. Use when the user wants to start, restart, or check the Discord bot.
user-invocable: true
allowed-tools:
  - Bash(bun *)
  - Bash(lsof *)
  - Bash(kill *)
---

# /discord:start-router

Start the Discord router process (the bot that bridges Discord and Claude Code sessions).

## Steps

1. Check if the router is already running:
   ```bash
   lsof -i :8789 2>/dev/null | grep LISTEN
   ```

2. If running, ask the user if they want to restart it.

3. Find the router script. It lives in the plugin cache:
   ```bash
   ls ~/.claude/plugins/cache/multi-channel-discord/discord/*/src/router.ts
   ```

4. Start it:
   ```bash
   bun run <path-to-router.ts> &
   ```

5. Verify it connected:
   - Should see "WS server listening on port 8789"
   - Should see "gateway connected as <BotName>"

If the token isn't configured, tell the user to run `/discord:configure <token>` first.

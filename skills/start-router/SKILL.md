---
name: start-router
description: Start the Discord router (bot) process. Use when the user wants to start, restart, or check the Discord bot.
user-invocable: true
allowed-tools:
  - Bash(bunx *)
  - Bash(bun *)
  - Bash(lsof *)
  - Bash(kill *)
  - Bash(cat *)
---

# /discord:start-router

Start the Discord router process (the bot that bridges Discord and Claude Code sessions).

## Steps

1. Check if a token is configured:
   ```bash
   cat ~/.claude/channels/discord/.env 2>/dev/null | grep DISCORD_BOT_TOKEN
   ```
   If no token, tell the user to run `/discord:configure <token>` first and stop.

2. Check if the router is already running:
   ```bash
   lsof -i :8789 2>/dev/null | grep LISTEN
   ```
   If running, tell the user it's already up. Ask if they want to restart.

3. Start the router using the npm package:
   ```bash
   bunx multi-channel-discord &
   ```

4. Wait 3 seconds, then verify it connected:
   ```bash
   sleep 3 && lsof -i :8789 2>/dev/null | grep LISTEN
   ```
   Should see a process listening on port 8789.

5. Confirm to the user:
   - "Router started. Your bot should be online in Discord."
   - "Run `/discord:start-router` again anytime to check status or restart."

## Restart

If the user wants to restart:
```bash
kill $(lsof -t -i:8789) 2>/dev/null
sleep 1
bunx multi-channel-discord &
```

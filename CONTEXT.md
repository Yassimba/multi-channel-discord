# Building a Claude Code Channel Plugin — What We Learned

Hard-won knowledge from building a multi-instance Discord channel for Claude Code. This isn't in the docs.

## Plugin System Internals

**Cache, not source.** Claude Code copies plugins to `~/.claude/plugins/cache/<marketplace>/<name>/<version>/` and runs from there. Changes to your source repo do nothing until you rebuild the cache. Our `./deploy.sh` bundles `plugin.ts` into the cache's `server.ts`.

**The `.mcp.json` entry point.** Claude Code runs your plugin via `.mcp.json`. The official pattern is:
```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```
This runs the `start` script from `package.json`, which runs `server.ts`. Don't put a second entry point in `.mcp.json` or you get double spawns.

**Double spawn trap.** If you have BOTH a user-level MCP server in `~/.claude.json` AND a plugin `.mcp.json`, Claude Code runs both. Remove any `cad mcp add` entries that overlap with your plugin.

**Bundle required.** The cache needs a self-contained `server.ts`. Raw TypeScript with relative imports doesn't resolve from the cache dir. Use `bun build src/plugin.ts --target=bun --outfile=server.ts` to bundle everything into one file.

**`startPlugin()` dedup.** If your source has `isMainModule` check AND you append a call in the bundle, it runs twice. Pick one. We removed the `isMainModule` check and let the bundle call `startPlugin()` directly.

## Environment & Process Tree

**`process.cwd()` is the cache dir.** Claude Code sets `--cwd ${CLAUDE_PLUGIN_ROOT}`, so `process.cwd()` returns the cache path, not the user's project.

**`OLDPWD` is unreliable.** It contains whichever directory the user was in before launching `cad`, which might not be the project they're working on.

**Real project dir: walk the process tree.** The Claude Code process (grandparent) has the real project cwd:
```typescript
const { execSync } = require('child_process')
const ppid = execSync(`ps -p ${process.ppid} -o ppid=`).toString().trim()
const cwd = execSync(`lsof -p ${ppid} 2>/dev/null | grep cwd | awk '{print $NF}'`).toString().trim()
```
Process tree: `plugin.ts → bun → claude → zsh`. Grandparent PID (from `process.ppid`'s parent) is Claude Code.

**`process.ppid` is Claude Code.** Confirmed via process tree. Multiple MCP spawns from the same Claude Code instance share this PID. Use it as `instanceId` for session dedup.

## Channel Protocol

**Use raw `Server`, not `McpServer`.** The high-level `McpServer` wrapper doesn't support the channel capability. Use `Server` from `@modelcontextprotocol/sdk/server/index.js` directly.

**The capability declaration is everything:**
```typescript
const mcp = new Server(
  { name: 'discord', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},              // registers notification listener
        'claude/channel/permission': {},   // opt in to permission relay
      },
    },
    instructions: '...',  // goes into Claude's system prompt
  },
)
```
Without `experimental: { 'claude/channel': {} }`, Claude Code won't register the notification listener and messages never appear.

**Notification format:**
```typescript
mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'message text',
    meta: { chat_id: '...', message_id: '...', user: '...', ts: '...' },
  },
})
```
Meta keys become attributes on the `<channel>` tag. Keys must be identifiers (letters, digits, underscores only).

**Permission relay:** Claude Code sends `notifications/claude/channel/permission_request` with `request_id` (5 lowercase letters), `tool_name`, `description`, `input_preview`. Reply with `notifications/claude/channel/permission` carrying `request_id` and `behavior` ('allow' or 'deny').

## Marketplace Publishing

**Structure for flat layout** (plugin at repo root):
```
your-repo/
├── .claude-plugin/
│   ├── plugin.json         # name, description, version
│   └── marketplace.json    # marketplace catalog
├── .mcp.json               # MCP server definition
├── src/
├── skills/
└── package.json
```

**`marketplace.json`:**
```json
{
  "name": "your-marketplace",
  "owner": { "name": "YourName" },
  "plugins": [{
    "name": "discord",
    "source": "./",
    "description": "...",
    "version": "0.0.1"
  }]
}
```

**Users install with:**
```
/plugin marketplace add YourName/your-repo
/plugin install discord@your-marketplace
```

**Development channels require a flag.** Custom marketplaces aren't on Anthropic's approved allowlist. Users must launch with:
```bash
claude --dangerously-load-development-channels plugin:discord@your-marketplace
```

**To avoid the flag:** submit to the official marketplace at `anthropics/claude-plugins-official`.

## Multi-Instance Gotchas

**Claude Code spawns the plugin process once, but multiple connections happen.** The single process can create multiple WS connections if `startPlugin()` is called twice (bundle dedup issue).

**Session dedup by `instanceId` (parent PID), not `projectPath`.** Two Claude Code instances on the same branch should be separate sessions. Multiple MCP spawns from the same Claude Code should merge. `process.ppid` distinguishes these.

**Broadcast to all `extraSends`.** When deduped sessions receive messages, broadcast to all registered send callbacks — we don't know which one is the channel handler.

**Close handler: only deregister if primary.** When a WS closes, check if it's the primary sender (`isPrimarySender()`). If it's an `extraSend` duplicate, just remove the callback without killing the session.

**Official plugin conflict.** If `discord@claude-plugins-official` is enabled in settings, it steals `messageCreate` events from your bot (same token, different process). Disable it in `~/.claude/settings.json`.

## Discord.js Notes

**Global slash commands take ~1 hour to propagate.** First deploy requires patience. Guild-specific commands are instant but don't work in DMs.

**Ephemeral responses** use `{ ephemeral: true }` in the reply options. Only the invoking user sees them.

**Typing indicator expires after 10 seconds.** Refresh every 8 seconds with `channel.sendTyping()` in a `setInterval`.

**Buttons for 2-5 options, select menu for 6+.** Discord caps buttons at 5 per action row. Use `StringSelectMenuBuilder` for more options (max 25).

**`awaitMessageComponent` for interactive responses.** Set a timeout (we use 5 minutes) and clean up components on timeout.

**Bot presence:** `client.user.setPresence()` with `ActivityType.Custom` for status messages.

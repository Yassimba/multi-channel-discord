#!/bin/bash
# Deploy the multi-instance Discord plugin to Claude Code's plugin cache.
# Run this after making changes or if Claude Code re-syncs the marketplace.
#
# Usage:
#   ./deploy.sh
#
# Then restart any 'cad --dangerously-load-development-channels plugin:discord@multi-channel-discord' sessions.

set -e
CACHE_DIR="$HOME/.claude/plugins/cache/multi-channel-discord/discord/0.0.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building plugin bundle..."
cd "$SCRIPT_DIR"
bun build src/plugin.ts --target=bun --outfile="$CACHE_DIR/server.ts"

echo "Updating config files..."
cat > "$CACHE_DIR/.mcp.json" << 'EOF'
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
EOF

cat > "$CACHE_DIR/package.json" << 'EOF'
{
  "name": "claude-channel-discord",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "discord.js": "^14.14.0"
  }
}
EOF

echo "Deployed to: $CACHE_DIR"
echo ""
echo "To use:"
echo "  1. Start the router:  bun run $SCRIPT_DIR/src/router.ts"
echo "  2. Start Claude Code: cad --dangerously-load-development-channels plugin:discord@multi-channel-discord"

#!/bin/bash
# Deploy the multi-instance Discord plugin to Claude Code's plugin cache.
# Run this after Anthropic updates their plugin, or after making changes.

set -e
CACHE_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building plugin bundle..."
cd "$SCRIPT_DIR"
bun build src/plugin.ts --target=bun --outfile="$CACHE_DIR/server.ts"

echo "Updating package.json..."
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
echo "Kill any running 'cad --channels' sessions and restart them."

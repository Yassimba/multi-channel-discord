# /discord:configure

Interactive setup guide for the Discord channel plugin.

## Steps

### 1. Discord Bot Token

You need a bot token from the [Discord Developer Portal](https://discord.com/developers/applications):

1. Go to Applications and create a new application (or select existing)
2. Go to **Bot** section
3. Click **Reset Token** and copy the token
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent** (optional, for member lookups)

### 2. Set the Token

Save the bot token to the channel config:

```bash
mkdir -p ~/.claude/channels/discord
echo "DISCORD_BOT_TOKEN=your-token-here" > ~/.claude/channels/discord/.env
chmod 600 ~/.claude/channels/discord/.env
```

Optional settings in the same `.env`:
```bash
DISCORD_WS_PORT=8789    # default: 8789
```

### 3. Invite the Bot

Generate an invite URL from the Developer Portal:

1. Go to **OAuth2** > **URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Manage Messages`
4. Copy the generated URL and open it in your browser
5. Select the server to invite the bot to

### 4. Validate

Test by starting the router:

```bash
bun run src/router.ts
```

You should see: `discord channel: gateway connected as YourBot#1234`

Send a DM to the bot. You should receive a pairing code response.

## Verification

After setup, confirm:
- Bot appears online in your Discord server
- Slash commands (`/switch`, `/list`, `/status`) appear when typing `/`
- DM to the bot triggers pairing flow

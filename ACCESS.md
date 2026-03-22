# Access Control

The Discord channel gates every inbound message before it reaches Claude. All state lives in `~/.claude/channels/discord/access.json`, managed by the `/discord:access` skill.

## DM Policy

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Unknown senders get a 6-char hex code. Approve with `/discord:access pair <code>` in Claude Code. Max 3 pending at a time, codes expire after 1 hour. After 2 replies per sender, further messages are silently dropped. |
| `allowlist` | Only pre-approved user IDs can message. No pairing flow. Recommended after initial setup. |
| `disabled` | All DMs are silently dropped. |

Change with: `/discord:access policy <mode>`

## Pairing Flow

1. Someone DMs the bot
2. Bot replies: *"Pairing required — run in Claude Code: `/discord:access pair abc123`"*
3. You run `/discord:access pair abc123` in your terminal
4. Their Discord user ID is added to `allowFrom`
5. Bot sends them a confirmation: *"Paired! Say hi to Claude."*

## Manual Allowlist

If you have the user's Discord snowflake ID (enable Developer Mode → right-click → Copy User ID):

```
/discord:access allow 310742800855465985
/discord:access remove 310742800855465985
```

## Guild Channels

By default the bot only responds to DMs. To opt in a guild channel:

```
/discord:access group add <channelId>
```

Options:
- `--no-mention` — respond to all messages, not just @mentions
- `--allow id1,id2` — restrict to specific users in that channel

Remove with: `/discord:access group rm <channelId>`

In guild channels, the bot requires an @mention (or a reply to the bot's message) by default. Custom mention patterns can be added:

```
/discord:access set mentionPatterns '["@mybot", "hey claude"]'
```

## Delivery Config

| Key | Default | Description |
| --- | --- | --- |
| `ackReaction` | *(none)* | Emoji to react with on receipt. Set to `""` to disable. |
| `replyToMode` | `first` | Which chunks get Discord's reply reference: `off`, `first`, `all`. |
| `textChunkLimit` | `2000` | Max chars per message before splitting. Discord caps at 2000. |
| `chunkMode` | `length` | Split mode: `length` (hard cut) or `newline` (prefer paragraph boundaries). |

Set with: `/discord:access set <key> <value>`

## Security Notes

- **Gate on sender, not channel.** In group chats, `message.from.id` differs from `message.chat.id`. The gate checks the sender's user ID.
- **Access mutations are terminal-only.** The `/discord:access` skill refuses requests that arrived via Discord messages to prevent prompt injection.
- **Tokens are credentials.** The `.env` file is `chmod 600`. The bot token grants full control of your bot.
- **File sends are gated.** The reply tool blocks sending files from the state directory (except `inbox/`), preventing accidental exfiltration of `access.json` or `.env`.

## access.json Schema

```json
{
  "dmPolicy": "pairing | allowlist | disabled",
  "allowFrom": ["userId1", "userId2"],
  "groups": {
    "channelId": {
      "requireMention": true,
      "allowFrom": ["userId1"]
    }
  },
  "pending": {
    "abc123": {
      "senderId": "310742800855465985",
      "chatId": "1234567890123456789",
      "createdAt": 1711100000000,
      "expiresAt": 1711103600000,
      "replies": 1
    }
  },
  "mentionPatterns": ["@mybot"],
  "ackReaction": "👀",
  "replyToMode": "first",
  "textChunkLimit": 2000,
  "chunkMode": "newline"
}
```

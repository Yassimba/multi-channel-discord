/**
 * Router — Discord bot + WS server + multi-session coordinator.
 *
 * The Discord bot receives messages and routes them to the active Claude Code
 * session via WebSocket. Claude replies flow back through the WS protocol
 * and are sent to Discord by the router.
 */

import { loadEnvFile, gate, checkApprovals, loadAccess, getStateDir } from './access.js'
import { createDiscordClient, safeAttName } from './discord.js'
import { SessionManager, ProjectHistory } from './sessions.js'
import { createWsHandlers } from './ws.js'
import type { WsData } from './ws.js'
import { PidManager } from './pid.js'
import { registerSlashCommands, handleSlashCommand, handleAutocomplete } from './slash-commands.js'
import type { SlashCommandDeps } from './slash-commands.js'
import type { Message } from 'discord.js'

// Load token from ~/.claude/channels/discord/.env
loadEnvFile()

const TOKEN = process.env.DISCORD_BOT_TOKEN
const WS_PORT = parseInt(process.env.DISCORD_WS_PORT ?? '8789', 10)
const STATE_DIR = getStateDir()

if (!TOKEN) {
  const envFile = `${STATE_DIR}/.env`
  process.stderr.write(
    `discord channel: DISCORD_BOT_TOKEN required\n` +
    `  set in ${envFile}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

// ============================================================
// Discord client
// ============================================================

const client = createDiscordClient()

// Safety nets
process.on('unhandledRejection', err => {
  process.stderr.write(`discord channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`discord channel: uncaught exception: ${err}\n`)
})

// ============================================================
// Session management
// ============================================================

const sessions = new SessionManager()
const history = new ProjectHistory()
const startedAt = Date.now()

let activeChatId: string | null = null

// ============================================================
// WebSocket server for Claude Code plugins
// ============================================================

const access = loadAccess()

const wsHandlers = createWsHandlers({
  sessions,
  history,
  client,
  chatId: () => activeChatId,
  chunkLimit: Math.min(access.textChunkLimit ?? 2000, 2000),
  chunkMode: access.chunkMode ?? 'length',
  replyToMode: access.replyToMode ?? 'first',
})

const wsServer = Bun.serve<WsData>({
  port: WS_PORT,
  fetch(req, server) {
    const upgraded = server.upgrade(req, {
      data: { sessionName: null },
    })
    if (!upgraded) {
      return new Response('WebSocket upgrade required', { status: 426 })
    }
    return undefined as unknown as Response
  },
  websocket: {
    open(ws) {
      wsHandlers.open(ws as any)
    },
    message(ws, msg) {
      wsHandlers.message(ws as any, msg as string | Buffer)
    },
    close(ws) {
      wsHandlers.close(ws as any)
    },
  },
})

process.stderr.write(`discord channel: WS server listening on port ${WS_PORT}\n`)

// ============================================================
// PID management
// ============================================================

const pidManager = new PidManager()
await pidManager.write()

// ============================================================
// Slash command dependencies
// ============================================================

const slashDeps: SlashCommandDeps = {
  sessions,
  history,
  startedAt,
}

// ============================================================
// Inbound message handler
// ============================================================

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
    } catch (err) {
      process.stderr.write(`discord channel: failed to send pairing code: ${err}\n`)
    }
    return
  }

  const accessConfig = result.access

  // Track the active chat
  activeChatId = msg.channelId

  // Typing indicator
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }

  // Ack reaction
  if (accessConfig.ackReaction) {
    void msg.react(accessConfig.ackReaction).catch(() => {})
  }

  // Build attachment metadata
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att.name ?? att.id, att.id)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  // Route to active session
  const meta: Record<string, string> = {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
  }

  const routed = sessions.routeToActive(content, meta)
  if (!routed) {
    try {
      await msg.reply('No active session. Connect Claude Code with this plugin, or use `/switch` to activate a session.')
    } catch {}
  }
}

// ============================================================
// Event handlers
// ============================================================

client.on('error', err => {
  process.stderr.write(`discord channel: client error: ${err}\n`)
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => process.stderr.write(`discord: handleInbound failed: ${e}\n`))
})

client.on('interactionCreate', interaction => {
  if (interaction.isAutocomplete()) {
    handleAutocomplete(interaction, slashDeps)
    return
  }
  if (interaction.isChatInputCommand()) {
    handleSlashCommand(interaction, slashDeps).catch(e =>
      process.stderr.write(`discord: slash command failed: ${e}\n`),
    )
  }
})

client.once('clientReady', c => {
  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\n`)
  registerSlashCommands(c).catch(e =>
    process.stderr.write(`discord: registerSlashCommands failed: ${e}\n`),
  )
})

// Poll for pairing approvals
setInterval(() => checkApprovals(client), 5000).unref()

// Periodic buffer persistence
const bufferInterval = setInterval(() => {
  sessions.saveBuffers().catch(() => {})
}, 30_000)

// ============================================================
// Shutdown
// ============================================================

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord channel: shutting down\n')
  clearInterval(bufferInterval)
  try {
    await history.save()
    await sessions.saveBuffers()
    await pidManager.remove()
  } catch {}
  wsServer.stop()
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGTERM', () => { shutdown() })
process.on('SIGINT', () => { shutdown() })

// Load persisted state
await history.load()
await sessions.loadBuffers()

// ============================================================
// Start
// ============================================================

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord channel: login failed: ${err}\n`)
  process.exit(1)
})

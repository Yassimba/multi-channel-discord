/**
 * Discord client setup and message sending helpers.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type TextBasedChannel,
} from 'discord.js'
import { realpathSync, statSync } from 'fs'
import { join, sep } from 'path'
import { getStateDir } from './access.js'

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// ============================================================
// Client factory
// ============================================================

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })
}

// ============================================================
// Channel helpers
// ============================================================

export async function fetchTextChannel(client: Client, id: string): Promise<TextBasedChannel> {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`)
  }
  return ch as TextBasedChannel
}

// ============================================================
// Text chunking (Discord 2000 char limit)
// ============================================================

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): readonly string[] {
  const cap = Math.max(1, Math.min(limit, MAX_CHUNK_LIMIT))
  if (text.length <= cap) return [text]

  const out: string[] = []
  let rest = text
  while (rest.length > cap) {
    let cut = cap
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', cap)
      const line = rest.lastIndexOf('\n', cap)
      const space = rest.lastIndexOf(' ', cap)
      cut = para > cap / 2 ? para : line > cap / 2 ? line : space > 0 ? space : cap
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ============================================================
// File security — block state dir, allow everything else
// ============================================================

export function assertSendable(filePath: string, stateDir?: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(filePath)
    stateReal = realpathSync(getStateDir(stateDir))
  } catch {
    return // statSync will fail properly; or STATE_DIR absent → nothing to leak
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${filePath}`)
  }
}

export function assertFileSize(filePath: string): void {
  const st = statSync(filePath)
  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large: ${filePath} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
  }
}

// ============================================================
// Attachment name sanitization
// ============================================================

export function safeAttName(name: string, id: string): string {
  return (name ?? id).replace(/[\[\]\r\n;]/g, '_')
}

// ============================================================
// Typing indicator manager
// ============================================================

/** Manages persistent typing indicators for Discord channels. */
export class TypingManager {
  private readonly client: Client
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>()

  constructor(client: Client) {
    this.client = client
  }

  /** Start a persistent typing indicator for a channel. Refreshes every 8s (Discord expires after 10s). */
  start(chatId: string): void {
    if (this.intervals.has(chatId)) return

    void this.sendOnce(chatId)

    const interval = setInterval(() => {
      void this.sendOnce(chatId)
    }, 8_000)

    this.intervals.set(chatId, interval)
  }

  /** Stop the typing indicator for a channel. */
  stop(chatId: string): void {
    const interval = this.intervals.get(chatId)
    if (interval) {
      clearInterval(interval)
      this.intervals.delete(chatId)
    }
  }

  /** Stop all typing indicators. */
  stopAll(): void {
    for (const interval of this.intervals.values()) clearInterval(interval)
    this.intervals.clear()
  }

  private async sendOnce(chatId: string): Promise<void> {
    try {
      const ch = await this.client.channels.fetch(chatId)
      if (ch && ch.isTextBased() && 'sendTyping' in ch) {
        await (ch as unknown as { sendTyping(): Promise<void> }).sendTyping()
      }
    } catch {}
  }
}

export { MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES }

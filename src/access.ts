/**
 * Access control for Discord channel.
 * Ported from Anthropic's official Discord plugin (Apache-2.0).
 * Manages pairing, allowlists, guild channel opt-in, and mention detection.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  ChannelType,
  type Message,
  type Client,
} from 'discord.js'

// ============================================================
// State directory & file paths
// ============================================================

export function getStateDir(stateDir?: string): string {
  return stateDir ?? process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}

function getAccessFile(stateDir?: string): string {
  return join(getStateDir(stateDir), 'access.json')
}

function getApprovedDir(stateDir?: string): string {
  return join(getStateDir(stateDir), 'approved')
}

export function getEnvFile(stateDir?: string): string {
  return join(getStateDir(stateDir), '.env')
}

// ============================================================
// Types
// ============================================================

export interface PendingEntry {
  readonly senderId: string
  readonly chatId: string
  readonly createdAt: number
  readonly expiresAt: number
  replies: number
}

export interface GroupPolicy {
  readonly requireMention: boolean
  readonly allowFrom: readonly string[]
}

export interface AccessConfig {
  readonly dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  readonly allowFrom: readonly string[]
  readonly groups: Readonly<Record<string, GroupPolicy>>
  pending: Record<string, PendingEntry>
  readonly mentionPatterns?: readonly string[]
  readonly ackReaction?: string
  readonly replyToMode?: 'off' | 'first' | 'all'
  readonly textChunkLimit?: number
  readonly chunkMode?: 'length' | 'newline'
}

export type GateResult =
  | { readonly action: 'deliver'; readonly access: AccessConfig }
  | { readonly action: 'drop' }
  | { readonly action: 'pair'; readonly code: string; readonly isResend: boolean }

// ============================================================
// Defaults
// ============================================================

export function defaultAccess(): AccessConfig {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// ============================================================
// Load / Save
// ============================================================

export function loadAccess(stateDir?: string): AccessConfig {
  const file = getAccessFile(stateDir)
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccessConfig>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`discord: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

export function saveAccess(access: Readonly<AccessConfig>, stateDir?: string): void {
  const dir = getStateDir(stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = getAccessFile(stateDir)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// ============================================================
// Expiry
// ============================================================

function pruneExpired(access: AccessConfig): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < now) {
      delete access.pending[code]
      changed = true
    }
  }
  return changed
}

// ============================================================
// Gate — decides whether to deliver, drop, or pair
// ============================================================

// Track message IDs we recently sent so reply-to-bot counts as a mention.
const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

export function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

export async function gate(msg: Message, stateDir?: string): Promise<GateResult> {
  const access = loadAccess(stateDir)
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access, stateDir)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    return gateDM(msg, access, senderId, stateDir)
  }

  return gateGuild(msg, access, senderId)
}

function gateDM(msg: Message, access: AccessConfig, senderId: string, stateDir?: string): GateResult {
  if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  // Pairing mode -- check for existing code for this sender
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= 2) return { action: 'drop' }
      p.replies = (p.replies ?? 1) + 1
      saveAccess(access, stateDir)
      return { action: 'pair', code, isResend: true }
    }
  }
  // Cap pending at 3
  if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

  const code = randomBytes(3).toString('hex')
  const now = Date.now()
  access.pending[code] = {
    senderId,
    chatId: msg.channelId,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000, // 1h
    replies: 1,
  }
  saveAccess(access, stateDir)
  return { action: 'pair', code, isResend: false }
}

async function gateGuild(msg: Message, access: AccessConfig, senderId: string): Promise<GateResult> {
  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }

  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }

  const requireMention = policy.requireMention ?? true
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

async function isMentioned(msg: Message, extraPatterns?: readonly string[]): Promise<boolean> {
  if (msg.client.user && msg.mentions.has(msg.client.user)) return true

  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === msg.client.user?.id) return true
    } catch {}
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ============================================================
// Approval polling — router calls this periodically
// ============================================================

export function checkApprovals(client: Client, stateDir?: string): void {
  const dir = getApprovedDir(stateDir)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(dir, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }

    // Fire-and-forget: send approval confirmation asynchronously without blocking the polling loop
    void (async () => {
      try {
        const ch = await client.channels.fetch(dmChannelId)
        if (ch && ch.isTextBased() && 'send' in ch) {
          await ch.send("Paired! Say hi to Claude.")
        }
        rmSync(file, { force: true })
      } catch (err: unknown) {
        process.stderr.write(`discord: failed to send approval confirm: ${err instanceof Error ? err.message : String(err)}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

// ============================================================
// .env loader
// ============================================================

export function loadEnvFile(stateDir?: string): void {
  const envFile = getEnvFile(stateDir)
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

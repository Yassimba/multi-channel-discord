/**
 * Session manager — routing table, active session, message buffers.
 * Ported from the WhatsApp project.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEntry, BufferedMessage, WsMessage, ProjectHistoryEntry, ChannelMeta } from './types.js'
import { SessionNotFoundError } from './errors.js'
import { getStateDir } from './access.js'

interface SessionSlot {
  readonly name: string
  readonly projectPath: string
  readonly connectedAt: number
  messageCount: number
  readonly send: (msg: string) => void
  readonly extraSends: Array<(msg: string) => void>
}

/** Manages the routing table, active session, message buffers, and unrouted inbox. */
export class SessionManager {
  private sessions = new Map<string, SessionSlot>()
  private active: string | null = null
  private unrouted: BufferedMessage[] = []
  private buffers = new Map<string, BufferedMessage[]>()

  /** Register a session. Returns the actual name (may differ due to collision suffix).
   *  If a session with the same projectPath already exists, adds this send callback
   *  to a list so ALL plugin instances for the same project receive messages. */
  registerSession(send: (msg: string) => void, name: string, projectPath: string): string {
    // Deduplicate: if same project is already registered, add send callback to existing
    for (const [existingName, slot] of this.sessions) {
      if (slot.projectPath === projectPath) {
        slot.extraSends.push(send)
        return existingName
      }
    }

    const actualName = this.resolveCollision(name)
    this.sessions.set(actualName, {
      name: actualName,
      projectPath,
      connectedAt: Date.now(),
      messageCount: 0,
      send,
      extraSends: [],
    })
    return actualName
  }

  /** Remove a session from the routing table. Also cleans up any extraSends references to this session's send callback. */
  deregisterSession(name: string): void {
    const slot = this.sessions.get(name)
    if (!slot) {
      throw new SessionNotFoundError(name)
    }
    const deadSend = slot.send
    this.sessions.delete(name)
    this.buffers.delete(name)
    if (this.active === name) {
      this.active = null
    }
    // Clean up extraSends in other sessions that might reference this session's send callback
    for (const [, otherSlot] of this.sessions) {
      const idx = otherSlot.extraSends.indexOf(deadSend)
      if (idx !== -1) otherSlot.extraSends.splice(idx, 1)
    }
  }

  /** Check if a send callback is the primary sender for a session (not an extraSend). */
  isPrimarySender(sessionName: string, send: (msg: string) => void): boolean {
    const slot = this.sessions.get(sessionName)
    return slot?.send === send
  }

  /** Remove a specific send callback from all sessions' extraSends lists without deregistering the session. */
  cleanupSender(send: (msg: string) => void): void {
    for (const [, slot] of this.sessions) {
      const idx = slot.extraSends.indexOf(send)
      if (idx !== -1) slot.extraSends.splice(idx, 1)
    }
  }

  /** Rename a session. Returns the actual new name. */
  renameSession(oldName: string, newName: string): string {
    const slot = this.sessions.get(oldName)
    if (!slot) throw new SessionNotFoundError(oldName)

    this.sessions.delete(oldName)
    const actualName = this.resolveCollision(newName)
    this.sessions.set(actualName, { ...slot, name: actualName })

    const buf = this.buffers.get(oldName)
    if (buf) {
      this.buffers.delete(oldName)
      this.buffers.set(actualName, buf)
    }

    if (this.active === oldName) {
      this.active = actualName
    }
    return actualName
  }

  /** Set the active session by name. */
  setActive(name: string): void {
    if (!this.sessions.has(name)) throw new SessionNotFoundError(name)
    this.active = name
  }

  getActive(): string | null {
    return this.active
  }

  /** Route a message to the active session. Returns false if queued to unrouted. */
  routeToActive(text: string, meta: ChannelMeta): boolean {
    if (!this.active) {
      this.unrouted.push({ text, timestamp: Date.now(), sessionName: '', meta })
      return false
    }
    const slot = this.sessions.get(this.active)
    if (!slot) {
      this.unrouted.push({ text, timestamp: Date.now(), sessionName: '', meta })
      return false
    }
    const msg: WsMessage = { type: 'message', content: text, meta }
    const json = JSON.stringify(msg)
    // Broadcast to ALL callbacks — Claude Code spawns multiple plugin instances
    // and we don't know which one is the channel handler.
    slot.send(json)
    for (const extra of slot.extraSends) { try { extra(json) } catch {} }
    slot.messageCount++
    return true
  }

  /** Send a message to a specific session by name. */
  routeToSession(name: string, text: string, meta: ChannelMeta): boolean {
    const slot = this.sessions.get(name)
    if (!slot) return false
    const msg: WsMessage = { type: 'message', content: text, meta }
    const json = JSON.stringify(msg)
    slot.send(json)
    for (const extra of slot.extraSends) { try { extra(json) } catch {} }
    slot.messageCount++
    return true
  }

  getSessions(): readonly SessionEntry[] {
    return Array.from(this.sessions.values()).map((slot) => ({
      name: slot.name,
      projectPath: slot.projectPath,
      connectedAt: slot.connectedAt,
      messageCount: slot.messageCount,
    }))
  }

  getUnrouted(): readonly BufferedMessage[] {
    return this.unrouted
  }

  drainUnrouted(): BufferedMessage[] {
    const drained = this.unrouted
    this.unrouted = []
    return drained
  }

  /** Buffer a reply from a non-active session. Returns the new buffer count, or 0 if session doesn't exist. */
  bufferReply(sessionName: string, text: string): number {
    if (!this.sessions.has(sessionName)) return 0
    const buf = this.buffers.get(sessionName) ?? []
    buf.push({ text, timestamp: Date.now(), sessionName, meta: {} as ChannelMeta })
    while (buf.length > 500) buf.shift()
    this.buffers.set(sessionName, buf)
    return buf.length
  }

  flushBuffer(sessionName: string): BufferedMessage[] {
    const buf = this.buffers.get(sessionName) ?? []
    this.buffers.delete(sessionName)
    return buf
  }

  getBufferedCount(sessionName: string): number {
    return this.buffers.get(sessionName)?.length ?? 0
  }

  getAllBuffers(): ReadonlyMap<string, readonly BufferedMessage[]> {
    return this.buffers
  }

  setAllBuffers(buffers: Map<string, BufferedMessage[]>): void {
    this.buffers = buffers
  }

  async saveBuffers(stateDir?: string): Promise<void> {
    const dir = getStateDir(stateDir)
    await mkdir(dir, { recursive: true })
    const data = { buffers: Object.fromEntries(this.buffers), unrouted: this.unrouted }
    await writeFile(join(dir, 'buffers.json'), JSON.stringify(data, null, 2))
  }

  async loadBuffers(stateDir?: string): Promise<void> {
    const dir = getStateDir(stateDir)
    try {
      const content = await readFile(join(dir, 'buffers.json'), 'utf-8')
      const data = JSON.parse(content) as { buffers?: Record<string, BufferedMessage[]>; unrouted?: BufferedMessage[] }
      if (data.buffers) this.buffers = new Map(Object.entries(data.buffers))
      if (Array.isArray(data.unrouted)) this.unrouted = data.unrouted
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  private resolveCollision(name: string): string {
    if (!this.sessions.has(name)) return name
    let suffix = 2
    while (this.sessions.has(`${name}-${suffix}`)) suffix++
    return `${name}-${suffix}`
  }
}

const PROJECTS_FILE = 'projects.json'
const MAX_HISTORY_ENTRIES = 100

/** Tracks which projects have connected, persisted to disk. */
export class ProjectHistory {
  private entries: ProjectHistoryEntry[] = []
  private readonly dir: string
  private readonly maxEntries: number

  constructor(stateDir?: string, maxEntries = MAX_HISTORY_ENTRIES) {
    this.dir = getStateDir(stateDir)
    this.maxEntries = maxEntries
  }

  record(name: string, path: string): void {
    const idx = this.entries.findIndex((e) => e.path === path)
    if (idx !== -1) this.entries.splice(idx, 1)
    this.entries.push({ name, path, lastUsed: Date.now() })
    while (this.entries.length > this.maxEntries) this.entries.shift()
  }

  getRecent(limit?: number): readonly ProjectHistoryEntry[] {
    const sorted = [...this.entries].reverse().sort((a, b) => b.lastUsed - a.lastUsed)
    return limit !== undefined ? sorted.slice(0, limit) : sorted
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(join(this.dir, PROJECTS_FILE), 'utf-8')
      this.entries = JSON.parse(content) as ProjectHistoryEntry[]
    } catch {}
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, PROJECTS_FILE), JSON.stringify(this.entries, null, 2))
  }
}

/** Format buffered messages for consolidated flush delivery. */
export function formatFlush(sessionName: string, messages: readonly BufferedMessage[]): string {
  if (messages.length === 0) return ''
  const lines = messages.map((m) => {
    const time = new Date(m.timestamp)
    const hh = String(time.getHours()).padStart(2, '0')
    const mm = String(time.getMinutes()).padStart(2, '0')
    return `${hh}:${mm} — ${m.text}`
  })
  return `[${sessionName}] 📬 Buffered messages:\n\n${lines.join('\n')}`
}

/**
 * WebSocket message handlers for the router's plugin-facing WS server.
 * Handles registration, reply, react, rename, deregister.
 */

import type { PluginToRouterMessage, WsRegistered, WsRenamed, WsError, WsToolResult } from './types.js'
import type { SessionManager, ProjectHistory } from './sessions.js'
import { chunk, assertSendable } from './discord.js'
import { noteSent, getStateDir } from './access.js'
import type { Client, TextBasedChannel } from 'discord.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

export interface WsData {
  sessionName: string | null
}

export interface WsDeps {
  sessions: SessionManager
  history: ProjectHistory
  client: Client
  chatId: () => string | null
  chunkLimit: number
  chunkMode: 'length' | 'newline'
  replyToMode: 'off' | 'first' | 'all'
  stateDir?: string
}

interface WsLike {
  data: WsData
  send(msg: string): void
}

export interface WsHandlers {
  open(ws: WsLike): void
  message(ws: WsLike, msg: string | Buffer): void
  close(ws: WsLike): void
}

export function createWsHandlers(deps: WsDeps): WsHandlers {
  return {
    open(_ws: WsLike) {},

    message(ws: WsLike, raw: string | Buffer) {
      const text = typeof raw === 'string' ? raw : raw.toString()

      let parsed: PluginToRouterMessage
      try {
        parsed = JSON.parse(text)
      } catch {
        sendError(ws, 'Invalid JSON')
        return
      }

      switch (parsed.type) {
        case 'register':
          if (!hasString(parsed, 'name') || !hasString(parsed, 'projectPath')) {
            sendError(ws, 'register requires name and projectPath')
            return
          }
          handleRegister(ws, parsed.name, parsed.projectPath, deps)
          break
        case 'deregister':
          handleDeregister(ws, deps)
          break
        case 'rename':
          if (!hasString(parsed, 'name')) {
            sendError(ws, 'rename requires name')
            return
          }
          handleRename(ws, parsed.name, deps)
          break
        case 'reply':
          if (!hasString(parsed, 'text')) {
            sendError(ws, 'reply requires text')
            return
          }
          handleReply(ws, parsed.text, parsed.replyTo, parsed.files, deps)
          break
        case 'react':
          if (!hasString(parsed, 'chatId') || !hasString(parsed, 'messageId') || !hasString(parsed, 'emoji')) {
            sendError(ws, 'react requires chatId, messageId, and emoji')
            return
          }
          handleReact(parsed.chatId, parsed.messageId, parsed.emoji, deps)
          break
        case 'editMessage':
          if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'messageId') || !hasString(parsed, 'text')) {
            sendError(ws, 'editMessage requires requestId, chatId, messageId, and text')
            return
          }
          handleEditMessage(ws, parsed.requestId, parsed.chatId, parsed.messageId, parsed.text, deps)
          break
        case 'downloadAttachment':
          if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'messageId')) {
            sendError(ws, 'downloadAttachment requires requestId, chatId, and messageId')
            return
          }
          handleDownloadAttachment(ws, parsed.requestId, parsed.chatId, parsed.messageId, deps)
          break
        case 'fetchMessages':
          if (!hasString(parsed, 'requestId') || !hasString(parsed, 'channel')) {
            sendError(ws, 'fetchMessages requires requestId and channel')
            return
          }
          handleFetchMessages(ws, parsed.requestId, parsed.channel, (parsed as { limit?: number }).limit, deps)
          break
        default:
          sendError(ws, `Unknown message type: ${(parsed as { type: string }).type}`)
      }
    },

    close(ws: WsLike) {
      if (ws.data.sessionName) {
        try {
          deps.sessions.deregisterSession(ws.data.sessionName)
        } catch {}
        ws.data.sessionName = null
      }
    },
  }
}

function handleRegister(ws: WsLike, name: string, projectPath: string, deps: WsDeps): void {
  const actualName = deps.sessions.registerSession(
    (msg: string) => ws.send(msg),
    name,
    projectPath,
  )
  ws.data.sessionName = actualName
  deps.history.record(actualName, projectPath)

  const response: WsRegistered = { type: 'registered', name: actualName }
  ws.send(JSON.stringify(response))
}

function handleDeregister(ws: WsLike, deps: WsDeps): void {
  if (ws.data.sessionName) {
    try {
      deps.sessions.deregisterSession(ws.data.sessionName)
    } catch {}
    ws.data.sessionName = null
  }
}

function handleRename(ws: WsLike, newName: string, deps: WsDeps): void {
  const oldName = ws.data.sessionName
  if (!oldName) {
    sendError(ws, 'Cannot rename: not registered')
    return
  }
  const actualName = deps.sessions.renameSession(oldName, newName)
  ws.data.sessionName = actualName

  const response: WsRenamed = { type: 'renamed', oldName, newName: actualName }
  ws.send(JSON.stringify(response))
}

function handleReply(ws: WsLike, text: string, replyTo: string | undefined, files: string[] | undefined, deps: WsDeps): void {
  const sessionName = ws.data.sessionName
  if (!sessionName) {
    sendError(ws, 'Cannot reply: not registered')
    return
  }

  const chatId = deps.chatId()
  if (!chatId) return

  const isActive = deps.sessions.getActive() === sessionName

  if (!isActive) {
    const count = deps.sessions.bufferReply(sessionName, text)
    sendToDiscord(deps.client, chatId, `[${sessionName} 📪] ${count} new message${count === 1 ? '' : 's'}`)
    return
  }

  // Active session — prefix with [session-name], chunk, and send
  const prefixed = `[${sessionName}] ${text}`
  const chunks = chunk(prefixed, deps.chunkLimit, deps.chunkMode)

  for (let i = 0; i < chunks.length; i++) {
    const shouldReplyTo = replyTo != null && deps.replyToMode !== 'off' && (deps.replyToMode === 'all' || i === 0)
    sendToDiscord(deps.client, chatId, chunks[i], shouldReplyTo ? replyTo : undefined, i === 0 ? files : undefined)
  }
}

function handleReact(chatId: string, messageId: string, emoji: string, deps: WsDeps): void {
  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased()) return
      const msg = await (ch as TextBasedChannel).messages.fetch(messageId)
      await msg.react(emoji)
    } catch (err) {
      process.stderr.write(`discord: react failed: ${err}\n`)
    }
  })()
}

function sendToDiscord(client: Client, chatId: string, text: string, replyTo?: string, files?: string[]): void {
  void (async () => {
    try {
      const ch = await client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased() || !('send' in ch)) return

      // Validate files
      const validFiles: string[] = []
      if (files) {
        for (const f of files) {
          try {
            assertSendable(f)
            validFiles.push(f)
          } catch {}
        }
      }

      const sent = await ch.send({
        content: text,
        ...(validFiles.length > 0 ? { files: validFiles } : {}),
        ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
      })
      noteSent(sent.id)
    } catch (err) {
      process.stderr.write(`discord: send failed: ${err}\n`)
    }
  })()
}

function handleEditMessage(ws: WsLike, requestId: string, chatId: string, messageId: string, text: string, deps: WsDeps): void {
  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased()) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await (ch as TextBasedChannel).messages.fetch(messageId)
      if (msg.author.id !== deps.client.user?.id) {
        sendToolResult(ws, requestId, false, 'Cannot edit messages from other users')
        return
      }
      await msg.edit(text)
      sendToolResult(ws, requestId, true, 'Message edited')
    } catch (err) {
      sendToolResult(ws, requestId, false, `Edit failed: ${err}`)
    }
  })()
}

function handleDownloadAttachment(ws: WsLike, requestId: string, chatId: string, messageId: string, deps: WsDeps): void {
  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased()) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await (ch as TextBasedChannel).messages.fetch(messageId)
      if (msg.attachments.size === 0) {
        sendToolResult(ws, requestId, false, 'No attachments on this message')
        return
      }

      const inboxDir = join(getStateDir(deps.stateDir), 'inbox')
      await mkdir(inboxDir, { recursive: true })

      const paths: string[] = []
      for (const att of msg.attachments.values()) {
        const url = att.url
        const resp = await fetch(url)
        if (!resp.ok) continue
        const buffer = await resp.arrayBuffer()
        const safeName = (att.name ?? att.id).replace(/[^a-zA-Z0-9._-]/g, '_')
        const filePath = join(inboxDir, `${att.id}_${safeName}`)
        await writeFile(filePath, Buffer.from(buffer))
        paths.push(filePath)
      }

      sendToolResult(ws, requestId, true, JSON.stringify(paths))
    } catch (err) {
      sendToolResult(ws, requestId, false, `Download failed: ${err}`)
    }
  })()
}

function handleFetchMessages(ws: WsLike, requestId: string, channelId: string, limit: number | undefined, deps: WsDeps): void {
  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(channelId)
      if (!ch || !ch.isTextBased()) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const messages = await (ch as TextBasedChannel).messages.fetch({ limit: Math.min(limit ?? 20, 100) })
      const result = messages.map(m => ({
        id: m.id,
        author: m.author.username,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        attachments: m.attachments.map(a => ({ name: a.name, url: a.url, size: a.size })),
      }))
      sendToolResult(ws, requestId, true, JSON.stringify(result))
    } catch (err) {
      sendToolResult(ws, requestId, false, `Fetch failed: ${err}`)
    }
  })()
}

function sendToolResult(ws: WsLike, requestId: string, success: boolean, data: string): void {
  const response: WsToolResult = { type: 'toolResult', requestId, success, data }
  ws.send(JSON.stringify(response))
}

function hasString(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[key] === 'string'
}

function sendError(ws: WsLike, message: string): void {
  const response: WsError = { type: 'error', message }
  ws.send(JSON.stringify(response))
}

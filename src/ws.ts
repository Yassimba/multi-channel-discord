/**
 * WebSocket message handlers for the router's plugin-facing WS server.
 *
 * Message types handled by dispatchMessage():
 *   register           → handleRegister       — register a new session
 *   deregister         → handleDeregister      — remove a session
 *   rename             → handleRename          — rename a session
 *   reply              → handleReply           — send a message to Discord
 *   react              → handleReact           — add emoji reaction
 *   editMessage        → handleEditMessage     — edit a previously sent message
 *   downloadAttachment → handleDownloadAttachment — download attachments from a message
 *   fetchMessages      → handleFetchMessages   — fetch recent channel messages
 *   askUser            → handleAskUser         — interactive question with buttons/select
 *   permissionRequest  → handlePermissionRequest — forward permission prompt to Discord
 *   registerSkills     → (inline)              — register discovered skills as slash commands
 */

import type { PluginToRouterMessage, WsRegistered, WsRenamed, WsError, WsToolResult, WsPermissionVerdict, WsAskUser, WsRegisterSkills, ChannelMeta } from './types.js'
import type { SessionManager, ProjectHistory } from './sessions.js'
import { chunk, assertSendable } from './discord.js'
import { noteSent, getStateDir } from './access.js'
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Client,
  type TextBasedChannel,
} from 'discord.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

export interface WsData {
  sessionName: string | null
  /** The send callback registered with SessionManager, kept for cleanup on close. */
  sendCallback: ((msg: string) => void) | null
}

export interface WsDeps {
  readonly sessions: SessionManager
  readonly history: ProjectHistory
  readonly client: Client
  readonly chatId: () => string | null
  readonly chunkLimit: number
  readonly chunkMode: 'length' | 'newline'
  readonly replyToMode: 'off' | 'first' | 'all'
  readonly stateDir?: string
  readonly onReply?: (chatId: string) => void
  readonly onSessionChange?: () => void
  readonly onSkillsRegistered?: (skills: ReadonlyArray<{ name: string; description: string }>) => void
}

export interface WsLike {
  data: WsData
  send(msg: string): void
}

export interface WsHandlers {
  open(ws: WsLike): void
  message(ws: WsLike, msg: string | Buffer): void
  close(ws: WsLike): void
}

/** Fetch a text-based channel from Discord, returning null if not found or not text-based. */
async function fetchTextChannelOrNull(client: Client, channelId: string): Promise<TextBasedChannel | null> {
  const ch = await client.channels.fetch(channelId)
  if (!ch || !ch.isTextBased()) return null
  return ch as TextBasedChannel
}

export function createWsHandlers(deps: Readonly<WsDeps>): WsHandlers {
  return {
    open(_ws: WsLike): void {},

    message(ws: WsLike, raw: string | Buffer): void {
      const text = typeof raw === 'string' ? raw : raw.toString()

      let parsed: PluginToRouterMessage
      try {
        parsed = JSON.parse(text) as PluginToRouterMessage
      } catch {
        sendError(ws, 'Invalid JSON')
        return
      }

      dispatchMessage(ws, parsed, deps)
    },

    close(ws: WsLike): void {
      // Clean up any pending permission requests associated with this WS
      for (const [reqId, reqWs] of permissionSessions) {
        if (reqWs === ws) {
          permissionSessions.delete(reqId)
          const t = permissionTimeouts.get(reqId)
          if (t) { clearTimeout(t); permissionTimeouts.delete(reqId) }
        }
      }

      if (ws.data.sessionName) {
        const isPrimary = ws.data.sendCallback
          ? deps.sessions.isPrimarySender(ws.data.sessionName, ws.data.sendCallback)
          : true

        if (ws.data.sendCallback) {
          deps.sessions.cleanupSender(ws.data.sendCallback)
        }

        // Only deregister the session if this WS is the primary sender.
        // Duplicate connections (extraSends) just remove their callback.
        if (isPrimary) {
          try {
            deps.sessions.deregisterSession(ws.data.sessionName)
          } catch {}
        }
        ws.data.sessionName = null
        ws.data.sendCallback = null
        deps.onSessionChange?.()
      }
    },
  }
}

function dispatchMessage(ws: WsLike, parsed: PluginToRouterMessage, deps: Readonly<WsDeps>): void {
  switch (parsed.type) {
    case 'register':
      if (!hasString(parsed, 'name') || !hasString(parsed, 'projectPath')) {
        sendError(ws, 'register requires name and projectPath')
        return
      }
      handleRegister(ws, parsed.name, parsed.projectPath, (parsed as { instanceId?: string }).instanceId, deps)
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
      handleReply(ws, parsed.text, parsed.replyTo, parsed.files ? [...parsed.files] : undefined, deps)
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
      handleFetchMessages(ws, parsed.requestId, parsed.channel, parsed.limit, deps)
      break
    case 'askUser':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'question')) {
        sendError(ws, 'askUser requires requestId, chatId, and question')
        return
      }
      handleAskUser(ws, parsed.requestId, parsed.chatId, parsed.question, parsed.options ?? [], deps)
      break
    case 'permissionRequest':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'toolName') || !hasString(parsed, 'description') || !hasString(parsed, 'inputPreview')) {
        sendError(ws, 'permissionRequest requires requestId, toolName, description, and inputPreview')
        return
      }
      handlePermissionRequest(ws, parsed.requestId, parsed.toolName, parsed.description, parsed.inputPreview, deps)
      break
    case 'registerSkills':
      if (!Array.isArray(parsed.skills)) {
        sendError(ws, 'registerSkills requires skills array')
        return
      }
      deps.onSkillsRegistered?.(parsed.skills)
      break
    default:
      sendError(ws, `Unknown message type: ${(parsed as { type: string }).type}`)
  }
}

function handleRegister(ws: WsLike, name: string, projectPath: string, instanceId: string | undefined, deps: Readonly<WsDeps>): void {
  const sendCb = (msg: string) => ws.send(msg)
  const actualName = deps.sessions.registerSession(
    sendCb,
    name,
    projectPath,
    instanceId,
  )
  ws.data.sessionName = actualName
  ws.data.sendCallback = sendCb
  deps.history.record(actualName, projectPath)

  const response: WsRegistered = { type: 'registered', name: actualName }
  ws.send(JSON.stringify(response))
  deps.onSessionChange?.()
}

function handleDeregister(ws: WsLike, deps: Readonly<WsDeps>): void {
  if (ws.data.sessionName) {
    try {
      deps.sessions.deregisterSession(ws.data.sessionName)
    } catch {}
    ws.data.sessionName = null
    deps.onSessionChange?.()
  }
}

function handleRename(ws: WsLike, newName: string, deps: Readonly<WsDeps>): void {
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

function handleReply(ws: WsLike, text: string, replyTo: string | undefined, files: string[] | undefined, deps: Readonly<WsDeps>): void {
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

  // Stop typing indicator when a reply is sent
  deps.onReply?.(chatId)
}

function handleReact(chatId: string, messageId: string, emoji: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: react asynchronously without blocking the WS message handler
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) return
      const msg = await ch.messages.fetch(messageId)
      await msg.react(emoji)
    } catch (err: unknown) {
      process.stderr.write(`discord: react failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })()
}

function sendToDiscord(client: Client, chatId: string, text: string, replyTo?: string, files?: readonly string[]): void {
  // Fire-and-forget: send to Discord asynchronously without blocking the caller
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(client, chatId)
      if (!ch || !('send' in ch)) return

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
    } catch (err: unknown) {
      process.stderr.write(`discord: send failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })()
}

function handleEditMessage(ws: WsLike, requestId: string, chatId: string, messageId: string, text: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: edit message asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await ch.messages.fetch(messageId)
      if (msg.author.id !== deps.client.user?.id) {
        sendToolResult(ws, requestId, false, 'Cannot edit messages from other users')
        return
      }
      await msg.edit(text)
      sendToolResult(ws, requestId, true, 'Message edited')
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Edit failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleDownloadAttachment(ws: WsLike, requestId: string, chatId: string, messageId: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: download attachments asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await ch.messages.fetch(messageId)
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
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleFetchMessages(ws: WsLike, requestId: string, channelId: string, limit: number | undefined, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: fetch messages asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, channelId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const messages = await ch.messages.fetch({ limit: Math.min(limit ?? 20, 100) })
      const result = messages.map(m => ({
        id: m.id,
        author: m.author.username,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        attachments: m.attachments.map(a => ({ name: a.name, url: a.url, size: a.size })),
      }))
      sendToolResult(ws, requestId, true, JSON.stringify(result))
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleAskUser(
  ws: WsLike,
  requestId: string,
  chatId: string,
  question: string,
  options: WsAskUser['options'],
  deps: Readonly<WsDeps>,
): void {
  // Fire-and-forget: ask user asynchronously via Discord components and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch || !('send' in ch)) {
        sendToolResult(ws, requestId, false, 'Channel not found or not sendable')
        return
      }

      const sessionName = ws.data.sessionName ?? 'unknown'

      if (options.length <= 5) {
        await askWithButtons(ch, ws, requestId, sessionName, question, options)
      } else {
        await askWithSelectMenu(ch, ws, requestId, sessionName, question, options)
      }
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Ask failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

async function askWithButtons(
  ch: { send: Function },
  ws: WsLike,
  requestId: string,
  sessionName: string,
  question: string,
  options: WsAskUser['options'],
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>()
  for (const opt of options) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ask_${requestId}_${opt.value}`)
        .setLabel(opt.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    )
  }

  const sent = await (ch as unknown as { send(opts: unknown): Promise<{ id: string; awaitMessageComponent(opts: unknown): Promise<{ customId: string; update(opts: unknown): Promise<void> }>; edit(opts: unknown): Promise<void> }> }).send({
    content: `**[${sessionName}]** ${question}`,
    components: [row],
  })
  noteSent(sent.id)

  try {
    const interaction = await sent.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 300_000,
    })

    const selectedValue = interaction.customId.replace(`ask_${requestId}_`, '')
    const selectedOption = options.find(o => o.value === selectedValue)

    await interaction.update({
      content: `**[${sessionName}]** ${question}\n\n> Selected: **${selectedOption?.label ?? selectedValue}**`,
      components: [],
    })

    sendToolResult(ws, requestId, true, JSON.stringify({
      value: selectedValue,
      label: selectedOption?.label ?? selectedValue,
    }))
  } catch {
    // Timeout -- disable buttons
    await sent.edit({ content: `**[${sessionName}]** ${question}\n\n> *(timed out)*`, components: [] }).catch(() => {})
    sendToolResult(ws, requestId, false, 'Selection timed out (5 min)')
  }
}

async function askWithSelectMenu(
  ch: { send: Function },
  ws: WsLike,
  requestId: string,
  sessionName: string,
  question: string,
  options: WsAskUser['options'],
): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ask_${requestId}`)
    .setPlaceholder('Choose an option...')

  for (const opt of options.slice(0, 25)) {
    select.addOptions({
      label: opt.label.slice(0, 100),
      description: opt.description?.slice(0, 100),
      value: opt.value.slice(0, 100),
    })
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)

  const sent = await (ch as unknown as { send(opts: unknown): Promise<{ id: string; awaitMessageComponent(opts: unknown): Promise<{ values: string[]; update(opts: unknown): Promise<void> }>; edit(opts: unknown): Promise<void> }> }).send({
    content: `**[${sessionName}]** ${question}`,
    components: [row],
  })
  noteSent(sent.id)

  try {
    const interaction = await sent.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: 300_000,
    })

    const selectedValue = interaction.values[0]
    const selectedOption = options.find(o => o.value === selectedValue)

    await interaction.update({
      content: `**[${sessionName}]** ${question}\n\n> Selected: **${selectedOption?.label ?? selectedValue}**`,
      components: [],
    })

    sendToolResult(ws, requestId, true, JSON.stringify({
      value: selectedValue,
      label: selectedOption?.label ?? selectedValue,
    }))
  } catch {
    await sent.edit({ content: `**[${sessionName}]** ${question}\n\n> *(timed out)*`, components: [] }).catch(() => {})
    sendToolResult(ws, requestId, false, 'Selection timed out (5 min)')
  }
}

/** Map of permission request ID → WS connection that sent it, so we can route verdicts back. */
const permissionSessions = new Map<string, WsLike>()

/** Map of permission request ID → cleanup timer, auto-removes stale entries after 5 minutes. */
const permissionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

function handlePermissionRequest(
  ws: WsLike,
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
  deps: Readonly<WsDeps>,
): void {
  const chatId = deps.chatId()
  if (!chatId) return

  const sessionName = ws.data.sessionName ?? 'unknown'

  // Store the WS so we can route the verdict back
  permissionSessions.set(requestId, ws)

  // Auto-cleanup after 5 minutes if no verdict is received
  const timeout = setTimeout(() => {
    permissionSessions.delete(requestId)
    permissionTimeouts.delete(requestId)
  }, 300_000)
  permissionTimeouts.set(requestId, timeout)

  // Fire-and-forget: send permission prompt to Discord asynchronously
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch || !('send' in ch)) return

      // Truncate input preview for Discord
      const preview = inputPreview.length > 800 ? inputPreview.slice(0, 800) + '...' : inputPreview

      const row = new ActionRowBuilder<ButtonBuilder>()
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm_yes_${requestId}`)
          .setLabel(`yes ${requestId}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm_no_${requestId}`)
          .setLabel(`no ${requestId}`)
          .setStyle(ButtonStyle.Danger),
      )

      const content = [
        `**[${sessionName}] Permission Request**`,
        `**Tool:** \`${toolName}\``,
        `**Description:** ${description}`,
        `\`\`\`\n${preview}\n\`\`\``,
      ].join('\n')

      const sent = await ch.send({ content, components: [row] })
      noteSent(sent.id)
    } catch (err: unknown) {
      process.stderr.write(`discord: permission request send failed: ${err instanceof Error ? err.message : String(err)}\n`)
      permissionSessions.delete(requestId)
      const t = permissionTimeouts.get(requestId)
      if (t) { clearTimeout(t); permissionTimeouts.delete(requestId) }
    }
  })()
}

/** Handle a button click for a permission request. Called from the router's interactionCreate handler. */
export function handlePermissionButton(customId: string): void {
  const yesMatch = customId.match(/^perm_yes_(.+)$/)
  const noMatch = customId.match(/^perm_no_(.+)$/)

  const requestId = yesMatch?.[1] ?? noMatch?.[1]
  if (!requestId) return

  const behavior: 'allow' | 'deny' = yesMatch ? 'allow' : 'deny'
  const ws = permissionSessions.get(requestId)
  if (!ws) return

  const verdict: WsPermissionVerdict = { type: 'permissionVerdict', requestId, behavior }
  ws.send(JSON.stringify(verdict))
  permissionSessions.delete(requestId)
  const t = permissionTimeouts.get(requestId)
  if (t) { clearTimeout(t); permissionTimeouts.delete(requestId) }
}

function sendToolResult(ws: WsLike, requestId: string, success: boolean, data: string): void {
  const response: WsToolResult = { type: 'toolResult', requestId, success, data }
  ws.send(JSON.stringify(response))
}

/** Type guard: checks that `obj[key]` exists and is a string. */
function hasString<K extends string>(obj: unknown, key: K): obj is Record<K, string> {
  return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[key] === 'string'
}

function sendError(ws: WsLike, message: string): void {
  const response: WsError = { type: 'error', message }
  ws.send(JSON.stringify(response))
}

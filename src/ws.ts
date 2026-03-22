/**
 * WebSocket message handlers for the router's plugin-facing WS server.
 * Handles registration, reply, react, rename, deregister.
 */

import type { PluginToRouterMessage, WsRegistered, WsRenamed, WsError, WsToolResult, WsPermissionVerdict } from './types.js'
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
  onReply?: (chatId: string) => void
  onSessionChange?: () => void
  onSkillsRegistered?: (skills: Array<{ name: string; description: string }>) => void
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
        case 'askUser':
          if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'question')) {
            sendError(ws, 'askUser requires requestId, chatId, and question')
            return
          }
          handleAskUser(ws, parsed.requestId, parsed.chatId, parsed.question, (parsed as any).options ?? [], deps)
          break
        case 'permissionRequest':
          if (!hasString(parsed, 'requestId') || !hasString(parsed, 'toolName') || !hasString(parsed, 'description') || !hasString(parsed, 'inputPreview')) {
            sendError(ws, 'permissionRequest requires requestId, toolName, description, and inputPreview')
            return
          }
          handlePermissionRequest(ws, parsed.requestId, parsed.toolName, parsed.description, parsed.inputPreview, deps)
          break
        case 'registerSkills':
          if (!Array.isArray((parsed as any).skills)) {
            sendError(ws, 'registerSkills requires skills array')
            return
          }
          deps.onSkillsRegistered?.((parsed as any).skills)
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
        deps.onSessionChange?.()
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
  deps.onSessionChange?.()
}

function handleDeregister(ws: WsLike, deps: WsDeps): void {
  if (ws.data.sessionName) {
    try {
      deps.sessions.deregisterSession(ws.data.sessionName)
    } catch {}
    ws.data.sessionName = null
    deps.onSessionChange?.()
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

  // Stop typing indicator when a reply is sent
  deps.onReply?.(chatId)
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

function handleAskUser(
  ws: WsLike,
  requestId: string,
  chatId: string,
  question: string,
  options: Array<{ label: string; description?: string; value: string }>,
  deps: WsDeps,
): void {
  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased() || !('send' in ch)) {
        sendToolResult(ws, requestId, false, 'Channel not found or not sendable')
        return
      }

      const sessionName = ws.data.sessionName ?? 'unknown'

      if (options.length <= 5) {
        // Use buttons for 2-5 options (cleaner UX)
        const row = new ActionRowBuilder<ButtonBuilder>()
        for (const opt of options) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`ask_${requestId}_${opt.value}`)
              .setLabel(opt.label.slice(0, 80))
              .setStyle(ButtonStyle.Primary),
          )
        }

        const sent = await ch.send({
          content: `**[${sessionName}]** ${question}`,
          components: [row],
        })
        noteSent(sent.id)

        // Wait for button click (5 min timeout)
        try {
          const interaction = await sent.awaitMessageComponent({
            componentType: ComponentType.Button,
            time: 300_000,
          })

          // Find the selected option
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
          // Timeout — disable buttons
          await sent.edit({ content: `**[${sessionName}]** ${question}\n\n> *(timed out)*`, components: [] }).catch(() => {})
          sendToolResult(ws, requestId, false, 'Selection timed out (5 min)')
        }
      } else {
        // Use select menu for 6+ options
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

        const sent = await ch.send({
          content: `**[${sessionName}]** ${question}`,
          components: [row],
        })
        noteSent(sent.id)

        // Wait for selection (5 min timeout)
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
    } catch (err) {
      sendToolResult(ws, requestId, false, `Ask failed: ${err}`)
    }
  })()
}

/** Map of permission request ID → WS connection that sent it, so we can route verdicts back. */
const permissionSessions = new Map<string, WsLike>()

function handlePermissionRequest(
  ws: WsLike,
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
  deps: WsDeps,
): void {
  const chatId = deps.chatId()
  if (!chatId) return

  const sessionName = ws.data.sessionName ?? 'unknown'

  // Store the WS so we can route the verdict back
  permissionSessions.set(requestId, ws)

  void (async () => {
    try {
      const ch = await deps.client.channels.fetch(chatId)
      if (!ch || !ch.isTextBased() || !('send' in ch)) return

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
    } catch (err) {
      process.stderr.write(`discord: permission request send failed: ${err}\n`)
      permissionSessions.delete(requestId)
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

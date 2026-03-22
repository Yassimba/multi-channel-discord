// ============================================================
// WebSocket Protocol — messages between MCP plugin and router
// ============================================================

/** Plugin → Router: register this session */
export interface WsRegister {
  type: 'register'
  name: string
  projectPath: string
}

/** Plugin → Router: rename this session */
export interface WsRename {
  type: 'rename'
  name: string
}

/** Plugin → Router: send a reply to Discord */
export interface WsReply {
  type: 'reply'
  text: string
  replyTo?: string
  files?: string[]
}

/** Plugin → Router: react to a Discord message */
export interface WsReact {
  type: 'react'
  chatId: string
  messageId: string
  emoji: string
}

/** Plugin → Router: edit a previously sent message */
export interface WsEditMessage {
  type: 'editMessage'
  requestId: string
  chatId: string
  messageId: string
  text: string
}

/** Plugin → Router: download attachments from a message */
export interface WsDownloadAttachment {
  type: 'downloadAttachment'
  requestId: string
  chatId: string
  messageId: string
}

/** Plugin → Router: fetch recent messages from a channel */
export interface WsFetchMessages {
  type: 'fetchMessages'
  requestId: string
  channel: string
  limit?: number
}

/** Plugin → Router: deregister this session */
export interface WsDeregister {
  type: 'deregister'
}

/** Union of all messages a plugin can send to the router */
export type PluginToRouterMessage =
  | WsRegister
  | WsRename
  | WsReply
  | WsReact
  | WsEditMessage
  | WsDownloadAttachment
  | WsFetchMessages
  | WsDeregister

// ============================================================
// Router → Plugin messages
// ============================================================

/** Router → Plugin: inbound Discord message for this session */
export interface WsMessage {
  type: 'message'
  content: string
  meta: Record<string, string>
}

/** Router → Plugin: confirms registration */
export interface WsRegistered {
  type: 'registered'
  name: string
}

/** Router → Plugin: confirms rename */
export interface WsRenamed {
  type: 'renamed'
  oldName: string
  newName: string
}

/** Router → Plugin: error response */
export interface WsError {
  type: 'error'
  message: string
}

/** Router → Plugin: result of a tool call (edit, download, fetch) */
export interface WsToolResult {
  type: 'toolResult'
  requestId: string
  success: boolean
  data: string
}

/** Union of all messages the router can send to a plugin */
export type RouterToPluginMessage =
  | WsMessage
  | WsRegistered
  | WsRenamed
  | WsError
  | WsToolResult

// ============================================================
// Session management
// ============================================================

/** A connected Claude Code instance in the routing table */
export interface SessionEntry {
  name: string
  projectPath: string
  connectedAt: number
  messageCount: number
}

/** A buffered message waiting to be flushed */
export interface BufferedMessage {
  text: string
  timestamp: number
  sessionName: string
  meta: Record<string, string>
}

/** A project that has been used with Claude Code */
export interface ProjectHistoryEntry {
  path: string
  lastUsed: number
  name: string
}

/**
 * Discord slash command registration and handling.
 * Defines /switch, /list, /status, /kill, /broadcast, /spawn.
 * All responses are ephemeral.
 */

import {
  SlashCommandBuilder,
  REST,
  Routes,
  type Client,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js'
import type { SessionManager, ProjectHistory } from './sessions.js'
import { formatFlush } from './sessions.js'

// ============================================================
// Command definitions
// ============================================================

const switchCommand = new SlashCommandBuilder()
  .setName('switch')
  .setDescription('Switch the active Claude Code session')
  .addStringOption(opt =>
    opt.setName('session')
      .setDescription('Session name to switch to')
      .setRequired(true)
      .setAutocomplete(true),
  )

const listCommand = new SlashCommandBuilder()
  .setName('list')
  .setDescription('List all connected Claude Code sessions')

const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show router uptime, instance count, and queued messages')

const killCommand = new SlashCommandBuilder()
  .setName('kill')
  .setDescription('Terminate a Claude Code session')
  .addStringOption(opt =>
    opt.setName('session')
      .setDescription('Session name to kill, or "all"')
      .setRequired(true)
      .setAutocomplete(true),
  )

const broadcastCommand = new SlashCommandBuilder()
  .setName('broadcast')
  .setDescription('Send a message to all connected sessions')
  .addStringOption(opt =>
    opt.setName('message')
      .setDescription('Message text to broadcast')
      .setRequired(true),
  )

const spawnCommand = new SlashCommandBuilder()
  .setName('spawn')
  .setDescription('Spawn a new Claude Code session from recent projects')
  .addStringOption(opt =>
    opt.setName('project')
      .setDescription('Project to spawn in')
      .setRequired(false)
      .setAutocomplete(true),
  )

export const ALL_COMMANDS = [
  switchCommand,
  listCommand,
  statusCommand,
  killCommand,
  broadcastCommand,
  spawnCommand,
]

// ============================================================
// Registration
// ============================================================

export async function registerSlashCommands(client: Client): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token || !client.user) return

  const rest = new REST({ version: '10' }).setToken(token)
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: ALL_COMMANDS.map(c => c.toJSON()) },
    )
    process.stderr.write(`discord channel: registered ${ALL_COMMANDS.length} slash commands\n`)
  } catch (err) {
    process.stderr.write(`discord channel: failed to register slash commands: ${err}\n`)
  }
}

// ============================================================
// Interaction context
// ============================================================

export interface SlashCommandDeps {
  sessions: SessionManager
  history: ProjectHistory
  startedAt: number
}

// ============================================================
// Autocomplete handlers
// ============================================================

export function handleAutocomplete(interaction: AutocompleteInteraction, deps: SlashCommandDeps): void {
  const focused = interaction.options.getFocused(true)
  const commandName = interaction.commandName

  if (commandName === 'switch' && focused.name === 'session') {
    const names = deps.sessions.getSessions().map(s => s.name)
    const filtered = names.filter(n => n.toLowerCase().startsWith(focused.value.toLowerCase()))
    void interaction.respond(
      filtered.slice(0, 25).map(n => ({ name: n, value: n })),
    ).catch(() => {})
    return
  }

  if (commandName === 'kill' && focused.name === 'session') {
    const names = ['all', ...deps.sessions.getSessions().map(s => s.name)]
    const filtered = names.filter(n => n.toLowerCase().startsWith(focused.value.toLowerCase()))
    void interaction.respond(
      filtered.slice(0, 25).map(n => ({ name: n, value: n })),
    ).catch(() => {})
    return
  }

  if (commandName === 'spawn' && focused.name === 'project') {
    const projects = deps.history.getRecent(25)
    const filtered = projects.filter(p =>
      p.name.toLowerCase().startsWith(focused.value.toLowerCase()) ||
      p.path.toLowerCase().includes(focused.value.toLowerCase()),
    )
    void interaction.respond(
      filtered.slice(0, 25).map(p => ({ name: `${p.name} — ${p.path}`, value: p.path })),
    ).catch(() => {})
    return
  }

  void interaction.respond([]).catch(() => {})
}

// ============================================================
// Command handlers
// ============================================================

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'switch': return handleSwitch(interaction, deps)
    case 'list': return handleList(interaction, deps)
    case 'status': return handleStatus(interaction, deps)
    case 'kill': return handleKill(interaction, deps)
    case 'broadcast': return handleBroadcast(interaction, deps)
    case 'spawn': return handleSpawn(interaction, deps)
    default:
      await interaction.reply({ content: `Unknown command: /${interaction.commandName}`, ephemeral: true })
  }
}

async function handleSwitch(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const sessionName = interaction.options.getString('session', true)
  const sessions = deps.sessions.getSessions()
  const target = sessions.find(s => s.name === sessionName)

  if (!target) {
    const names = sessions.map(s => s.name)
    const available = names.length > 0 ? `Available: ${names.join(', ')}` : 'No sessions connected.'
    await interaction.reply({ content: `Session '${sessionName}' not found. ${available}`, ephemeral: true })
    return
  }

  deps.sessions.setActive(sessionName)
  const parts: string[] = [`Switched to **${sessionName}**`]

  // Flush per-session buffer
  const buffered = deps.sessions.flushBuffer(sessionName)
  if (buffered.length > 0) {
    parts.push(formatFlush(sessionName, buffered))
  }

  // Drain unrouted inbox
  const unrouted = deps.sessions.drainUnrouted()
  if (unrouted.length > 0) {
    for (const msg of unrouted) {
      deps.sessions.routeToActive(msg.text, msg.meta)
    }
    parts.push(`[router] ${unrouted.length} unrouted message${unrouted.length === 1 ? '' : 's'} delivered`)
  }

  await interaction.reply({ content: parts.join('\n\n'), ephemeral: true })
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const sessions = deps.sessions.getSessions()
  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
    return
  }

  const active = deps.sessions.getActive()
  const lines = sessions.map(s => {
    const bufCount = deps.sessions.getBufferedCount(s.name)
    const status = s.name === active
      ? '(active)'
      : bufCount > 0
        ? `${bufCount} buffered`
        : 'idle'
    return `- **${s.name}** — ${s.projectPath} [${status}]`
  })

  await interaction.reply({ content: lines.join('\n'), ephemeral: true })
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const sessions = deps.sessions.getSessions()
  const uptime = formatUptime(Date.now() - deps.startedAt)
  const unroutedCount = deps.sessions.getUnrouted().length
  const totalBuffered = sessions.reduce((sum, s) => sum + deps.sessions.getBufferedCount(s.name), 0)

  const lines = [
    `**Uptime**: ${uptime}`,
    `**Instances**: ${sessions.length}`,
    `**Queued messages**: ${totalBuffered + unroutedCount}`,
  ]

  await interaction.reply({ content: lines.join('\n'), ephemeral: true })
}

async function handleKill(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const sessionName = interaction.options.getString('session', true)

  if (sessionName === 'all') {
    const sessions = deps.sessions.getSessions()
    if (sessions.length === 0) {
      await interaction.reply({ content: 'No sessions to terminate.', ephemeral: true })
      return
    }
    const count = sessions.length
    for (const s of sessions) {
      deps.sessions.deregisterSession(s.name)
    }
    await interaction.reply({
      content: `${count} session${count === 1 ? '' : 's'} terminated.`,
      ephemeral: true,
    })
    return
  }

  const sessions = deps.sessions.getSessions()
  if (!sessions.find(s => s.name === sessionName)) {
    const names = sessions.map(s => s.name)
    const available = names.length > 0 ? `Available: ${names.join(', ')}` : 'No sessions connected.'
    await interaction.reply({ content: `Session '${sessionName}' not found. ${available}`, ephemeral: true })
    return
  }

  deps.sessions.deregisterSession(sessionName)
  const remaining = deps.sessions.getSessions().map(s => s.name)
  const activeInfo = remaining.length > 0 ? `Active: ${remaining.join(', ')}` : 'No sessions remaining.'
  await interaction.reply({
    content: `Session "${sessionName}" terminated. ${activeInfo}`,
    ephemeral: true,
  })
}

async function handleBroadcast(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const message = interaction.options.getString('message', true)
  const sessions = deps.sessions.getSessions()

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
    return
  }

  for (const s of sessions) {
    deps.sessions.routeToSession(s.name, message, { type: 'broadcast' })
  }

  await interaction.reply({
    content: `Broadcast sent to ${sessions.length} session${sessions.length === 1 ? '' : 's'}.`,
    ephemeral: true,
  })
}

async function handleSpawn(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDeps,
): Promise<void> {
  const projectPath = interaction.options.getString('project')

  if (projectPath) {
    // Reply first, then spawn in background
    await interaction.reply({
      content: `Spawning Claude Code in \`${projectPath}\`...`,
      ephemeral: true,
    })
    spawnCad(projectPath)
    return
  }

  // No project specified — show recent projects
  const projects = deps.history.getRecent(10)
  if (projects.length === 0) {
    await interaction.reply({ content: 'No recent projects. Connect a Claude Code instance first.', ephemeral: true })
    return
  }

  const lines = projects.map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``)
  await interaction.reply({
    content: `Recent projects:\n${lines.join('\n')}\n\nUse \`/spawn project:<path>\` to spawn.`,
    ephemeral: true,
  })
}

// ============================================================
// Spawn helper
// ============================================================

export function spawnCad(dir: string): void {
  try {
    const { spawn } = require('child_process')
    const child = spawn('cad', ['--channels', 'plugin:discord@claude-plugins-official'], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      shell: true,
    })
    child.unref()
    process.stderr.write(`discord channel: spawned cad in ${dir}\n`)
  } catch (err) {
    process.stderr.write(`discord channel: failed to spawn cad: ${err}\n`)
  }
}

// ============================================================
// Utilities
// ============================================================

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

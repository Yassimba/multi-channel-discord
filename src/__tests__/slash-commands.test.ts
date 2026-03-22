import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { handleSlashCommand, handleAutocomplete, spawnCad, isSkillCommand, _setRegisteredSkillsForTest } from '../slash-commands.js'
import type { SlashCommandDeps } from '../slash-commands.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface MockInteraction {
  commandName: string
  channelId: string
  user: { username: string; id: string }
  options: {
    getString: ReturnType<typeof mock>
    getNumber: ReturnType<typeof mock>
  }
  reply: ReturnType<typeof mock>
}

function makeMockInteraction(commandName: string, opts: Record<string, string | number | null> = {}): MockInteraction {
  return {
    commandName,
    channelId: '999888777',
    user: { username: 'testuser', id: '12345' },
    options: {
      getString: mock((name: string, _required?: boolean) => opts[name] ?? null) as any,
      getNumber: mock((name: string) => opts[name] ?? null) as any,
    },
    reply: mock(async (_opts: unknown) => {}),
  }
}

interface MockAutocompleteInteraction {
  commandName: string
  options: {
    getFocused: ReturnType<typeof mock>
  }
  respond: ReturnType<typeof mock>
}

function makeMockAutocomplete(commandName: string, focusedName: string, focusedValue: string): MockAutocompleteInteraction {
  return {
    commandName,
    options: {
      getFocused: mock((_full?: boolean) => ({ name: focusedName, value: focusedValue })),
    },
    respond: mock(async (_choices: unknown[]) => {}),
  }
}

let sessions: SessionManager
let history: ProjectHistory
let deps: SlashCommandDeps

beforeEach(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'slash-test-'))
  sessions = new SessionManager()
  history = new ProjectHistory(tempDir)
  deps = {
    sessions,
    history,
    startedAt: Date.now() - 60_000,
  }
})

function lastReply(interaction: MockInteraction): { content: string; ephemeral: boolean } {
  const calls = interaction.reply.mock.calls
  return calls[calls.length - 1]![0] as { content: string; ephemeral: boolean }
}

describe('/switch slash command', () => {
  test('switches to existing session', async () => {
    sessions.registerSession(mock(() => {}), 'backend', '/path')
    const interaction = makeMockInteraction('switch', { session: 'backend' })

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('**backend**')
    expect(sessions.getActive()).toBe('backend')
  })

  test('returns error for unknown session', async () => {
    const interaction = makeMockInteraction('switch', { session: 'nope' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('not found')
  })

  test('lists available sessions on error', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/w')
    sessions.registerSession(mock(() => {}), 'api', '/a')
    const interaction = makeMockInteraction('switch', { session: 'nope' })

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('web')
    expect(reply.content).toContain('api')
  })

  test('flushes buffer on switch', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    sessions.bufferReply('web', 'buffered msg')
    const interaction = makeMockInteraction('switch', { session: 'web' })

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('Buffered messages')
    expect(reply.content).toContain('buffered msg')
    expect(sessions.getBufferedCount('web')).toBe(0)
  })

  test('drains unrouted inbox on switch', async () => {
    const send = mock((_msg: string) => {})
    sessions.registerSession(send, 'web', '/path')
    sessions.routeToActive('unrouted msg', { from: '123' })
    expect(sessions.getUnrouted()).toHaveLength(1)

    const interaction = makeMockInteraction('switch', { session: 'web' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('unrouted')
    expect(reply.content).toContain('delivered')
    expect(sessions.getUnrouted()).toHaveLength(0)
    expect(send).toHaveBeenCalled()
  })
})

describe('/list slash command', () => {
  test('shows no sessions message when empty', async () => {
    const interaction = makeMockInteraction('list')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('No sessions')
  })

  test('shows all sessions with status', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/home/user/web')
    sessions.registerSession(mock(() => {}), 'api', '/home/user/api')
    sessions.setActive('web')
    sessions.bufferReply('api', 'msg1')
    sessions.bufferReply('api', 'msg2')

    const interaction = makeMockInteraction('list')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('**web**')
    expect(reply.content).toContain('active')
    expect(reply.content).toContain('**api**')
    expect(reply.content).toContain('2 buffered')
  })
})

describe('/status slash command', () => {
  test('shows uptime and instance count', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    const interaction = makeMockInteraction('status')

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('**Uptime**')
    expect(reply.content).toContain('**Instances**: 1')
  })

  test('shows queued messages', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    sessions.bufferReply('web', 'queued')
    sessions.routeToActive('unrouted', {})

    const interaction = makeMockInteraction('status')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('**Queued messages**: 2')
  })
})

describe('/kill slash command', () => {
  test('kills a named session', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    const interaction = makeMockInteraction('kill', { session: 'web' })

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('web')
    expect(reply.content).toContain('terminated')
    expect(sessions.getSessions()).toHaveLength(0)
  })

  test('/kill all terminates all sessions', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/w')
    sessions.registerSession(mock(() => {}), 'api', '/a')
    const interaction = makeMockInteraction('kill', { session: 'all' })

    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('2')
    expect(reply.content).toContain('terminated')
    expect(sessions.getSessions()).toHaveLength(0)
  })

  test('returns error for unknown session', async () => {
    const interaction = makeMockInteraction('kill', { session: 'nope' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('not found')
  })

  test('/kill all with no sessions', async () => {
    const interaction = makeMockInteraction('kill', { session: 'all' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('No sessions to terminate')
  })
})

describe('/broadcast slash command', () => {
  test('sends message to all sessions', async () => {
    const send1 = mock((_msg: string) => {})
    const send2 = mock((_msg: string) => {})
    sessions.registerSession(send1, 'web', '/w')
    sessions.registerSession(send2, 'api', '/a')

    const interaction = makeMockInteraction('broadcast', { message: 'status update' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('2 session')
    expect(send1).toHaveBeenCalled()
    expect(send2).toHaveBeenCalled()
  })

  test('returns error with no sessions', async () => {
    const interaction = makeMockInteraction('broadcast', { message: 'hello' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('No sessions')
  })
})

describe('/spawn slash command', () => {
  test('shows recent projects when no project specified', async () => {
    history.record('web', '/home/user/web')
    history.record('api', '/home/user/api')

    const interaction = makeMockInteraction('spawn')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('Recent projects')
    expect(reply.content).toContain('web')
    expect(reply.content).toContain('api')
  })

  test('replies with no projects when history is empty', async () => {
    const interaction = makeMockInteraction('spawn')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('No recent projects')
  })

  test.skip('spawns when project path is given', async () => {
    const interaction = makeMockInteraction('spawn', { project: '/home/user/web' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('Spawning')
    expect(reply.content).toContain('/home/user/web')
  })
})

describe('autocomplete', () => {
  test('returns session names for /switch', () => {
    sessions.registerSession(mock(() => {}), 'web', '/w')
    sessions.registerSession(mock(() => {}), 'api', '/a')
    sessions.registerSession(mock(() => {}), 'mobile', '/m')

    const interaction = makeMockAutocomplete('switch', 'session', 'w')
    handleAutocomplete(interaction as any, deps)

    expect(interaction.respond).toHaveBeenCalledTimes(1)
    const choices = interaction.respond.mock.calls[0]![0] as Array<{ name: string; value: string }>
    expect(choices).toHaveLength(1)
    expect(choices[0].value).toBe('web')
  })

  test('returns "all" plus session names for /kill', () => {
    sessions.registerSession(mock(() => {}), 'web', '/w')

    const interaction = makeMockAutocomplete('kill', 'session', '')
    handleAutocomplete(interaction as any, deps)

    const choices = interaction.respond.mock.calls[0]![0] as Array<{ name: string; value: string }>
    expect(choices.length).toBeGreaterThanOrEqual(2)
    expect(choices[0].value).toBe('all')
    expect(choices[1].value).toBe('web')
  })

  test('returns projects for /spawn', () => {
    history.record('web', '/home/user/web')
    history.record('api', '/home/user/api')

    const interaction = makeMockAutocomplete('spawn', 'project', 'web')
    handleAutocomplete(interaction as any, deps)

    const choices = interaction.respond.mock.calls[0]![0] as Array<{ name: string; value: string }>
    expect(choices.length).toBeGreaterThanOrEqual(1)
    expect(choices[0].value).toBe('/home/user/web')
  })

  test('returns empty for unknown command', () => {
    const interaction = makeMockAutocomplete('unknown', 'foo', '')
    handleAutocomplete(interaction as any, deps)

    const choices = interaction.respond.mock.calls[0]![0] as unknown[]
    expect(choices).toHaveLength(0)
  })
})

describe('isSkillCommand', () => {
  test('returns false for unknown command', () => {
    _setRegisteredSkillsForTest([])
    expect(isSkillCommand('unknown')).toBe(false)
  })

  test('returns true for registered skill', () => {
    _setRegisteredSkillsForTest(['commit', 'deploy'])
    expect(isSkillCommand('commit')).toBe(true)
    expect(isSkillCommand('deploy')).toBe(true)
  })

  test('returns false for unregistered skill', () => {
    _setRegisteredSkillsForTest(['commit'])
    expect(isSkillCommand('deploy')).toBe(false)
  })
})

describe('skill invocation via slash command', () => {
  beforeEach(() => {
    _setRegisteredSkillsForTest(['commit', 'deploy'])
  })

  test('routes skill command to active session', async () => {
    const send = mock((_msg: string) => {})
    sessions.registerSession(send, 'web', '/path')
    sessions.setActive('web')

    const interaction = makeMockInteraction('commit', { args: 'fix the bug' })
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('/commit')
    expect(reply.content).toContain('fix the bug')

    // Verify message was routed
    expect(send).toHaveBeenCalled()
    const sent = JSON.parse(send.mock.calls[0]![0] as string)
    expect(sent.type).toBe('message')
    expect(sent.content).toBe('/commit fix the bug')
    expect(sent.meta.type).toBe('skill')
  })

  test('routes skill command without args', async () => {
    const send = mock((_msg: string) => {})
    sessions.registerSession(send, 'web', '/path')
    sessions.setActive('web')

    const interaction = makeMockInteraction('deploy')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('/deploy')

    const sent = JSON.parse(send.mock.calls[0]![0] as string)
    expect(sent.content).toBe('/deploy')
  })

  test('returns error when no sessions connected', async () => {
    const interaction = makeMockInteraction('commit')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('No sessions connected')
  })

  test('returns error when no active session', async () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    // Don't set active

    const interaction = makeMockInteraction('commit')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toContain('No active session')
  })

  test('unregistered skill falls through to unknown command', async () => {
    _setRegisteredSkillsForTest([])
    const interaction = makeMockInteraction('nonexistent')
    await handleSlashCommand(interaction as any, deps)

    const reply = lastReply(interaction)
    expect(reply.content).toContain('Unknown command')
  })
})

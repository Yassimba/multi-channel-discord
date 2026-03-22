import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers } from '../ws.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface MockWs {
  data: WsData
  send: ReturnType<typeof mock>
}

function makeMockWs(): MockWs {
  return {
    data: { sessionName: null },
    send: mock((_msg: string) => {}),
  }
}

let sessions: SessionManager
let history: ProjectHistory

function makeDeps(): WsDeps {
  return {
    sessions,
    history,
    client: { channels: { fetch: mock(async () => null) } } as any,
    chatId: () => '123456789',
    chunkLimit: 2000,
    chunkMode: 'length',
    replyToMode: 'first',
  }
}

beforeEach(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'ws-test-'))
  sessions = new SessionManager()
  history = new ProjectHistory(tempDir)
})

describe('WS register', () => {
  test('registers session and sends registered response', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({
      type: 'register', name: 'web-app', projectPath: '/home/user/web-app',
    }))

    expect(ws.data.sessionName).toBe('web-app')
    expect(sessions.getSessions()).toHaveLength(1)
    const response = JSON.parse(String(ws.send.mock.calls[0]![0]))
    expect(response.type).toBe('registered')
    expect(response.name).toBe('web-app')
  })

  test('collision returns suffixed name', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws1 = makeMockWs()
    const ws2 = makeMockWs()

    handlers.message(ws1 as any, JSON.stringify({ type: 'register', name: 'app', projectPath: '/a' }))
    handlers.message(ws2 as any, JSON.stringify({ type: 'register', name: 'app', projectPath: '/b' }))

    expect(ws2.data.sessionName).toBe('app-2')
  })
})

describe('WS deregister', () => {
  test('removes session on deregister message', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'register', name: 'web', projectPath: '/path' }))
    handlers.message(ws as any, JSON.stringify({ type: 'deregister' }))

    expect(sessions.getSessions()).toHaveLength(0)
    expect(ws.data.sessionName).toBeNull()
  })

  test('removes session on close', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'register', name: 'web', projectPath: '/path' }))
    handlers.close(ws as any)

    expect(sessions.getSessions()).toHaveLength(0)
  })
})

describe('WS error handling', () => {
  test('invalid JSON sends error', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, 'not json')

    const response = JSON.parse(String(ws.send.mock.calls[0]![0]))
    expect(response.type).toBe('error')
    expect(response.message).toContain('Invalid JSON')
  })

  test('unknown type sends error', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'foobar' }))

    const response = JSON.parse(String(ws.send.mock.calls[0]![0]))
    expect(response.type).toBe('error')
  })

  test('reply before register sends error', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'reply', text: 'too early' }))

    const response = JSON.parse(String(ws.send.mock.calls[0]![0]))
    expect(response.type).toBe('error')
    expect(response.message).toContain('not registered')
  })
})

describe('WS rename', () => {
  test('renames session', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'register', name: 'web', projectPath: '/p' }))
    handlers.message(ws as any, JSON.stringify({ type: 'rename', name: 'login-fix' }))

    expect(ws.data.sessionName).toBe('login-fix')
    const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1]
    const response = JSON.parse(String(lastCall![0]))
    expect(response.type).toBe('renamed')
    expect(response.newName).toBe('login-fix')
  })
})

describe('WS registerSkills', () => {
  test('calls onSkillsRegistered callback with skills', () => {
    const onSkills = mock((_skills: ReadonlyArray<{ name: string; description: string }>) => {})
    const deps = { ...makeDeps(), onSkillsRegistered: onSkills }
    const handlers = createWsHandlers(deps)
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({
      type: 'registerSkills',
      skills: [
        { name: 'commit', description: 'Write commits' },
        { name: 'deploy', description: 'Deploy to prod' },
      ],
    }))

    expect(onSkills).toHaveBeenCalledTimes(1)
    const skills = onSkills.mock.calls[0]![0]
    expect(skills).toHaveLength(2)
    expect(skills[0].name).toBe('commit')
    expect(skills[1].name).toBe('deploy')
  })

  test('sends error for missing skills array', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    handlers.message(ws as any, JSON.stringify({ type: 'registerSkills' }))

    const response = JSON.parse(String(ws.send.mock.calls[0]![0]))
    expect(response.type).toBe('error')
    expect(response.message).toContain('skills array')
  })

  test('does not error when no callback is set', () => {
    const handlers = createWsHandlers(makeDeps())
    const ws = makeMockWs()

    // Should not throw
    handlers.message(ws as any, JSON.stringify({
      type: 'registerSkills',
      skills: [{ name: 'test', description: 'Test' }],
    }))

    // No error sent
    expect(ws.send.mock.calls).toHaveLength(0)
  })
})

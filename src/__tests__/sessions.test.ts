import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { SessionManager } from '../sessions.js'

let sessions: SessionManager

beforeEach(() => {
  sessions = new SessionManager()
})

describe('registerSession', () => {
  test('registers and returns the name', () => {
    const send = mock((_msg: string) => {})
    const name = sessions.registerSession(send, 'frontend', '/test/frontend')
    expect(name).toBe('frontend')
    expect(sessions.getSessions()).toHaveLength(1)
  })

  test('resolves name collision with suffix', () => {
    sessions.registerSession(mock(() => {}), 'app', '/a')
    const name2 = sessions.registerSession(mock(() => {}), 'app', '/b')
    expect(name2).toBe('app-2')
  })
})

describe('deregisterSession', () => {
  test('removes session', () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    sessions.deregisterSession('web')
    expect(sessions.getSessions()).toHaveLength(0)
  })

  test('clears active if deregistered session was active', () => {
    sessions.registerSession(mock(() => {}), 'web', '/path')
    sessions.setActive('web')
    sessions.deregisterSession('web')
    expect(sessions.getActive()).toBeNull()
  })

  test('throws for unknown session', () => {
    expect(() => sessions.deregisterSession('nope')).toThrow('not found')
  })
})

describe('routeToActive', () => {
  test('sends message to active session', () => {
    const send = mock((_msg: string) => {})
    sessions.registerSession(send, 'web', '/path')
    sessions.setActive('web')
    const routed = sessions.routeToActive('hello', { from: 'user1' })
    expect(routed).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    const msg = JSON.parse(String(send.mock.calls[0]![0]))
    expect(msg.type).toBe('message')
    expect(msg.content).toBe('hello')
  })

  test('queues to unrouted when no active session', () => {
    const routed = sessions.routeToActive('orphan', {})
    expect(routed).toBe(false)
    expect(sessions.getUnrouted()).toHaveLength(1)
  })
})

describe('bufferReply', () => {
  test('buffers and returns count', () => {
    sessions.registerSession(mock(() => {}), 'bg', '/path')
    expect(sessions.bufferReply('bg', 'msg1')).toBe(1)
    expect(sessions.bufferReply('bg', 'msg2')).toBe(2)
  })

  test('flushBuffer returns and clears', () => {
    sessions.registerSession(mock(() => {}), 'bg', '/path')
    sessions.bufferReply('bg', 'msg1')
    const flushed = sessions.flushBuffer('bg')
    expect(flushed).toHaveLength(1)
    expect(sessions.getBufferedCount('bg')).toBe(0)
  })
})

describe('renameSession', () => {
  test('renames and migrates buffer', () => {
    sessions.registerSession(mock(() => {}), 'old', '/path')
    sessions.bufferReply('old', 'buffered')
    const newName = sessions.renameSession('old', 'new')
    expect(newName).toBe('new')
    expect(sessions.getBufferedCount('new')).toBe(1)
    expect(sessions.getSessions()[0].name).toBe('new')
  })
})

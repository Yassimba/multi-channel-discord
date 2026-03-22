import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccess, saveAccess, defaultAccess, loadEnvFile } from '../access.js'
import type { AccessConfig } from '../access.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'discord-access-'))
})

describe('loadAccess', () => {
  test('returns defaults when file does not exist', () => {
    const access = loadAccess(tempDir)
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
    expect(access.groups).toEqual({})
    expect(access.pending).toEqual({})
  })

  test('loads saved config', async () => {
    const config: AccessConfig = {
      dmPolicy: 'allowlist',
      allowFrom: ['user123', 'user456'],
      groups: {},
      pending: {},
      ackReaction: '👀',
      textChunkLimit: 1500,
      chunkMode: 'newline',
    }
    saveAccess(config, tempDir)

    const loaded = loadAccess(tempDir)
    expect(loaded.dmPolicy).toBe('allowlist')
    expect(loaded.allowFrom).toEqual(['user123', 'user456'])
    expect(loaded.ackReaction).toBe('👀')
    expect(loaded.textChunkLimit).toBe(1500)
    expect(loaded.chunkMode).toBe('newline')
  })

  test('handles corrupt JSON by starting fresh', async () => {
    await writeFile(join(tempDir, 'access.json'), 'not json {{{')
    const loaded = loadAccess(tempDir)
    expect(loaded.dmPolicy).toBe('pairing')
    expect(loaded.allowFrom).toEqual([])
  })
})

describe('saveAccess', () => {
  test('persists config to disk', async () => {
    const config = defaultAccess()
    config.allowFrom = ['myuser']
    saveAccess(config, tempDir)

    const raw = await readFile(join(tempDir, 'access.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.allowFrom).toEqual(['myuser'])
  })
})

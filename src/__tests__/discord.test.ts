import { describe, test, expect } from 'bun:test'
import { chunk, assertSendable, safeAttName } from '../discord.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('chunk', () => {
  test('returns single element for short text', () => {
    expect(chunk('hello', 2000, 'length')).toEqual(['hello'])
  })

  test('splits at limit in length mode', () => {
    const text = 'A'.repeat(2500)
    const result = chunk(text, 2000, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBe(2000)
    expect(result[1].length).toBe(500)
  })

  test('splits at newlines in newline mode', () => {
    const text = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(400)
    const result = chunk(text, 2000, 'newline')
    expect(result.length).toBe(1) // fits in one chunk
  })

  test('splits long text at paragraph boundary', () => {
    const para1 = 'A'.repeat(1200)
    const para2 = 'B'.repeat(1200)
    const text = `${para1}\n\n${para2}`
    const result = chunk(text, 2000, 'newline')
    expect(result.length).toBe(2)
    expect(result[0]).toBe(para1)
    expect(result[1]).toBe(para2)
  })

  test('caps limit at 2000', () => {
    const text = 'A'.repeat(3000)
    const result = chunk(text, 5000, 'length') // tries 5000, capped to 2000
    expect(result[0].length).toBe(2000)
  })
})

describe('assertSendable', () => {
  test('allows normal files outside state dir', async () => {
    const fileDir = await mkdtemp(join(tmpdir(), 'send-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'state-'))
    const file = join(fileDir, 'test.txt')
    await writeFile(file, 'hello')
    expect(() => assertSendable(file, stateDir)).not.toThrow()
  })

  test('blocks state dir files', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'state-'))
    const secretFile = join(stateDir, 'access.json')
    await writeFile(secretFile, '{}')
    expect(() => assertSendable(secretFile, stateDir)).toThrow('refusing to send')
  })

  test('allows inbox files within state dir', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'state-'))
    const inboxDir = join(stateDir, 'inbox')
    await mkdir(inboxDir, { recursive: true })
    const inboxFile = join(inboxDir, 'photo.jpg')
    await writeFile(inboxFile, 'data')
    expect(() => assertSendable(inboxFile, stateDir)).not.toThrow()
  })
})

describe('safeAttName', () => {
  test('strips dangerous characters', () => {
    expect(safeAttName('file[name].txt\ninjection', '123')).toBe('file_name_.txt_injection')
  })

  test('falls back to id', () => {
    expect(safeAttName(undefined as any, '456')).toBe('456')
  })
})

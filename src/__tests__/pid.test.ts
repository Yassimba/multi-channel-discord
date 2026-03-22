import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PidManager } from '../pid.js'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pid-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('PidManager', () => {
  test('write() creates PID file with current process PID', async () => {
    const mgr = new PidManager(tempDir)
    await mgr.write()
    const content = await readFile(join(tempDir, 'router.pid'), 'utf-8')
    expect(content.trim()).toBe(String(process.pid))
  })

  test('read() returns PID from file', async () => {
    const mgr = new PidManager(tempDir)
    await mgr.write()
    const pid = await mgr.read()
    expect(pid).toBe(process.pid)
  })

  test('read() returns null when file does not exist', async () => {
    const mgr = new PidManager(tempDir)
    const pid = await mgr.read()
    expect(pid).toBeNull()
  })

  test('remove() deletes PID file', async () => {
    const mgr = new PidManager(tempDir)
    await mgr.write()
    await mgr.remove()
    const pid = await mgr.read()
    expect(pid).toBeNull()
  })

  test('remove() does not throw if file does not exist', async () => {
    const mgr = new PidManager(tempDir)
    await expect(mgr.remove()).resolves.toBeUndefined()
  })

  test('isAlive() returns true for current process', () => {
    const mgr = new PidManager(tempDir)
    expect(mgr.isAlive(process.pid)).toBe(true)
  })

  test('isAlive() returns false for non-existent PID', () => {
    const mgr = new PidManager(tempDir)
    expect(mgr.isAlive(99999999)).toBe(false)
  })

  test('cleanStale() removes PID file when process is dead', async () => {
    const mgr = new PidManager(tempDir)
    await writeFile(join(tempDir, 'router.pid'), '99999999')

    const cleaned = await mgr.cleanStale()
    expect(cleaned).toBe(true)
    expect(await mgr.read()).toBeNull()
  })

  test('cleanStale() keeps PID file when process is alive', async () => {
    const mgr = new PidManager(tempDir)
    await mgr.write()

    const cleaned = await mgr.cleanStale()
    expect(cleaned).toBe(false)
    expect(await mgr.read()).toBe(process.pid)
  })

  test('cleanStale() returns false when no PID file exists', async () => {
    const mgr = new PidManager(tempDir)
    const cleaned = await mgr.cleanStale()
    expect(cleaned).toBe(false)
  })

  test('write() creates state directory if missing', async () => {
    const nested = join(tempDir, 'sub', 'dir')
    const mgr = new PidManager(nested)
    await mgr.write()
    const pid = await mgr.read()
    expect(pid).toBe(process.pid)
  })
})

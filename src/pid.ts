import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getStateDir } from './access.js'

const PID_FILE = 'router.pid'

/** Manages the router PID file for daemon lifecycle and stale detection. */
export class PidManager {
  private readonly pidPath: string

  constructor(stateDir?: string) {
    const dir = getStateDir(stateDir)
    this.pidPath = join(dir, PID_FILE)
  }

  /** Write current process PID to file. Creates directory if needed. */
  async write(): Promise<void> {
    const dir = join(this.pidPath, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(this.pidPath, String(process.pid))
  }

  /** Read PID from file. Returns null if file doesn't exist. */
  async read(): Promise<number | null> {
    try {
      const content = await readFile(this.pidPath, 'utf-8')
      const pid = parseInt(content.trim(), 10)
      return Number.isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  /** Remove PID file. No-op if file doesn't exist. */
  async remove(): Promise<void> {
    try {
      await unlink(this.pidPath)
    } catch {
      // File doesn't exist — that's fine
    }
  }

  /** Check if a process with the given PID is alive. */
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Remove PID file if the recorded process is dead. Returns true if stale PID was cleaned. */
  async cleanStale(): Promise<boolean> {
    const pid = await this.read()
    if (pid === null) return false

    if (!this.isAlive(pid)) {
      await this.remove()
      return true
    }

    return false
  }
}

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { PidManager } from './pid.js'

interface EnsureRouterOptions {
  wsPort?: number
  stateDir?: string
  routerScript?: string
  timeoutMs?: number
}

const DEFAULT_WS_PORT = 8789
const DEFAULT_TIMEOUT_MS = 3000
const POLL_INTERVAL_MS = 200

/** Check if a TCP port is accepting connections. */
export async function isPortReachable(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const result = await Promise.race([
      Bun.connect({
        hostname: 'localhost',
        port,
        socket: {
          data() {},
          open(socket) { socket.end() },
          error() {},
          close() {},
        },
      }),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ])
    if (result) result.end()
    return true
  } catch {
    return false
  }
}

/** Ensure the router daemon is running. Spawns it if unreachable. */
export async function ensureRouter(opts?: EnsureRouterOptions): Promise<void> {
  const wsPort = opts?.wsPort ?? DEFAULT_WS_PORT
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stateDir = opts?.stateDir
  const routerScript = opts?.routerScript ?? resolve(import.meta.dir, 'router.ts')

  // Clean stale PID if needed
  const pid = new PidManager(stateDir)
  await pid.cleanStale()

  // Check if already running
  if (await isPortReachable(wsPort, 1000)) {
    return
  }

  // Spawn router as detached background process
  const child = spawn('bun', ['run', routerScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(stateDir ? { DISCORD_STATE_DIR: stateDir } : {}),
    },
  })
  child.unref()

  // Wait for the port to become available
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortReachable(wsPort, 500)) {
      return
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  throw new Error(`Router failed to start within ${timeoutMs}ms`)
}

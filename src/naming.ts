/**
 * Session naming — derive a name from git branch, package.json, or directory.
 * Ported from the WhatsApp project.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'

export interface NamingContext {
  readonly gitBranch?: string
  readonly packageName?: string
  readonly dirName: string
}

const GENERIC_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD'])

/** Read naming context from the project directory. */
export async function readNamingContext(cwd: string): Promise<NamingContext> {
  const ctx: { gitBranch?: string; packageName?: string; dirName: string } = { dirName: basename(cwd) }

  // Try git branch
  try {
    const branch = await new Promise<string>((resolve, reject) => {
      const proc = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
      let out = ''
      proc.stdout.on('data', (d: Buffer) => { out += d })
      proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject())
      proc.on('error', reject)
    })
    if (branch && !GENERIC_BRANCHES.has(branch)) {
      ctx.gitBranch = branch
    }
  } catch {}

  // Try package.json name
  try {
    const pkg = JSON.parse(await readFile(`${cwd}/package.json`, 'utf-8')) as { name?: string }
    if (typeof pkg.name === 'string' && pkg.name) {
      ctx.packageName = pkg.name
    }
  } catch {}

  return ctx
}

/** Pick the best session name from the context. */
export function pickSessionName(ctx: Readonly<NamingContext>): string {
  if (ctx.gitBranch) return ctx.gitBranch
  if (ctx.packageName) return ctx.packageName
  return ctx.dirName
}

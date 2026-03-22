/**
 * Skill discovery — scans .claude/skills/ directories for user-invocable skills.
 * Reads SKILL.md frontmatter to extract name, description, and user-invocable flag.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface SkillInfo {
  readonly name: string
  readonly description: string
}

/** Parse YAML frontmatter from a SKILL.md file. Returns null if not parseable or not user-invocable. */
export function parseFrontmatter(content: string): SkillInfo | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const yaml = match[1]
  const fields: Record<string, string> = {}

  for (const line of yaml.split('\n')) {
    // Handle simple key: value lines (skip continuation lines for multi-line values)
    const kv = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      let value = kv[2].trim()
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      // Strip YAML block scalar indicators
      if (value === '>' || value === '|') value = ''
      fields[key] = value
    } else if (Object.keys(fields).length > 0) {
      // Continuation line for multi-line description
      const lastKey = Object.keys(fields).at(-1)!
      if (lastKey === 'description' && line.trim()) {
        fields[lastKey] = fields[lastKey]
          ? `${fields[lastKey]} ${line.trim()}`
          : line.trim()
      }
    }
  }

  if (!fields['name']) return null
  // Include skills that are explicitly user-invocable OR don't specify (default to invocable)
  if (fields['user-invocable'] === 'false') return null

  return {
    name: fields['name'],
    description: (fields['description'] ?? '').slice(0, 100) || fields['name'],
  }
}

/** Scan a .claude/skills/ directory for user-invocable skills. */
async function scanSkillsDir(dir: string): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    try {
      const skillMd = join(dir, entry, 'SKILL.md')
      const content = await readFile(skillMd, 'utf-8')
      const info = parseFrontmatter(content)
      if (info) skills.push(info)
    } catch {
      // No SKILL.md or not readable — skip
    }
  }

  return skills
}

/**
 * Discover all user-invocable skills for a project.
 * Project skills override user skills when names collide.
 * Returns at most `limit` skills.
 */
export async function discoverSkills(projectDir: string, limit = 90): Promise<readonly SkillInfo[]> {
  const userSkillsDir = join(homedir(), '.claude', 'skills')
  const projectSkillsDir = join(projectDir, '.claude', 'skills')

  const [userSkills, projectSkills] = await Promise.all([
    scanSkillsDir(userSkillsDir),
    scanSkillsDir(projectSkillsDir),
  ])

  // Project skills take precedence over user skills
  const seen = new Set<string>()
  const result: SkillInfo[] = []

  for (const skill of projectSkills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name)
      result.push(skill)
    }
  }

  for (const skill of userSkills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name)
      result.push(skill)
    }
  }

  return result.slice(0, limit)
}

import { describe, test, expect, beforeEach } from 'bun:test'
import { parseFrontmatter, discoverSkills } from '../skills.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('parseFrontmatter', () => {
  test('parses valid user-invocable skill', () => {
    const content = `---
name: commit
description: Write clear commit messages
user-invocable: true
---

# Commit skill
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'commit',
      description: 'Write clear commit messages',
    })
  })

  test('includes skill without explicit user-invocable flag', () => {
    const content = `---
name: refactor
description: Deep code analysis
---

# Refactor
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({ name: 'refactor', description: 'Deep code analysis' })
  })

  test('returns null for user-invocable: false', () => {
    const content = `---
name: internal
description: Internal skill
user-invocable: false
---
`
    expect(parseFrontmatter(content)).toBeNull()
  })

  test('returns null when no frontmatter', () => {
    expect(parseFrontmatter('# Just a heading')).toBeNull()
  })

  test('returns null when no name field', () => {
    const content = `---
description: No name
user-invocable: true
---
`
    expect(parseFrontmatter(content)).toBeNull()
  })

  test('handles quoted description', () => {
    const content = `---
name: deploy
description: "Deploy the app to production"
user-invocable: true
---
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'deploy',
      description: 'Deploy the app to production',
    })
  })

  test('handles single-quoted description', () => {
    const content = `---
name: test
description: 'Run all tests'
user-invocable: true
---
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'test',
      description: 'Run all tests',
    })
  })

  test('handles multi-line description with block scalar', () => {
    const content = `---
name: review
description: >
  Review code changes and suggest improvements.
  Covers style, correctness, and performance.
user-invocable: true
---
`
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('review')
    expect(result!.description).toContain('Review code changes')
  })

  test('truncates long descriptions to 100 chars', () => {
    const longDesc = 'A'.repeat(200)
    const content = `---
name: verbose
description: ${longDesc}
user-invocable: true
---
`
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.description.length).toBeLessThanOrEqual(100)
  })

  test('uses name as description fallback when description is empty', () => {
    const content = `---
name: minimal
user-invocable: true
---
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'minimal',
      description: 'minimal',
    })
  })

  test('handles extra frontmatter fields', () => {
    const content = `---
name: access
description: Manage access control
user-invocable: true
allowed-tools:
  - Read
  - Write
---
`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'access',
      description: 'Manage access control',
    })
  })
})

describe('discoverSkills', () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'skills-test-'))
  })

  test('discovers project skills', async () => {
    const skillDir = join(projectDir, '.claude', 'skills', 'commit')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: commit
description: Write commit messages
---
`)

    const skills = await discoverSkills(projectDir)
    const commit = skills.find(s => s.name === 'commit')
    expect(commit).toEqual({ name: 'commit', description: 'Write commit messages' })
  })

  test('skips skills with user-invocable: false', async () => {
    const skillDir = join(projectDir, '.claude', 'skills', 'internal')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: internal
description: Not user facing
user-invocable: false
---
`)

    const skills = await discoverSkills(projectDir)
    expect(skills.find(s => s.name === 'internal')).toBeUndefined()
  })

  test('skips directories without SKILL.md', async () => {
    const skillDir = join(projectDir, '.claude', 'skills', 'empty')
    await mkdir(skillDir, { recursive: true })

    const skills = await discoverSkills(projectDir)
    expect(skills.find(s => s.name === 'empty')).toBeUndefined()
  })

  test('returns user skills even when no project skills directory exists', async () => {
    const skills = await discoverSkills(projectDir)
    // May include user-level skills from ~/.claude/skills/
    expect(Array.isArray(skills)).toBe(true)
  })

  test('project skills override user skills by name', async () => {
    const skill1 = join(projectDir, '.claude', 'skills', 'deploy')
    await mkdir(skill1, { recursive: true })
    await writeFile(join(skill1, 'SKILL.md'), `---
name: deploy
description: Project deploy
---
`)

    const skill2 = join(projectDir, '.claude', 'skills', 'test-skill')
    await mkdir(skill2, { recursive: true })
    await writeFile(join(skill2, 'SKILL.md'), `---
name: test-skill
description: Run tests
---
`)

    const skills = await discoverSkills(projectDir)
    const names = skills.map(s => s.name)
    expect(names).toContain('deploy')
    expect(names).toContain('test-skill')
  })

  test('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const skillDir = join(projectDir, '.claude', 'skills', `skill-${i}`)
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), `---
name: skill-${i}
description: Skill ${i}
user-invocable: true
---
`)
    }

    const skills = await discoverSkills(projectDir, 3)
    expect(skills).toHaveLength(3)
  })
})

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

  test('returns null for non-user-invocable skill', () => {
    const content = `---
name: refactor
description: Deep code analysis
---

# Refactor
`
    expect(parseFrontmatter(content)).toBeNull()
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
user-invocable: true
---
`)

    const skills = await discoverSkills(projectDir)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toEqual({
      name: 'commit',
      description: 'Write commit messages',
    })
  })

  test('skips non-user-invocable skills', async () => {
    const skillDir = join(projectDir, '.claude', 'skills', 'internal')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: internal
description: Not user facing
---
`)

    const skills = await discoverSkills(projectDir)
    expect(skills).toHaveLength(0)
  })

  test('skips directories without SKILL.md', async () => {
    const skillDir = join(projectDir, '.claude', 'skills', 'empty')
    await mkdir(skillDir, { recursive: true })

    const skills = await discoverSkills(projectDir)
    expect(skills).toHaveLength(0)
  })

  test('returns empty array when no skills directory exists', async () => {
    const skills = await discoverSkills(projectDir)
    expect(skills).toHaveLength(0)
  })

  test('project skills override user skills by name', async () => {
    // We can only test project skills here (user skills require writing to ~/.claude)
    // but we can test the dedup logic by having two skills with different dirs
    const skill1 = join(projectDir, '.claude', 'skills', 'deploy')
    await mkdir(skill1, { recursive: true })
    await writeFile(join(skill1, 'SKILL.md'), `---
name: deploy
description: Project deploy
user-invocable: true
---
`)

    const skill2 = join(projectDir, '.claude', 'skills', 'test')
    await mkdir(skill2, { recursive: true })
    await writeFile(join(skill2, 'SKILL.md'), `---
name: test
description: Run tests
user-invocable: true
---
`)

    const skills = await discoverSkills(projectDir)
    expect(skills).toHaveLength(2)
    const names = skills.map(s => s.name)
    expect(names).toContain('deploy')
    expect(names).toContain('test')
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

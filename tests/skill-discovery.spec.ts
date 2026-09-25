import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

it('discovers memory-vault through skill-filesystem.customSkillDirs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mydsh-skill-home-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      customSkillDirs: [join(root, 'skills')],
      watch: false,
    })
    const skills = await ctx.skills.list({ cwd: root })
    expect(skills.find(skill => skill.name === 'memory-vault')).toMatchObject({
      description: expect.stringContaining('durable cross-session memory'),
      source: 'custom',
    })
    const skill = await ctx.skills.get('memory-vault')
    expect(skill?.content).toContain('Safe write protocol')
    expect(skill?.content).toContain('baseVersion')
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

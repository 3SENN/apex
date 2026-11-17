/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRAND_NAME } from '@shared/branding'
import { COMPANION_FILE_VERSION, COMPANION_PREVIEW_TEXT_MAX, DEFAULT_LOOK, DEFAULT_PROFILE, skillReviewText, type CompanionPreset } from '@shared/companion'
import { CompanionStore, FIRST_COMPANION_ID, companionFile, parseCompanionFile, uniqueName } from '../src/main/companions'
import { CompanionService } from '../src/main/companionsService'
import { MemoryService } from '../src/main/memory'
import { ConnectorStore, RoutineStore, SkillStore } from '../src/main/stores'

const PRESETS: CompanionPreset[] = [
  { id: 'pip', name: 'Pip', tagline: 'Friendly', personality: 'Warm.', look: DEFAULT_LOOK },
  { id: 'nova', name: 'Nova', tagline: 'Bright', personality: 'Curious.', look: { ...DEFAULT_LOOK, rig: 'B' } },
]
const presets = (): CompanionPreset[] => PRESETS

function store(dir = mkdtempSync(join(tmpdir(), 'apex-companions-'))): { dir: string; companions: CompanionStore } {
  return { dir, companions: new CompanionStore(dir, { presets }) }
}

describe('companion names', () => {
  it('get a suffix on a clash and stay within the limit', () => {
    expect(uniqueName('Nova', ['Pip'])).toBe('Nova')
    expect(uniqueName('Nova', ['nova', 'Nova 2'])).toBe('Nova 3')
    expect(uniqueName('x'.repeat(30), ['x'.repeat(24)])).toBe(`${'x'.repeat(22)} 2`)
    expect(uniqueName('   ', [])).toBe('Companion')
  })
})

describe('companion list', () => {
  it('migrates the single profile into the first companion with a stable id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-companions-'))
    writeFileSync(join(dir, 'companion.json'), JSON.stringify({ name: 'Juno', persona: 'nova', look: DEFAULT_LOOK, dockIcon: true }))
    const { companions } = store(dir)
    expect(companions.list()).toEqual([expect.objectContaining({ id: FIRST_COMPANION_ID, name: 'Juno', persona: 'nova', dockIcon: true, hidden: false, instructions: '', model: null, effort: null })])
    expect(companions.activeId()).toBe(FIRST_COMPANION_ID)
    // Reopening reads companions.json; the old file is left alone.
    expect(new CompanionStore(dir, { presets }).get().id).toBe(FIRST_COMPANION_ID)
    expect(JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8')).name).toBe('Juno')
  })

  it('creates from presets or a given look, with unique names, and makes the new one active', () => {
    const { companions } = store()
    const nova = companions.create({ presetId: 'nova' })
    expect(nova).toMatchObject({ name: 'Nova', persona: 'nova', look: { rig: 'B' } })
    expect(companions.activeId()).toBe(nova.id)
    const second = companions.create({ presetId: 'nova', activate: false })
    expect(second.name).toBe('Nova 2')
    expect(companions.activeId()).toBe(nova.id)
    const blank = companions.create({ name: '  Rex  ', look: { ...DEFAULT_LOOK, rig: 'C' } })
    expect(blank).toMatchObject({ name: 'Rex', persona: 'custom', look: { rig: 'C' } })
    // A persona this Apex doesn't ship becomes custom.
    expect(companions.create({ name: 'Imp', persona: 'pirate' }).persona).toBe('custom')
    expect(() => companions.create({ presetId: 'ghost' })).toThrow('That preset is not available.')
  })

  it('updates instructions and model defaults, and resets to how it started', () => {
    const { companions } = store()
    const nova = companions.create({ presetId: 'nova' })
    companions.update(nova.id, { name: 'Novi', instructions: '  Reply in French.\r\n', model: 'claude-sonnet-5-5', effort: 'low', look: { ...DEFAULT_LOOK, rig: 'C' } })
    expect(companions.get(nova.id)).toMatchObject({ name: 'Novi', instructions: 'Reply in French.', model: 'claude-sonnet-5-5', effort: 'low' })
    companions.update(nova.id, { model: 'not-a-model', effort: null })
    expect(companions.get(nova.id)).toMatchObject({ model: null, effort: null })
    expect(companions.reset(nova.id)).toMatchObject({ name: 'Nova', persona: 'nova', look: { rig: 'B' }, instructions: '', model: null })
  })

  it('keeps at least one visible companion and an active one that is visible', () => {
    const { companions } = store()
    expect(() => companions.remove(FIRST_COMPANION_ID)).toThrow(/at least one companion/)
    expect(() => companions.setHidden(FIRST_COMPANION_ID, true)).toThrow(/at least one companion visible/)
    const nova = companions.create({ presetId: 'nova' })
    companions.setHidden(nova.id, true)
    expect(companions.activeId()).toBe(FIRST_COMPANION_ID)
    expect(() => companions.setActive(nova.id)).toThrow(/Show this companion again/)
    // A hidden one can go even when only one is visible.
    companions.remove(nova.id)
    expect(companions.list()).toHaveLength(1)
    const bolt = companions.create({ name: 'Bolt' })
    companions.remove(FIRST_COMPANION_ID)
    expect(companions.activeId()).toBe(bolt.id)
    expect(() => companions.get(FIRST_COMPANION_ID)).toThrow('That companion no longer exists.')
  })

  it('duplicates as a visible, inactive copy', () => {
    const { companions } = store()
    const copy = companions.duplicate(FIRST_COMPANION_ID)
    expect(copy).toMatchObject({ name: `${DEFAULT_PROFILE.name} 2`, hidden: false, dockIcon: false })
    expect(copy.id).not.toBe(FIRST_COMPANION_ID)
    expect(companions.activeId()).toBe(FIRST_COMPANION_ID)
  })

  it('repairs a file whose active companion is gone or everyone is hidden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-companions-'))
    writeFileSync(join(dir, 'companions.json'), JSON.stringify({ version: 1, activeId: 'gone', companions: [{ id: 'a', name: 'A', hidden: true }, { id: '../evil', name: 'B' }] }))
    const { companions } = store(dir)
    expect(companions.list().map((c) => [c.id, c.hidden])).toEqual([['a', false]])
    expect(companions.activeId()).toBe('a')
  })
})

describe('companion files', () => {
  const base = { format: 'apex-companion', version: 1, name: 'Nova', persona: 'nova', look: DEFAULT_LOOK, instructions: 'Be brief.', model: null, effort: null }

  it('round-trip a companion with its extras', () => {
    const { companions } = store()
    const nova = companions.update(FIRST_COMPANION_ID, { instructions: 'Be brief.', model: 'claude-haiku-5-5', effort: 'medium' })
    const file = companionFile(nova, { note: ' Made for you ', skills: [{ name: 'recap', description: 'd', instructions: 'Recap my day.' }] }, new Date(0))
    expect(file).toMatchObject({ format: 'apex-companion', version: COMPANION_FILE_VERSION, exportedAt: '1970-01-01T00:00:00.000Z', note: 'Made for you' })
    expect(parseCompanionFile(JSON.stringify(file))).toMatchObject({ name: DEFAULT_PROFILE.name, instructions: 'Be brief.', model: 'claude-haiku-5-5', effort: 'medium', skills: [{ name: 'recap' }] })
  })

  it('refuse other files, newer versions and damaged contents with readable errors', () => {
    expect(() => parseCompanionFile('not json')).toThrow(`isn't a companion file for ${BRAND_NAME}`)
    expect(() => parseCompanionFile(JSON.stringify({ format: 'other' }))).toThrow(`isn't a companion file for ${BRAND_NAME}`)
    expect(() => parseCompanionFile(JSON.stringify({ ...base, version: COMPANION_FILE_VERSION + 1 }))).toThrow(`newer version of ${BRAND_NAME}`)
    expect(() => parseCompanionFile(JSON.stringify({ ...base, look: { ...DEFAULT_LOOK, rig: 'Z' } }))).toThrow(/damaged or incomplete/)
    expect(() => parseCompanionFile(JSON.stringify({ ...base, memory: [{ path: '/memories/../x', text: '' }] }))).toThrow(/damaged/)
    expect(() => parseCompanionFile(JSON.stringify({ ...base, memory: [{ path: '/memories/shared/x.md', text: '' }] }))).toThrow(/damaged/)
    expect(() => parseCompanionFile(JSON.stringify({ ...base, routines: [{ name: 'r', prompt: 'p', schedule: { kind: 'daily', time: '25:00', days: [] } }] }))).toThrow(/damaged/)
  })

  it('treat an unknown model or effort as following the defaults, and trim long names', () => {
    expect(parseCompanionFile(JSON.stringify({ ...base, name: 'y'.repeat(40), model: 'claude-future-9', effort: 'ultra' }))).toMatchObject({ name: 'y'.repeat(24), model: null, effort: null })
  })
})

describe('companion service', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'apex-companion-service-'))
    const companions = new CompanionStore(dir, { presets })
    const skills = new SkillStore(dir)
    const routines = new RoutineStore(dir)
    const connectors = new ConnectorStore(dir)
    const memory = new MemoryService(dir)
    const service = new CompanionService({ store: companions, skills, routines, connectors, memory })
    return { companions, skills, routines, connectors, memory, service }
  }

  it('duplicates own skills and memory, not routines', () => {
    const { skills, routines, memory, service } = setup()
    skills.save({ name: 'recap', description: '', instructions: 'Recap.', owner: FIRST_COMPANION_ID })
    skills.save({ name: 'shared-one', description: '', instructions: 'Shared.' })
    routines.save({ name: 'Daily', prompt: 'p', schedule: { kind: 'interval', hours: 2 }, enabled: true, owner: FIRST_COMPANION_ID })
    memory.write('/memories/me.md', 'likes tea', FIRST_COMPANION_ID)
    const copy = service.duplicate(FIRST_COMPANION_ID)
    expect(skills.ownedBy(copy.id).map((s) => s.name)).toEqual(['recap'])
    expect(routines.ownedBy(copy.id)).toHaveLength(0)
    expect(memory.read('/memories/me.md', copy.id)).toBe('likes tea')
  })

  it('deletes what a companion owns and leaves shared items', async () => {
    const { companions, skills, routines, connectors, memory, service } = setup()
    const nova = companions.create({ presetId: 'nova' })
    skills.save({ name: 'recap', description: '', instructions: 'Recap.', owner: nova.id })
    skills.save({ name: 'recap', description: '', instructions: 'Shared recap.' })
    routines.save({ name: 'Daily', prompt: 'p', schedule: { kind: 'interval', hours: 2 }, enabled: true, owner: nova.id })
    connectors.save({ name: 'docs', url: 'https://mcp.example/docs', enabled: true, owner: nova.id })
    memory.write('/memories/me.md', 'note', nova.id)
    await service.remove(nova.id)
    expect(skills.list().map((s) => s.owner)).toEqual(['shared'])
    // A removed companion's routines stay, waiting until you pick another companion.
    expect(routines.list()).toHaveLength(1)
    expect(connectors.list()).toHaveLength(0)
    expect(memory.ownerFolder(nova.id)).toBeNull()
    await expect(service.remove(FIRST_COMPANION_ID)).rejects.toThrow(/at least one companion/)
  })

  it('exports the chosen parts and imports them as a new companion after a preview', () => {
    const { companions, skills, routines, memory, service } = setup()
    companions.update(FIRST_COMPANION_ID, { instructions: 'Use metric units.' })
    skills.save({ name: 'recap', description: 'Daily recap', instructions: 'Recap.', owner: FIRST_COMPANION_ID })
    routines.save({ name: 'Morning', prompt: 'Brief me.', schedule: { kind: 'daily', time: '08:00', days: [] }, enabled: true, owner: FIRST_COMPANION_ID })
    memory.write('/memories/prefs.md', 'aisle seats', FIRST_COMPANION_ID)

    const bare = JSON.parse(service.exportText(FIRST_COMPANION_ID))
    expect(bare).not.toHaveProperty('skills')
    expect(bare).not.toHaveProperty('memory')
    const text = service.exportText(FIRST_COMPANION_ID, { includeSkills: true, includeRoutines: true, includeMemory: true, note: 'Hi' })

    const preview = service.preview(text)
    expect(preview).toMatchObject({ name: `${DEFAULT_PROFILE.name} 2`, originalName: DEFAULT_PROFILE.name, note: 'Hi', instructions: 'Use metric units.', skills: [{ name: 'recap', description: 'Daily recap' }], routines: [{ name: 'Morning' }], memoryFiles: 1 })
    const added = service.confirm(preview.token)
    expect(added).toMatchObject({ name: `${DEFAULT_PROFILE.name} 2`, instructions: 'Use metric units.' })
    expect(companions.activeId()).toBe(added.id)
    expect(companions.list()).toHaveLength(2)
    expect(skills.ownedBy(added.id).map((s) => s.name)).toEqual(['recap'])
    // Imported routines start paused.
    expect(routines.ownedBy(added.id)).toEqual([expect.objectContaining({ name: 'Morning', enabled: false, nextRunAt: null })])
    expect(memory.read('/memories/prefs.md', added.id)).toBe('aisle seats')
    // A preview is used once.
    expect(() => service.confirm(preview.token)).toThrow(/expired/)
  })

  it('shares a companion’s own skills with their steps and files, and duplicates them too', () => {
    const { skills, service } = setup()
    const plan = skills.save({ name: 'evil-plan', description: 'A plan', instructions: '', steps: [{ id: 'a', title: 'Monologue', instructions: 'Gloat.' }], owner: FIRST_COMPANION_ID })
    skills.writeFile(plan.id, 'notes/lairs.md', 'Volcano first.')
    skills.save({ name: 'shared-one', description: '', instructions: 'Shared.' })
    const file = JSON.parse(service.exportText(FIRST_COMPANION_ID, { includeSkills: true }))
    expect(file.skills).toEqual([{ name: 'evil-plan', description: 'A plan', instructions: '', steps: [{ title: 'Monologue', instructions: 'Gloat.' }], files: [{ path: 'notes/lairs.md', text: 'Volcano first.' }] }])

    const added = service.confirm(service.preview(JSON.stringify(file)).token)
    const imported = skills.ownedBy(added.id)
    expect(imported).toEqual([expect.objectContaining({ name: 'evil-plan', steps: [expect.objectContaining({ title: 'Monologue', instructions: 'Gloat.' })] })])
    expect(skills.readFile(imported[0]!.id, 'notes/lairs.md')).toBe('Volcano first.')

    const copy = service.duplicate(FIRST_COMPANION_ID)
    const copied = skills.ownedBy(copy.id)
    expect(copied.map((s) => s.steps.length)).toEqual([1])
    expect(skills.readFile(copied[0]!.id, 'notes/lairs.md')).toBe('Volcano first.')
  })

  it('previews everything the companion tells the assistant: skill instructions, steps, files and routine prompts', () => {
    const { skills, routines, service } = setup()
    const plan = skills.save({ name: 'evil-plan', description: 'A plan', instructions: 'Keep it secret.', steps: [{ id: 'a', title: 'Monologue', instructions: 'Gloat.' }], owner: FIRST_COMPANION_ID })
    skills.writeFile(plan.id, 'notes/lairs.md', 'Volcano first.')
    skills.writeFile(plan.id, 'notes/big.md', 'x'.repeat(COMPANION_PREVIEW_TEXT_MAX))
    routines.save({ name: 'Morning', prompt: 'Brief me on the news.', schedule: { kind: 'daily', time: '08:00', days: [] }, enabled: true, owner: FIRST_COMPANION_ID })
    const preview = service.preview(service.exportText(FIRST_COMPANION_ID, { includeSkills: true, includeRoutines: true }))
    expect(preview.skills).toEqual([
      {
        name: 'evil-plan',
        description: 'A plan',
        instructions: 'Keep it secret.',
        steps: [{ title: 'Monologue', instructions: 'Gloat.' }],
        files: [
          // The first file fills the budget, so the second shows its size instead of its text.
          { path: 'notes/big.md', size: COMPANION_PREVIEW_TEXT_MAX, text: 'x'.repeat(COMPANION_PREVIEW_TEXT_MAX) },
          { path: 'notes/lairs.md', size: 14, text: null },
        ],
      },
    ])
    expect(skillReviewText(preview.skills[0]!)).toBe('Keep it secret.\n\n1. Monologue\nGloat.')
    expect(preview.routines).toEqual([{ name: 'Morning', prompt: 'Brief me on the news.', schedule: { kind: 'daily', time: '08:00', days: [] } }])
  })

  it('refuses a companion file whose skill files leave the skill’s folder', () => {
    const { service } = setup()
    const file = JSON.parse(service.exportText(FIRST_COMPANION_ID))
    for (const path of ['../escape.md', '/etc/x.md', 'SKILL.md', 'a/../../b.md', 'tool.exe']) {
      const text = JSON.stringify({ ...file, skills: [{ name: 'x', description: '', instructions: 'Do it.', files: [{ path, text: 'hi' }] }] })
      expect(() => service.preview(text), path).toThrow(/damaged or incomplete/)
    }
    // A skill with neither instructions nor steps has nothing to do.
    expect(() => service.preview(JSON.stringify({ ...file, skills: [{ name: 'x', description: '', instructions: ' ' }] }))).toThrow(/damaged or incomplete/)
  })

  it('expires previews', () => {
    const { service } = setup()
    const preview = service.preview(service.exportText(FIRST_COMPANION_ID), 0)
    expect(() => service.confirm(preview.token, 31 * 60_000)).toThrow(/expired/)
  })
})

describe('companion service schemas', () => {
  it('validate updates, creation and import input', async () => {
    const { SERVICE_SCHEMAS } = await import('../src/main/services')
    const companions = SERVICE_SCHEMAS.companions
    expect(companions.update.safeParse([FIRST_COMPANION_ID, { instructions: 'Be kind.', model: null, effort: 'max' }]).success).toBe(true)
    expect(companions.update.safeParse([FIRST_COMPANION_ID, { instructions: 'x'.repeat(4001) }]).success).toBe(false)
    expect(companions.update.safeParse([FIRST_COMPANION_ID, { hidden: true }]).success).toBe(false)
    expect(companions.update.safeParse(['../x', {}]).success).toBe(false)
    expect(companions.create.safeParse([{ presetId: 'nova' }]).success).toBe(true)
    expect(companions.create.safeParse([{ name: '' }]).success).toBe(false)
    expect(companions.export.safeParse([FIRST_COMPANION_ID, { includeMemory: true, shareImage: 'data:image/png;base64,iVBORw0KGgo=' }]).success).toBe(true)
    expect(companions.export.safeParse([FIRST_COMPANION_ID, { shareImage: 'data:text/html,hi' }]).success).toBe(false)
    expect(companions.confirmImport.safeParse(['not-a-token']).success).toBe(false)
  })
})

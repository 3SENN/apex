/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Routine, RoutineRun, RoutineSuggestion } from '@shared/routines'
import type { Skill, SkillFile } from '@shared/skills'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Skill folders and the legacy migration, built-in skills, Save as skill, routines, cron, one-off tasks, run history and catch-up.
// Offline only: nothing here calls a model except a routine's Run now,
// which goes through the offline smoke client. Every check removes what it
// made. Shots cover the Skills page, the skill editor, the Routines page,
// a routine's detail page and the editor sheet, in light and dark.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function rejects(p: Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await p
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    assert(pattern.test(message), `${label}: unexpected error “${message}”`)
    return
  }
  throw new Error(`${label}: expected a refusal`)
}

const DAY = 86_400_000

async function makeRoutine(ctx: SmokeContext, name: string, extra: Record<string, unknown> = {}): Promise<Routine> {
  return ctx.chrome.invoke<Routine>('routines', 'save', { name, prompt: 'Say hello in one line.', schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, enabled: true, ...extra })
}

export const checks: SmokeCheck[] = [
  {
    name: 'built-in skills are listed, read-only and never deletable',
    async run(ctx) {
      const all = await ctx.chrome.invoke<Skill[]>('skills', 'list', { source: 'builtin' })
      assert(all.length >= 8 && all.length <= 12, `expected 8–12 built-ins, got ${all.length}`)
      const first = all[0]!
      assert(first.builtinVersion, 'a built-in has no version')
      await rejects(ctx.chrome.invoke('skills', 'save', { id: first.id, name: first.name, description: 'x', instructions: 'y' }), /read-only/, 'saving a built-in')
      await rejects(ctx.chrome.invoke('skills', 'remove', first.id), /Built-in/, 'deleting a built-in')
    },
  },
  {
    name: 'a skill folder with steps and supporting files',
    async run(ctx) {
      const skill = await ctx.chrome.invoke<Skill>('skills', 'save', {
        name: 'smoke-d3-skill',
        description: 'A smoke test skill.',
        instructions: 'Answer in one line.',
        steps: [
          { id: 's1', title: 'Read', instructions: 'Read the page.' },
          { id: 's2', title: 'Answer', instructions: 'Answer briefly.' },
        ],
      })
      try {
        assert(skill.steps.length === 2 && skill.steps[0]!.title === 'Read', 'steps were not kept in order')
        await ctx.chrome.invoke<SkillFile>('skills', 'writeFile', skill.id, 'notes.md', '# Notes')
        await ctx.chrome.invoke<SkillFile>('skills', 'addFile', skill.id, 'data.bin', Buffer.from([1, 2, 3]).toString('base64'))
        const files = await ctx.chrome.invoke<SkillFile[]>('skills', 'files', skill.id)
        assert(files.some((f) => f.path === 'notes.md' && f.editable), 'notes.md is missing or not editable')
        assert(files.some((f) => f.path === 'data.bin' && !f.editable), 'data.bin is missing or editable')
        assert((await ctx.chrome.invoke<string>('skills', 'readFile', skill.id, 'notes.md')) === '# Notes', 'notes.md reads back wrong')
        await rejects(ctx.chrome.invoke('skills', 'readFile', skill.id, '../skills.json.bak'), /isn’t in this skill|escapes its folder/, 'reading outside the folder')
        await rejects(ctx.chrome.invoke('skills', 'save', { name: 'smoke-d3-skill', description: 'Clash', instructions: 'x' }), /already exists/, 'a name clash')
      } finally {
        await ctx.chrome.invoke('skills', 'remove', skill.id)
      }
      const after = await ctx.chrome.invoke<Skill[]>('skills', 'list')
      assert(!after.some((s) => s.id === skill.id), 'the deleted skill is still listed')
    },
  },
  {
    name: 'schedules, cron checks and the next-run preview',
    async run(ctx) {
      assert((await ctx.chrome.invoke<{ ok: boolean }>('routines', 'validateCron', '0 9 * * 1-5')).ok, 'a good cron was refused')
      const bad = await ctx.chrome.invoke<{ ok: boolean; error?: string }>('routines', 'validateCron', '0 9 * *')
      assert(!bad.ok && /five fields/.test(bad.error ?? ''), 'a four-field cron was accepted')
      const runs = await ctx.chrome.invoke<number[]>('routines', 'previewSchedule', { kind: 'cron', expr: '30 7 * * *' }, 'Europe/Amsterdam', 5)
      assert(runs.length === 5 && runs.every((r, i) => i === 0 || r > runs[i - 1]!), 'the preview is not five rising times')
      const interval = await ctx.chrome.invoke<number[]>('routines', 'previewSchedule', { kind: 'interval', minutes: 30, between: { start: 540, end: 600 } }, null, 3)
      assert(interval.length === 3, 'the interval preview is short')
    },
  },
  {
    name: 'revision conflicts, destinations and the missing-companion state',
    async run(ctx) {
      const r = await makeRoutine(ctx, 'Smoke routine conflict')
      try {
        const saved = await ctx.chrome.invoke<Routine>('routines', 'save', { id: r.id, revision: r.revision, name: 'Smoke routine renamed', prompt: r.prompt, schedule: r.schedule, enabled: true })
        assert(saved.revision === r.revision + 1, 'the revision did not move on')
        await rejects(ctx.chrome.invoke('routines', 'save', { id: r.id, revision: r.revision, name: 'Stale', prompt: r.prompt, schedule: r.schedule, enabled: true }), /changed-elsewhere/, 'a stale save')
        await rejects(ctx.chrome.invoke('routines', 'save', { id: r.id, name: 'x', prompt: 'p', schedule: r.schedule, enabled: true, destination: { kind: 'append', chatId: '00000000-0000-4000-8000-000000000000' } }), /deleted/, 'appending to a missing chat')
        await rejects(ctx.chrome.invoke('routines', 'save', { name: 'x', prompt: 'p', schedule: r.schedule, enabled: true, companionId: 'no-such-companion' }), /companion/, 'an unknown companion')
        const paused = await ctx.chrome.invoke<Routine>('routines', 'setEnabled', r.id, false)
        assert(!paused.enabled && paused.nextRunAt === null, 'pausing kept a next run')
      } finally {
        await ctx.chrome.invoke('routines', 'remove', r.id)
      }
    },
  },
  {
    name: 'a one-off task runs now, records the run and moves to Past',
    async run(ctx) {
      const r = await makeRoutine(ctx, 'Smoke routine once', { schedule: { kind: 'once', at: Date.now() + DAY } })
      try {
        await ctx.chrome.invoke('routines', 'runNow', r.id)
        await waitFor(async () => {
          const page = await ctx.chrome.invoke<{ runs: RoutineRun[]; total: number }>('routines', 'runs', { routineId: r.id })
          return page.total === 1 && page.runs[0]!.status !== 'running'
        }, 'the run record', 20_000)
        const page = await ctx.chrome.invoke<{ runs: RoutineRun[] }>('routines', 'runs', { routineId: r.id })
        assert(page.runs[0]!.trigger === 'manual', 'Run now was not recorded as manual')
        const past = await ctx.chrome.invoke<Routine[]>('routines', 'list', { status: 'past' })
        assert(past.some((x) => x.id === r.id), 'the task did not move to Past')
        await ctx.chrome.invoke('routines', 'markRunsRead', r.id)
        const unread = await ctx.chrome.invoke<{ total: number }>('routines', 'runs', { routineId: r.id, unreadOnly: true })
        assert(unread.total === 0, 'mark all read left unread runs')
      } finally {
        await ctx.chrome.invoke('routines', 'remove', r.id)
      }
    },
  },
  {
    name: 'the starter suggestions show, and a dismissed one stays away',
    async run(ctx) {
      const list = await ctx.chrome.invoke<RoutineSuggestion[]>('routines', 'suggestions')
      assert(list.length > 0, 'no starter suggestions')
      assert(!list.some((s) => s.id.startsWith('prompt-') || s.id.startsWith('site-')), 'personal suggestions while proactive.routines is off')
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'skills-page',
    async run(ctx) {
      ctx.tabs.openInternal('apex://skills?tab=builtin')
      await ctx.chrome.until(`return document.querySelector('.sk-card')`, 8000, 'the Skills page')
      await ctx.shot('skills-page')
    },
  },
  {
    name: 'skills-editor',
    async run(ctx) {
      const [first] = await ctx.chrome.invoke<Skill[]>('skills', 'list', { source: 'builtin' })
      assert(first, 'no built-in skill')
      ctx.tabs.openInternal(`apex://skills/${first.id}`)
      await ctx.chrome.until(`return document.querySelector('.sk-editor .sk-steps')`, 8000, 'the skill editor')
      await ctx.shot('skills-editor')
    },
  },
  {
    name: 'routines-page',
    async run(ctx) {
      const r = await makeRoutine(ctx, 'Smoke routine brief')
      try {
        ctx.tabs.openInternal('apex://routines')
        await ctx.chrome.until(`return document.querySelector('.sp-item') && document.querySelector('.rt-suggest')`, 8000, 'the Routines page')
        await ctx.shot('routines-page')
        ctx.tabs.openInternal(`apex://routines/${r.id}`)
        await ctx.chrome.until(`return document.querySelector('.rt-detail .rt-facts')`, 8000, 'the routine detail page')
        await ctx.shot('routines-detail')
        ctx.tabs.openInternal(`apex://routines/${r.id}/edit`)
        await ctx.chrome.until(`return document.querySelector('.rt-editor .rt-timing')`, 8000, 'the routine editor')
        await ctx.shot('routines-editor')
        await ctx.chrome.escape()
      } finally {
        await ctx.chrome.invoke('routines', 'remove', r.id)
      }
    },
  },
]

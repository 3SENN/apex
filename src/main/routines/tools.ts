/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The routine and skill client tools (SK-06): propose_routine and draft_skill put a
// card in the chat for you to save or edit (they never save anything
// themselves, and never wait); list_routines lets the agent see what is
// already scheduled, and shows them as cards. A companion drafts skills of its
// own, or changes one it has, and read_skill reads one first.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SHARED_OWNER } from '@shared/chats'
import { NOTIFY_IF_MAX, type RoutineDraft } from '@shared/routines'
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_PATTERN, type Skill, type SkillDraft } from '@shared/skills'
import type { ClientTool, ClientToolResult } from '../agent/tools/registry'
import { skillNameFromFile } from '../skills/format'
import type { SkillStore } from '../skills/store'
import { anyScheduleSchema } from './scheduleSchema'
import { migrateSchedule, nextRunAfter, validateSchedule } from './schedule'
import type { RoutineStore } from './store'

export interface SkillRoutineToolDeps {
  routines: RoutineStore
  skills: SkillStore
  now?: () => number
}

const scheduleJson = {
  description: 'When it runs. One of: {"kind":"daily","time":"HH:MM","days":[0-6, empty for every day]}; {"kind":"interval","minutes":30-1440,"between":{"start":minuteOfDay,"end":minuteOfDay}?,"days":[...]?}; {"kind":"cron","expr":"five-field cron"}; {"kind":"once","at":epoch milliseconds}. Days: 0 is Sunday.',
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['daily', 'interval', 'cron', 'once'] },
    time: { type: 'string' },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    minutes: { type: 'integer', minimum: 30, maximum: 1440 },
    between: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'] },
    expr: { type: 'string' },
    at: { type: 'integer' },
  },
  required: ['kind'],
} as const

const proposeInput = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(10_000),
  schedule: anyScheduleSchema,
  timeZone: z.string().min(1).max(64).nullable().optional(),
  destination: z.enum(['new-chat', 'this-chat']).optional(),
  notify_if: z.string().trim().max(NOTIFY_IF_MAX).optional(),
})

const listInput = z.object({ query: z.string().max(200).optional(), status: z.enum(['active', 'paused', 'past']).optional() })

const draftInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(SKILL_DESCRIPTION_MAX * 2),
  instructions: z.string().max(50_000),
  steps: z.array(z.object({ title: z.string().max(200), instructions: z.string().max(20_000) })).max(50).optional(),
})

const readInput = z.object({
  name: z.string().min(1).max(80),
  file: z.string().min(1).max(300).optional(),
})

const ok = (content: string): ClientToolResult => ({ content })
const fail = (content: string): ClientToolResult => ({ content, isError: true })

export function skillRoutineTools(deps: SkillRoutineToolDeps): ClientTool[] {
  const now = (): number => deps.now?.() ?? Date.now()

  const propose: ClientTool<z.infer<typeof proposeInput>> = {
    name: 'propose_routine',
    group: 'routines',
    description:
      'Suggest a routine: a task the user’s companion runs on a schedule in its own background chat (no browser control). The user sees a card and decides whether to save or edit it; nothing is saved until they do. Use it when the user asks for something recurring or at a later time.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short name, such as "Morning brief".' },
        prompt: { type: 'string', description: 'What the companion should do each run, written as a message to it.' },
        schedule: scheduleJson,
        timeZone: { type: ['string', 'null'], description: 'IANA time zone; null for the user’s own.' },
        destination: { type: 'string', enum: ['new-chat', 'this-chat'], description: 'A new chat for each run (default), or add each run to this chat.' },
        notify_if: { type: 'string', description: 'Only when the user wants to hear about some runs: the condition, judged on each run’s reply, e.g. "the price is under €200". Omit to notify after every run.' },
      },
      required: ['name', 'prompt', 'schedule'],
    },
    parse: proposeInput,
    enabled: (setup) => !setup.routine,
    async run(input, ctx) {
      const timeZone = input.timeZone ?? null
      const { schedule } = migrateSchedule(input.schedule, now(), timeZone)
      try {
        validateSchedule(schedule, { now: now(), requireFuture: true, timeZone })
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'That schedule is not valid.')
      }
      const destination = input.destination === 'this-chat' && !ctx.isPrivate ? { kind: 'append' as const, chatId: ctx.chatId } : { kind: 'new-chat' as const }
      const draft: RoutineDraft = { name: input.name, prompt: input.prompt, schedule, companionId: ctx.companionId, destination, timeZone, ...(input.notify_if ? { notifyIf: input.notify_if } : {}) }
      ctx.emit({ type: 'routine-proposal', requestId: randomUUID(), draft })
      const next = nextRunAfter(schedule, now(), timeZone)
      return ok(`Shown to the user as a routine card${next ? `; if they save it, it first runs at ${new Date(next).toISOString()}` : ''}. It is not saved yet: the user saves or edits it from the card.`)
    },
  }

  const list: ClientTool<z.infer<typeof listInput>> = {
    name: 'list_routines',
    group: 'routines',
    description: 'List the user’s routines (scheduled tasks), with their schedule, next run and status. The user sees them as cards.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match in the name or instructions.' },
        status: { type: 'string', enum: ['active', 'paused', 'past'] },
      },
    },
    parse: listInput,
    enabled: () => true,
    async run(input, ctx) {
      const routines = deps.routines.query({ ...(input.query ? { query: input.query } : {}), ...(input.status ? { status: input.status } : {}), sort: 'next-run' }).slice(0, 50)
      ctx.emit({ type: 'routine-list', routineIds: routines.map((r) => r.id) })
      const rows = routines.map((r) => ({
        id: r.id,
        name: r.name,
        instructions: r.prompt.slice(0, 500),
        schedule: r.schedule,
        timeZone: r.timeZone,
        enabled: r.enabled,
        nextRun: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
        lastRun: r.lastRunAt ? { at: new Date(r.lastRunAt).toISOString(), status: r.lastStatus } : null,
        companion: r.owner,
        needsCompanion: r.needsCompanion,
      }))
      return ok(rows.length ? JSON.stringify(rows) : 'The user has no routines that match.')
    },
  }

  const draft: ClientTool<z.infer<typeof draftInput>> = {
    name: 'draft_skill',
    group: 'skills',
    description:
      'Give yourself a skill: reusable instructions that are yours alone (the user\'s other companions don\'t get it). The user runs it by typing /name, and you can follow it when a request fits. Use the name of a skill you already have to change it: read it first with read_skill, and steps you leave out stay as they are. The user sees the draft and decides whether to save it. Use it when the user asks you to remember how to do a task or to give you a skill, or after you worked out a procedure worth reusing. Steps are optional, for multi-step workflows. Never build a pack to give yourself skills: a pack\'s skills go to every companion and you can\'t change them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase letters, digits and dashes, up to 40 characters, such as "weekly-report". One of your own skills\' names changes that skill.' },
        description: { type: 'string', description: 'One or two lines on what it is for (up to 500 characters).' },
        instructions: { type: 'string', description: 'What to do, written to yourself.' },
        steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, instructions: { type: 'string' } }, required: ['title', 'instructions'] } },
      },
      required: ['name', 'description', 'instructions'],
    },
    parse: draftInput,
    enabled: (setup) => !setup.routine,
    async run(input, ctx) {
      const name = SKILL_NAME_PATTERN.test(input.name) ? input.name : skillNameFromFile(input.name)
      if (!SKILL_NAME_PATTERN.test(name)) return fail('Use a name of lowercase letters, digits and dashes.')
      // A skill of its own under this name: the draft changes it, keeping the steps the companion left out.
      const own = deps.skills.ownedBy(ctx.companionId).find((s) => s.name === name)
      const steps = input.steps ? input.steps.map((s, i) => ({ id: `step-${i + 1}`, title: s.title.trim(), instructions: s.instructions.trim() })) : (own?.steps ?? [])
      if (!input.instructions.trim() && !steps.length) return fail('A skill needs instructions.')
      const skill: SkillDraft = {
        name,
        description: input.description.trim().slice(0, SKILL_DESCRIPTION_MAX),
        instructions: input.instructions.trim(),
        steps,
        owner: ctx.companionId,
        ...(own ? { updates: own.id } : {}),
      }
      ctx.emit({ type: 'skill-draft', requestId: randomUUID(), draft: skill })
      if (own) return ok(`Shown to the user as a change to your skill /${name}. It is not saved until they confirm.`)
      const other = deps.skills.resolve(name, ctx.companionId)
      const instead = !other ? '' : other.source === 'pack' ? `the one from the pack ${other.pack?.name ?? ''}`.trim() : other.source === 'builtin' ? 'the built-in one' : 'the shared one'
      return ok(`Shown to the user as a draft of a skill of your own${instead ? `; once saved, /${name} runs yours in your chats instead of ${instead}` : ''}. It is not saved until they confirm.`)
    },
  }

  const read: ClientTool<z.infer<typeof readInput>> = {
    name: 'read_skill',
    group: 'skills',
    description:
      `Read a skill by its /name: what it is for, its instructions, its steps and the supporting files it has (pass file to read one of them). It finds your own skill first, then one shared by all companions, one from a pack, or one that comes with ${BRAND_NAME}. Read your own skill before you change it with draft_skill, and before you follow it.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill\'s name, such as "weekly-report".' },
        file: { type: 'string', description: 'A supporting file\'s path from an earlier read_skill, to read that file instead.' },
      },
      required: ['name'],
    },
    parse: readInput,
    enabled: () => true,
    async run(input, ctx) {
      const name = input.name.trim().replace(/^\//, '').toLowerCase()
      const skill = deps.skills.resolve(name, ctx.companionId)
      if (!skill) {
        const mine = deps.skills.ownedBy(ctx.companionId).map((s) => `/${s.name}`)
        return fail(`There is no skill named /${name}.${mine.length ? ` Yours: ${mine.join(', ')}.` : ' You have no skills of your own yet.'}`)
      }
      if (input.file) {
        try {
          return ok(deps.skills.readFile(skill.id, input.file))
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
      return ok(
        JSON.stringify({
          name: skill.name,
          whose: whose(skill),
          ...(skill.owner === ctx.companionId && skill.source === 'user' ? {} : { note: 'Not yours: draft_skill under this name gives you your own version instead of changing this one.' }),
          description: skill.description,
          instructions: skill.instructions,
          steps: skill.steps.map(({ title, instructions }) => ({ title, instructions })),
          files: skill.files.map((f) => f.path),
        }),
      )
    },
  }

  /** Whose a skill is, as the companion reads it. */
  function whose(skill: Skill): string {
    if (skill.source === 'builtin') return 'built-in'
    if (skill.source === 'pack') return `from the pack ${skill.pack?.name ?? ''}`.trim()
    return skill.owner === SHARED_OWNER ? 'shared' : 'yours'
  }

  return [propose, list, draft, read]
}

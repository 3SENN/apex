/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { OWN_SERVER_PLACEHOLDER, PROVIDER_DEFAULTS, isPreset, type DecisionPresetId, type DecisionRequest } from '../src/shared/decisions'
import { endpointFor, requestDecision, type FetchLike } from '../src/main/decisions/client'
import { setDecider, type DecideCall, type Decider } from '../src/main/decisions/service'
import { clickKind, dictationOnly, messageEffort, needsYou, rankSkills, searchOrAsk, tabPlace, voiceForCompanion, worthRemembering, type TabPlace } from '../src/main/decisions/uses'
import { labelItems, type ItemAnswer } from '../src/main/decisions/tool'
import { asksForInput } from '../src/main/agent/session'
import { guardAction } from '../src/main/agent/guard'
import type { Effort, ElementDescription } from '../src/shared/ipc'

// Measuring Atelier's own decisions against a real decision model
// (docs/decisions.md › Measuring). Skipped unless you point it at one:
//
//   ATELIER_DECISIONS_EVAL=typesafe ATELIER_DECISIONS_KEY=… npx vitest run tests/decisionsEval.test.ts --silent=false
//   ATELIER_DECISIONS_EVAL=experiential ATELIER_DECISIONS_KEY=xpl_… ATELIER_DECISIONS_MODEL=clef npx vitest run tests/decisionsEval.test.ts --silent=false
//   ATELIER_DECISIONS_EVAL=custom ATELIER_DECISIONS_URL=http://127.0.0.1:8009 npx vitest run tests/decisionsEval.test.ts --silent=false
//
// (ATELIER_DECISIONS_EVAL is any provider in PROVIDER_DEFAULTS;
// ATELIER_DECISIONS_MODEL overrides its default model; ATELIER_DECISIONS_PACE_MS
// spaces the requests out for a plan with a per-minute limit, such as 6500
// for 10 a minute.) Each labelled case in
// fixtures/decisions-eval.json goes through the same question Atelier asks and
// the same cutoffs Atelier applies. Per decision it reports accuracy on the
// cases the model was sure of, how often it stayed unsure (Atelier's rule then
// decides), and whether a choice changes when its options are listed in the
// reverse order. Next to that it shows what the person would get: Atelier's
// rule alone, and the rule with the model taking over where it is sure. It
// fails when a decision is right on fewer than 80% of the cases it was sure
// of, or flips with the order. The labeling cases run the companion's
// label_items tool the same way, and the skills cases rank one companion's
// skills against each first message.

// Any provider in the table, or 'custom' for your own server at ATELIER_DECISIONS_URL.
const provider = process.env.ATELIER_DECISIONS_EVAL as DecisionPresetId | 'custom' | undefined
const enabled = provider !== undefined && (provider === 'custom' || isPreset(provider))

const cases = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'decisions-eval.json'), 'utf8')) as {
  needsYou: Array<{ reply: string; expect: boolean }>
  dictation: Array<{ spoken: string; field: string; expect: boolean }>
  agentClicks: Array<{
    name: string
    role: string
    page: string
    url: string
    expect: string | null
  }>
  searchOrAsk: Array<{ text: string; expect: 'search' | 'ask' }>
  voiceTarget: Array<{
    spoken: string
    field: string
    value: string
    expect: boolean
  }>
  labeling: {
    context: string
    questions: Record<string, DecisionRequest['questions'][string]>
    items: Array<{ text: string; expect: Record<string, string> }>
  }
  effort: Array<{ previous: string; message: string; expect: Effort }>
  memory: Array<{ transcript: string; expect: boolean }>
  tabs: Array<{
    title: string
    url: string
    groups: string[]
    expect: TabPlace
  }>
  skills: {
    skills: Array<{ name: string; description: string }>
    messages: Array<{ message: string; expect: string | null }>
  }
}

const MIN_ACCURACY = 0.8

const endpoint = enabled
  ? provider === 'custom'
    ? endpointFor(process.env.ATELIER_DECISIONS_URL ?? OWN_SERVER_PLACEHOLDER, process.env.ATELIER_DECISIONS_KEY ?? null, process.env.ATELIER_DECISIONS_MODEL ?? 'kev-latest')
    : endpointFor(PROVIDER_DEFAULTS[provider!].url, process.env.ATELIER_DECISIONS_KEY ?? null, process.env.ATELIER_DECISIONS_MODEL ?? PROVIDER_DEFAULTS[provider!].suggested, PROVIDER_DEFAULTS[provider!].dialect)
  : null
const fetchImpl: FetchLike = async (url, init) => {
  const res = await fetch(url, init)
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  }
}

const paceMs = Number(process.env.ATELIER_DECISIONS_PACE_MS) || 0
let nextAt = 0
/** Waits for the next request slot when the run is paced. */
async function slot(): Promise<void> {
  const wait = nextAt - Date.now()
  nextAt = Math.max(nextAt, Date.now()) + paceMs
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}
/** Room for a decision's cases at two requests each, plus the pacing. */
const timeoutFor = (n: number): number => 120_000 + n * 2 * paceMs

/** The order-flipped copy of a request: every choice's options listed last to first. */
function reversed(request: DecisionRequest): DecisionRequest {
  return {
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([k, q]) => [
        k,
        q.type === 'choice'
          ? {
              ...q,
              criteria: Object.fromEntries(Object.entries(q.criteria).reverse()),
            }
          : q,
      ]),
    ),
  }
}

interface Outcome {
  verdict: unknown
  flipped: boolean
  ms: number
}

/** A decider that sends each question to the real model (and again reversed) and returns Atelier's reading of the answer. */
function liveDecider(record: (o: Outcome) => void): Decider {
  return {
    active: () => true,
    ready: () => true,
    paused: () => false,
    ask: () => Promise.reject(new Error('not used')),
    async model(_caller, request) {
      await slot()
      return requestDecision(fetchImpl, endpoint!, request, {
        timeoutMs: 15_000,
      })
    },
    async decide<T>(call: DecideCall<T>): Promise<T> {
      const rule = await call.rule
      const request = call.request()
      await slot()
      const a = await requestDecision(fetchImpl, endpoint!, request, {
        timeoutMs: 15_000,
      })
      await slot()
      const b = await requestDecision(fetchImpl, endpoint!, reversed(request), {
        timeoutMs: 15_000,
      })
      const verdict = call.read(a, rule)
      const flippedVerdict = call.read(b, rule)
      record({
        verdict,
        flipped: verdict !== null && flippedVerdict !== null && JSON.stringify(verdict) !== JSON.stringify(flippedVerdict),
        ms: a.ms,
      })
      return verdict ?? rule
    },
  }
}

afterAll(() => setDecider(null))

/** The time below which `share` of the calls answered, in ms. */
function percentile(ms: number[], share: number): number {
  const sorted = [...ms].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

interface Measure<C> {
  run(c: C): Promise<unknown>
  expected(c: C): unknown
  /** What Atelier's rule decides on its own. */
  rule(c: C): unknown
  /** What the person gets: the model's verdict where it is sure, otherwise the rule (default). */
  combine?(verdict: unknown, rule: unknown): unknown
  /** Whether a final answer is right (default: equal to the expected one). */
  right?(answer: unknown, c: C): boolean
}

async function measure<C>(name: string, list: C[], m: Measure<C>): Promise<void> {
  let sure = 0
  let right = 0
  let ruleRight = 0
  let finalRight = 0
  let flips = 0
  const wrong: string[] = []
  const ms: number[] = []
  for (const c of list) {
    let outcome: Outcome = { verdict: null, flipped: false, ms: 0 }
    setDecider(liveDecider((o) => (outcome = o)))
    await m.run(c)
    ms.push(outcome.ms)
    const isRight = (answer: unknown): boolean => (m.right ? m.right(answer, c) : same(answer, m.expected(c)))
    const rule = m.rule(c)
    if (isRight(rule)) ruleRight++
    if (isRight(m.combine ? m.combine(outcome.verdict, rule) : (outcome.verdict ?? rule))) finalRight++
    if (outcome.flipped) flips++
    if (outcome.verdict === null) continue
    sure++
    if (same(outcome.verdict, m.expected(c))) right++
    else wrong.push(`${JSON.stringify(c).slice(0, 90)} → ${JSON.stringify(outcome.verdict)}`)
  }
  const accuracy = sure ? right / sure : 1
  // Logged from inside the test: vitest drops output from a file-level afterAll.
  console.log(
    `${endpoint?.model} (${provider}) ${name}: rule alone ${ruleRight}/${list.length}, with the model ${finalRight}/${list.length}; ${right}/${sure} right when sure (${Math.round(accuracy * 100)}%), unsure on ${list.length - sure}, ${flips} flipped with the order, ${percentile(ms, 0.5)} ms median and ${percentile(ms, 0.9)} ms at the 90th percentile${wrong.length ? `\n  wrong: ${wrong.join('\n  wrong: ')}` : ''}`,
  )
  expect(flips, `${name} changed its answer when the options were reversed`).toBe(0)
  expect(accuracy, `${name}: ${wrong.join('; ')}`).toBeGreaterThanOrEqual(MIN_ACCURACY)
}

/** The guard's English keyword list on its own: the kind of stop it makes, or null. */
const keywordStop = (c: (typeof cases.agentClicks)[number]): string | null =>
  guardAction({
    kind: 'click',
    element: { role: c.role, name: c.name } as ElementDescription,
  })?.action ?? null

describe.skipIf(!enabled)('quick decisions against a real decision model', () => {
  // The rule's own value goes in, as in Atelier; each read ignores it, so the verdict is the model's alone.
  it(
    'needsYou',
    () =>
      measure('needsYou', cases.needsYou, {
        run: (c) => needsYou(c.reply, asksForInput(c.reply), false),
        expected: (c) => c.expect,
        rule: (c) => asksForInput(c.reply),
      }),
    timeoutFor(cases.needsYou.length),
  )
  // dictationOnly, voiceForCompanion and clickKind only ever answer one way (a sure "no" keeps the rule), so a wrong answer is a yes where the label says no.
  it(
    'dictation',
    () =>
      measure('dictation', cases.dictation, {
        run: (c) => dictationOnly(c.spoken, c.field, false),
        expected: (c) => c.expect,
        rule: () => false,
      }),
    timeoutFor(cases.dictation.length),
  )
  // A stop is right when one is needed, whatever its kind; the keyword list goes first and the model is only asked when it found nothing.
  it(
    'agentClicks',
    () =>
      measure('agentClicks', cases.agentClicks, {
        run: (c) => clickKind(c, false),
        expected: (c) => c.expect,
        rule: keywordStop,
        combine: (verdict, rule) => rule ?? verdict,
        right: (answer, c) => (answer !== null) === (c.expect !== null),
      }),
    timeoutFor(cases.agentClicks.length),
  )
  // The new tab's composer starts in companion mode (newTabMode), so its rule is "ask".
  it(
    'searchOrAsk',
    () =>
      measure('searchOrAsk', cases.searchOrAsk, {
        run: (c) => searchOrAsk(c.text, 'ask'),
        expected: (c) => c.expect,
        rule: () => 'ask',
      }),
    timeoutFor(cases.searchOrAsk.length),
  )
  it(
    'voiceTarget',
    () =>
      measure('voiceTarget', cases.voiceTarget, {
        run: (c) => voiceForCompanion(c.spoken, { label: c.field, value: c.value }, false),
        expected: (c) => c.expect,
        rule: () => false,
      }),
    timeoutFor(cases.voiceTarget.length),
  )

  // The chat's effort is the default "high": "low" for a quick message, one step up ("xhigh") for hard work.
  it(
    'effort',
    () =>
      measure('effort', cases.effort, {
        run: (c) => messageEffort(c.message, c.previous, 'high', false),
        expected: (c) => c.expect,
        rule: () => 'high',
      }),
    timeoutFor(cases.effort.length),
  )
  // A chat is only left out of the memory jobs on a sure "nothing lasting"; the rule reads every chat.
  it(
    'memory',
    () =>
      measure('memory', cases.memory, {
        run: (c) => worthRemembering(c.transcript),
        expected: (c) => c.expect,
        rule: () => true,
      }),
    timeoutFor(cases.memory.length),
  )
  // The rule groups by site, which names no topic or group, so "rule alone" counts none right here.
  it(
    'tabs',
    () =>
      measure('tabs', cases.tabs, {
        run: (c) => tabPlace({ title: c.title, url: c.url }, c.groups, false),
        expected: (c) => c.expect,
        rule: () => null,
      }),
    timeoutFor(cases.tabs.length),
  )

  // Right when the skill that fits is the only one marked (none for a message no skill fits); the rule marks none.
  it(
    'skills',
    async () => {
      const { skills, messages } = cases.skills
      let sure = 0
      let right = 0
      let ruleRight = 0
      let finalRight = 0
      const wrong: string[] = []
      const ms: number[] = []
      for (const c of messages) {
        let outcome: Outcome = { verdict: null, flipped: false, ms: 0 }
        setDecider(liveDecider((o) => (outcome = o)))
        const ranked = await rankSkills(c.message, skills, false)
        ms.push(outcome.ms)
        const fits = ranked.filter((s) => s.fits === true).map((s) => s.name)
        if (c.expect === null) ruleRight++
        if ((fits[0] ?? null) === c.expect) finalRight++
        if (fits.length === 0 && !ranked.every((s) => s.fits === false)) continue
        sure++
        if ((fits[0] ?? null) === c.expect && fits.length === (c.expect ? 1 : 0)) right++
        else wrong.push(`${c.message.slice(0, 60)} → ${fits.join(', ') || 'none'}`)
      }
      console.log(
        `${endpoint?.model} (${provider}) skills: rule alone ${ruleRight}/${messages.length}, with the model ${finalRight}/${messages.length}; ${right}/${sure} right when sure, unsure on ${messages.length - sure}, ${percentile(ms, 0.5)} ms median and ${percentile(ms, 0.9)} ms at the 90th percentile${wrong.length ? `\n  wrong: ${wrong.join('\n  wrong: ')}` : ''}`,
      )
      expect(sure ? right / sure : 1, wrong.join('; ')).toBeGreaterThanOrEqual(MIN_ACCURACY)
    },
    timeoutFor(cases.skills.messages.length),
  )

  it(
    'labeling (the companion’s label_items)',
    async () => {
      const { context, questions, items } = cases.labeling
      setDecider(liveDecider(() => undefined))
      const started = Date.now()
      const out = await labelItems({ context, questions, items: items.map((i) => ({ text: i.text })) }, new AbortController().signal)
      const ms = Date.now() - started
      const rows = (
        JSON.parse(out.content) as {
          items: Array<{
            answers?: Record<string, ItemAnswer>
            error?: string
          }>
        }
      ).items
      const lines: string[] = []
      let sure = 0
      let right = 0
      const wrong: string[] = []
      for (const key of Object.keys(questions)) {
        let s = 0
        let r = 0
        rows.forEach((row, i) => {
          const a = row.answers?.[key]
          if (!a || a.answer === 'unsure') return
          s++
          if (a.answer === items[i]!.expect[key]) r++
          else wrong.push(`${items[i]!.text.slice(0, 60)} → ${key}: ${a.answer}`)
        })
        lines.push(`${key} ${r}/${s} right when sure, unsure on ${items.length - s}`)
        sure += s
        right += r
      }
      console.log(`${endpoint?.model} (${provider}) labeling ${items.length} emails in ${ms} ms: ${lines.join('; ')}${wrong.length ? `\n  wrong: ${wrong.join('\n  wrong: ')}` : ''}`)
      expect(rows.filter((r) => r.error)).toEqual([])
      expect(sure ? right / sure : 1, wrong.join('; ')).toBeGreaterThanOrEqual(MIN_ACCURACY)
    },
    timeoutFor(cases.labeling.items.length * 2),
  )
})

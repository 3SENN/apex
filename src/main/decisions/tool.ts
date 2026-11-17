/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// label_items (DC-13, docs/decisions.md › Your companion): the companion
// hands judgment calls over many items (labeling, sorting, filtering,
// checking emails, products, search results, rows) to the decision model:
// one System One request per item, a few at a time, read with the same
// cutoffs as Apex's own decisions, and "unsure" where the model is not sure,
// for the companion to look at itself. Offered only while a decision model is
// set up and "Labeling and sorting" is on, never in a private chat. There is
// no Claude fallback: the companion is the Claude engine and judges the items
// itself when the model is off, paused by a rate limit or unreachable.
import { z } from 'zod'
import { DECISION_LIMITS, DECISION_QUESTION_SCHEMA, sureChoice, sureLevel, yesNo, type DecisionAnswer, type DecisionQuestion, type DecisionResult } from '@shared/decisions'
import { CLIENT_TOOL_RESULT_MAX, clientTool, registerClientTool, type ClientTool, type ClientToolResult } from '../agent/tools/registry'
import { DecisionError } from './client'
import { decider } from './service'

export const LABEL_ITEMS_MAX = 50
export const LABEL_QUESTIONS_MAX = 5
const ITEM_CHARS = 4_000
const CONTEXT_CHARS = 500
/** Requests in flight at once: fast enough for 50 items, gentle on a provider's per-minute limit. */
const AT_ONCE = 4

const questionKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)

const input = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100).optional(),
            text: z.string().trim().min(1).max(ITEM_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(LABEL_ITEMS_MAX),
    questions: z.record(questionKey, DECISION_QUESTION_SCHEMA).refine(
      (q) => {
        const n = Object.keys(q).length
        return n >= 1 && n <= LABEL_QUESTIONS_MAX
      },
      { message: `Ask 1 to ${LABEL_QUESTIONS_MAX} questions.` },
    ),
    context: z.string().trim().max(CONTEXT_CHARS).optional(),
  })
  .strict()

type Input = z.infer<typeof input>

/** One question's answer for one item, as the companion reads it. */
export type ItemAnswer = { answer: string; p: number; leaning?: string }

/** The model's answer in plain words: the verdict when it is sure, otherwise "unsure" and what it leaned towards. */
export function readAnswer(question: DecisionQuestion, answer: DecisionAnswer | undefined): ItemAnswer {
  if (!answer) return { answer: 'unsure', p: 0 }
  const round = (n: number): number => Math.round(n * 100) / 100
  if (answer.type === 'noul') {
    const verdict = yesNo(answer)
    return {
      answer: verdict === null ? 'unsure' : verdict ? 'yes' : 'no',
      p: round(answer.noul),
    }
  }
  if (answer.type === 'choice') {
    const p = round(answer.probabilities[answer.choice] ?? answer.confidence)
    return sureChoice(answer) === null ? { answer: 'unsure', p, leaning: answer.choice } : { answer: answer.choice, p }
  }
  const levels = question.type === 'score' ? question.criteria : []
  const level = sureLevel(answer)
  const likeliest = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0]
  const text = (i: number): string => levels[i] ?? String(i)
  if (level === null)
    return {
      answer: 'unsure',
      p: round(likeliest?.[1] ?? 0),
      ...(likeliest ? { leaning: text(Number(likeliest[0])) } : {}),
    }
  return {
    answer: text(level),
    p: round(answer.probabilities[String(level)] ?? 0),
  }
}

const NOT_ANSWERED: Partial<Record<DecisionError['code'], string>> = {
  'rate-limited': 'the provider’s rate limit was reached',
  timeout: 'no answer in time',
  unauthorized: 'the provider refused the key',
  offline: 'the provider couldn’t be reached',
  overloaded: 'the provider was busy',
  'no-key': 'no decision model is set up',
}

export async function labelItems(args: Input, signal: AbortSignal): Promise<ClientToolResult> {
  const items = args.items.map((item, i) => ({
    id: item.id ?? String(i + 1),
    text: item.text,
  }))
  const rows: Array<{
    id: string
    answers?: Record<string, ItemAnswer>
    error?: string
  }> = items.map((item) => ({ id: item.id }))
  let model = ''
  let stop: string | null = null
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop && !signal.aborted) {
      const index = next++
      const item = items[index]!
      try {
        const result: DecisionResult = await decider().model(
          'labeling',
          {
            state: args.context ? { context: args.context, item: item.text } : item.text,
            questions: args.questions,
          },
          { signal },
        )
        model = result.model
        rows[index]!.answers = Object.fromEntries(Object.entries(args.questions).map(([key, q]) => [key, readAnswer(q, result.answers[key])]))
      } catch (err) {
        if (signal.aborted) return
        const code = err instanceof DecisionError ? err.code : 'failed'
        rows[index]!.error = NOT_ANSWERED[code] ?? 'the decision model failed'
        // These hold for every item, so the rest are not sent.
        if (code === 'rate-limited' || code === 'unauthorized' || code === 'no-key' || code === 'offline') stop = rows[index]!.error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker))
  signal.throwIfAborted()
  for (const row of rows) if (!row.answers && !row.error) row.error = stop ?? 'not sent'
  const unsure = rows.filter((r) => r.answers && Object.values(r.answers).some((a) => a.answer === 'unsure')).length
  const failed = rows.filter((r) => r.error).length
  if (failed === rows.length) {
    return {
      content: `The decision model didn’t answer (${rows[0]?.error ?? 'it failed'}). Judge these items yourself.`,
      isError: true,
    }
  }
  const note = [
    unsure ? `${unsure} item(s) have an “unsure” answer: the model was not sure enough, so judge those yourself (“leaning” is its best guess).` : '',
    failed ? `${failed} item(s) were not answered (see “error”): judge those yourself.` : '',
    'p is the probability of “yes” for a yes-or-no question, and of the answer given otherwise.',
  ]
    .filter(Boolean)
    .join(' ')
  let out = JSON.stringify({ model, items: rows, note })
  if (out.length > CLIENT_TOOL_RESULT_MAX)
    out = JSON.stringify({
      model,
      items: rows.map((r) => ({
        id: r.id,
        ...(r.answers
          ? {
              answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.answer])),
            }
          : { error: r.error }),
      })),
      note,
    })
  return { content: out }
}

export const labelItemsTool: ClientTool<Input> = {
  name: 'label_items',
  group: 'chat',
  description:
    'Answer the same short judgment questions about many items at once with the person’s decision model: yes or no, one of a set of options, or a level on a scale. ' +
    'Use it to label, sort, filter or check several items you have read (emails, products, search results, table rows, tabs, comments): it is much faster and cheaper than judging them one by one yourself, and its probabilities are calibrated. ' +
    'Each item is judged on its own text (plus the optional context); the model sees nothing else, does no research and writes no text. ' +
    'Answers it is not sure of come back as “unsure” for you to judge yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: LABEL_ITEMS_MAX,
        description: 'The items to judge, each with all the text the questions need.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Your name for the item (default: its position, from 1).',
            },
            text: { type: 'string', maxLength: ITEM_CHARS },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      questions: {
        type: 'object',
        description: `1 to ${LABEL_QUESTIONS_MAX} questions asked about every item, keyed by a short name (a letter, then letters, digits or _).`,
        additionalProperties: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['noul', 'choice', 'score'],
              description: 'noul: yes or no. choice: exactly one of the options. score: a level on an ordered scale.',
            },
            instructions: {
              type: 'string',
              maxLength: DECISION_LIMITS.instructionChars,
              description: 'The question, about one item. Say what counts.',
            },
            criteria: {
              description:
                `choice: an object of 2 to ${DECISION_LIMITS.choices} options, {"option_key": "what it means"} (a description may be null). ` +
                `score: an array of 2 to ${DECISION_LIMITS.levels} level descriptions, lowest first. noul: optional {"true": "…", "false": "…"}.`,
            },
          },
          required: ['type', 'instructions'],
        },
      },
      context: {
        type: 'string',
        maxLength: CONTEXT_CHARS,
        description: 'What the items are, shared by all of them (“emails in Sam’s work inbox”).',
      },
    },
    required: ['items', 'questions'],
    additionalProperties: false,
  },
  parse: input,
  enabled: (setup) => !setup.private && decider().active('labeling'),
  async run(args, ctx) {
    if (ctx.isPrivate)
      return {
        content: 'Nothing is sent to the decision model from a private chat. Judge these items yourself.',
        isError: true,
      }
    if (!decider().active('labeling'))
      return {
        content: 'The decision model is off or not set up right now. Judge these items yourself.',
        isError: true,
      }
    return labelItems(args, ctx.signal)
  },
}

/** Registers label_items once (the registry refuses a second registration). */
export function registerLabelItems(): void {
  if (!clientTool(labelItemsTool.name)) registerClientTool(labelItemsTool)
}

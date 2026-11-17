/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { LogItem } from '../src/renderer/src/agentLog'
import { closingAsk, liftClosingQuestion } from '../src/renderer/src/chat/logic/askBlock'
import { markdownText, parseMarkdown } from '../src/renderer/src/chat/logic/markdown'

// DS-63: a reply's closing question moves into its own block, so it shows once.

const lift = (md: string) => {
  const out = liftClosingQuestion(parseMarkdown(md))
  return out && { question: out.question, detail: out.detail, text: markdownText(out.blocks) }
}

describe('liftClosingQuestion (DS-63)', () => {
  it('moves a lone closing question out of the text', () => {
    expect(lift('Here are three options.\n\nWhich one suits you best?')).toEqual({ question: 'Which one suits you best?', detail: null, text: 'Here are three options.' })
  })

  it('turns a short lead-in into the description when other text stays', () => {
    expect(lift('I compared both.\n\nThe 9:40 is cheaper. Should I book it?')).toEqual({ question: 'Should I book it?', detail: 'The 9:40 is cheaper.', text: 'I compared both.' })
  })

  it('keeps the lead-in in the text when the paragraph is the whole reply', () => {
    expect(lift('I found it. Should I book the 9:40 train?')).toEqual({ question: 'Should I book the 9:40 train?', detail: null, text: 'I found it.' })
  })

  it('keeps a lead-in with a link in the text, with its formatting', () => {
    const out = liftClosingQuestion(parseMarkdown('Intro.\n\nSee [the page](https://example.com) **now**. Want more?'))
    expect(out?.detail).toBeNull()
    expect(out && markdownText(out.blocks)).toBe('Intro.\n\nSee the page now.')
    expect(JSON.stringify(out?.blocks)).toContain('"kind":"link"')
  })

  it('cuts a question from inside formatting', () => {
    expect(lift('Done.\n\n**Shall I go on?**')).toEqual({ question: 'Shall I go on?', detail: null, text: 'Done.' })
  })

  it('cuts the question from a list’s last item', () => {
    expect(lift('- One\n- Two\n- Shall I go on?')).toEqual({ question: 'Shall I go on?', detail: null, text: 'One\nTwo' })
  })

  it('leaves statements, code and long questions alone', () => {
    expect(lift('All done.')).toBeNull()
    expect(lift('```\nwhy?\n```')).toBeNull()
    expect(lift(`${'x'.repeat(300)}?`)).toBeNull()
  })
})

describe('closingAsk (DS-63)', () => {
  const items: LogItem[] = [
    { kind: 'assistant', id: 'a', text: 'Looked it up.\n\nWant the cheaper one?', thinking: '' },
    { kind: 'suggestions', id: 's', turnId: 'a', heading: null, items: ['Yes'] } as LogItem,
  ]

  it('names the item the question came from, with next steps still allowed', () => {
    const ask = closingAsk({ last: true, running: false, items })
    expect(ask?.itemId).toBe('a')
    expect(ask?.question).toBe('Want the cheaper one?')
  })

  it('shows nothing on an older or running reply', () => {
    expect(closingAsk({ last: false, running: false, items })).toBeNull()
    expect(closingAsk({ last: true, running: true, items })).toBeNull()
  })
})

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIRST_WEEK_GUIDES } from '@shared/firstWeek'
import { guideTitle, inlineText, parseGuide, parseInline } from '@shared/guideMarkdown'
import { NL } from '@shared/i18n/nl'

describe('guide Markdown', () => {
  it('parses headings, paragraphs, lists and tips', () => {
    const blocks = parseGuide(['# Title', '', 'One line', 'joined.', '', '## Steps', '1. First', '2. Second', '   continued', '', '- a', '- b', '', '> Tip: hello'].join('\n'))
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'tip'])
    expect(guideTitle(blocks)).toBe('Title')
    const [, paragraph, , ordered, bullets] = blocks
    expect(paragraph?.type === 'paragraph' && inlineText(paragraph.children)).toBe('One line joined.')
    expect(ordered?.type === 'list' && ordered.ordered && ordered.items.map(inlineText)).toEqual(['First', 'Second continued'])
    expect(bullets?.type === 'list' && !bullets.ordered && bullets.items.length).toBe(2)
  })

  it('parses inline marks', () => {
    expect(parseInline('Press `⌘J` and **go** *now*')).toEqual([
      { type: 'text', text: 'Press ' },
      { type: 'code', text: '⌘J' },
      { type: 'text', text: ' and ' },
      { type: 'strong', children: [{ type: 'text', text: 'go' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'now' }] },
    ])
    // Unclosed marks stay as text.
    expect(inlineText(parseInline('a * b ** c `d'))).toBe('a * b ** c `d')
  })

  it('links only to Apex pages', () => {
    expect(parseInline('[All chats](apex://chats)')).toEqual([{ type: 'link', href: 'apex://chats', children: [{ type: 'text', text: 'All chats' }] }])
    const evil = parseInline('[evil](javascript:alert(1))')
    expect(evil.some((n) => n.type === 'link')).toBe(false)
    expect(inlineText(evil)).not.toContain('javascript')
    expect(parseInline('[site](https://example.com)')).toEqual([{ type: 'text', text: 'site' }])
  })

  it('ships every guide, each titled as listed and linking only to real Apex pages', () => {
    for (const guide of FIRST_WEEK_GUIDES) {
      const source = readFileSync(join(__dirname, '../src/renderer/src/first-week/guides', `${guide.id}.md`), 'utf8')
      const blocks = parseGuide(source)
      expect(guideTitle(blocks)).toBe(guide.title)
      expect(blocks.length).toBeGreaterThan(5)
      const words = source.split(/\s+/).length
      // Short guides: roughly the minutes on the badge at a relaxed reading pace.
      expect(words).toBeLessThan(guide.minutes * 200)
      const links = [...source.matchAll(/\]\((apex:\/\/[^)]+)\)/g)].map((m) => m[1])
      for (const href of links) expect(href).toMatch(/^apex:\/\/(chats|skills|routines|connectors|settings\/memory)$/)
    }
  })

  it('ships every guide in Dutch too, titled as the Dutch catalogue says and linking to the same pages', () => {
    for (const guide of FIRST_WEEK_GUIDES) {
      const english = readFileSync(join(__dirname, '../src/renderer/src/first-week/guides', `${guide.id}.md`), 'utf8')
      const source = readFileSync(join(__dirname, '../src/renderer/src/first-week/guides/nl', `${guide.id}.md`), 'utf8')
      const blocks = parseGuide(source)
      const key = `firstRun.weekGuide.${guide.id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}.title` as keyof typeof NL & string
      expect(guideTitle(blocks)).toBe(NL[key])
      expect(blocks.length).toBe(parseGuide(english).length)
      expect(source.split(/\s+/).length).toBeLessThan(guide.minutes * 200)
      const links = (text: string): string[] => [...text.matchAll(/\]\((apex:\/\/[^)]+)\)/g)].map((m) => m[1] ?? '')
      expect(links(source)).toEqual(links(english))
    }
  })
})

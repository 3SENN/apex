/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SpeechSessionEvent } from '../src/shared/speech'
import { BilingualMerger, SETTLE_MS, score, wins, type Heard } from '../src/main/speech/bilingual'
import { secondLocale } from '../src/shared/speech'

// Real output of the speech helper on this Mac, heard once in English (first) and once in Dutch:
// - mixed: two Dutch sentences, English, then Dutch again (macOS voices Xander and Samantha);
// - one speaker: the Dutch voice Xander switching to English between and inside sentences;
// - mid-sentence: one sentence that goes Dutch, English, Dutch (Xander, Samantha, Xander).
const fixture = (name: string): SpeechSessionEvent[] => readFileSync(`tests/fixtures/speech/${name}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SpeechSessionEvent)
const REAL = fixture('mixed-bilingual')
const merged = (events: SpeechSessionEvent[]): SpeechSessionEvent[] => {
  const merger = new BilingualMerger('en-US', 'nl-NL', { settleMs: null })
  return events.flatMap((e, i) => merger.push(e, i * 100))
}
const languages = (events: SpeechSessionEvent[]): string[] => events.flatMap((e) => (e.type === 'final' ? [(e as { locale?: string }).locale ?? '?'] : []))
const texts = (events: SpeechSessionEvent[]): string[] => events.flatMap((e) => (e.type === 'final' ? [e.text] : []))

const heard = (locale: string, startMs: number, endMs: number, fit: number, text = locale): Heard => ({ source: 'mic', locale, text, startMs, endMs, fit })

describe('the second language', () => {
  const items = [
    { id: 'en-GB', name: 'English (UK)', onDevice: true },
    { id: 'en-US', name: 'English (US)', onDevice: true },
    { id: 'nl-NL', name: 'Dutch (Netherlands)', onDevice: true },
    { id: 'de-DE', name: 'German (Germany)', onDevice: false },
  ]
  it('Automatic takes the Mac’s next language in another language, as this Mac offers it', () => {
    expect(secondLocale(null, 'en-GB', { items, preferred: ['en-NL', 'nl-NL'] })?.id).toBe('nl-NL')
    expect(secondLocale(null, 'en-GB', { items, preferred: ['en-US', 'nl'] })?.id).toBe('nl-NL')
    expect(secondLocale(null, 'en-GB', { items, preferred: ['en-NL'] })).toBeNull()
    expect(secondLocale(null, 'nl-NL', { items, preferred: ['nl-NL', 'en-NL'] })?.id).toBe('en-GB')
  })
  it('a chosen one is used when it is another language; One language only turns it off', () => {
    expect(secondLocale('de-DE', 'en-GB', { items, preferred: ['nl-NL'] })?.id).toBe('de-DE')
    expect(secondLocale('en-US', 'en-GB', { items })).toBeNull()
    expect(secondLocale('none', 'en-GB', { items, preferred: ['nl-NL'] })).toBeNull()
    expect(secondLocale('fr-FR', 'en-GB', { items })).toBeNull()
  })
})

describe('bilingual meetings: the language that fits each stretch', () => {
  it('keeps the Dutch and the English of a real mixed recording, in order, and drops the garble', () => {
    const merger = new BilingualMerger('en-US', 'nl-NL', { settleMs: null })
    const out = REAL.flatMap((e, i) => merger.push(e, i * 100))
    expect(texts(out)).toEqual([
      'Goedemorgen allemaal, vandaag bespreken we de planning voor het nieuwe kwartaal.',
      'Jan neemt de marketing op zich en Sanne werk aan de nieuwe website.',
      'Thanks, everyone.',
      "Let's move on to the budget.",
      'We need to finalize the numbers before Friday.',
      'Oké, dan spreken we af dat we volgende week dinsdag weer samen komen',
    ])
    expect(out.at(-1)?.type).toBe('stopped')
    expect(out.filter((e) => e.type === 'final').map((e) => (e as { locale?: string }).locale)).toEqual(['nl-NL', 'nl-NL', 'en-US', 'en-US', 'en-US', 'nl-NL'])
  })

  it('switches within a sentence when the speaker does: Dutch, English, Dutch', () => {
    const out = merged(fixture('mid-sentence-switch'))
    expect(texts(out)).toEqual(['We moeten de presentatie voor vrijdag afmaken', "So let's focus on the slides first.", 'En daarna kijken we naar de cijfers'])
    expect(languages(out)).toEqual(['nl-NL', 'en-US', 'nl-NL'])
  })

  it('one Dutch speaker mixing in English keeps the Dutch reading, never the English recognizer’s fluent-looking guesses', () => {
    const out = merged(fixture('one-speaker-switching'))
    expect(languages(out)).toEqual(['nl-NL', 'nl-NL', 'nl-NL', 'nl-NL'])
    expect(texts(out).join(' ')).toContain('We moeten de presentatie voor vrijdag afmaken')
    expect(texts(out).join(' ')).not.toMatch(/demortion|presentatzi|soupsheet/)
  })

  it('weighs a line by its recognizer’s confidence, nudged by its fit', () => {
    // The English recognizer on Dutch speech: fluent-looking English (fit 0.99) it was unsure of.
    expect(score({ fit: 0.99, confidence: 0.44 })).toBeLessThan(score({ fit: 0.83, confidence: 0.6 }))
    expect(score({ fit: 0.7 })).toBe(0.7)
  })

  it('a final wins when it fits better over at least half of its time; a tie goes to the first language', () => {
    expect(wins(heard('en', 0, 1000, 0.6), [heard('nl', 0, 1000, 0.9)], 'en')).toBe(false)
    expect(wins(heard('en', 0, 1000, 0.6), [heard('nl', 0, 400, 0.9)], 'en')).toBe(true)
    expect(wins(heard('en', 0, 1000, 0.8), [heard('nl', 0, 1000, 0.82)], 'en')).toBe(true)
    expect(wins(heard('nl', 0, 1000, 0.82), [heard('en', 0, 1000, 0.8)], 'en')).toBe(false)
    expect(wins(heard('en', 0, 1000, 0.1), [], 'en')).toBe(true)
  })

  it('live: decides once the other language has reported past a final, or after waiting', () => {
    const merger = new BilingualMerger('en-US', 'nl-NL')
    const final = (locale: string, text: string, startMs: number, endMs: number, fit: number) => ({ type: 'final', source: 'mic', text, startMs, endMs, locale, fit }) as SpeechSessionEvent
    expect(merger.push(final('en-US', 'Hoi', 0, 900, 0.4), 0)).toEqual([])
    // Dutch reaches past it: the English line is decided (and loses); the Dutch one waits for English to pass 1.2 s.
    expect(merger.push(final('nl-NL', 'Hoi allemaal', 0, 1200, 0.9), 500)).toEqual([])
    // English reports further: the Dutch line stands. The English one has nothing from Dutch yet, so it waits, then stands.
    expect(texts(merger.push(final('en-US', 'Thanks everyone', 2000, 3000, 0.95), 3000))).toEqual(['Hoi allemaal'])
    expect(merger.settle(3000 + SETTLE_MS - 1)).toEqual([])
    expect(texts(merger.settle(3000 + SETTLE_MS))).toEqual(['Thanks everyone'])
  })

  it('live captions follow the language that won last', () => {
    const merger = new BilingualMerger('en-US', 'nl-NL')
    const partial = (locale: string, text: string) => ({ type: 'partial', source: 'mic', text, startMs: 0, endMs: 100, locale }) as SpeechSessionEvent
    expect(merger.push(partial('en-US', 'hello'), 0)).toHaveLength(1)
    expect(merger.push(partial('nl-NL', 'hallo'), 0)).toHaveLength(0)
    merger.push({ type: 'final', source: 'mic', text: 'Goedemorgen allemaal', startMs: 0, endMs: 1500, locale: 'nl-NL', fit: 1 } as SpeechSessionEvent, 0)
    merger.settle(0, true)
    expect(merger.push(partial('nl-NL', 'en dan'), 10)).toHaveLength(1)
    expect(merger.push(partial('en-US', 'and then'), 10)).toHaveLength(0)
  })

  it('passes everything else through, and decides what waits when the session stops', () => {
    const merger = new BilingualMerger('en-US', 'nl-NL')
    expect(merger.push({ type: 'level', source: 'mic', rms: 0.1, peak: 0.2 } as SpeechSessionEvent, 0)).toHaveLength(1)
    merger.push({ type: 'final', source: 'mic', text: 'Tot zo', startMs: 0, endMs: 800, locale: 'nl-NL', fit: 0.9 } as SpeechSessionEvent, 0)
    const out = merger.push({ type: 'stopped', durationMs: 1000, audio: null } as SpeechSessionEvent, 100)
    expect(out.map((e) => e.type)).toEqual(['final', 'stopped'])
  })
})

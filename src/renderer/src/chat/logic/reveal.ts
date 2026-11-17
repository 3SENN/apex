/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The word reveal for streamed replies. Each text turn keeps a record of how
// many words it has shown and when each batch of new words arrived. The
// record lives in the chat's store, so remounting a view or moving the chat
// between the panel and the page never plays a word twice.

/** Streamed text reaches the view in batches this far apart. */
export const REVEAL_BATCH_MS = 140
export const WORD_FADE_MS = 160
export const WORD_STAGGER_MS = 10
/** The last word of a batch starts at most this long after the first. */
export const BATCH_STAGGER_CAP_MS = 220

export interface RevealBatch {
  /** Index of the batch's first word. */
  start: number
  /** When the batch first rendered. */
  at: number
}

export interface RevealRecord {
  /** Words rendered so far. */
  shown: number
  /** Batches that may still be fading in, oldest first. */
  batches: RevealBatch[]
}

/** Text seen for the first time: settled, unless it is streaming in right now. */
export function newReveal(words: number, live: boolean, now: number): RevealRecord {
  if (!live || words === 0) return { shown: words, batches: [] }
  return { shown: words, batches: [{ start: 0, at: now }] }
}

const batchDone = (batch: RevealBatch, now: number): boolean => now - batch.at > BATCH_STAGGER_CAP_MS + WORD_FADE_MS

/**
 * Notes words that appeared since the last render and drops batches that have
 * finished. Returns the same object when nothing changed, so callers can skip writes.
 */
export function advanceReveal(record: RevealRecord, words: number, now: number): RevealRecord {
  // The text was cut (edit and resend, retry): nothing left to animate.
  if (words < record.shown) return { shown: words, batches: [] }
  let batches = record.batches
  while (batches.length > 0 && batchDone(batches[0]!, now)) batches = batches.slice(1)
  if (words > record.shown) batches = [...batches, { start: record.shown, at: now }]
  if (batches === record.batches && words === record.shown) return record
  return { shown: words, batches }
}

/**
 * How long word `index` waits before fading in, in ms; null when it is
 * settled and draws as plain text. A view that mounted after the batch
 * arrived gets a negative delay, so the fade continues instead of restarting.
 */
export function wordDelay(record: RevealRecord, index: number, mountedAt: number): number | null {
  if (index >= record.shown) return null
  let batch: RevealBatch | null = null
  for (const b of record.batches) {
    if (b.start <= index) batch = b
    else break
  }
  if (!batch) return null
  const delay = Math.min(BATCH_STAGGER_CAP_MS, (index - batch.start) * WORD_STAGGER_MS) - Math.max(0, mountedAt - batch.at)
  return delay + WORD_FADE_MS <= 0 ? null : delay
}

/** Words in a piece of text: runs of non-space characters. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

/** Splits text into words and the spaces between them, keeping every character. */
export function splitWords(text: string): Array<{ word: boolean; text: string }> {
  const parts: Array<{ word: boolean; text: string }> = []
  for (const match of text.matchAll(/(\s+)|(\S+)/g)) parts.push({ word: match[2] !== undefined, text: match[0] })
  return parts
}

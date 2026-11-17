/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The en-XA pseudo-locale: every English message accented, about 35%
// longer and bracketed, so clipped text, hard-coded strings and messages
// built by gluing pieces together stand out in screenshots. Placeholders
// ({name}), plural headers and '#' are kept as written, so formatting still
// works on the transformed message. No imports: scripts/i18n/pseudo.mjs loads
// this file directly.

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
}

/** How much longer a pseudo message is than its English, before the brackets. */
export const PSEUDO_EXPANSION = 0.35

/** The filler that makes up the extra length; one word of it per gap. */
const FILLER = 'ļöñĝéŕ ţéẋţ ŵíðéŕ šţíļļ '

export const PSEUDO_OPEN = '['
export const PSEUDO_CLOSE = ']'

function accent(text: string): string {
  let out = ''
  for (const ch of text) out += ACCENTS[ch] ?? ch
  return out
}

/** Index of the brace that closes the one opened at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

// One level of message: text outside braces is accented; {name} stays;
// {n, plural, one {…} other {…}} keeps its header and case names and
// transforms each case body. Returns the text and how many letters it shows.
function transform(message: string): { text: string; visible: number } {
  let text = ''
  let visible = 0
  let i = 0
  while (i < message.length) {
    const open = message.indexOf('{', i)
    const plain = open < 0 ? message.slice(i) : message.slice(i, open)
    text += accent(plain)
    visible += [...plain].length
    if (open < 0) break
    const end = closing(message, open)
    if (end < 0) {
      text += message.slice(open)
      break
    }
    const inner = message.slice(open + 1, end)
    const header = /^(\s*[A-Za-z0-9_]+\s*,\s*plural\s*,)([\s\S]*)$/.exec(inner)
    if (header) {
      const body = transformCases(header[2] ?? '')
      text += `{${header[1]}${body.text}}`
      visible += body.visible
    } else {
      text += message.slice(open, end + 1)
    }
    i = end + 1
  }
  return { text, visible }
}

function transformCases(body: string): { text: string; visible: number } {
  let text = ''
  let visible = 0
  let i = 0
  let longest = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open < 0) {
      text += body.slice(i)
      break
    }
    const end = closing(body, open)
    if (end < 0) {
      text += body.slice(i)
      break
    }
    text += body.slice(i, open)
    const inner = transform(body.slice(open + 1, end))
    text += `{${inner.text}}`
    longest = Math.max(longest, inner.visible)
    i = end + 1
  }
  visible += longest
  return { text, visible }
}

function filler(length: number): string {
  let out = ''
  while (out.length < length) out += FILLER
  return out.slice(0, length).trimEnd()
}

/** The en-XA form of one English message. Already-pseudo text and empty strings are returned unchanged. */
export function pseudoize(message: string): string {
  if (message === '' || (message.startsWith(PSEUDO_OPEN) && message.endsWith(PSEUDO_CLOSE))) return message
  const { text, visible } = transform(message)
  const extra = Math.ceil(visible * PSEUDO_EXPANSION)
  const pad = extra > 0 ? ` ${filler(extra)}` : ''
  return `${PSEUDO_OPEN}${text}${pad}${PSEUDO_CLOSE}`
}

/** True for text that went through pseudoize(); smoke uses it to spot strings that bypass the catalogue. */
export function isPseudo(text: string): boolean {
  return text.startsWith(PSEUDO_OPEN) && text.endsWith(PSEUDO_CLOSE)
}

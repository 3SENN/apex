/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseSync } from 'vite'
import { describe, expect, it } from 'vitest'
import { SWEEP_COMPLETE } from '@shared/i18n/locales'

// User-visible strings in the chrome go through the catalogue. A real TSX
// parse (TypeScript 7 has no in-process compiler API, so this uses the oxc
// parser Vite ships) finds JSX text and literal title, aria-label,
// placeholder and alt attributes, and the kit's text props (label,
// description, tooltip and the like). Once the catalogue is complete (SWEEP_COMPLETE) any such
// literal fails, apart from names, key labels and text that isn't language.

const ROOT = join(__dirname, '..', 'src', 'renderer', 'src')
const ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'description', 'tooltip', 'aria-valuetext', 'aria-description', 'hint', 'message', 'heading', 'confirmLabel', 'cancelLabel', 'emptyText', 'subtitle', 'caption', 'trailing'])
/** Names and marks that read the same in every language. */
const ALLOWED_TEXT = new Set(['Atelier', 'Claude', 'Anthropic', 'Markdown', 'JavaScript', 'GitHub', 'ChatGPT'])
/** Keys as printed on the keyboard, and command names typed as they are. */
const KEYS_AND_COMMANDS = new Set(['esc', 'Esc', 'Tab', 'Enter', 'Return', 'Space', 'Shift', 'npx'])
/** Text that isn't language: addresses, hosts, paths, identifiers, code samples and key prefixes. */
const NOT_LANGUAGE = [
  /^[a-z][a-z0-9+.-]*:\/\/\S*$/, // https://example.com/mcp
  /^([a-z0-9-]+\.)+[a-z]{2,}$/, // example.com
  /^(~|\.{0,2})\/\S*$/, // /Users/you/servers/notes
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/, // API_KEY
  /^[[{]/, // a JSON sample
  /^sk-ant-/, // the shape of an API key
  /^\(?[⌘⌥⇧⌃]+\S{1,3}\)?$/, // a shortcut after a translated label: (⌘J)
]

interface Literal {
  file: string
  line: number
  kind: 'text' | string
  text: string
}

function needsCatalogue(text: string): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!/\p{L}/u.test(trimmed)) return false
  if (ALLOWED_TEXT.has(trimmed.replace(/:$/, '')) || KEYS_AND_COMMANDS.has(trimmed)) return false
  return !NOT_LANGUAGE.some((pattern) => pattern.test(trimmed))
}

function lineOf(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

type Node = { type?: string; [key: string]: unknown }

/** Literal user-visible strings in one TSX source. */
function scanTsx(file: string, source: string): Literal[] {
  const found: Literal[] = []
  const { program } = parseSync(file, source, { lang: 'tsx' })
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const n = node as Node
    if (n.type === 'JSXText' && typeof n.value === 'string' && needsCatalogue(n.value)) {
      found.push({ file, line: lineOf(source, Number(n.start)), kind: 'text', text: n.value.trim() })
    }
    if (n.type === 'JSXAttribute') {
      const name = (n.name as Node | undefined)?.name
      const value = n.value as Node | null | undefined
      if (typeof name === 'string' && ATTRIBUTES.has(name) && value) {
        const literal = value.type === 'Literal' ? value : value.type === 'JSXExpressionContainer' ? (value.expression as Node) : null
        if (literal?.type === 'Literal' && typeof literal.value === 'string' && needsCatalogue(literal.value)) {
          found.push({ file, line: lineOf(source, Number(n.start)), kind: name, text: literal.value })
        }
        if (literal?.type === 'TemplateLiteral' && Array.isArray(literal.quasis)) {
          const raw = (literal.quasis as Node[]).map((q) => String((q.value as { raw?: string } | undefined)?.raw ?? '')).join('')
          if (needsCatalogue(raw)) found.push({ file, line: lineOf(source, Number(n.start)), kind: name, text: raw })
        }
      }
    }
    for (const [key, child] of Object.entries(n)) if (key !== 'parent' && child && typeof child === 'object') visit(child)
  }
  visit(program)
  return found
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path))
    else if (name.endsWith('.tsx')) out.push(path)
  }
  return out
}

describe('no hard-coded strings', () => {
  it('finds text, attributes and template literals, and skips symbols and names', () => {
    const found = scanTsx(
      'x.tsx',
      `const a = <div title="Close panel" aria-label={'Open it'} placeholder={\`Search \${x}\`} alt="">Hello there<b>·</b>{' '}Atelier<i title={t('k')}>{t('x')}</i><input placeholder="https://example.com/mcp" /><input placeholder="API_KEY" /><b>ChatGPT:</b><kbd>esc</kbd></div>`,
    )
    expect(found.map((f) => `${f.kind}:${f.text}`)).toEqual(['title:Close panel', 'aria-label:Open it', 'placeholder:Search ', 'text:Hello there'])
  })

  it('the chrome’s .tsx files use the catalogue', () => {
    const literals = tsxFiles(ROOT).flatMap((file) => scanTsx(file, readFileSync(file, 'utf8')).map((l) => ({ ...l, file: relative(ROOT, file) })))
    expect(SWEEP_COMPLETE).toBe(true)
    expect(literals.map((l) => `${l.file}:${l.line} ${l.kind} “${l.text}”`)).toEqual([])
  }, 30_000) // It parses every renderer .tsx file; more than 5 s on a busy machine.
})

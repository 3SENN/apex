/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { LogItem } from '../../agentLog'
import { useT } from '../../i18n/useT'
import { IconButton, cx, useMotion } from '../../ui'
import { FIND_PAGE_LIMIT, FIND_QUERY_MAX, findCountLabel, findEntries, findMatches, nearestMatch, needsOlderPages, occurrences, stepMatch, type FindMatch } from '../logic/find'
import { chatState, loadOlder } from '../store'
import '../chatTools.css'

// The find bar of a chat surface (CH-37): a count, next and previous, Enter,
// ⇧Enter and Esc. Matches come from the whole log, so older messages that
// aren't rendered yet still count; jumping to one asks the log to render it
// (an 'atelier:chat-reveal' event for the log's paging) and then highlights it. The
// highlights use the CSS Custom Highlight API, so the messages' DOM is never
// touched.

const SEARCH_DELAY_MS = 60
const HIGHLIGHT_ALL = 'atelier-find'
const HIGHLIGHT_CURRENT = 'atelier-find-current'

/** The text nodes under an element, with each one's start in the joined text. */
function textNodes(root: Element): Array<{ node: Text; start: number }> {
  const out: Array<{ node: Text; start: number }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    out.push({ node, start: offset })
    offset += node.data.length
  }
  return out
}

/** Ranges for each occurrence of `query` inside a rendered message. */
function rangesIn(el: Element, query: string): Range[] {
  const nodes = textNodes(el)
  const text = nodes.map((n) => n.node.data).join('')
  const locate = (at: number): { node: Text; offset: number } | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const entry = nodes[i]
      if (entry && entry.start <= at) return { node: entry.node, offset: Math.min(at - entry.start, entry.node.data.length) }
    }
    return null
  }
  return occurrences(text, query).flatMap(([start, end]) => {
    const a = locate(start)
    const b = locate(end)
    if (!a || !b) return []
    const range = document.createRange()
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    return [range]
  })
}

function setHighlights(all: Range[], current: Range | null): void {
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  if (!registry || typeof Highlight === 'undefined') return
  registry.set(HIGHLIGHT_ALL, new Highlight(...all))
  if (current) registry.set(HIGHLIGHT_CURRENT, new Highlight(current))
  else registry.delete(HIGHLIGHT_CURRENT)
}

function clearHighlights(): void {
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  registry?.delete(HIGHLIGHT_ALL)
  registry?.delete(HIGHLIGHT_CURRENT)
}

export interface ChatFindBarProps {
  chatId: string
  items: readonly LogItem[]
  /** The chat surface; messages are found under it by `data-find-id`. */
  root: RefObject<HTMLElement | null>
  /** Bumps each time ⌘F is pressed again, to refocus the field. */
  nonce: number
  onClose(): void
  className?: string
}

export function ChatFindBar({ chatId, items, root, nonce, onClose, className }: ChatFindBarProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const field = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState(() => window.getSelection()?.toString().split('\n')[0]?.slice(0, FIND_QUERY_MAX) ?? '')
  const [query, setQuery] = useState(input)
  const [current, setCurrent] = useState(-1)
  const lastItem = useRef<string | null>(null)

  const entries = useMemo(() => findEntries(items), [items])
  const matches = useMemo(() => findMatches(entries, query), [entries, query])

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [nonce])

  // Searches a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [input])

  // A new query keeps your place: the first match at or after the last one.
  useEffect(() => {
    setCurrent(nearestMatch(matches, entries, lastItem.current))
    // Only the query moves the cursor; streamed text keeps it where it is.
  }, [query])

  useEffect(() => clearHighlights, [])

  // The whole log: once you search, older pages that aren't loaded yet come in
  // too (the log's paging), so the count covers every message in the chat.
  const searching = query.trim() !== ''
  useEffect(() => {
    if (!searching) return
    let cancelled = false
    void (async () => {
      for (let page = 0; page < FIND_PAGE_LIMIT && !cancelled; page++) {
        const current = chatState(chatId)
        if (!current || !needsOlderPages(current.logStart ?? 0)) return
        if (current.olderLoading) await new Promise((r) => setTimeout(r, 80))
        else if (!(await loadOlder(chatId)) && !chatState(chatId)?.olderLoading) return
      }
    })()
    return () => {
      cancelled = true
    }
  }, [searching, chatId])

  const match: FindMatch | null = current >= 0 ? (matches[current] ?? null) : null
  useLayoutEffect(() => {
    const surface = root.current
    if (!surface || !query.trim()) {
      clearHighlights()
      return
    }
    let frame = 0
    let tries = 0
    const paint = (): void => {
      const all: Range[] = []
      let currentRange: Range | null = null
      for (const el of surface.querySelectorAll<HTMLElement>('[data-find-id]')) {
        const ranges = rangesIn(el, query)
        all.push(...ranges)
        if (match && el.dataset.findId === match.itemId) currentRange = ranges[Math.min(match.occurrence, ranges.length - 1)] ?? null
      }
      if (match && !currentRange && tries < 10) {
        // Not rendered yet: ask the log to render it, then look again.
        if (tries === 0) window.dispatchEvent(new CustomEvent('atelier:chat-reveal', { detail: { chatId, itemId: match.itemId } }))
        tries++
        frame = requestAnimationFrame(paint)
        return
      }
      setHighlights(all, currentRange)
      if (currentRange) {
        const target = currentRange.startContainer.parentElement
        target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
      }
    }
    paint()
    return () => cancelAnimationFrame(frame)
  }, [match?.itemId, match?.occurrence, query, entries, chatId, reduced])

  useEffect(() => {
    if (match) lastItem.current = match.itemId
  }, [match])

  const step = (direction: 1 | -1): void => setCurrent((c) => stepMatch(c, matches.length, direction))
  const count = findCountLabel(current, matches.length, query, { of: t('chatTools.find.of'), none: t('chatTools.find.none') })

  return (
    <div className={cx('cd-find', className)} role="search" aria-label={t('chatTools.find.label')}>
      <input
        ref={field}
        type="text"
        className="cd-find__field"
        value={input}
        maxLength={FIND_QUERY_MAX}
        placeholder={t('chatTools.find.placeholder')}
        aria-label={t('chatTools.find.placeholder')}
        spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            // Enter right after typing searches the latest text first.
            if (input !== query) setQuery(input)
            else step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className={cx('cd-find__count', query.trim() && matches.length === 0 && 'cd-find__count--none')} role="status" aria-live="polite">{count}</span>
      <IconButton size="sm" label={t('chatTools.find.previous')} shortcut="Shift+Enter" icon={<ChevronUp />} disabled={matches.length === 0} onClick={() => step(-1)} />
      <IconButton size="sm" label={t('chatTools.find.next')} shortcut="Enter" icon={<ChevronDown />} disabled={matches.length === 0} onClick={() => step(1)} />
      <IconButton size="sm" label={t('chatTools.find.close')} shortcut="Escape" icon={<X />} onClick={onClose} />
    </div>
  )
}

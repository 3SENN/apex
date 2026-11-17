/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, type AttachmentRef } from '@shared/attachments'
import { edgeRow, filterRows, listState, menuKey, rootRows, stepRow, type MenuRow } from '../src/renderer/src/chat/logic/addMenu'
import { hasEffortControl, primaryButton, type PrimaryInput } from '../src/renderer/src/chat/logic/composer'
import { FILE_BYTES_MAX, carriesFiles, dragDepth, pageDragSource, preflightFiles } from '../src/renderer/src/chat/logic/drop'
import { chipView, editedAttachments, intakeGate, isLegacyRef } from '../src/renderer/src/chat/logic/intake'
import { lineCount, pasteAction, putBack } from '../src/renderer/src/chat/logic/paste'

// The composer's intake (CH-21 to CH-24, CH-09): paste
// thresholds, drop acceptance, chip state to Send, and the + menu's model.

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'a1',
  kind: 'text',
  name: 'notes.txt',
  state: 'ready',
  error: null,
  size: 10,
  mediaType: 'text/plain',
  thumbnail: null,
  ...over,
})

describe('paste thresholds (CH-24)', () => {
  it('keeps short text as typing and turns long text into a chip', () => {
    expect(pasteAction({ text: 'x'.repeat(1499), files: 0, images: 0 })).toBe('default')
    expect(pasteAction({ text: 'x'.repeat(1500), files: 0, images: 0 })).toBe('long-text')
    expect(pasteAction({ text: Array(29).fill('a').join('\n'), files: 0, images: 0 })).toBe('default')
    expect(pasteAction({ text: Array(30).fill('a').join('\n'), files: 0, images: 0 })).toBe('long-text')
  })

  it('attaches clipboard images, but keeps the words when a document brings a picture of itself', () => {
    expect(pasteAction({ text: '', files: 1, images: 1 })).toBe('files')
    expect(pasteAction({ text: 'Quarterly notes', files: 1, images: 1 })).toBe('default')
    expect(pasteAction({ text: 'report.pdf', files: 1, images: 0 })).toBe('files')
  })

  it('counts lines without a trailing newline and puts text back on its own lines', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(putBack('Hello world', 5, 'PASTE')).toEqual({ text: 'Hello\nPASTE\n world', caret: 11 })
    expect(putBack('', 0, 'x')).toEqual({ text: 'x', caret: 1 })
  })
})

describe('drop acceptance (CH-23)', () => {
  it('shows the overlay only for files and counts nested enter and leave', () => {
    expect(carriesFiles(['Files', 'text/plain'])).toBe(true)
    expect(carriesFiles(['text/html', 'text/uri-list'])).toBe(false)
    let depth = dragDepth(0, 'enter')
    depth = dragDepth(depth, 'enter')
    depth = dragDepth(depth, 'leave')
    expect(depth).toBe(1)
    expect(dragDepth(depth, 'drop')).toBe(0)
    expect(dragDepth(0, 'leave')).toBe(0)
  })

  it('turns away folders, oversized files and anything past the per-message limit, with a reason', () => {
    const plan = preflightFiles(
      [
        { name: 'a.png', size: 10 },
        { name: 'big.mov', size: FILE_BYTES_MAX + 1 },
        { name: 'Photos', size: 0, directory: true },
        { name: 'b.pdf', size: 10 },
      ],
      ATTACHMENT_LIMITS.perMessage - 1,
    )
    expect(plan.accept).toEqual([0])
    expect(plan.reject).toEqual([
      { index: 1, reason: 'too-large' },
      { index: 2, reason: 'folder' },
      { index: 3, reason: 'too-many' },
    ])
  })

  it('reads page drags as a picture or a quoted selection with its links', () => {
    const page = { tabId: 't1', url: 'https://example.com/post', title: 'Post' }
    expect(pageDragSource({ uriList: 'https://example.com/cat.png', html: '', text: '' }, page)).toEqual({ type: 'page-url', tabId: 't1', url: 'https://example.com/cat.png' })
    const selection = pageDragSource({ uriList: '', html: 'Read <a href="/more">more</a> here', text: 'Read more here' }, page)
    expect(selection).toMatchObject({ type: 'selection', text: 'Read more here', url: page.url, title: 'Post', links: [{ text: 'more', url: 'https://example.com/more' }] })
    expect(pageDragSource({ uriList: '', html: '', text: 'plain words' }, page)).toBeNull()
    expect(pageDragSource({ uriList: 'https://example.com/cat.png', html: '', text: '' }, { ...page, url: 'atelier://newtab' })).toBeNull()
  })
})

describe('chip state and Send (CH-22)', () => {
  it('waits while a chip prepares, blocks on a failure and past the limit', () => {
    expect(intakeGate([{ state: 'ready' }]).canSend).toBe(true)
    const preparing = intakeGate([{ state: 'ready' }, { state: 'preparing' }])
    expect(preparing.canSend).toBe(false)
    expect(preparing.hint).toMatch(/finish preparing/)
    expect(intakeGate([{ state: 'failed' }]).hint).toMatch(/didn’t work/)
    expect(intakeGate([{ state: 'ready' }], ATTACHMENT_LIMITS.perMessage).canSend).toBe(false)
  })

  it('holds Send and Queue, but not the mic or Stop, until the chips are ready', () => {
    const base: PrimaryInput = { hasText: true, canSend: true, running: false, sending: false, editingQueued: false, voice: 'idle' }
    expect(primaryButton({ ...base, attachmentsReady: false })).toMatchObject({ action: 'send', disabled: true })
    expect(primaryButton({ ...base, attachmentsReady: true })).toMatchObject({ action: 'send', disabled: false })
    expect(primaryButton({ ...base, running: true, attachmentsReady: false })).toMatchObject({ action: 'queue', disabled: true })
    expect(primaryButton({ ...base, running: true, hasText: false, attachmentsReady: false })).toMatchObject({ action: 'stop', disabled: false })
    expect(primaryButton({ ...base, hasText: false, attachmentsReady: false })).toMatchObject({ action: 'voice', disabled: false })
  })

  it('labels chips by state, lines, pages or source host', () => {
    expect(chipView(ref({ state: 'preparing' })).sublabel).toBe('Preparing…')
    expect(chipView(ref({ kind: 'meeting', state: 'preparing' })).sublabel).toBe('Waiting for the transcript')
    expect(chipView(ref({ state: 'failed', error: 'Too big' })).sublabel).toBe('Too big')
    expect(chipView(ref({ kind: 'paste', name: '', lines: 42 }))).toMatchObject({ sublabel: '42 lines', previewable: true, name: 'Pasted text' })
    expect(chipView(ref({ kind: 'pdf', pages: 3 })).sublabel).toBe('3 pages')
    expect(chipView(ref({ kind: 'selection', source: { url: 'https://www.example.com/a', title: 'A' } }))).toMatchObject({ sublabel: 'example.com', sourceUrl: 'https://www.example.com/a' })
  })

  it('notes models without an effort setting', () => {
    expect(hasEffortControl('claude-opus-5-5')).toBe(true)
    expect(hasEffortControl('claude-haiku-5-5')).toBe(false)
  })
})

describe('editing a sent message (CH-09)', () => {
  const original = [ref({ id: 'a' }), ref({ id: 'legacy-m1-0', kind: 'image' }), ref({ id: 'b' })]

  it('keeps the attachments as they were when nothing changed', () => {
    expect(editedAttachments(original, ['a', 'legacy-m1-0', 'b'], [])).toBeUndefined()
  })

  it('sends the kept and added refs, leaving out older entries that have no store entry', () => {
    expect(editedAttachments(original, ['a', 'legacy-m1-0'], ['c'])).toEqual([
      { kind: 'ref', id: 'a' },
      { kind: 'ref', id: 'c' },
    ])
    expect(editedAttachments(original, [], [])).toEqual([])
    expect(isLegacyRef({ id: 'legacy-x-1' })).toBe(true)
  })
})

describe('the + menu (CH-21, DS-126)', () => {
  const labels = { files: 'Files…', skills: 'Skills', meetings: 'Meetings', connectors: 'Connectors', tabs: 'Tabs', recent: 'Recent tabs' }
  const recent = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, title: `Tab ${n}`, url: `https://site${n}.com/` }))

  it('lists Files, the four submenus and at most three recent tabs, with no folder row before D', () => {
    const rows = rootRows(labels, recent)
    expect(rows.map((r) => r.id)).toEqual(['files', 'sep-attach', 'sub:skills', 'sub:meetings', 'sub:connectors', 'sub:tabs', 'sep-recent', 'recent', 'tab:t1', 'tab:t2', 'tab:t3'])
    expect(rows.find((r) => r.id === 'tab:t1')?.detail).toBe('site1.com')
    expect(rootRows(labels, []).some((r) => r.kind === 'header')).toBe(false)
  })

  it('filters a submenu by every word, telling empty apart from no match', () => {
    const rows: MenuRow[] = [
      { id: 'skill:brief', label: 'Weekly brief', kind: 'item', detail: 'Mondays' },
      { id: 'skill:café', label: 'Café finder', kind: 'item' },
    ]
    expect(filterRows(rows, 'week mon').map((r) => r.id)).toEqual(['skill:brief'])
    expect(filterRows(rows, 'cafe').map((r) => r.id)).toEqual(['skill:café'])
    expect(listState(rows, 'zzz')).toEqual({ kind: 'no-match' })
    expect(listState([], '')).toEqual({ kind: 'empty' })
    expect(listState('loading', '')).toEqual({ kind: 'loading' })
    expect(listState(rows, '')).toMatchObject({ kind: 'rows' })
  })

  it('moves past dividers and wraps, opens submenus, and goes back with ← or Esc', () => {
    const rows = rootRows(labels, recent.slice(0, 1))
    expect(edgeRow(rows, 'first')).toBe(0)
    expect(stepRow(rows, 0, 1)).toBe(2)
    expect(stepRow(rows, 0, -1)).toBe(rows.length - 1)
    expect(menuKey('Enter', rows, 2, 'root')).toEqual({ type: 'open', submenu: 'skills' })
    expect(menuKey('ArrowRight', rows, 2, 'root')).toEqual({ type: 'open', submenu: 'skills' })
    expect(menuKey('ArrowRight', rows, 0, 'root')).toBeNull()
    expect(menuKey('Enter', rows, 0, 'root')).toMatchObject({ type: 'choose', row: { id: 'files' } })
    expect(menuKey('Escape', rows, 0, 'root')).toEqual({ type: 'close' })
    expect(menuKey('Tab', rows, 0, 'skills')).toEqual({ type: 'close' })
    expect(menuKey('Escape', rows, 0, 'skills')).toEqual({ type: 'back' })
    expect(menuKey('ArrowLeft', rows, 0, 'skills', '')).toEqual({ type: 'back' })
    expect(menuKey('ArrowLeft', rows, 0, 'skills', 'we')).toBeNull()
    expect(menuKey('Home', rows, 3, 'skills', 'we')).toBeNull()
    expect(menuKey('ArrowDown', [], -1, 'skills')).toBeNull()
  })
})

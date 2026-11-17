/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcRenderer } from 'electron'
import { PAGE } from '@shared/ipc'
import { TRANSLATE_SAMPLE_MAX, type PageLanguageHints, type PageTranslateBatchReply, type PageTranslateCommand, type PageTranslateReport, type TranslateErrorCode } from '@shared/translate'
import { DomTranslator, sampleText, TRANSLATED_ATTRIBUTES, type TNode } from './translateDom'

// Page translation's part in the page (TR-07 to TR-09), top frame only, in the
// preload's isolated world: it reports the page's language hints, and while
// main has it translate it changes text nodes in place (translateDom.ts),
// sending batches to main, which picks the engine. A MutationObserver picks
// up what the page adds while translated; Show original restores it all.
// Nothing here touches the page's own JavaScript world.

/** New content is gathered for this long before it goes out as one batch. */
const OBSERVE_DEBOUNCE_MS = 250
/** Pages that draw their text late (single-page apps) get a second look. */
const SECOND_LOOK_MS = 2000
const SHORT_SAMPLE = 200

class BatchError extends Error {
  constructor(readonly code: TranslateErrorCode) {
    super(code)
  }
}

function meta(selector: string): string | null {
  return document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null
}

function roots(): TNode[] {
  const out: TNode[] = []
  const title = document.querySelector('head > title')
  if (title) out.push(title as unknown as TNode)
  if (document.body) out.push(document.body as unknown as TNode)
  return out
}

function hints(): PageLanguageHints {
  const html = document.documentElement
  const google = (meta('meta[name="google" i]') ?? '').toLowerCase()
  return {
    declared: html?.getAttribute('lang') || html?.getAttribute('xml:lang') || null,
    contentLanguage: meta('meta[http-equiv="content-language" i]'),
    ogLocale: meta('meta[property="og:locale" i]'),
    optOut: html?.getAttribute('translate')?.toLowerCase() === 'no' || html?.classList.contains('notranslate') === true || /\bnotranslate\b/.test(google),
    sample: document.body ? sampleText([document.body as unknown as TNode], TRANSLATE_SAMPLE_MAX) : '',
  }
}

export function installTranslate(): void {
  // Only real documents (never a frame stub without a DOM).
  if (typeof document === 'undefined') return
  const translator = new DomTranslator()
  let session: string | null = null
  let observer: MutationObserver | null = null
  let pending: MutationRecord[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const report = (r: PageTranslateReport): void => ipcRenderer.send(PAGE.translateReport, r)
  const sendHints = (): PageLanguageHints => {
    const h = hints()
    ipcRenderer.send(PAGE.translateHints, h)
    return h
  }

  const engineFor =
    (s: string) =>
    async (texts: string[]): Promise<string[]> => {
      const reply = (await ipcRenderer.invoke(PAGE.translateBatch, { session: s, texts })) as PageTranslateBatchReply
      if ('error' in reply) throw new BatchError(reply.error)
      return reply.texts
    }

  const failed = (s: string, err: unknown): void => {
    if (session !== s) return
    stop()
    translator.restore()
    report({ kind: 'failed', session: s, error: err instanceof BatchError ? err.code : 'failed' })
  }

  const flush = (): void => {
    timer = null
    const s = session
    const records = pending
    pending = []
    if (!s) return
    const nodes = translator.changed(records)
    if (nodes.length === 0) return
    void translator.more(nodes).then(
      (p) => {
        if (p && session === s) report({ kind: 'done', session: s, done: p.done, total: p.total })
      },
      (err: unknown) => failed(s, err),
    )
  }

  const watch = (): void => {
    if (observer || !document.body) return
    observer = new MutationObserver((records) => {
      pending.push(...records)
      if (!timer) timer = setTimeout(flush, OBSERVE_DEBOUNCE_MS)
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TRANSLATED_ATTRIBUTES })
    const title = document.querySelector('head > title')
    if (title) observer.observe(title, { subtree: true, childList: true, characterData: true })
  }

  const stop = (): void => {
    observer?.disconnect()
    observer = null
    pending = []
    if (timer) clearTimeout(timer)
    timer = null
  }

  const start = (cmd: Extract<PageTranslateCommand, { kind: 'start' }>): void => {
    stop()
    session = cmd.session
    const s = cmd.session
    // start() restores an earlier translation synchronously, before its first batch goes out;
    // the observer starts after that, so those writes are not taken for the page's own.
    const run = translator.start(roots(), engineFor(s), (p) => {
      if (session === s) report({ kind: 'progress', session: s, done: p.done, total: p.total })
    })
    watch()
    void run.then(
      (p) => {
        if (p && session === s) report({ kind: 'done', session: s, done: p.done, total: p.total })
      },
      (err: unknown) => failed(s, err),
    )
  }

  ipcRenderer.on(PAGE.translate, (_event, raw: unknown) => {
    const cmd = raw as PageTranslateCommand | null
    if (!cmd || typeof cmd !== 'object') return
    if (cmd.kind === 'start' && typeof cmd.session === 'string') start(cmd)
    else if (cmd.kind === 'restore') {
      stop()
      session = null
      translator.restore()
      report({ kind: 'restored' })
    } else if (cmd.kind === 'hints') sendHints()
  })

  const first = (): void => {
    const h = sendHints()
    if (h.sample.length < SHORT_SAMPLE) setTimeout(() => void (session === null && sendHints()), SECOND_LOOK_MS)
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', first, { once: true })
  else first()
}

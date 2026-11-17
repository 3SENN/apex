/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SettingsView } from '@shared/ipc'
import type { OmniboxAction, OmniboxGroup, OmniboxRow } from '@shared/omnibox'
import { resolveEngine, type SearchEngineDef } from '@shared/searchEngines'
import { apex, call, errorText } from '../../api'
import { toast } from '../../ui'
import { startEntries, startKey, startPlan, startSuggestions, type NewTabMode, type StartAction, type StartEntry, type StartPlan } from './searchLogic'

// NT-01: the new tab's web search, next to asking the companion. The mode is
// a profile setting (newTabMode), the engine is Settings › Search's default,
// and the rows under the composer come from main's omnibox providers (the
// command bar's ranking). Searches and typed sites commit through the same
// omnibox.commit as the address bar, so they load in this tab.

/** How long typing pauses before the search-or-ask question goes out. */
const HINT_PAUSE_MS = 350

export interface StartSearchOptions {
  tabId: string
  text: string
  settings: SettingsView | null
  /** Keys and Enter go to the page as before (dictation is listening, the add entry). */
  bypass: boolean
  /** The field is disabled while a chat opens. */
  busy: boolean
  /** The composer starts a private chat (CH-30): what is typed is never sent to a decision model (DC-04). */
  private?: boolean
  onAsk(text: string): void
  onClear(): void
  focusField(): void
}

export interface StartSearch {
  mode: NewTabMode
  engine: SearchEngineDef
  plan: StartPlan
  groups: OmniboxGroup[]
  entries: StartEntry[]
  selected: number
  open: boolean
  /** The one-time engine choice is showing (NT-01). */
  choosing: boolean
  listId: string
  optionId(index: number): string
  setMode(mode: NewTabMode): void
  setSelected(index: number): void
  setFocused(focused: boolean): void
  run(index: number): void
  runEnter(): void
  keyFirst(e: KeyboardEvent<HTMLTextAreaElement>): boolean
  chooseEngine(id: string): void
  keepEngine(): void
}

export function useStartSearch({ tabId, text, settings, bypass, busy, private: isPrivate = false, onAsk, onClear, focusField }: StartSearchOptions): StartSearch {
  const source = settings ?? apex.initial.settings
  const [pendingMode, setPendingMode] = useState<NewTabMode | null>(null)
  const stored: NewTabMode = source.newTabMode === 'web' ? 'web' : 'companion'
  const mode = pendingMode ?? stored
  useEffect(() => setPendingMode(null), [stored])
  const engine = useMemo(() => resolveEngine(source.searchEngine, source.customSearchEngines), [source.searchEngine, source.customSearchEngines])

  const [focused, setFocused] = useState(false)
  const [rawGroups, setRawGroups] = useState<OmniboxGroup[]>([])
  const [selected, setSelected] = useState(-1)
  const [choosing, setChoosing] = useState(false)
  const seq = useRef(0)
  const committing = useRef(false)
  const listId = `nt-suggest-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  const query = text.trim()
  // The command bar's rows for what is typed, newest query wins.
  useEffect(() => {
    const id = ++seq.current
    setSelected(-1)
    if (!query || !focused) {
      setRawGroups([])
      return
    }
    void call('omnibox', 'query', query).then(
      (groups) => {
        if (id === seq.current) setRawGroups(groups)
      },
      () => undefined,
    )
  }, [query, focused])

  // DC-12 (Settings › Quick decisions): when a decision model is on, a pause in typing asks whether this
  // text is a search or a question; the top row (and Enter) follows a sure answer, the mode stays yours.
  // Picking a mode by hand settles it for the text typed so far.
  const [hint, setHint] = useState<{ query: string; mode: NewTabMode; kind: 'search' | 'ask' } | null>(null)
  const [manualFor, setManualFor] = useState<string | null>(null)
  useEffect(() => {
    if (!query || !focused || bypass || isPrivate || manualFor === query) return
    const current = mode === 'web' ? 'search' : 'ask'
    const timer = setTimeout(() => {
      call('decisions', 'searchOrAsk', query, current).then(
        (kind) => setHint({ query, mode, kind }),
        () => undefined,
      )
    }, HINT_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [query, focused, bypass, isPrivate, mode, manualFor])
  const hinted = hint && !isPrivate && hint.query === query && hint.mode === mode && manualFor !== query ? hint.kind : null
  const planMode: NewTabMode = hinted === null ? mode : hinted === 'search' ? 'web' : 'companion'
  const plan = useMemo(() => startPlan(text, planMode, engine), [text, planMode, engine])
  const go = plan.actions.find((a) => a.kind === 'go') ?? null
  const groups = useMemo(() => startSuggestions(rawGroups, mode, go), [rawGroups, mode, go?.kind === 'go' ? go.url : null])
  const entries = useMemo(() => startEntries(plan, groups), [plan, groups])
  const open = focused && query !== '' && !busy && !choosing && entries.length > 0

  const commit = useCallback(
    (action: OmniboxAction, after?: () => void): void => {
      if (committing.current) return
      committing.current = true
      call('omnibox', 'commit', tabId, text, action)
        .then((result) => {
          if (!result.ok) toast.show({ message: result.error, tone: 'error' })
          else after?.()
        })
        .catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
        .finally(() => {
          committing.current = false
        })
    },
    [tabId, text],
  )

  const runAction = (action: StartAction | null): void => {
    if (!action) return
    if (action.kind === 'ask') return onAsk(action.text)
    if (action.kind === 'go') return commit(action.internal ? { kind: 'open-internal', url: action.url } : { kind: 'navigate', url: action.url })
    commit({ kind: 'navigate', url: action.url })
  }
  const runRow = (row: OmniboxRow): void => commit(row.action, row.action.kind === 'switch-tab' ? onClear : undefined)
  const run = (index: number): void => {
    const entry = entries[index]
    if (!entry) return
    if (entry.kind === 'action') runAction(entry.action)
    else runRow(entry.row)
  }

  const save = (patch: Parameters<typeof apex.settings.set>[0]): void => {
    apex.settings.set(patch).catch((err: unknown) => {
      setPendingMode(null)
      toast.show({ message: errorText(err), tone: 'error' })
    })
  }
  const setMode = (next: NewTabMode): void => {
    setManualFor(query)
    if (next !== mode) {
      setPendingMode(next)
      save({ newTabMode: next })
    }
    // NT-01: the first time the web is picked without an engine chosen, the choice is offered once.
    if (next === 'web' && source.searchEngineChosen !== true) setChoosing(true)
    else setChoosing(false)
    requestAnimationFrame(focusField)
  }
  const chooseEngine = (id: string): void => {
    setChoosing(false)
    save({ searchEngine: id })
    requestAnimationFrame(focusField)
  }
  // Skipping keeps the engine and marks the choice made (main sets searchEngineChosen on any searchEngine patch).
  const keepEngine = (): void => chooseEngine(engine.id)

  const keyFirst = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (choosing && e.key === 'Escape') {
      e.preventDefault()
      keepEngine()
      return true
    }
    if (bypass || !query) return false
    const key = startKey(
      { key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing },
      { open, count: entries.length, selected, multiline: text.includes('\n') },
    )
    if (!key) return false
    e.preventDefault()
    switch (key.kind) {
      case 'enter':
        runAction(plan.enter)
        break
      case 'alt':
        runAction(plan.alt)
        break
      case 'run':
        run(key.index)
        break
      case 'select':
        setSelected(key.index)
        break
      case 'clear':
        setSelected(-1)
        onClear()
        break
    }
    return true
  }

  return {
    mode,
    engine,
    plan,
    groups,
    entries,
    selected,
    open,
    choosing,
    listId,
    optionId: (index) => `${listId}-${index}`,
    setMode,
    setSelected,
    setFocused,
    run,
    runEnter: () => (selected >= 0 && selected < entries.length ? run(selected) : runAction(plan.enter)),
    keyFirst,
    chooseEngine,
    keepEngine,
  }
}

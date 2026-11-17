/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Companion, CompanionPreset } from '@shared/companion'
import { atelier, call, errorText } from '../api'
import { loadCompanionAssets, type CompanionAssets } from '../companion'

// ---- the companion list ----

export interface CompanionsState {
  /** Every companion, hidden ones included, in creation order. */
  items: Companion[]
  activeId: string
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

// One copy for the whole chrome, kept live by the 'companions' event, so the
// card, the new tab, the sidebar and the chat pages never disagree.
let companionsState: CompanionsState = { items: [], activeId: '', status: 'loading', error: null }
const companionListeners = new Set<() => void>()
let companionsStarted = false
// Bumped by every event; a load that started before one is stale.
let companionsVersion = 0

function setCompanionsState(next: CompanionsState): void {
  companionsState = next
  for (const listener of companionListeners) listener()
}

function startCompanions(): void {
  if (companionsStarted) return
  companionsStarted = true
  atelier.onAppEvent((event) => {
    if (event.type !== 'companions') return
    companionsVersion++
    setCompanionsState({ items: event.items, activeId: event.activeId, status: 'ready', error: null })
  })
  void reloadCompanions()
}

/** Loads the list again (after an error, or to be sure it is current). */
export async function reloadCompanions(): Promise<void> {
  const version = companionsVersion
  if (companionsState.status === 'error') setCompanionsState({ ...companionsState, status: 'loading', error: null })
  try {
    const [items, activeId] = await Promise.all([call('companions', 'list'), call('companions', 'activeId')])
    if (version === companionsVersion) setCompanionsState({ items, activeId, status: 'ready', error: null })
  } catch (err) {
    if (version === companionsVersion) setCompanionsState({ ...companionsState, status: 'error', error: errorText(err) })
  }
}

function subscribeCompanions(listener: () => void): () => void {
  startCompanions()
  companionListeners.add(listener)
  return () => companionListeners.delete(listener)
}

/** The current list outside React. */
export function companionsSnapshot(): CompanionsState {
  startCompanions()
  return companionsState
}

/** Every companion and the active one's id, kept live. */
export function useCompanions(): CompanionsState {
  return useSyncExternalStore(subscribeCompanions, () => companionsState)
}

/** One companion by id; null while loading or once it is deleted. */
export function useCompanion(id: string | null | undefined): Companion | null {
  const { items } = useCompanions()
  return (id ? items.find((c) => c.id === id) : undefined) ?? null
}

/** The active companion; null until the list has loaded. */
export function useActiveCompanion(): Companion | null {
  const { items, activeId } = useCompanions()
  return items.find((c) => c.id === activeId) ?? items.find((c) => !c.hidden) ?? null
}

/** Makes a companion active, showing the choice at once; main's event confirms it. */
export async function chooseCompanion(id: string): Promise<void> {
  const previous = companionsState
  if (previous.activeId === id) return
  setCompanionsState({ ...previous, activeId: id })
  try {
    await call('companions', 'setActive', id)
  } catch (err) {
    // Only roll back if nothing newer arrived meanwhile.
    if (companionsState.activeId === id) setCompanionsState({ ...companionsState, activeId: previous.activeId })
    throw err
  }
}

// ---- assets, presets and off-screen images ----

/** The manifest and configs; null while loading, an Error if they failed. */
export function useCompanionAssets(): [CompanionAssets | Error | null, () => void] {
  const [assets, setAssets] = useState<CompanionAssets | Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    loadCompanionAssets().then(
      (loaded) => live && setAssets(loaded),
      (err: unknown) => live && setAssets(err instanceof Error ? err : new Error(String(err))),
    )
    return () => {
      live = false
    }
  }, [attempt])
  return [assets, () => {
    setAssets(null)
    setAttempt((n) => n + 1)
  }]
}

let presetsPromise: Promise<CompanionPreset[]> | null = null

/** Presets validated by main, fetched once per session (empty until they load). */
export function usePresets(): CompanionPreset[] {
  const [presets, setPresets] = useState<CompanionPreset[]>([])
  useEffect(() => {
    let live = true
    presetsPromise ??= call('companion', 'presets').then((list) => {
      // An empty list may mean the assets are not generated yet; ask again next time.
      if (list.length === 0) presetsPromise = null
      return list
    }, (err: unknown) => {
      presetsPromise = null
      throw err
    })
    presetsPromise.then((list) => live && setPresets(list), () => undefined)
    return () => {
      live = false
    }
  }, [])
  return presets
}

// Off-screen stills live in the companion module; re-exported for existing callers.
export { companionImage, stillFraming, useCompanionImage, type ImageOptions } from '../companion/images'

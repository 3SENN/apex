/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { MediaHubState } from '@shared/media'
import { apex } from '../../api'
import { useLatest } from '../../ui'
import { anchorFromElement } from '../../overlay/useSurface'

// Opens the now-playing popover (MD-01) from the toolbar button or the
// sidebar card, keeps its sources current while it is open, and closes it
// once nothing is left to show.

export interface NowPlayingPopoverControl {
  open: boolean
  toggle(): void
}

export function useNowPlayingPopover(anchor: RefObject<HTMLElement | null>, state: MediaHubState): NowPlayingPopoverControl {
  const [open, setOpen] = useState(false)
  const instance = useRef<string | null>(null)
  const opening = useRef(false)
  /** Bumped by every close, so an open that resolves after it is closed again. */
  const generation = useRef(0)
  const latest = useLatest(state)

  const hide = useCallback((): void => {
    const id = instance.current
    generation.current++
    instance.current = null
    setOpen(false)
    if (id) apex.overlay.close(id)
  }, [])

  const show = useCallback(async (): Promise<void> => {
    const el = anchor.current
    if (!el || instance.current || opening.current) return
    opening.current = true
    const gen = ++generation.current
    setOpen(true)
    try {
      const { instanceId } = await apex.overlay.open('now-playing', anchorFromElement(el), { state: latest.current })
      if (gen !== generation.current) apex.overlay.close(instanceId)
      else instance.current = instanceId
    } catch {
      setOpen(false)
    } finally {
      opening.current = false
    }
  }, [])

  // Esc, an outside click or going to a tab closes it from the overlay side.
  useEffect(
    () =>
      apex.overlay.onResult((r) => {
        if (r.instanceId !== instance.current) return
        instance.current = null
        setOpen(false)
      }),
    [],
  )

  useEffect(() => {
    if (!instance.current) return
    if (state.sources.length === 0) hide()
    else apex.overlay.update(instance.current, { state })
  }, [state])

  useEffect(() => () => hide(), [])

  return { open, toggle: () => (instance.current || opening.current ? hide() : void show()) }
}

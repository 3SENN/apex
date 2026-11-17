/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, type KeyboardEvent, type RefObject } from 'react'
import { rovingIndex, type RovingOptions } from './logic/keys'

// Roving focus for lists of controls: arrows, Home and End move
// between the items a selector finds inside a container; Tab leaves. Items
// keep their own tabindex (one at 0), so the list is one Tab stop.

export interface RovingFocusOptions extends Omit<RovingOptions, 'disabled'> {
  /** The items to move between (default: enabled buttons with role radio, option, tab or menuitem). */
  selector?: string
  /** Also select the item focus lands on (radio groups). */
  onMove?(element: HTMLElement, index: number): void
}

const DEFAULT_SELECTOR = '[role="radio"]:not(:disabled), [role="option"]:not([aria-disabled="true"]), [role="tab"]:not(:disabled), [role="menuitem"]:not(:disabled)'

/** A keydown handler for the container. */
export function useRovingFocus(container: RefObject<HTMLElement | null>, options: RovingFocusOptions = {}): (e: KeyboardEvent<HTMLElement>) => void {
  const { selector = DEFAULT_SELECTOR, orientation = 'both', loop = true, onMove } = options
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const items = [...(container.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      const current = items.indexOf(document.activeElement as HTMLElement)
      if (current < 0) return
      const next = rovingIndex(e.key, current, items.length, { orientation, loop })
      const target = next === null ? undefined : items[next]
      if (next === null || !target) return
      e.preventDefault()
      target.focus()
      onMove?.(target, next)
    },
    [selector, orientation, loop, onMove],
  )
}

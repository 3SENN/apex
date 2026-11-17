/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type RefObject } from 'react'
import { apex } from '../api'
import { anchorFromElement } from '../overlay/useSurface'
import { nextTooltipDelay, tooltipTarget } from './logic/tooltip'

// Dark tooltips drawn in the passive overlay tier (OV-06, DS-95, SH-31), so
// they can cross page views and leave the chrome's bounds. Shown after about
// 500 ms over a control, at once when moving between controls, and hidden on
// leave, press, blur or a key. Without the overlay host (before M1, or a
// renderer that is down) the native title is the fallback.

export interface TooltipOptions {
  label: string
  /** A shortcut table row, shown as key caps. */
  shortcutId?: string | null
  /** Where it goes; 'bottom' (below) by default, 'top' for footer, composer and start-surface controls. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Off: no tooltip at all. */
  disabled?: boolean
  /** Positions the tip against this element instead of the control (the footer's strip, DS-18). */
  anchor?: RefObject<HTMLElement | null>
}

let lastHiddenAt = 0
let openTip: { instanceId: string | null; owner: object } | null = null

/**
 * Where a control is, in window CSS px. Inside the overlay host the surfaces'
 * root is shifted by its tier view's origin, so that shift is added back.
 */
function tooltipAnchor(el: HTMLElement): ReturnType<typeof anchorFromElement> {
  const anchor = anchorFromElement(el)
  const root = el.closest('.ov-root')
  if (!root || anchor.kind !== 'window') return anchor
  const shift = root.getBoundingClientRect()
  return { kind: 'window', rect: { ...anchor.rect, x: anchor.rect.x - shift.left, y: anchor.rect.y - shift.top } }
}

function hideOpen(owner?: object): void {
  if (!openTip || (owner && openTip.owner !== owner)) return
  if (openTip.instanceId) apex.overlay.close(openTip.instanceId)
  openTip = null
  lastHiddenAt = Date.now()
}

/** Attaches the overlay tooltip to an element. */
export function useTooltip(ref: RefObject<HTMLElement | null>, options: TooltipOptions): void {
  const latest = useRef(options)
  latest.current = options
  const ownerRef = useRef<object | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || options.disabled) return
    const owner = {}
    ownerRef.current = owner
    let timer: ReturnType<typeof setTimeout> | null = null
    let fallback = false
    // No overlay host: the native title shows instead, from then on (both at once would double up).
    const native = (): void => {
      fallback = true
      el.title = latest.current.label
    }
    // A renderer without the overlay API at all (a float window) goes native at once.
    if (!apex.overlay) native()

    const show = (): void => {
      timer = null
      const { label, shortcutId, side } = latest.current
      if (fallback || !label || !el.isConnected) return
      const overlay = apex.overlay
      if (!overlay) return native()
      hideOpen()
      const tip = { instanceId: null as string | null, owner }
      openTip = tip
      Promise.resolve()
        .then(() => overlay.open('tooltip', tooltipAnchor(tooltipTarget(el, latest.current.anchor?.current)), { label, shortcutId: shortcutId ?? null, side: side ?? 'bottom' }))
        .then(({ instanceId }) => {
          if (openTip === tip) tip.instanceId = instanceId
          else overlay.close(instanceId)
        })
        .catch(() => {
          if (openTip === tip) openTip = null
          native()
        })
    }
    const enter = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(show, nextTooltipDelay(Date.now(), lastHiddenAt))
    }
    const leave = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      hideOpen(owner)
    }
    // Keyboard focus shows it too, so the shortcut is discoverable without a pointer.
    const focus = (): void => {
      if (el.matches(':focus-visible')) enter()
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', leave)
    el.addEventListener('focus', focus)
    el.addEventListener('blur', leave)
    el.addEventListener('keydown', leave)
    window.addEventListener('blur', leave)
    return () => {
      leave()
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', leave)
      el.removeEventListener('focus', focus)
      el.removeEventListener('blur', leave)
      el.removeEventListener('keydown', leave)
      window.removeEventListener('blur', leave)
    }
  }, [ref, options.disabled])

  // A label change while shown updates it in place.
  useEffect(() => {
    // The native fallback follows the label too.
    const el = ref.current
    if (el?.title) el.title = options.label
    const tip = openTip
    if (tip?.instanceId && tip.owner === ownerRef.current) apex.overlay.update(tip.instanceId, { label: options.label, shortcutId: options.shortcutId ?? null, side: options.side ?? 'bottom' })
  }, [options.label, options.shortcutId, options.side])
}

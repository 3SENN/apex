/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { surfaceTier, type OverlayDismissReason, type OverlayTier, type Rect, type SurfaceAnchor, type SurfaceId, type SurfacePolicy } from '@shared/overlay'
import { unionRect } from '@shared/overlayLayout'

// The overlay host's bookkeeping, kept free of Electron so the policy rules
// are unit-tested (OV-01, OV-02): which instances are open, which
// are hidden until their tab returns, which are exiting, what a tab switch,
// a scroll or an outside press does to each, and the union the interactive
// view is sized to.

export interface OverlayInstance {
  id: string
  surface: SurfaceId
  tier: OverlayTier
  anchor: SurfaceAnchor
  props: unknown
  /** The tab the surface belongs to (a tab anchor, or opts.tabId). */
  tabId: string | null
  seq: number
  /** Known once the renderer mounted the surface; until then the tier default applies. */
  policy: SurfacePolicy | null
  /** The drawn rect in window CSS px, as the renderer reported it. */
  rect: Rect | null
  /** Hidden while its tab is away (hide-until-return), or while its tab has no pane. */
  hidden: boolean
  /** Set once closing started: the result is already delivered and the exit plays. */
  closing: boolean
}

export type OverlayEffect =
  | { kind: 'close'; id: string; reason: OverlayDismissReason }
  | { kind: 'hide'; id: string }
  | { kind: 'show'; id: string }
  | { kind: 'reanchor'; id: string; anchor: SurfaceAnchor }

/** Policies a surface gets before its renderer reports the real one. */
export function defaultPolicy(surface: SurfaceId): SurfacePolicy {
  const tier = surfaceTier(surface)
  return tier === 'passive'
    ? { tier, size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'close', layer: 'hint', focus: false, exitMs: 100 }
    : { tier, size: 'fixed', outsideClick: 'close', blocksPage: false, onTabSwitch: 'close', layer: 'menu', focus: true, exitMs: 120 }
}

/** A popover an outside press would close (a menu, site info, the command bar): only one shows at a time. */
export function isTransient(p: SurfacePolicy): boolean {
  return p.tier === 'interactive' && p.outsideClick === 'close' && p.layer !== 'hint'
}

/** A window dialog (clear browsing data, the task manager), not a tab's own: it owns the window until answered. */
export function isWindowModal(p: SurfacePolicy): boolean {
  return p.tier === 'interactive' && p.layer === 'modal' && p.size !== 'fill-tab' && p.outsideClick === 'ignore'
}

export class OverlayState {
  readonly #instances = new Map<string, OverlayInstance>()
  #seq = 0

  add(input: { id: string; surface: SurfaceId; anchor: SurfaceAnchor; props: unknown; tabId?: string | null }): { instance: OverlayInstance; replaced: string[] } {
    const tabId = input.anchor.kind === 'tab' ? input.anchor.tabId : (input.tabId ?? null)
    // One instance per surface id, except stacked modals (a confirm over a sheet).
    const replaced = this.open()
      .filter((i) => i.surface === input.surface && (i.policy ?? defaultPolicy(i.surface)).layer !== 'modal')
      .map((i) => i.id)
    const instance: OverlayInstance = {
      id: input.id,
      surface: input.surface,
      tier: surfaceTier(input.surface),
      anchor: input.anchor,
      props: input.props,
      tabId,
      seq: ++this.#seq,
      policy: null,
      rect: null,
      hidden: false,
      closing: false,
    }
    this.#instances.set(instance.id, instance)
    return { instance, replaced }
  }

  get(id: string): OverlayInstance | undefined {
    return this.#instances.get(id)
  }

  /** Every instance, exiting ones included. */
  all(): OverlayInstance[] {
    return [...this.#instances.values()]
  }

  /** Instances that have not started closing. */
  open(): OverlayInstance[] {
    return this.all().filter((i) => !i.closing)
  }

  policyOf(i: OverlayInstance): SurfacePolicy {
    return i.policy ?? defaultPolicy(i.surface)
  }

  /**
   * Records the policy the renderer reported and returns the instances to
   * dismiss now that it is known (the host closes them as 'replaced'). Only
   * one transient popover shows at a time, the newest; a window modal
   * dismisses the popovers under it; and a popover can't open over a window
   * modal, so then the newcomer itself goes. Toasts, hints, bars and prompts
   * (outsideClick 'ignore') are left alone.
   */
  mounted(id: string, policy: SurfacePolicy): string[] {
    const i = this.#instances.get(id)
    if (!i) return []
    // The tier is fixed by the shared list; a renderer can't move a surface across tiers.
    i.policy = { ...policy, tier: i.tier }
    if (i.closing || i.hidden) return []
    const own = i.policy
    // Only surfaces whose policy is known: an unmounted one settles when it mounts.
    const others = this.open().filter((o) => o.id !== id && o.policy !== null && !o.hidden)
    if (isTransient(own)) {
      if (others.some((o) => isWindowModal(o.policy!))) return [id]
      if (others.some((o) => isTransient(o.policy!) && o.seq > i.seq)) return [id]
      return others.filter((o) => isTransient(o.policy!) && o.seq < i.seq).map((o) => o.id)
    }
    if (isWindowModal(own)) return others.filter((o) => isTransient(o.policy!)).map((o) => o.id)
    return []
  }

  setRect(id: string, rect: Rect | null): void {
    const i = this.#instances.get(id)
    if (i) i.rect = rect
  }

  update(id: string, props: unknown): boolean {
    const i = this.#instances.get(id)
    if (!i || i.closing) return false
    i.props = props
    return true
  }

  /** Starts the close; false when it was already closing or unknown (the result goes out once). */
  beginClose(id: string): boolean {
    const i = this.#instances.get(id)
    if (!i || i.closing) return false
    i.closing = true
    return true
  }

  remove(id: string): OverlayInstance | undefined {
    const i = this.#instances.get(id)
    this.#instances.delete(id)
    return i
  }

  setHidden(id: string, hidden: boolean): void {
    const i = this.#instances.get(id)
    if (i) i.hidden = hidden
  }

  /** What a tab switch does to each open surface (onTabSwitch). */
  tabSwitched(activeId: string | null, visibleTabIds: readonly string[]): OverlayEffect[] {
    const effects: OverlayEffect[] = []
    for (const i of this.open()) {
      const policy = this.policyOf(i)
      const own = i.tabId
      const stillVisible = own !== null && visibleTabIds.includes(own)
      switch (policy.onTabSwitch) {
        case 'stay':
          break
        case 'close':
          // A surface of a split pane that is still showing stays.
          if (own === null || !stillVisible) effects.push({ kind: 'close', id: i.id, reason: 'tab-switch' })
          break
        case 'hide-until-return':
          if (own !== null && !stillVisible && !i.hidden) effects.push({ kind: 'hide', id: i.id })
          else if (own !== null && stillVisible && i.hidden) effects.push({ kind: 'show', id: i.id })
          break
        case 'follow':
          // Follows the active tab: a tab anchor moves onto the new tab's pane.
          if (activeId && own !== activeId) {
            i.tabId = activeId
            if (i.anchor.kind === 'tab') i.anchor = { ...i.anchor, tabId: activeId }
            effects.push({ kind: 'reanchor', id: i.id, anchor: i.anchor })
          }
          break
      }
    }
    return effects
  }

  /** A page scrolled by (dx, dy) CSS px: page-anchored surfaces follow or close. */
  scrolled(tabId: string, dx: number, dy: number): OverlayEffect[] {
    const effects: OverlayEffect[] = []
    if (dx === 0 && dy === 0) return effects
    for (const i of this.open()) {
      if (i.tabId !== tabId || i.anchor.kind !== 'tab' || !i.anchor.rect) continue
      const mode = this.policyOf(i).onScroll
      if (mode === 'close') effects.push({ kind: 'close', id: i.id, reason: 'outside' })
      else if (mode === 'follow') {
        const rect = i.anchor.rect
        i.anchor = { ...i.anchor, rect: { ...rect, x: rect.x - dx, y: rect.y - dy } }
        effects.push({ kind: 'reanchor', id: i.id, anchor: i.anchor })
      }
    }
    return effects
  }

  /** A press outside the interactive surfaces (on the chrome or a page), or the window lost focus. */
  outsidePress(): OverlayEffect[] {
    return this.open()
      .filter((i) => i.tier === 'interactive' && this.policyOf(i).outsideClick === 'close')
      .map((i) => ({ kind: 'close', id: i.id, reason: 'outside' }) as const)
  }

  /** Closes everything that matches; used by closeAll and a crashed renderer. */
  matching(filter: (i: OverlayInstance) => boolean): OverlayInstance[] {
    return this.open().filter(filter)
  }

  /** Instances drawn in a tier right now (exiting ones too: they are still on screen). */
  shown(tier: OverlayTier): OverlayInstance[] {
    return this.all().filter((i) => i.tier === tier && !i.hidden)
  }

  /** The window CSS rect the interactive view must cover, or null when nothing is drawn. */
  interactiveUnion(viewport: Rect): Rect | null {
    const rects = this.shown('interactive').map((i) => {
      const size = this.policyOf(i).size
      return size === 'fill-window' ? viewport : i.rect
    })
    return unionRect(rects)
  }

  /** A modal is open: page views stay but the passive tier hides (it would sit above the modal). */
  modalOpen(): boolean {
    return this.shown('interactive').some((i) => this.policyOf(i).layer === 'modal')
  }

  /** A whole-window dialog layer is open and not yet closing, so the chrome veils itself. */
  veiled(): boolean {
    return this.shown('interactive').some((i) => !i.closing && this.policyOf(i).veil === true)
  }

  /** Something open blocks the page (a cover or a blocking modal). */
  blocksPage(): boolean {
    return this.shown('interactive').some((i) => this.policyOf(i).blocksPage)
  }

  /** The newest open instance that takes focus. */
  focusOwner(): OverlayInstance | null {
    const focusable = this.shown('interactive').filter((i) => !i.closing && this.policyOf(i).focus)
    return focusable.sort((a, b) => b.seq - a.seq)[0] ?? null
  }
}

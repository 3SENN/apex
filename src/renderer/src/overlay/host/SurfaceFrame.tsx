/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { OverlayTier, Rect } from '@shared/overlay'
import { EMPTY_RECT, exitDuration, placeSurface, zIndexFor } from '@shared/overlayLayout'
import { apex } from '../../api'
import { useMotion } from '../../ui/motion'
import { surfaceModule } from '../registry'
import type { SurfaceComponentProps, SurfaceModule } from '../types'
import { removeHosted, setHostedRect, type HostedInstance } from './store'
import { viewportVars } from './viewport'

// One mounted surface in an overlay tier: validates its props with the
// module's schema, reports its policy and drawn rect to main, places itself
// beside its anchor (inside the window), takes focus when its policy says
// so, and plays its exit before telling main it is gone (OV-02, DS-82).

const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function SurfaceFrame({ item, tier }: { item: HostedInstance; tier: OverlayTier }): ReactElement | null {
  const { message } = item
  const id = message.instanceId
  const module = surfaceModule(message.surface) as SurfaceModule<unknown> | null
  const parsed = useMemo(() => module?.props.safeParse(message.props), [module, message.props])
  const motion = useMotion()
  const frame = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [exiting, setExiting] = useState(false)
  const viewport = message.viewport ?? EMPTY_RECT
  const policy = module?.policy

  // A surface this renderer can't draw is dismissed at once, so the opener never waits.
  useEffect(() => {
    if (module && parsed?.success) return
    console.error(`Overlay surface ${message.surface} ${module ? 'got invalid props' : 'is not registered'}.`, parsed && !parsed.success ? parsed.error.issues : '')
    apex.overlay.dismiss(id, 'closed')
    removeHosted(id)
  }, [module, parsed, id, message.surface])

  useEffect(() => {
    if (policy) apex.overlay.mounted(id, policy)
  }, [id, policy])

  // Natural size of fixed surfaces; fill surfaces take their area.
  useLayoutEffect(() => {
    const el = frame.current
    if (!el || policy?.size !== 'fixed') return
    const measure = (): void => {
      const next = { width: el.offsetWidth, height: el.offsetHeight }
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [policy?.size, item.version])

  const rect: Rect | null = useMemo(() => {
    if (!policy || message.hidden) return null
    if (policy.size === 'fill-window') return viewport
    if (policy.size === 'fill-tab') return message.rect ?? viewport
    if (!size) return null
    const anchor = message.rect ?? { x: viewport.width / 2, y: 0, width: 0, height: 0 }
    const placement = typeof module?.placement === 'function' ? module.placement(parsed?.success ? parsed.data : undefined) : module?.placement
    return placeSurface(anchor, size, viewport, placement ?? 'below', module?.gap ?? 6)
  }, [policy, message.hidden, message.rect, viewport, size, module, parsed])

  useEffect(() => {
    setHostedRect(id, rect)
    apex.overlay.reportBounds(id, rect ?? EMPTY_RECT)
  }, [id, rect])

  // Focus moves in for focus surfaces; main focused this renderer's view.
  useEffect(() => {
    if (tier !== 'interactive' || !policy?.focus || !rect) return
    const el = frame.current
    if (!el || el.contains(document.activeElement)) return
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(TABBABLE) ?? el
    target.focus({ preventScroll: true })
    // Only on the first placement: later moves must not steal focus back.
  }, [tier, policy?.focus, rect !== null])

  // The exit: stays mounted for its policy's exitMs (none under reduced motion), then goes.
  useEffect(() => {
    if (!item.closing || !policy) return
    setExiting(true)
    const ms = exitDuration(policy, motion.reduced)
    const timer = setTimeout(() => removeHosted(id), ms)
    return () => clearTimeout(timer)
  }, [item.closing, policy, motion.reduced, id])

  if (!module || !parsed?.success || !policy) return null
  const Component = module.component
  const props: SurfaceComponentProps<unknown> = {
    instanceId: id,
    props: parsed.data,
    anchor: message.anchor,
    windowId: message.windowId,
    resolve: (value) => apex.overlay.resolve(id, value),
    close: () => apex.overlay.dismiss(id, 'closed'),
    reportBounds: (r) => apex.overlay.reportBounds(id, r),
    exiting,
    anchorRect: message.rect ?? null,
    viewport,
    tabId: message.tabId ?? null,
    shown: rect !== null,
  }
  const placed = rect ?? (policy.size === 'fixed' ? { x: 0, y: 0, width: 0, height: 0 } : viewport)
  return (
    <div
      ref={frame}
      className="ov-frame"
      data-surface={message.surface}
      data-layer={policy.layer}
      data-size={policy.size}
      data-exiting={exiting || undefined}
      data-placed={rect ? '' : undefined}
      tabIndex={-1}
      hidden={message.hidden || undefined}
      style={{
        left: placed.x,
        top: placed.y,
        ...(policy.size === 'fixed' ? {} : { width: placed.width, height: placed.height }),
        zIndex: zIndexFor(policy.layer, item.seq),
        ['--ov-exit-ms' as string]: `${exitDuration(policy, motion.reduced)}ms`,
        ...viewportVars(viewport),
      }}
    >
      <Component {...props} />
    </div>
  )
}

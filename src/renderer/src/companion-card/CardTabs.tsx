/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { cx, panelDomId, tabDomId } from '../ui'
import { rovingIndex } from '../ui/logic/keys'
import { underlineFor } from './logic/cardLayout'

// The card's tab row: neutral 14 px labels with one full-ink underline that
// glides to the active tab, and only the active tab showing its icon, which
// grows in while the old one collapses. Labels reserve their medium-weight
// width, so switching never shifts the row.

export interface CardTab {
  id: string
  label: string
  icon: ReactNode
}

interface CardTabsProps {
  tabs: readonly CardTab[]
  value: string
  onChange(id: string): void
  label: string
  idPrefix: string
  className?: string
}

export function CardTabs({ tabs, value, onChange, label, idPrefix, className }: CardTabsProps): ReactElement {
  const row = useRef<HTMLDivElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const labels = useRef<Array<HTMLSpanElement | null>>([])
  const [widths, setWidths] = useState<number[]>([])
  // The first placement doesn't glide; later ones do.
  const [placed, setPlaced] = useState(false)
  const active = tabs.findIndex((t) => t.id === value)

  useLayoutEffect(() => {
    const measure = (): void => {
      const next = labels.current.slice(0, tabs.length).map((el) => el?.offsetWidth ?? 0)
      setWidths((w) => (w.length === next.length && w.every((v, i) => v === next[i]) ? w : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    labels.current.forEach((el) => el && observer.observe(el))
    // Inter can finish loading after the first layout.
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [tabs.length])

  const line = widths.length === tabs.length ? underlineFor(widths, active) : null
  useEffect(() => {
    if (!line || placed) return
    const frame = requestAnimationFrame(() => setPlaced(true))
    return () => cancelAnimationFrame(frame)
  }, [line !== null, placed])

  // Keep the active tab in view when the row overflows (only the row scrolls).
  useEffect(() => {
    const el = buttons.current[active]
    const r = row.current
    if (!el || !r || r.scrollWidth <= r.clientWidth) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < r.scrollLeft) r.scrollLeft = left
    else if (right > r.scrollLeft + r.clientWidth) r.scrollLeft = right - r.clientWidth
  }, [active])

  // An overflowing row scrolls sideways with the wheel.
  useEffect(() => {
    const el = row.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={row} role="tablist" aria-label={label} aria-orientation="horizontal" className={cx('co-tabs', className)}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            buttons.current[i] = el
          }}
          id={tabDomId(idPrefix, tab.id)}
          type="button"
          role="tab"
          aria-selected={i === active}
          aria-controls={panelDomId(idPrefix, tab.id)}
          tabIndex={i === (active >= 0 ? active : 0) ? 0 : -1}
          className="co-tabs__tab"
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, i, tabs.length)
            if (next === null) return
            e.preventDefault()
            buttons.current[next]?.focus()
            const target = tabs[next]
            if (target) onChange(target.id)
          }}
        >
          <span className="co-tabs__icon" aria-hidden="true">
            {tab.icon}
          </span>
          <span
            ref={(el) => {
              labels.current[i] = el
            }}
            className="co-tabs__label"
            data-text={tab.label}
          >
            <span>{tab.label}</span>
          </span>
        </button>
      ))}
      {line && <span className="co-tabs__line" data-glide={placed || undefined} style={{ transform: `translateX(${line.left}px)`, width: line.width }} aria-hidden="true" />}
    </div>
  )
}

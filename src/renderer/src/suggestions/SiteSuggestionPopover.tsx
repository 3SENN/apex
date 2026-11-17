/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The toolbar's site-suggestion popover (OV-23, overlay surface
// `site-suggestion`): the same offer as the panel card, hanging under the
// toolbar button, drafting into the attached chat or a new one. Esc closes;
// focus starts on the first task.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { anchorBelow } from '@shared/extensions'
import type { SiteSuggestionSurfaceProps } from '@shared/overlay/site-suggestions'
import type { SurfaceComponentProps } from '../overlay/types'
import { SuggestionBody } from './SuggestionBody'
import { useSiteSuggestion } from './suggestionData'

const WIDTH = 320

type Props = SurfaceComponentProps<SiteSuggestionSurfaceProps['site-suggestion']>

export function SiteSuggestionPopover({ props, anchor, close, reportBounds }: Props): ReactElement | null {
  const suggestion = useSiteSuggestion(props.tabId)
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(160)
  const [seen, setSeen] = useState(false)
  const rect = anchor.kind === 'window' ? anchor.rect : { x: window.innerWidth - 48, y: 4, width: 32, height: 32 }
  const place = anchorBelow(rect, { width: WIDTH, height }, { width: window.innerWidth, height: window.innerHeight })

  useEffect(() => {
    if (suggestion) setSeen(true)
    // The suggestion went away (dismissed, the page changed): the popover goes with it.
    else if (seen) close()
  }, [suggestion, seen])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      setHeight(el.scrollHeight)
      const r = el.getBoundingClientRect()
      reportBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [reportBounds, suggestion !== null])

  useEffect(() => {
    if (suggestion) box.current?.querySelector<HTMLElement>('.pl-suggest__task, button')?.focus()
  }, [suggestion !== null])

  if (!suggestion) return null
  return (
    <div
      ref={box}
      style={{ position: 'absolute', left: place.x, top: place.y, width: place.width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      <SuggestionBody suggestion={suggestion} chatId={props.chatId} variant="popover" onDone={close} />
    </div>
  )
}

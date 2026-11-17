/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import type { SplitMenuChoice, SplitMenuProps } from '@shared/overlay/tabs'
import { call, errorText } from '../../api'
import { t } from '@shared/i18n/core'
import { openTabsSurface, resultValue, type OpenSurface } from '../../overlay/surfaces/tabs/open'
import { toast } from '../../ui'
import { isEven, sideOf } from './logic'

// The split menu (SH-40) from the toolbar's split button: swap, reset to
// even widths, close the left or right page, and separate. It closes on a
// window resize, on blur or a click outside (the overlay's policy) and when
// the split ends.

export function splitMenuProps(snapshot: TabsSnapshot): SplitMenuProps | null {
  const split = snapshot.split
  if (!split) return null
  const find = (id: string): TabInfo | undefined => snapshot.tabs.find((tab) => tab.id === id)
  const left = find(split.primaryId)
  const right = find(split.secondaryId)
  if (!left || !right) return null
  const page = (tab: TabInfo) => ({ tabId: tab.id, title: tab.title || t('tabs.card.newTab'), favicon: tab.favicon })
  return { left: page(left), right: page(right), even: isEven(snapshot.splitRatio ?? 0.5), focused: sideOf(split, snapshot.activeId) ?? 'left' }
}

export function runSplitChoice(choice: SplitMenuChoice): void {
  const fail = (err: unknown): void => {
    toast.show({ message: t('tabs.error.action', { what: t('tabs.error.split'), reason: errorText(err) }), tone: 'error' })
  }
  switch (choice) {
    case 'swap':
      return void call('split', 'swap').catch(fail)
    case 'reset':
      return void call('split', 'reset').catch(fail)
    case 'close-left':
      return void call('split', 'closeSide', 'left').catch(fail)
    case 'close-right':
      return void call('split', 'closeSide', 'right').catch(fail)
    case 'separate':
      return void call('split', 'separate').catch(fail)
  }
}

const CHOICES: readonly SplitMenuChoice[] = ['swap', 'reset', 'close-left', 'close-right', 'separate']

/** The toolbar button's handle on the menu: open it under the button; it follows the split while open. */
export function useSplitMenu(snapshot: TabsSnapshot): { open(anchor: Element): void; isOpen: boolean } {
  const current = useRef<OpenSurface | null>(null)
  const [isOpen, setOpen] = useState(false)
  const key = snapshot.split ? `${snapshot.split.primaryId}|${snapshot.split.secondaryId}` : null
  const props = splitMenuProps(snapshot)
  const propsKey = JSON.stringify(props)

  // The split ended or changed pair: the menu goes.
  useEffect(() => () => current.current?.close(), [key])
  // Titles, focus and evenness stay current while it is open.
  useEffect(() => {
    if (props) current.current?.update(props)
  }, [propsKey])
  useEffect(() => {
    if (!isOpen) return
    const onResize = (): void => current.current?.close()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isOpen])

  return {
    isOpen,
    open: (anchor) => {
      if (current.current) {
        current.current.close()
        return
      }
      if (!props) return
      const r = anchor.getBoundingClientRect()
      void openTabsSurface('split-menu', { kind: 'window', rect: { x: r.left, y: r.top, width: r.width, height: r.height } }, props).then((s) => {
        if (!s) return
        current.current = s
        setOpen(true)
        void s.result.then((res) => {
          if (current.current === s) current.current = null
          setOpen(false)
          const value = resultValue(res)
          if (typeof value === 'string' && (CHOICES as readonly string[]).includes(value)) runSplitChoice(value as SplitMenuChoice)
        })
      })
    },
  }
}

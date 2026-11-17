/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement } from 'react'
import { z } from 'zod'
import type { MenuItemSpec } from '@shared/menu'
import { formatShortcut } from '../../ui/logic/shortcut'
import { MENU_POLICY, type SurfaceComponentProps, type SurfaceModule } from '../types'
import { CascadeMenu } from './CascadeMenu'
import { Popover } from './Popover'
import { unionBox, type Box } from './logic'
import type { KitItem } from './types'

// A plain in-window menu on the kit (DS-94): one card under or above an
// element, with cascading side cards. It is what ui/menu.ts's
// showPopoverMenu draws, for menus that need no surface of their own.

export interface PopoverMenuProps {
  items: KitItem[]
  label: string
  search?: string
  width?: number
  rowHeight?: number
  side: 'below' | 'above'
  align: 'start' | 'end'
  gap?: number
}

/** A native-menu spec as kit rows: separators, check and radio rows, accelerators, danger and submenus. */
export function fromSpec(items: readonly MenuItemSpec[], mac: boolean): KitItem[] {
  const out: KitItem[] = []
  for (const item of items) {
    if (item.type === 'separator') {
      if (out.length && out[out.length - 1]?.kind !== 'separator') out.push({ id: item.id, label: '', kind: 'separator' })
      continue
    }
    out.push({
      id: item.id,
      label: item.label,
      ...(item.enabled === false ? { disabled: true } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checkable: true } : {}),
      ...(item.danger ? { danger: true } : {}),
      ...(item.accelerator ? { shortcut: formatShortcut(item.accelerator, mac) } : {}),
      ...(item.submenu ? { submenu: fromSpec(item.submenu, mac) } : {}),
    })
  }
  while (out.length && out[out.length - 1]?.kind === 'separator') out.pop()
  return out
}

function PopoverMenu({ props, anchor, anchorRect, resolve, close, reportBounds }: SurfaceComponentProps<PopoverMenuProps>): ReactElement {
  const rect = anchorRect ?? (anchor.kind === 'window' ? anchor.rect : { x: 0, y: 0, width: 0, height: 0 })
  const root = useRef<Box | null>(null)
  const sub = useRef<Box | null>(null)
  const report = (): void => {
    const box = unionBox([root.current, sub.current].filter((b): b is Box => !!b))
    if (box) reportBounds({ x: box.left, y: box.top, width: box.width, height: box.height })
  }
  return (
    <Popover
      anchor={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      side={props.side}
      align={props.align}
      gap={props.gap ?? 4}
      width={props.width}
      rowHeight={props.rowHeight}
      label={props.label}
      onBounds={(box) => {
        root.current = box
        report()
      }}
    >
      <CascadeMenu
        items={props.items}
        label={props.label}
        search={props.search}
        handlers={{
          onChoose: (item) => resolve(item.id),
          // Switch and keep-open rows answer at once; the caller hears them through the result only when chosen.
          onAction: (item) => resolve(item.id),
          onDismiss: (refocus) => (refocus ? resolve(null) : close()),
        }}
        onSubmenusBounds={(box) => {
          sub.current = box
          report()
        }}
      />
    </Popover>
  )
}

/** Drawn by the chrome host only (its items carry React nodes, which can't cross to the overlay). */
export const popoverMenuSurface: SurfaceModule<PopoverMenuProps> = {
  component: PopoverMenu,
  props: z.custom<PopoverMenuProps>(),
  policy: MENU_POLICY,
}

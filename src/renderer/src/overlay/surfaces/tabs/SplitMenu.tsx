/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SplitMenuChoice, SplitMenuProps } from '@shared/overlay/tabs'
import { ArrowLeftRight, Columns2, Unlink2 } from 'lucide-react'
import { useT } from '../../../i18n/useT'
import { MenuList, type PopoverItem } from '../../../ui/MenuList'
import type { SurfaceComponentProps } from '../../types'
import { PageFavicon } from './cardParts'

// The split menu (SH-40), from the toolbar's split button: swap sides, reset
// to even widths (off when already even), close the left or right page
// (each with its favicon and title) and separate. Arrow keys move, Esc
// closes; it also closes on resize, blur, a click outside or the split ending.

export function splitMenuItems(props: SplitMenuProps, t: ReturnType<typeof useT>): PopoverItem[] {
  return [
    { id: 'swap', label: t('tabs.split.swap'), icon: <ArrowLeftRight size={15} aria-hidden /> },
    { id: 'reset', label: t('tabs.split.reset'), icon: <Columns2 size={15} aria-hidden />, disabled: props.even, title: props.even ? t('tabs.split.alreadyEven') : undefined },
    { id: 'sep-1', label: '', kind: 'separator' },
    { id: 'close-left', label: t('tabs.split.closeLeft', { title: props.left.title }), icon: <PageFavicon src={props.left.favicon} size={15} />, description: props.focused === 'left' ? t('tabs.split.focused') : undefined },
    { id: 'close-right', label: t('tabs.split.closeRight', { title: props.right.title }), icon: <PageFavicon src={props.right.favicon} size={15} />, description: props.focused === 'right' ? t('tabs.split.focused') : undefined },
    { id: 'sep-2', label: '', kind: 'separator' },
    { id: 'separate', label: t('tabs.split.separate'), icon: <Unlink2 size={15} aria-hidden /> },
  ]
}

export function SplitMenu({ props, resolve, close }: SurfaceComponentProps<SplitMenuProps>): ReactElement {
  const t = useT()
  return (
    <div className="ui-pop split-menu" style={{ ['--pop-row' as string]: '32px' }}>
      <MenuList items={splitMenuItems(props, t)} label={t('tabs.split.menuLabel')} onChoose={(id) => resolve(id as SplitMenuChoice)} onDismiss={() => close()} />
    </div>
  )
}

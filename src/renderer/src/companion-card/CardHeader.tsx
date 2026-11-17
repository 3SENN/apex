/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChevronsUpDown, EllipsisVertical, FileUp, X } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { CompanionAvatar } from '../components/sidebar/CompanionAvatar'
import { IconButton, showPopoverMenu, type PopoverItem } from '../ui'
import { switcherOrder } from './logic/cycle'
import { openCompanionImport, openNewCompanion } from './sheets'
import { useT } from '../i18n/useT'

interface CardHeaderProps {
  companion: Companion
  /** Every companion, for the switcher. */
  companions: readonly Companion[]
  titleId: string
  /** Saves pending edits first, then shows `id` in place, on the same tab. */
  onSwitch(id: string): void
  onMenu(anchor: HTMLElement): void
  onClose(): void
}

/**
 * One 52 px row: the switcher pill (face, name, chevron) on the left, and
 * only More and Close on the right. The name is edited in the hero, and the
 * save state floats under this row.
 */
export function CardHeader({ companion, companions, titleId, onSwitch, onMenu, onClose }: CardHeaderProps) {
  // DS-34: an in-card menu 224 wide, 6 px under the switcher: 40 px rows with
  // 28 px faces; the current row is neutral and semibold with an ink check;
  // then the create rows with their plus tiles.
  const t = useT()
  const openSwitcher = async (anchor: HTMLElement): Promise<void> => {
    const order = switcherOrder(companions, companion.id)
    const items: PopoverItem[] = [
      ...order.flatMap((id): PopoverItem[] => {
        const c = companions.find((x) => x.id === id)
        if (!c) return []
        const current = c.id === companion.id
        return [{ id: `companion:${c.id}`, label: c.name, description: c.hidden ? t('coCard.cardHeader.hidden') : undefined, icon: <CompanionAvatar companion={c} size={28} label="" />, trailing: 'check', checked: current, strong: current }]
      }),
      { id: 'sep', label: '', kind: 'separator' },
      { id: 'new', label: t('coCard.cardHeader.newCompanion'), kind: 'create' },
      { id: 'import', label: t('coCard.cardHeader.addFromFile'), kind: 'create', icon: <FileUp /> },
    ]
    const choice = await showPopoverMenu(items, anchor, { label: t('coCard.cardHeader.switchCompanion2'), width: 224, gap: 6, rowHeight: 40, className: 'co-switcher-menu' })
    if (!choice) return
    if (choice.startsWith('companion:')) {
      const id = choice.slice('companion:'.length)
      if (id !== companion.id) onSwitch(id)
    } else if (choice === 'new') openNewCompanion({ onCreated: (c) => onSwitch(c.id) })
    else if (choice === 'import') void openCompanionImport({ onCreated: (c) => onSwitch(c.id) })
  }

  return (
    <header className="co-card__header">
      {/* The dialog's name; the switcher's own label says what it does. */}
      <h2 id={titleId} className="ui-sr-only">
        {companion.name}
      </h2>
      <button type="button" className="co-switcher" aria-haspopup="menu" aria-label={t('coCard.cardHeader.switchCompanion', { name: companion.name })} onClick={(e) => void openSwitcher(e.currentTarget)}>
        <CompanionAvatar companion={companion} size={28} label="" className="co-switcher__face" />
        <span className="co-switcher__name">{companion.name}</span>
        {companion.hidden && <span className="co-switcher__note">{t('coCard.cardHeader.hidden')}</span>}
        <ChevronsUpDown className="co-switcher__chevron" aria-hidden />
      </button>
      <div className="co-card__actions">
        <IconButton label={t('coCard.cardHeader.moreFor', { name: companion.name })} icon={<EllipsisVertical />} size="md" className="co-round" aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)} />
        <IconButton label={t('coCard.cardHeader.close')} shortcut="Escape" icon={<X />} size="md" className="co-round" onClick={onClose} data-skip-autofocus />
      </div>
    </header>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type CSSProperties, type ReactElement } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { FaceAvatar } from '../../companion'
import { menuSeparator, showMenu, type MenuItemSpec } from '../../ui'
import { nameColor } from './newtabLogic'
import { useT } from '../../i18n/useT'

export interface SwitcherPillProps {
  /** Who takes the next chat. */
  selected: Companion
  /** Every visible companion; in picker mode they all sit in the pill. */
  companions: readonly Companion[]
  /** Picker mode lists everyone in the pill; floor mode shows only the selected one (the rest stand on the floor). */
  listAll: boolean
  onChoose(id: string): void
  onAdd(): void
  onOpenCard(id: string): void
}

/** The companion colour as text that reads on the raised surface in both modes (DS-139). */
function nameColors(companion: Companion): CSSProperties {
  const skin = companion.look.colors.skin
  return { ['--name-light' as string]: nameColor(skin, 'light'), ['--name-dark' as string]: nameColor(skin, 'dark') }
}

/**
 * The switcher at the top centre of the new tab (DS-77): a grey track with
 * the selected companion's segment (its face and name in its colour) and an
 * add segment. The selected segment opens a companion menu; in picker mode
 * the other companions sit in the track as faces, one click away.
 */
export function SwitcherPill({ selected, companions, listAll, onChoose, onAdd, onOpenCard }: SwitcherPillProps): ReactElement {
  const t = useT()
  const segment = useRef<HTMLButtonElement>(null)
  const openMenu = async (): Promise<void> => {
    const anchor = segment.current
    if (!anchor) return
    const items: MenuItemSpec[] = [
      ...companions.map((c) => ({ id: `choose:${c.id}`, label: c.name, type: 'radio' as const, checked: c.id === selected.id })),
      menuSeparator(),
      { id: 'card', label: t('tabs.newTabSwitcherPill.openSCard', { name: selected.name }) },
      { id: 'add', label: t('tabs.newTabSwitcherPill.newCompanion') },
    ]
    const picked = await showMenu(items, anchor)
    if (!picked) return
    if (picked === 'card') onOpenCard(selected.id)
    else if (picked === 'add') onAdd()
    else if (picked.startsWith('choose:')) onChoose(picked.slice('choose:'.length))
  }
  return (
    <div className="nt-switcher" role="group" aria-label={t('tabs.newTabSwitcherPill.whoTakesYourNext')}>
      {(listAll ? companions : [selected]).map((c) =>
        c.id === selected.id ? (
          <button key={c.id} ref={segment} type="button" className="nt-switcher__selected" aria-haspopup="menu" aria-expanded="false" style={nameColors(c)} onClick={() => void openMenu()}>
            <FaceAvatar look={c.look} name={c.name} size={30} label="" />
            <span className="nt-switcher__name">{c.name}</span>
            <ChevronDown className="nt-switcher__chevron" aria-hidden />
          </button>
        ) : (
          <OtherSegment key={c.id} companion={c} onChoose={onChoose} />
        ),
      )}
      <button type="button" className="nt-switcher__add" onClick={onAdd}>
        <Plus aria-hidden />
        <span>{t('tabs.newTabSwitcherPill.add')}</span>
      </button>
    </div>
  )
}

function OtherSegment({ companion, onChoose }: { companion: Companion; onChoose(id: string): void }): ReactElement {
  const t = useT()
  return (
    <button type="button" className="nt-switcher__other" aria-label={t('tabs.newTabSwitcherPill.choose', { name: companion.name })} title={companion.name} onClick={() => onChoose(companion.id)}>
      <FaceAvatar look={companion.look} name={companion.name} size={30} label="" />
    </button>
  )
}

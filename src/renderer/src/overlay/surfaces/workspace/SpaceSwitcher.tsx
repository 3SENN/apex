/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { WorkspaceSurfaceProps } from '@shared/overlay/workspace'
import type { SpaceInfo } from '@shared/workspace'
import { call } from '../../../api'
import type { T } from '../../../i18n/useT'
import { useT } from '../../../i18n/useT'
import { MenuList, type PopoverItem } from '../../../ui/MenuList'
import { ProjectDot } from '../../../workspace/kit'
import type { SurfaceComponentProps } from '../../types'
import { SPACE_NEW, spaceRowId } from './spaceChoice'
import '../../../workspace/workspace.css'

// The space switcher, from the Space row at the top of
// the sidebar: every space of this window with its tab count, the current
// one checked, then New project…. Drawn in the overlay so it sits over page
// views in Apex's own menu style; arrow keys move, typing jumps, Esc closes.
// It resolves with the row's id and the Space row does the switch, so the
// toast and the project editor stay where they always were.

export function spaceSwitcherItems(spaces: readonly SpaceInfo[], t: T): PopoverItem[] {
  return [
    ...spaces.map(
      (s): PopoverItem => ({
        id: spaceRowId(s.projectId),
        label: s.name,
        icon: <ProjectDot color={s.color} />,
        description: t('workspace.space.tabs', { count: s.tabCount }),
        checked: s.active,
        strong: s.active,
        trailing: 'check',
      }),
    ),
    { id: 'space:sep', label: '', kind: 'separator' },
    { id: SPACE_NEW, label: t('workspace.space.newProject'), kind: 'create' },
  ]
}

export function SpaceSwitcher({ windowId, resolve, close }: SurfaceComponentProps<WorkspaceSurfaceProps['space-switcher']>): ReactElement {
  const t = useT()
  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null)

  // The host's own window, never one named in the props.
  useEffect(() => {
    let live = true
    Promise.resolve(call('spaces', 'list', windowId))
      .then((list) => {
        if (live) setSpaces(list)
      })
      .catch(() => {
        if (live) close()
      })
    return () => {
      live = false
    }
  }, [windowId])

  return (
    <div className="ui-pop space-switcher" style={{ ['--pop-row' as string]: '32px' }} aria-busy={spaces === null || undefined}>
      {spaces && <MenuList items={spaceSwitcherItems(spaces, t)} label={t('workspace.space.switcher')} onChoose={(id) => resolve(id)} onDismiss={() => close()} />}
    </div>
  )
}

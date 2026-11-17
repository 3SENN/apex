/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Space row at the top of the sidebar: hidden
// until a project exists. It names the current space (a project's tabs in
// this window, or "No project") and opens the switcher: every space with its
// tab count, then New project…. Switching shows that space's tabs and hides
// the rest, which stay open in their own spaces. The switcher is the overlay
// `space-switcher` surface; a native menu only without an overlay host.
import { useRef, type ReactElement } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { anchorFromElement, openSurface } from '../../overlay/useSurface'
import { SPACE_NEW, spaceChoice, spaceRowId, type SpaceChoice } from '../../overlay/surfaces/workspace/spaceChoice'
import { showMenu, toast } from '../../ui'
import { useTooltip } from '../../ui/Tooltip'
import { openProjectEditor } from '../../workspace/ProjectEditor'
import { useSpaces } from '../../workspace/data'
import { ProjectDot } from '../../workspace/kit'
import { activeSpace, spacesShown } from '../../workspace/logic'
import { fail } from '../../workspace/open'
import '../../workspace/projectMenuRunner'
import '../../workspace/workspace.css'

export function SpaceRow(): ReactElement | null {
  const t = useT()
  const spaces = useSpaces()
  const opening = useRef(false)
  const row = useRef<HTMLButtonElement>(null)
  const shown = spaces !== null && spacesShown(spaces)
  useTooltip(row, { label: t('workspace.space.switcher'), disabled: !shown })
  if (!spaces || !shown) return null
  const current = activeSpace(spaces)
  const name = current?.name ?? t('workspace.space.none')

  const switchTo = (projectId: string | null, label: string): void => {
    Promise.resolve(call('spaces', 'switchTo', projectId))
      .then(() => toast.show({ message: t('workspace.space.switched', { name: label }), tone: 'neutral', duration: 2000 }))
      .catch(fail)
  }

  // Without an overlay host (it is down, or not up yet) the same rows come as a native menu.
  const nativeMenu = async (anchor: Element): Promise<SpaceChoice | null> =>
    spaceChoice(
      await showMenu(
        [
          ...spaces.map((s) => ({
            id: spaceRowId(s.projectId),
            label: `${s.name}  ·  ${t('workspace.space.tabs', { count: s.tabCount })}`,
            type: 'checkbox' as const,
            checked: s.active,
          })),
          { id: 'space:sep', label: '', type: 'separator' as const },
          { id: SPACE_NEW, label: t('workspace.space.newProject') },
        ],
        anchor,
      ),
    )

  const choose = async (anchor: HTMLElement): Promise<SpaceChoice | null> => {
    try {
      const result = await openSurface('space-switcher', anchorFromElement(anchor), {})
      return spaceChoice('value' in result ? result.value : null)
    } catch {
      return nativeMenu(anchor)
    }
  }

  const open = async (anchor: HTMLElement): Promise<void> => {
    if (opening.current) return
    opening.current = true
    let choice: SpaceChoice | null
    try {
      choice = await choose(anchor)
    } finally {
      opening.current = false
    }
    if (!choice) return
    if (choice.kind === 'new') {
      const created = await openProjectEditor(null).catch((err: unknown) => {
        fail(err)
        return null
      })
      if (created) switchTo(created.id, created.name)
      return
    }
    const target = choice.projectId
    const space = spaces.find((s) => s.projectId === target)
    if (space && !space.active) switchTo(target, space.name)
  }

  return (
    <button ref={row} type="button" className="space-row" aria-haspopup="menu" aria-label={t('workspace.space.label', { name })} onClick={(e) => void open(e.currentTarget)}>
      <ProjectDot color={current?.color ?? null} />
      <span className="space-row__name">{name}</span>
      <ChevronsUpDown className="space-row__chevron" aria-hidden />
    </button>
  )
}

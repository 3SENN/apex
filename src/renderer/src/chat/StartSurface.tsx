/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useMemo, useRef, type ReactElement, type RefObject } from 'react'
import { Sofa } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { heroTint } from '../companion-card/logic/cardColors'
import { openNewCompanion } from '../companion-card/sheets'
import { Floor, type FloorHandle } from '../components/newtab/Floor'
import { InboxButton } from '../components/newtab/Inbox'
import { SwitcherPill } from '../components/newtab/SwitcherPill'
import { useCompanionFloor } from '../components/newtab/useCompanionFloor'
import { useShell } from '../components/shellContext'
import { useT } from '../i18n/useT'
import { IconButton } from '../ui'
import { useSettingsView, useTabs } from './hooks'

export interface StartChromeProps {
  /** The chat view; the floor keeps out of its composer, figure and ideas. */
  root: RefObject<HTMLElement | null>
  /** Who this empty chat is with. */
  companion: Companion
  /** Every visible companion. */
  companions: readonly Companion[]
  /** Another companion takes this chat (from the switcher, the floor or a drop on the composer). */
  onSwitch(companionId: string): void
}

/**
 * DS-72: an empty chat (page or panel) uses the start surface's composition,
 * like the new tab: the switcher pill at the top centre, the floor toggle and
 * notifications at the top right, and the other companions on the floor
 * around the composer when "Companions on New Tab" is on.
 */
export function StartChrome({ root, companion, companions, onSwitch }: StartChromeProps): ReactElement {
  const tr = useT()
  const shell = useShell()
  const settings = useSettingsView()
  const tabs = useTabs()
  const { on: floorOn, toggle } = useCompanionFloor()
  const stage = useRef<HTMLDivElement>(null)
  const floor = useRef<FloorHandle>(null)
  const composerBox = useRef<HTMLElement | null>(null)
  const figure = useRef<HTMLElement | null>(null)
  const ideas = useRef<HTMLElement | null>(null)
  // These live in ChatView's own tree; the floor finds them once they are laid out.
  useLayoutEffect(() => {
    const view = root.current
    composerBox.current = view?.querySelector<HTMLElement>('.chat-composer .chat-composer__box') ?? null
    figure.current = view?.querySelector<HTMLElement>('.chat-empty__companion') ?? null
    ideas.current = view?.querySelector<HTMLElement>('.chat-start__below .chat-ideas') ?? null
  })
  const avoid = useMemo(() => [composerBox, figure, ideas], [])
  const favicons = useMemo(() => [...new Set(tabs.tabs.filter((t) => t.favicon && /^https?:/.test(t.url)).map((t) => t.favicon as string))].slice(0, 6), [tabs.tabs])
  const userName = settings.userName?.trim() ?? ''
  const onFloor = companions.filter((c) => c.id !== companion.id)

  return (
    <>
      <div ref={stage} className="chat-start__stage" data-floor={floorOn ? 'on' : 'off'}>
        <Floor
          ref={floor}
          companions={onFloor}
          shown={floorOn}
          stageRef={stage}
          avoid={avoid}
          figureRef={figure}
          tint={heroTint(companion.look)}
          pulse={companion.id}
          dropRef={composerBox}
          favicons={favicons}
          youInitial={userName ? userName.charAt(0).toUpperCase() : null}
          onChoose={onSwitch}
          onDrag={() => undefined}
        />
      </div>
      <div className="chat-start__bar">
        <div className="chat-start__pill" role="group" aria-label={tr('tabs.chatStart.switch')}>
          <SwitcherPill selected={companion} companions={companions} listAll={!floorOn} onChoose={onSwitch} onAdd={() => openNewCompanion()} onOpenCard={(id) => shell.openCompanionCard(id)} />
        </div>
        <div className="chat-start__corner">
          <IconButton label={tr('tabs.newTab.floor')} icon={<Sofa />} pressed={floorOn} className="nt__round" onClick={toggle} />
          <InboxButton className="nt__arrive-last" />
        </div>
      </div>
    </>
  )
}

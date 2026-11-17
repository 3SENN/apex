/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { engineHasOwnAccount } from '@shared/engine'
import { useT } from '../../i18n/useT'
import { useTooltip } from '../../ui/Tooltip'
import { gaugeFraction, type SpendView } from '@shared/pricing'
import { KeyRound, UserRound } from 'lucide-react'
import { call } from '../../api'
import { useSpend } from '../../chat/hooks'
import { useShell } from '../shellContext'
import type { ShellMenuDeps } from './shellMenu'
import { openMainMenu as openMainMenuSurface } from '../../overlay/surfaces/menus/main-menu/open'
import { UpdatePill } from '../../updates/UpdatePill'

/** Your local initial, or a person glyph until you set a name. */
export function ProfileBadge({ name, avatar, size = 24 }: { name: string; avatar: string | null; size?: number }): ReactElement {
  const initial = name.trim().charAt(0).toUpperCase()
  return (
    <span className="profile-badge" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }} aria-hidden>
      {avatar ? <img src={avatar} alt="" draggable={false} /> : initial ? <span>{initial}</span> : <UserRound size={Math.round(size * 0.6)} />}
    </span>
  )
}

/** The footer ring as a gauge (DS-18): this month's spend on your key against your budget, full without one. */
function GaugeRing({ children, spend }: { children: ReactNode; spend: SpendView | null }): ReactElement {
  const fraction = spend ? gaugeFraction(spend) : 1
  return (
    <span className="profile-row__ring" style={{ '--gauge': fraction } as CSSProperties}>
      {children}
    </span>
  )
}

/**
 * Opens the main menu (DS-93): the in-window card built on the
 * overlay kit, above the footer or under the toolbar's menu button.
 */
export function openMainMenu(anchor: HTMLElement, deps: ShellMenuDeps, spend: SpendView | null = null): Promise<void> {
  return openMainMenuSurface(anchor, { settings: deps.settings, spend, renameWindow: deps.shell.renameWindow })
}

/**
 * The sidebar footer, with no divider above it: your local profile (a small
 * avatar in a gauge ring of your profile hue, then your name in the muted
 * tone) opens the main menu. On the right, a solid capsule in the profile
 * hue when something needs doing: today the API key; the update
 * prompt ("Restart to update") uses the same capsule.
 */
export function SidebarFooter({ deps }: { deps: Omit<ShellMenuDeps, 'shell'> }): ReactElement {
  const shell = useShell()
  const spend = useSpend()
  const { settings } = deps
  const name = settings.userName.trim()
  const t = useT()
  // DS-18, DS-95: the dark tooltip above the strip. The button is 36 px, but its hover fills the 44 px strip, so the tip is placed against the strip's top edge.
  const profile = useRef<HTMLButtonElement>(null)
  const strip = useRef<HTMLElement>(null)
  useTooltip(profile, { label: t('tabs.footer.tooltip'), side: 'top', anchor: strip })
  return (
    <footer ref={strip} className="side-footer">
      <button ref={profile} type="button" className="profile-row" aria-haspopup="menu" aria-label={t('tabs.sidebarFooter.mainMenu')} onClick={(e) => void openMainMenu(e.currentTarget, { ...deps, shell }, spend)}>
        <GaugeRing spend={spend}>
          <ProfileBadge name={name} avatar={settings.userAvatar} size={20} />
        </GaugeRing>
        <span className="profile-row__name">{name || t('tabs.sidebarFooter.you')}</span>
      </button>
      {/* Only the API-key engine needs a key; another engine signs in on its own. */}
      {!settings.hasApiKey && !engineHasOwnAccount(settings.engine) && (
        <button type="button" className="footer-capsule" onClick={() => void call('pages', 'open', 'apex://settings/model')} title={t('tabs.sidebarFooter.yourCompanionNeedsAn')}>
          <KeyRound size={12} aria-hidden />
          {t('tabs.sidebarFooter.addApiKey')}
        </button>
      )}
      {/* The update capsule (SH-16, DS-18); renders nothing until there is an update status to show. */}
      <UpdatePill />
    </footer>
  )
}

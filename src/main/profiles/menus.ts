/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MenuItemModel } from '@shared/menuModel'
import { profileTokens } from '@shared/profile'
import { profileInitial, type Profile } from '@shared/profiles'
import { t } from '@shared/i18n/core'

// The profile menus (SH-50, SH-51, SH-54, SH-60), as plain builders so they
// can be tested without Electron. service.ts registers them as menu
// contributions and runs their items.

export const PROFILE_MENU = {
  current: 'profile:current',
  switchMenu: 'profile:switch',
  switchTo: 'profile:switch:',
  add: 'profile:add',
  manage: 'profile:manage',
  import: 'profile:import',
  appMenu: 'profiles-menu',
  appTo: 'profiles-menu:',
  newWindowMenu: 'new-window-in-profile',
  newWindowIn: 'new-window-in-profile:',
  dockTo: 'dock-profile:',
  dockSeparator: 'dock-profile-separator',
} as const

/** The profile's initial on its hue (white semibold reads on it, CAPSULE_CONTRAST), as a 16 px image for menu rows. */
export function profileAvatarUrl(profile: Pick<Profile, 'name' | 'hue'>): string {
  const fill = profileTokens(profile.hue, 'light').hue
  const letter = profileInitial(profile.name).replace(/[<>&"']/g, '')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${fill}"/><text x="8" y="11.5" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="10" font-weight="600" fill="#ffffff">${letter}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/** The id a profile row stands for, or null. */
export function profileIdFromItem(itemId: string, prefix: string): string | null {
  if (!itemId.startsWith(prefix)) return null
  const id = itemId.slice(prefix.length)
  return /^[a-z0-9]{1,32}$/.test(id) ? id : null
}

/**
 * The main menu's profile block (SH-54). The popover head already shows the
 * person, their initial and the key status; this block adds the profile: the
 * current one on its hue once there are several, Switch ›, Manage and Import.
 */
export function profileBlockItems(profiles: readonly Profile[], currentId: string): MenuItemModel[] {
  const current = profiles.find((p) => p.id === currentId) ?? profiles[0]
  if (!current) return []
  const others = profiles.filter((p) => p.id !== current.id)
  return [
    ...(others.length ? [{ id: PROFILE_MENU.current, label: current.name, variant: 'header' as const, image: profileAvatarUrl(current) }] : []),
    {
      id: PROFILE_MENU.switchMenu,
      label: t('profiles.menu.switch'),
      icon: 'user',
      submenu: [
        { id: PROFILE_MENU.current, label: current.name, type: 'checkbox' as const, checked: true, enabled: false },
        ...others.map((p) => ({ id: `${PROFILE_MENU.switchTo}${p.id}`, label: p.name, image: profileAvatarUrl(p) })),
        { id: 'profile:switch-sep', label: '', type: 'separator' as const },
        { id: PROFILE_MENU.add, label: t('profiles.menu.add') },
      ],
    },
    { id: PROFILE_MENU.manage, label: t('profiles.menu.manage'), icon: 'settings' },
    { id: PROFILE_MENU.import, label: t('profiles.menu.import'), icon: 'download' },
  ]
}

/** App menu › Profiles (SH-50): each profile (the focused window's checked), Add… and Manage…. */
export function appProfilesItems(profiles: readonly Profile[], currentId: string): MenuItemModel[] {
  return [
    {
      id: PROFILE_MENU.appMenu,
      label: t('profiles.menu.profiles'),
      submenu: [
        ...profiles.map((p) => ({ id: `${PROFILE_MENU.appTo}${p.id}`, label: p.name, type: 'checkbox' as const, checked: p.id === currentId })),
        { id: 'profiles-menu-sep', label: '', type: 'separator' },
        { id: PROFILE_MENU.add, label: t('profiles.menu.add') },
        { id: PROFILE_MENU.manage, label: t('profiles.menu.manage') },
      ],
    },
  ]
}

/** File › New Window in Profile (SH-51), once there is more than one profile. */
export function newWindowItems(profiles: readonly Profile[]): MenuItemModel[] {
  if (profiles.length < 2) return []
  return [{ id: PROFILE_MENU.newWindowMenu, label: t('profiles.menu.newWindowIn'), submenu: profiles.map((p) => ({ id: `${PROFILE_MENU.newWindowIn}${p.id}`, label: p.name })) }]
}

/** The Dock menu's profile rows (SH-60), once there is more than one profile: each focuses its window or opens one. */
export function dockProfileItems(profiles: readonly Profile[]): MenuItemModel[] {
  if (profiles.length < 2) return []
  return [...profiles.map((p) => ({ id: `${PROFILE_MENU.dockTo}${p.id}`, label: p.name })), { id: PROFILE_MENU.dockSeparator, label: '', type: 'separator' as const }]
}

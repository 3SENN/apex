/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { Ban, BellOff, BellRing, CameraOff, MapPinOff, MicOff, ShieldAlert } from 'lucide-react'
import type { PermissionChipAnswer } from '@shared/overlay/sites'
import type { PermissionActivity, SitePermission } from '@shared/sites'
import { atelier, call } from '../api'
import { useT } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { openSiteInfo } from '../overlay/surfaces/sites/open'
import { macosPane, permissionChips, promptOrigin, type PermissionChip } from '../overlay/surfaces/sites/promptLogic'
import { cx } from '../ui'
import './permissionChips.css'

// The address pill's permission chips: what this page load asked for and
// didn't get, from main's permission activity (TabInfo.permissionActivity).
// A held-back notification request opens a small Allow / Don't allow popover;
// a permission macOS turned off opens one with its System Settings pane; a
// refused one opens site info, where it can be changed. The chips are plain
// buttons in the pill's tab order, and a live region says when a request is
// held back, since nothing else would.

const OFF_ICONS: Partial<Record<SitePermission, typeof Ban>> = { camera: CameraOff, microphone: MicOff, location: MapPinOff, notifications: BellOff }

function ChipIcon({ chip }: { chip: PermissionChip }): ReactElement {
  if (chip.kind === 'quiet') return <BellRing size={14} aria-hidden />
  const Icon = (chip.perms.length === 1 && OFF_ICONS[chip.perms[0]!]) || (chip.kind === 'macos' ? ShieldAlert : Ban)
  return <Icon size={14} aria-hidden />
}

export function PermissionChips({ tabId, activity }: { tabId: string; activity: readonly PermissionActivity[] }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState<PermissionChip['kind'] | null>(null)
  const chips = permissionChips(activity)
  const names = (perms: readonly SitePermission[]): string => perms.map((p) => t(`sites.perm.${p}`)).join(', ')
  const label = (chip: PermissionChip): string =>
    chip.kind === 'quiet'
      ? t('sites.chip.quiet', { host: promptOrigin(chip.origin).text })
      : chip.kind === 'macos'
        ? t('sites.chip.macos', { what: names(chip.perms) })
        : t('sites.chip.blocked', { what: names(chip.perms) })

  const act = (chip: PermissionChip, answer: PermissionChipAnswer): void => {
    if (answer.action === 'allow' || answer.action === 'block') void call('sites', 'answerQuiet', tabId, 'notifications', answer.action === 'allow')
    else if (answer.action === 'open-settings') {
      const pane = macosPane(chip.perms)
      if (pane) void call('sites', 'openSystemSettings', pane)
    } else if (answer.action === 'reload') void atelier.nav.reload(tabId)
  }

  const onClick = (chip: PermissionChip, el: HTMLElement): void => {
    if (chip.kind === 'blocked') {
      openSiteInfo(el, tabId)
      return
    }
    setOpen(chip.kind)
    openSurface('permission-chip', anchorFromElement(el), { tabId, kind: chip.kind, origin: chip.origin, perms: chip.perms }).then(
      (result) => {
        setOpen(null)
        if ('value' in result && result.value && typeof result.value === 'object') act(chip, result.value as PermissionChipAnswer)
      },
      () => setOpen(null),
    )
  }

  const quiet = chips.find((c) => c.kind === 'quiet')
  return (
    <span className="pill__perms">
      {chips.map((chip) => (
        <button
          key={chip.kind}
          type="button"
          className={cx('pill__perm', `pill__perm--${chip.kind}`)}
          aria-label={label(chip)}
          title={label(chip)}
          aria-haspopup="dialog"
          aria-expanded={chip.kind === 'blocked' ? undefined : open === chip.kind}
          onClick={(e) => onClick(chip, e.currentTarget)}
        >
          <ChipIcon chip={chip} />
        </button>
      ))}
      {/* Always mounted, so a request held back later is announced. */}
      <span className="ui-sr-only" role="status">
        {quiet ? label(quiet) : ''}
      </span>
    </span>
  )
}

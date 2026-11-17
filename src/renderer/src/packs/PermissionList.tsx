/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pack's permissions in plain words (docs/packs.md › Permissions in plain
// words): one line each, most serious first, with an icon for its level.
import type { ReactElement } from 'react'
import { AlertTriangle, Info, ShieldAlert, Sparkle } from 'lucide-react'
import type { PackPermissionLevel, PackPermissionLine } from '@shared/packs'
import { useT } from '../i18n/useT'
import { VisuallyHidden, cx } from '../ui'
import { isAdded } from './logic'

const ICONS: Record<PackPermissionLevel, ReactElement> = {
  info: <Sparkle aria-hidden="true" />,
  notice: <Info aria-hidden="true" />,
  warning: <AlertTriangle aria-hidden="true" />,
  danger: <ShieldAlert aria-hidden="true" />,
}

export function PermissionList({ lines, added, label }: { lines: readonly PackPermissionLine[]; added?: readonly PackPermissionLine[]; label: string }): ReactElement {
  const t = useT()
  if (lines.length === 0) return <p className="pk-muted pk-small">{t('packs.perm.none')}</p>
  return (
    <ul className="pk-perms" aria-label={label}>
      {lines.map((line, i) => {
        const fresh = added ? isAdded(line, added) : false
        return (
          <li key={`${line.kind}-${i}`} className={cx('pk-perm', `pk-perm--${line.level}`, fresh && 'pk-perm--new')} data-new={fresh ? t('packs.perm.new') : undefined}>
            {ICONS[line.level]}
            <span>
              <VisuallyHidden>{t(`packs.level.${line.level}`)}: </VisuallyHidden>
              {t(line.key, line.vars)}
              {fresh && <VisuallyHidden> ({t('packs.perm.new')})</VisuallyHidden>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

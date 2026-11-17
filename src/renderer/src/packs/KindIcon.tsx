/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pack's type as a small tinted tile (docs/packs.md): the same mark on its
// card, in its sheet and in the type filter, so an app, a game, a world,
// skills, a look, a companion and tools tell apart at a glance.
import type { ReactElement } from 'react'
import { AppWindow, Earth, Gamepad2, Package, Palette, Smile, WandSparkles, Wrench, type LucideIcon } from 'lucide-react'
import { cx } from '../ui'
import type { PackKind } from './logic'

const ICONS: Record<PackKind, LucideIcon> = {
  app: AppWindow,
  game: Gamepad2,
  world: Earth,
  skills: WandSparkles,
  look: Palette,
  companion: Smile,
  tools: Wrench,
  pack: Package,
}

export function KindIcon({ kind, size = 'md' }: { kind: PackKind; size?: 'sm' | 'md' | 'lg' }): ReactElement {
  const Icon = ICONS[kind]
  return (
    <span className={cx('pk-kind', `pk-kind--${kind}`, `pk-kind--${size}`)} aria-hidden="true">
      <Icon />
    </span>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement } from 'react'
import { Puzzle } from 'lucide-react'
import { EXTENSIONS_SETTINGS_URL, type ExtensionInfo } from '@shared/extensions'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { IconButton, confirm, cx, showMenu, toast } from '../ui'
import { ExtensionBadge, ExtensionIcon } from './ExtensionIcon'
import type { ExtensionsSlot } from '@shared/extensions'
import { useExtensionPrompts } from './promptBridge'
import { toolbarButtons, useExtensions } from './useExtensions'
import './extensions.css'

// The toolbar's extension slot (SH-32, SH-65, DS-24): on websites, pinned
// extensions (and an unpinned one while its popup is open) as buttons with
// their badge, then the Extensions button; on internal tab pages only the
// Extensions button, 8 px from the right edge. It also hosts the prompt
// listener, so it is mounted on every page and draws nothing where the
// cluster is empty.

export { extensionsSlot, type ExtensionsSlot } from '@shared/extensions'

function rectOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

export async function runExtension(ext: ExtensionInfo, anchor: HTMLElement): Promise<void> {
  try {
    await call('extensions', 'runAction', ext.id, rectOf(anchor))
  } catch (err) {
    toast.show({ tone: 'error', message: t('extensions.popover.failed', { name: ext.name, reason: errorText(err) }) })
  }
}

/** Remove, after the confirmation every remove path shares (SH-65, ST-40). */
export async function removeExtension(ext: Pick<ExtensionInfo, 'id' | 'name'>): Promise<void> {
  const ok = await confirm({ title: t('extensions.remove.title', { name: ext.name }), message: t('extensions.remove.body'), confirmLabel: t('extensions.action.remove'), destructive: true })
  if (!ok) return
  try {
    await call('extensions', 'remove', ext.id)
  } catch (err) {
    toast.show({ tone: 'error', message: t('extensions.settings.actionFailed', { reason: errorText(err) }) })
  }
}

function ExtensionButton({ ext }: { ext: ExtensionInfo }): ReactElement {
  const label = ext.badge ? t('extensions.toolbar.withBadge', { name: ext.title, badge: ext.badge.text }) : ext.title
  return (
    <IconButton
      label={label}
      className={cx('ext-btn', ext.popupOpen && 'ext-btn--open', !ext.pinned && 'ext-btn--temporary')}
      pressed={ext.hasPopup ? ext.popupOpen : undefined}
      aria-haspopup={ext.hasPopup ? 'dialog' : undefined}
      icon={<ExtensionIcon ext={ext} size={16} />}
      badge={ext.badge ? <ExtensionBadge badge={ext.badge} /> : undefined}
      onClick={(e) => void runExtension(ext, e.currentTarget)}
    />
  )
}

/** Before the overlay host is up, the list opens as a native menu with the same actions. */
async function fallbackMenu(items: readonly ExtensionInfo[], anchor: HTMLElement): Promise<void> {
  const runnable = items.filter((e) => e.enabled && e.supported)
  const picked = await showMenu(
    [
      ...runnable.map((e) => ({ id: `run:${e.id}`, label: e.name })),
      ...(runnable.length ? [{ id: 'sep', label: '', type: 'separator' as const }] : []),
      ...(items.length === 0 ? [{ id: 'store', label: t('extensions.popover.find') }] : []),
      { id: 'manage', label: t('extensions.popover.manageAll') },
    ],
    anchor,
  )
  if (!picked) return
  if (picked === 'store') return void call('extensions', 'openStore')
  if (picked === 'manage') return void call('pages', 'open', EXTENSIONS_SETTINGS_URL)
  const ext = runnable.find((e) => `run:${e.id}` === picked)
  if (ext) void runExtension(ext, anchor)
}

function ExtensionsMenuButton({ items }: { items: readonly ExtensionInfo[] }): ReactElement {
  const button = useRef<HTMLButtonElement>(null)
  const open = async (): Promise<void> => {
    const el = button.current
    if (!el) return
    el.setAttribute('aria-expanded', 'true')
    try {
      const result = await openSurface('extensions-popover', anchorFromElement(el), {})
      // The popover hands back what needs the chrome: a confirmed remove.
      const value = 'value' in result ? (result.value as { kind?: string; id?: string; name?: string } | null) : null
      if (value?.kind === 'remove' && value.id && value.name) await removeExtension({ id: value.id, name: value.name })
    } catch {
      await fallbackMenu(items, el)
    } finally {
      el.setAttribute('aria-expanded', 'false')
    }
  }
  return (
    <IconButton
      ref={button}
      label={t('extensions.toolbar.button')}
      aria-haspopup="dialog"
      aria-expanded={false}
      className="ext-menu-btn"
      icon={<Puzzle />}
      onClick={() => void open()}
    />
  )
}

export function ExtensionsToolbar({ slot }: { slot: ExtensionsSlot }): ReactElement | null {
  const { items } = useExtensions()
  useExtensionPrompts()
  if (!slot) return null
  const buttons = slot === 'website' ? toolbarButtons(items) : []
  return (
    <div className={cx('ext-cluster', `ext-cluster--${slot}`)} role="group" aria-label={t('extensions.toolbar.button')}>
      {buttons.map((ext) => (
        <ExtensionButton key={ext.id} ext={ext} />
      ))}
      <ExtensionsMenuButton items={items} />
    </div>
  )
}

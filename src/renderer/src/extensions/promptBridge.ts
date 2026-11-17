/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExtensionInstallPrompt, ExtensionNativePrompt } from '@shared/extensions'
import { call, useAppEvent } from '../api'
import { t } from '@shared/i18n/core'
import { openSurface } from '../overlay/useSurface'
import { confirm } from '../ui'

// The chrome's side of the extension prompts (OV-16): main sends the
// question to the asking profile's focused window; the chrome shows it as an
// overlay surface, and the surface answers main. A dismissal (Esc, a click
// outside, a closed window) counts as no. Before the overlay host is up, the
// kit's confirmation asks the same question in the chrome.

const answered = new Set<string>()

function respondInstall(id: string, allow: boolean): void {
  if (answered.has(id)) return
  answered.add(id)
  void call('extensions', 'respondInstall', id, allow)
}

function respondNative(id: string, decision: 'once' | 'always' | 'deny'): void {
  if (answered.has(id)) return
  answered.add(id)
  void call('extensions', 'respondNative', id, decision)
}

/** The permissions as one plain list for the fallback dialog. */
function listText(lines: readonly string[]): string {
  return lines.map((l) => `• ${l}`).join('\n')
}

async function showInstall(prompt: ExtensionInstallPrompt): Promise<void> {
  try {
    const result = await openSurface('extension-install-prompt', { kind: 'point', x: 0, y: 0 }, { prompt })
    if ('value' in result) respondInstall(prompt.id, result.value === true)
    else respondInstall(prompt.id, false)
    return
  } catch {
    // No overlay host yet: ask in the chrome instead.
  }
  if (prompt.unsupportedReason) {
    await confirm({ title: t('extensions.unsupported.title'), message: prompt.unsupportedReason, confirmLabel: t('extensions.unsupported.ok'), cancelLabel: t('extensions.action.cancel') })
    return respondInstall(prompt.id, false)
  }
  const lines = prompt.permissions.map((p) => p.label)
  const optional = prompt.kind === 'install' && prompt.optional.length ? `\n\n${t('extensions.install.later')}\n${listText(prompt.optional.map((p) => p.label))}` : ''
  const body = lines.length ? `${prompt.kind === 'optional' ? t('extensions.optional.body') : t('extensions.install.canDo')}\n${listText(lines)}` : t('extensions.install.nothingExtra')
  const ok = await confirm({
    title: prompt.kind === 'optional' ? t('extensions.optional.title', { name: prompt.name }) : t('extensions.install.title', { name: prompt.name }),
    message: body + optional,
    confirmLabel: prompt.kind === 'optional' ? t('extensions.optional.allow') : t('extensions.install.add'),
    cancelLabel: prompt.kind === 'optional' ? t('extensions.optional.deny') : t('extensions.install.cancel'),
  })
  respondInstall(prompt.id, ok)
}

async function showNative(prompt: ExtensionNativePrompt): Promise<void> {
  try {
    const result = await openSurface('extension-native-prompt', { kind: 'point', x: 0, y: 0 }, { prompt })
    const value = 'value' in result ? result.value : null
    respondNative(prompt.id, value === 'once' || value === 'always' ? value : 'deny')
    return
  } catch {
    // No overlay host yet: a yes or no in the chrome (yes allows once).
  }
  const ok = await confirm({
    title: t('extensions.native.title', { extension: prompt.extensionName, host: prompt.host }),
    message: t('extensions.native.body'),
    confirmLabel: t('extensions.native.once'),
    cancelLabel: t('extensions.native.deny'),
  })
  respondNative(prompt.id, ok ? 'once' : 'deny')
}

/** Mount once in the chrome: it turns main's questions into prompts. */
export function useExtensionPrompts(): void {
  useAppEvent('extension-install-prompt', (e) => void showInstall(e.prompt))
  useAppEvent('extension-native-prompt', (e) => void showNative(e.prompt))
}

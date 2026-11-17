/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The proxy form's rules, pure so they are unit-tested: which
// fields a mode shows, whether the draft differs from what is applied, and
// the message for each validation issue (shared/proxy.ts validates).
import type { ProxyMode, ProxySettings } from '@shared/ipc'
import type { ProxyField, ProxyIssue } from '@shared/proxy'
import type { MessageKey } from '@shared/i18n/core'

export const PROXY_MODES: readonly ProxyMode[] = ['system', 'direct', 'manual', 'pac']

/** The fields each mode shows, in order. */
export function proxyFields(mode: ProxyMode): ProxyField[] {
  if (mode === 'manual') return ['http', 'https', 'socks', 'bypass']
  if (mode === 'pac') return ['pacUrl', 'bypass']
  return []
}

/** Modes without fields apply as soon as they are picked; the others wait for Apply. */
export function appliesAtOnce(mode: ProxyMode): boolean {
  return proxyFields(mode).length === 0
}

/** Whether the draft would change what main applies (fields a mode hides don't count). */
export function proxyDirty(draft: ProxySettings, applied: ProxySettings): boolean {
  if (draft.mode !== applied.mode) return true
  return proxyFields(draft.mode).some((f) => draft[f].trim() !== applied[f].trim())
}

export function issueMessage(issue: ProxyIssue): MessageKey {
  switch (issue) {
    case 'required':
      return 'safety.proxy.error.required'
    case 'host':
      return 'safety.proxy.error.host'
    case 'port':
      return 'safety.proxy.error.port'
    case 'scheme':
      return 'safety.proxy.error.scheme'
    case 'url':
      return 'safety.proxy.error.url'
    case 'rule':
      return 'safety.proxy.error.rule'
  }
}

/** A pac 'required' issue gets its own wording. */
export function fieldIssueMessage(field: ProxyField, issue: ProxyIssue): MessageKey {
  return field === 'pacUrl' && issue === 'required' ? 'safety.proxy.error.pacRequired' : issueMessage(issue)
}

export const FIELD_LABEL: Record<ProxyField, MessageKey> = {
  http: 'safety.proxy.http',
  https: 'safety.proxy.https',
  socks: 'safety.proxy.socks',
  pacUrl: 'safety.proxy.pacUrl',
  bypass: 'safety.proxy.bypass',
}

export const FIELD_HINT: Record<ProxyField, MessageKey> = {
  http: 'safety.proxy.serverHint',
  https: 'safety.proxy.serverHint',
  socks: 'safety.proxy.socksHint',
  pacUrl: 'safety.proxy.pacHint',
  bypass: 'safety.proxy.bypassHint',
}

export const MODE_LABEL: Record<ProxyMode, MessageKey> = {
  system: 'safety.proxy.system',
  direct: 'safety.proxy.direct',
  manual: 'safety.proxy.manual',
  pac: 'safety.proxy.pac',
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { checkConnectorUrl, executionOf, LOGO_MAX_BYTES, type ConnectorAuth, type ConnectorInputV2, type UrlProblem } from '@shared/connectors'
import type { MessageKey } from '@shared/i18n/core'
import type { Connector } from '@shared/services'
import type { FieldError } from './schemaForm'

// SK-15: the add custom server dialog's draft and its checks. Each problem is
// keyed by the field it belongs to, so the form marks that field; main runs
// the same rules again on save (config.ts).

export type ServerMode = 'remote' | 'local' | 'json'
export type DraftAuth = 'none' | 'bearer' | 'api-key'

export interface EnvRow {
  /** React key; stable while the row lives. */
  rowId: string
  name: string
  /** Empty with `saved` keeps the stored value. */
  value: string
  secret: boolean
  /** A value is stored in main (never sent here). */
  saved: boolean
  revealed: boolean
}

export interface ServerDraft {
  id?: string
  displayName: string
  /** undefined keeps the saved logo, null removes it. */
  logo: string | null | undefined
  mode: ServerMode
  url: string
  command: string
  args: string[]
  env: EnvRow[]
  cwd: string
  json: string
  auth: DraftAuth
  /** Empty with `hasSecret` keeps the stored secret. */
  secret: string
  hasSecret: boolean
  removeSecret: boolean
  headerName: string
  owner?: string
}

export type DraftErrors = Record<string, FieldError>

let rows = 0
export function envRow(over: Partial<EnvRow> = {}): EnvRow {
  rows += 1
  return { rowId: `env-${rows}`, name: '', value: '', secret: false, saved: false, revealed: false, ...over }
}

export function emptyDraft(mode: ServerMode = 'remote'): ServerDraft {
  return { displayName: '', logo: undefined, mode, url: '', command: '', args: [], env: [], cwd: '', json: '', auth: 'none', secret: '', hasSecret: false, removeSecret: false, headerName: '' }
}

/** A custom connector as the dialog edits it. Values of stored secrets never come back. */
export function draftFromConnector(c: Connector): ServerDraft {
  const base = { ...emptyDraft(c.transport.kind === 'local' ? 'local' : 'remote'), id: c.id, displayName: c.displayName, hasSecret: c.hasSecret, owner: c.owner }
  const auth: DraftAuth = c.auth === 'api-key' ? 'api-key' : c.auth === 'bearer' ? 'bearer' : 'none'
  if (c.transport.kind === 'remote') return { ...base, url: c.transport.url, headerName: c.transport.headerName ?? '', auth }
  return {
    ...base,
    command: c.transport.command,
    args: [...c.transport.args],
    env: c.transport.env.map((e) => envRow({ name: e.name, secret: e.secret, saved: e.hasValue })),
    cwd: c.transport.cwd ?? '',
    auth,
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'transfer-encoding'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const FORBIDDEN_ENV = /^(DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|PYTHONSTARTUP$)/
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS$|AUTH|CREDENTIAL|COOKIE|SESSION/i

const URL_KEYS: Record<UrlProblem, MessageKey> = {
  invalid: 'connectors.field.urlInvalid',
  scheme: 'connectors.field.urlScheme',
  insecure: 'connectors.field.urlInsecure',
  credentials: 'connectors.field.urlCredentials',
  'too-long': 'connectors.field.urlTooLong',
}

/** Whether a variable name looks like it holds a secret (the toggle starts on). */
export function looksSecret(name: string): boolean {
  return SECRETISH.test(name)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Every problem in the draft, keyed by field ('displayName', 'url', 'env.2.name', …). The JSON mode is checked by main. */
export function validateDraft(d: ServerDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (d.mode === 'json') {
    if (!d.json.trim()) errors.json = { key: 'connectors.config.noServers' }
    return errors
  }
  const name = d.displayName.trim()
  if (!name) errors.displayName = { key: 'connectors.error.nameMissing' }
  else if (name.length > 48) errors.displayName = { key: 'connectors.field.nameTooLong' }
  if (d.mode === 'remote') {
    const url = checkConnectorUrl(d.url)
    if (!d.url.trim()) errors.url = { key: 'connectors.field.urlInvalid' }
    else if (!url.ok) errors.url = { key: URL_KEYS[url.problem] }
    const header = d.headerName.trim()
    if (header && !HEADER_NAME.test(header)) errors.headerName = { key: 'connectors.field.headerInvalid' }
    else if (header && RESERVED_HEADERS.has(header.toLowerCase())) errors.headerName = { key: 'connectors.field.headerReserved', vars: { header } }
    else if (!header && d.auth === 'api-key') errors.headerName = { key: 'connectors.field.headerMissing' }
  } else {
    const command = d.command.trim()
    if (!command) errors.command = { key: 'connectors.field.commandMissing' }
    else if (/[\0\n\r]/.test(command) || command.length > 1024) errors.command = { key: 'connectors.field.commandInvalid' }
    if (d.args.length > 64) errors.args = { key: 'connectors.field.argsTooMany' }
    d.args.forEach((arg, i) => {
      if (arg.includes('\0') || arg.length > 4096) errors[`args.${i}`] = { key: 'connectors.field.argInvalid' }
    })
    const seen = new Set<string>()
    d.env.forEach((e, i) => {
      const n = e.name.trim()
      if (!ENV_NAME.test(n)) errors[`env.${i}.name`] = { key: 'connectors.field.envName' }
      else if (FORBIDDEN_ENV.test(n)) errors[`env.${i}.name`] = { key: 'connectors.field.envForbidden', vars: { name: n } }
      else if (seen.has(n)) errors[`env.${i}.name`] = { key: 'connectors.field.envDuplicate', vars: { name: n } }
      seen.add(n)
      if (e.value.length > 8192 || e.value.includes('\0')) errors[`env.${i}.value`] = { key: 'connectors.field.envValue' }
    })
    const cwd = d.cwd.trim()
    if (cwd && !isAbsolutePath(cwd)) errors.cwd = { key: 'connectors.field.cwd' }
  }
  if (d.auth !== 'none' && d.secret && (d.secret.length > 4096 || /[\r\n\0]/.test(d.secret.trim()))) errors.secret = { key: 'connectors.field.secretInvalid' }
  if (d.auth !== 'none' && !d.secret.trim() && !(d.hasSecret && !d.removeSecret)) errors.secret = { key: 'connectors.add.secretMissing' }
  return errors
}

/** The draft as connectors.save takes it (remote or local mode). */
export function toInput(d: ServerDraft): ConnectorInputV2 {
  const name = d.displayName.trim()
  const auth: ConnectorAuth = d.auth
  const secret = auth === 'none' ? (d.hasSecret ? null : undefined) : d.secret.trim() ? d.secret.trim() : d.removeSecret ? null : undefined
  const transport: ConnectorInputV2['transport'] =
    d.mode === 'local'
      ? {
          kind: 'local',
          command: d.command.trim(),
          args: d.args,
          env: d.env.map((e) => ({ name: e.name.trim(), secret: e.secret, value: e.value === '' && e.saved ? undefined : e.value })),
          cwd: d.cwd.trim() || null,
        }
      : { kind: 'remote', url: d.url.trim(), headerName: d.headerName.trim() || null }
  return {
    ...(d.id ? { id: d.id } : {}),
    name,
    displayName: name,
    source: 'custom',
    transport,
    auth,
    secret,
    enabled: true,
    ...(d.logo !== undefined ? { logo: d.logo } : {}),
    ...(d.owner ? { owner: d.owner } : {}),
  }
}

/** Where the draft would run, for the dialog's note (server-side or on this computer). */
export function draftExecution(d: ServerDraft): 'server' | 'local' | null {
  if (d.mode === 'json') return null
  if (d.mode === 'local') return 'local'
  if (!checkConnectorUrl(d.url).ok) return null
  return executionOf({ kind: 'remote', url: d.url, headerName: d.headerName.trim() || null }, d.auth)
}

/** Splits a pasted command line into the program and its arguments, honouring quotes (no shell runs it). */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (started || cur) out.push(cur)
  const [command = '', ...args] = out
  return { command, args }
}

/** A logo file's problem, or null: image types only, at most 256 KB. */
export function logoProblem(file: { type: string; size: number }): MessageKey | null {
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(file.type)) return 'connectors.field.logoType'
  if (file.size > LOGO_MAX_BYTES) return 'connectors.field.logoSize'
  return null
}

/** The command as the approval and the detail page show it: arguments quoted when needed. */
export function commandLine(command: string, args: readonly string[]): string {
  const quote = (s: string): string => (s === '' ? "''" : /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s)
  return [command, ...args].map(quote).join(' ')
}

/** A saved connector as connectors.save takes it, with a patch; stored secrets and env values are kept. */
export function inputFromConnector(c: Connector, patch: Partial<Pick<ConnectorInputV2, 'owner' | 'settings' | 'displayName' | 'enabled'>> & { url?: string } = {}): ConnectorInputV2 {
  const transport: ConnectorInputV2['transport'] =
    c.transport.kind === 'remote'
      ? { kind: 'remote', url: patch.url ?? c.transport.url, headerName: c.transport.headerName }
      : { kind: 'local', command: c.transport.command, args: [...c.transport.args], env: c.transport.env.map((e) => ({ name: e.name, secret: e.secret })), cwd: c.transport.cwd }
  return {
    id: c.id,
    name: c.name,
    displayName: patch.displayName ?? c.displayName,
    source: c.source,
    directoryId: c.directoryId,
    transport,
    auth: c.auth,
    enabled: patch.enabled ?? c.enabled,
    owner: patch.owner ?? c.owner,
    settings: patch.settings ?? c.settings,
  }
}

/** A directory URL template with the connector's settings filled in ("https://{host}/mcp"). */
export function fillUrlTemplate(template: string, settings: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => encodeURIComponent(settings[key] ?? ''))
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAbsolute } from 'node:path'
import { LOGO_DATA_URL, LOGO_MAX_BYTES, checkConnectorUrl, type ConnectorInputV2, type UrlProblem } from '@shared/connectors'
import type { ConnectorInput } from '@shared/services'
import { mainT } from '../i18n/mainT'

// Checking connector input field by field, and reading pasted `mcpServers`
// JSON (Claude Desktop, VS Code and Cursor shapes). Every problem names the
// field it is about, so the add dialog can point at it. Nothing parsed here
// ever starts a server: local commands wait for OV-09's approval.

export type InputCheck = { ok: true } | { ok: false; field: string; message: string }

/** "My Linear!!" → "my-linear": at most 48 of [a-z0-9_-]. */
export function connectorSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
}

/** The original remote-only input as v2: a bearer token when one is given. */
export function legacyToV2(input: ConnectorInput): ConnectorInputV2 {
  return {
    id: input.id,
    name: input.name,
    transport: { kind: 'remote', url: input.url, headerName: null },
    auth: 'bearer',
    secret: input.token,
    enabled: input.enabled,
    owner: input.owner,
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'transfer-encoding'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** Variables that would load code into the server's process behind the command you approved. */
const FORBIDDEN_ENV = /^(DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|PYTHONSTARTUP$)/

const URL_MESSAGES: Record<UrlProblem, Parameters<typeof mainT>[0]> = {
  invalid: 'connectors.field.urlInvalid',
  scheme: 'connectors.field.urlScheme',
  insecure: 'connectors.field.urlInsecure',
  credentials: 'connectors.field.urlCredentials',
  'too-long': 'connectors.field.urlTooLong',
}

const fail = (field: string, key: Parameters<typeof mainT>[0], vars?: Record<string, string | number>): InputCheck => ({ ok: false, field, message: mainT(key, vars) })

export function checkConnectorInput(input: ConnectorInputV2): InputCheck {
  if (!connectorSlug(input.name ?? '')) return fail('name', 'connectors.error.nameMissing')
  if (input.displayName !== undefined && input.displayName.trim().length > 48) return fail('displayName', 'connectors.field.nameTooLong')
  const t = input.transport
  if (t.kind === 'remote') {
    const url = checkConnectorUrl(t.url)
    if (!url.ok) return fail('transport.url', URL_MESSAGES[url.problem])
    const header = t.headerName?.trim()
    if (header) {
      if (!HEADER_NAME.test(header)) return fail('transport.headerName', 'connectors.field.headerInvalid')
      if (FORBIDDEN_HEADERS.has(header.toLowerCase())) return fail('transport.headerName', 'connectors.field.headerReserved', { header })
    }
  } else {
    const command = t.command.trim()
    if (!command) return fail('transport.command', 'connectors.field.commandMissing')
    if (/[\0\n\r]/.test(command) || command.length > 1024) return fail('transport.command', 'connectors.field.commandInvalid')
    if (t.args.length > 64) return fail('transport.args', 'connectors.field.argsTooMany')
    for (const [i, arg] of t.args.entries()) if (/[\0]/.test(arg) || arg.length > 4096) return fail(`transport.args[${i}]`, 'connectors.field.argInvalid')
    const names = new Set<string>()
    for (const [i, e] of t.env.entries()) {
      const name = e.name.trim()
      if (!ENV_NAME.test(name)) return fail(`transport.env[${i}].name`, 'connectors.field.envName')
      if (FORBIDDEN_ENV.test(name)) return fail(`transport.env[${i}].name`, 'connectors.field.envForbidden', { name })
      if (names.has(name)) return fail(`transport.env[${i}].name`, 'connectors.field.envDuplicate', { name })
      names.add(name)
      if (typeof e.value === 'string' && (e.value.length > 8192 || e.value.includes('\0'))) return fail(`transport.env[${i}].value`, 'connectors.field.envValue')
    }
    const cwd = t.cwd?.trim()
    if (cwd && !isAbsolute(cwd)) return fail('transport.cwd', 'connectors.field.cwd')
    if (input.auth === 'oauth') return fail('auth', 'connectors.field.oauthLocal')
  }
  if (typeof input.secret === 'string' && (input.secret.length > 4096 || /[\r\n\0]/.test(input.secret.trim()))) return fail('secret', 'connectors.field.secretInvalid')
  if (input.auth === 'api-key' && t.kind === 'remote' && !t.headerName?.trim()) return fail('transport.headerName', 'connectors.field.headerMissing')
  if (typeof input.logo === 'string') {
    if (!LOGO_DATA_URL.test(input.logo)) return fail('logo', 'connectors.field.logoType')
    const base64 = input.logo.slice(input.logo.indexOf(',') + 1)
    if (Math.floor((base64.length * 3) / 4) > LOGO_MAX_BYTES) return fail('logo', 'connectors.field.logoSize')
  }
  if (input.labelColor && !/^#[0-9a-f]{6}$/i.test(input.labelColor)) return fail('labelColor', 'connectors.field.color')
  return { ok: true }
}

export interface ParsedConfig {
  inputs: ConnectorInputV2[]
  errors: { index: number; field: string; message: string }[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS$|AUTH|CREDENTIAL|COOKIE|SESSION/i

/** The servers map out of the common shapes: { mcpServers }, { servers }, { mcp: { servers } }, a bare map, or one server. */
function serversOf(root: unknown): [string, unknown][] | null {
  if (!isObject(root)) return null
  if (isObject(root.mcpServers)) return Object.entries(root.mcpServers)
  if (isObject(root.servers)) return Object.entries(root.servers)
  if (isObject(root.mcp) && isObject(root.mcp.servers)) return Object.entries(root.mcp.servers)
  if (typeof root.command === 'string' || typeof root.url === 'string' || typeof root.serverUrl === 'string') return [[typeof root.name === 'string' ? root.name : 'server', root]]
  const entries = Object.entries(root)
  return entries.length > 0 && entries.every(([, v]) => isObject(v)) ? entries : null
}

/** Pasted config → inputs (all off until you review them; local ones still need approval) plus per-field errors. */
export function parseMcpConfig(json: string): ParsedConfig {
  const out: ParsedConfig = { inputs: [], errors: [] }
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch (err) {
    out.errors.push({ index: -1, field: 'json', message: mainT('connectors.config.notJson', { detail: err instanceof Error ? err.message.slice(0, 120) : '' }) })
    return out
  }
  const servers = serversOf(root)
  if (!servers || servers.length === 0) {
    out.errors.push({ index: -1, field: 'json', message: mainT('connectors.config.noServers') })
    return out
  }
  if (servers.length > 20) {
    out.errors.push({ index: -1, field: 'json', message: mainT('connectors.config.tooMany') })
    return out
  }
  servers.forEach(([name, value], index) => {
    const at = `mcpServers.${name}`
    const error = (field: string, message: string): void => void out.errors.push({ index, field: `${at}.${field}`, message })
    if (!isObject(value)) return error('', mainT('connectors.config.notObject'))
    let input: ConnectorInputV2
    const url = typeof value.url === 'string' ? value.url : typeof value.serverUrl === 'string' ? value.serverUrl : null
    if (typeof value.command === 'string') {
      if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((a) => typeof a === 'string'))) return error('args', mainT('connectors.config.argsStrings'))
      if (value.env !== undefined && (!isObject(value.env) || !Object.values(value.env).every((v) => typeof v === 'string'))) return error('env', mainT('connectors.config.envStrings'))
      const env = Object.entries((value.env as Record<string, string> | undefined) ?? {}).map(([k, v]) => ({ name: k, value: v, secret: SECRETISH.test(k) }))
      input = {
        name,
        displayName: name,
        transport: { kind: 'local', command: value.command, args: (value.args as string[] | undefined) ?? [], env, cwd: typeof value.cwd === 'string' ? value.cwd : null },
        auth: 'none',
        enabled: false,
      }
    } else if (url) {
      if (value.headers !== undefined && (!isObject(value.headers) || !Object.values(value.headers).every((v) => typeof v === 'string'))) return error('headers', mainT('connectors.config.headerStrings'))
      const headers = Object.entries((value.headers as Record<string, string> | undefined) ?? {})
      if (headers.length > 1) return error('headers', mainT('connectors.config.oneHeader'))
      const [header] = headers
      let auth: ConnectorInputV2['auth'] = 'none'
      let headerName: string | null = null
      let secret: string | undefined
      if (header) {
        const bearer = /^Bearer\s+(.+)$/i.exec(header[1].trim())
        if (header[0].toLowerCase() === 'authorization' && bearer) {
          auth = 'bearer'
          secret = bearer[1]
        } else {
          auth = 'api-key'
          headerName = header[0]
          secret = header[1]
        }
      }
      input = { name, displayName: name, transport: { kind: 'remote', url, headerName }, auth, secret, enabled: false }
    } else return error('command', mainT('connectors.config.commandOrUrl'))
    const check = checkConnectorInput(input)
    if (!check.ok) return error(configField(check.field), check.message)
    out.inputs.push(input)
  })
  return out
}

/** transport.url → url, transport.env[1].name → env, so config errors read in the JSON's own terms. */
function configField(field: string): string {
  if (field === 'transport.url') return 'url'
  if (field === 'transport.headerName' || field === 'secret') return 'headers'
  if (field.startsWith('transport.env')) return 'env'
  if (field.startsWith('transport.args')) return 'args'
  return field.replace(/^transport\./, '')
}

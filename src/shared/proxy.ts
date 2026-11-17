/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Proxy settings: per-field validation for Settings › General
// and the translation to Electron's ProxyConfig that main applies to every
// session. Pure, so the page and main agree on what is valid.
import type { ProxySettings } from './ipc'

export type ProxyField = 'http' | 'https' | 'socks' | 'pacUrl' | 'bypass'

export type ProxyIssue = 'required' | 'host' | 'port' | 'scheme' | 'url' | 'rule'

export type ProxyErrors = Partial<Record<ProxyField, ProxyIssue>>

/** Electron's ProxyConfig, restated so shared code needs no Electron types. */
export interface ProxyConfigLike {
  mode: 'direct' | 'fixed_servers' | 'pac_script' | 'system'
  proxyRules?: string
  pacScript?: string
  proxyBypassRules?: string
}

export interface ProxyServer {
  scheme: 'http' | 'https' | 'socks4' | 'socks5'
  host: string
  port: number | null
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^\[[0-9a-f:.]+\]$/i

function validHost(host: string): boolean {
  return host.length <= 253 && (IPV4.test(host) || IPV6.test(host) || HOST.test(host))
}

const SERVER_SCHEMES: Record<'http' | 'https' | 'socks', readonly ProxyServer['scheme'][]> = {
  http: ['http', 'https'],
  https: ['http', 'https'],
  socks: ['socks4', 'socks5'],
}

/** Parses "host:port", "[::1]:8080" or "socks5://host:1080"; returns the issue when it can't. */
export function parseProxyServer(text: string, field: 'http' | 'https' | 'socks'): ProxyServer | ProxyIssue {
  let rest = text.trim()
  let scheme: ProxyServer['scheme'] = field === 'socks' ? 'socks5' : 'http'
  const prefixed = /^([a-z0-9]+):\/\//i.exec(rest)
  if (prefixed) {
    const given = (prefixed[1] ?? '').toLowerCase()
    const named = given === 'socks' ? 'socks5' : given
    if (!SERVER_SCHEMES[field].includes(named as ProxyServer['scheme'])) return 'scheme'
    scheme = named as ProxyServer['scheme']
    rest = rest.slice(prefixed[0].length)
  }
  rest = rest.replace(/\/$/, '')
  if (!rest || /[/\s@]/.test(rest)) return 'host'
  let host = rest
  let port: number | null = null
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d*)$/.exec(rest)
  if (withPort) {
    host = withPort[1] ?? ''
    const digits = withPort[2] ?? ''
    if (!/^\d{1,5}$/.test(digits)) return 'port'
    port = Number(digits)
    if (port < 1 || port > 65535) return 'port'
  } else if (rest.includes(':') && !IPV6.test(rest)) {
    return 'host'
  }
  if (!validHost(host)) return 'host'
  return { scheme, host: host.toLowerCase(), port }
}

/** One bypass entry: <local>, a host or *.domain (with an optional port), an IP or a CIDR range. */
function validBypassRule(rule: string): boolean {
  if (rule === '<local>' || rule === '<-loopback>') return true
  const stripped = rule.replace(/^[a-z]+:\/\//i, '')
  const cidr = /^([0-9a-f:.[\]]+)\/(\d{1,3})$/i.exec(stripped)
  if (cidr) return IPV4.test(cidr[1] ?? '') || IPV6.test(`[${(cidr[1] ?? '').replace(/^\[|\]$/g, '')}]`)
  const hostPart = stripped.replace(/:\d{1,5}$/, '')
  const bare = hostPart.replace(/^\*?\./, '')
  if (bare === '*') return true
  return validHost(bare) || IPV6.test(hostPart)
}

/** The bypass list as entries: commas, semicolons, spaces and new lines all separate. */
export function bypassEntries(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function validPacUrl(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return ['http:', 'https:', 'file:', 'data:'].includes(url.protocol)
  } catch {
    return false
  }
}

/**
 * Per-field problems, so the page can show each under its field. Manual mode
 * needs at least one server; PAC mode needs a script URL. Fields the mode
 * doesn't use are not checked.
 */
export function validateProxy(p: ProxySettings): ProxyErrors {
  const errors: ProxyErrors = {}
  if (p.mode === 'manual') {
    for (const field of ['http', 'https', 'socks'] as const) {
      if (!p[field].trim()) continue
      const parsed = parseProxyServer(p[field], field)
      if (typeof parsed === 'string') errors[field] = parsed
    }
    if (!p.http.trim() && !p.https.trim() && !p.socks.trim()) errors.http = 'required'
  }
  if (p.mode === 'pac') {
    if (!p.pacUrl.trim()) errors.pacUrl = 'required'
    else if (!validPacUrl(p.pacUrl)) errors.pacUrl = 'url'
  }
  if (p.mode === 'manual' || p.mode === 'pac') {
    if (bypassEntries(p.bypass).some((rule) => !validBypassRule(rule))) errors.bypass = 'rule'
  }
  return errors
}

function serverText(s: ProxyServer, withScheme: boolean): string {
  const hostPort = s.port === null ? s.host : `${s.host}:${s.port}`
  return withScheme ? `${s.scheme}://${hostPort}` : hostPort
}

/**
 * Electron's ProxyConfig for the settings, or null when they don't validate
 * (main then keeps the system proxy and logs why).
 */
export function toProxyConfig(p: ProxySettings): ProxyConfigLike | null {
  if (Object.keys(validateProxy(p)).length > 0) return null
  const bypass = bypassEntries(p.bypass).join(',')
  switch (p.mode) {
    case 'system':
      return { mode: 'system' }
    case 'direct':
      return { mode: 'direct' }
    case 'pac':
      return { mode: 'pac_script', pacScript: p.pacUrl.trim(), ...(bypass ? { proxyBypassRules: bypass } : {}) }
    case 'manual': {
      const rules: string[] = []
      const http = p.http.trim() ? parseProxyServer(p.http, 'http') : null
      const https = p.https.trim() ? parseProxyServer(p.https, 'https') : null
      const socks = p.socks.trim() ? parseProxyServer(p.socks, 'socks') : null
      if (http && typeof http !== 'string') rules.push(`http=${serverText(http, http.scheme !== 'http')}`)
      if (https && typeof https !== 'string') rules.push(`https=${serverText(https, https.scheme !== 'http')}`)
      // A SOCKS proxy alone carries everything; beside the others it is the fallback for the rest.
      if (socks && typeof socks !== 'string') rules.push(rules.length ? `socks=${serverText(socks, true)}` : serverText(socks, true))
      return { mode: 'fixed_servers', proxyRules: rules.join(';'), ...(bypass ? { proxyBypassRules: bypass } : {}) }
    }
  }
}

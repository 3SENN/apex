/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { ProxySettings } from '@shared/ipc'
import { bypassEntries, parseProxyServer, toProxyConfig, validateProxy, type ProxyIssue } from '@shared/proxy'
import { appliesAtOnce, FIELD_HINT, FIELD_LABEL, fieldIssueMessage, issueMessage, MODE_LABEL, PROXY_MODES, proxyDirty, proxyFields } from '../src/renderer/src/settings/sections/network/logic'
import { safety as strings } from '../src/shared/i18n/en/safety'

// Proxy validation per field and the ProxyConfig main applies to every session.

const base: ProxySettings = { mode: 'system', http: '', https: '', socks: '', pacUrl: '', bypass: '<local>' }
const manual = (patch: Partial<ProxySettings>): ProxySettings => ({ ...base, mode: 'manual', ...patch })

describe('parseProxyServer', () => {
  it('reads host and port, with or without a scheme', () => {
    expect(parseProxyServer('proxy.example:8080', 'http')).toEqual({ scheme: 'http', host: 'proxy.example', port: 8080 })
    expect(parseProxyServer('https://Proxy.Example:443/', 'https')).toEqual({ scheme: 'https', host: 'proxy.example', port: 443 })
    expect(parseProxyServer('10.0.0.1', 'http')).toEqual({ scheme: 'http', host: '10.0.0.1', port: null })
    expect(parseProxyServer('[::1]:3128', 'http')).toEqual({ scheme: 'http', host: '[::1]', port: 3128 })
    expect(parseProxyServer('socks://tor.local:9050', 'socks')).toEqual({ scheme: 'socks5', host: 'tor.local', port: 9050 })
    expect(parseProxyServer('socks4://tor.local:9050', 'socks')).toEqual({ scheme: 'socks4', host: 'tor.local', port: 9050 })
    expect(parseProxyServer('tor.local:9050', 'socks')).toMatchObject({ scheme: 'socks5' })
  })

  it.each<[string, 'http' | 'https' | 'socks', ProxyIssue]>([
    ['', 'http', 'host'],
    ['proxy.example:0', 'http', 'port'],
    ['proxy.example:70000', 'http', 'port'],
    ['proxy.example:', 'http', 'port'],
    ['proxy.example:abc', 'http', 'host'],
    ['user@proxy.example:8080', 'http', 'host'],
    ['proxy.example/path', 'http', 'host'],
    ['-bad-.example', 'http', 'host'],
    ['socks5://proxy.example', 'http', 'scheme'],
    ['http://proxy.example', 'socks', 'scheme'],
    ['ftp://proxy.example', 'https', 'scheme'],
  ])('rejects %j for %s with %s', (text, field, issue) => {
    expect(parseProxyServer(text, field)).toBe(issue)
  })
})

describe('validateProxy', () => {
  it('checks nothing for system and direct', () => {
    expect(validateProxy({ ...base, http: 'bad host', bypass: '!!' })).toEqual({})
    expect(validateProxy({ ...base, mode: 'direct', http: 'bad host' })).toEqual({})
  })

  it('wants at least one server in manual mode, and checks each one given', () => {
    expect(validateProxy(manual({}))).toEqual({ http: 'required' })
    expect(validateProxy(manual({ socks: 'tor.local:9050' }))).toEqual({})
    expect(validateProxy(manual({ http: 'proxy.example:99999', https: 'ok.example:443' }))).toEqual({ http: 'port' })
  })

  it('wants a valid script address in PAC mode', () => {
    expect(validateProxy({ ...base, mode: 'pac' })).toEqual({ pacUrl: 'required' })
    expect(validateProxy({ ...base, mode: 'pac', pacUrl: 'not a url' })).toEqual({ pacUrl: 'url' })
    expect(validateProxy({ ...base, mode: 'pac', pacUrl: 'ftp://x.example/p.pac' })).toEqual({ pacUrl: 'url' })
    expect(validateProxy({ ...base, mode: 'pac', pacUrl: 'https://corp.example/proxy.pac' })).toEqual({})
  })

  it('checks every bypass entry', () => {
    const ok = '<local>, *.corp.example; 192.168.0.0/16 10.1.2.3 [::1] intranet:8080 <-loopback> .example.org'
    expect(validateProxy(manual({ http: 'p.example:80', bypass: ok }))).toEqual({})
    expect(validateProxy(manual({ http: 'p.example:80', bypass: '<local>, bad_host!' }))).toEqual({ bypass: 'rule' })
    expect(validateProxy(manual({ http: 'p.example:80', bypass: '' }))).toEqual({})
  })

  it('splits the bypass list on commas, semicolons, spaces and lines', () => {
    expect(bypassEntries(' a.example,b.example;c.example\nd.example  e.example ')).toEqual(['a.example', 'b.example', 'c.example', 'd.example', 'e.example'])
  })
})

describe('toProxyConfig', () => {
  it('maps the simple modes', () => {
    expect(toProxyConfig(base)).toEqual({ mode: 'system' })
    expect(toProxyConfig({ ...base, mode: 'direct' })).toEqual({ mode: 'direct' })
  })

  it('builds per-scheme rules, with SOCKS as the fallback', () => {
    expect(toProxyConfig(manual({ http: 'p.example:3128', https: 'https://s.example:443', socks: 'tor.local:9050', bypass: '<local>, *.corp.example' }))).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=p.example:3128;https=https://s.example:443;socks=socks5://tor.local:9050',
      proxyBypassRules: '<local>,*.corp.example',
    })
  })

  it('lets a lone SOCKS proxy carry everything', () => {
    expect(toProxyConfig(manual({ socks: 'socks4://tor.local:9050', bypass: '' }))).toEqual({ mode: 'fixed_servers', proxyRules: 'socks4://tor.local:9050' })
  })

  it('passes the PAC script with its bypass list', () => {
    expect(toProxyConfig({ ...base, mode: 'pac', pacUrl: ' https://corp.example/p.pac ' })).toEqual({ mode: 'pac_script', pacScript: 'https://corp.example/p.pac', proxyBypassRules: '<local>' })
  })

  it('refuses settings that do not validate, so main keeps the system proxy', () => {
    expect(toProxyConfig(manual({}))).toBeNull()
    expect(toProxyConfig(manual({ http: 'bad host' }))).toBeNull()
  })
})

describe('the proxy form', () => {
  it('shows the fields each mode uses and applies field-less modes at once', () => {
    expect(PROXY_MODES).toEqual(['system', 'direct', 'manual', 'pac'])
    expect(proxyFields('manual')).toEqual(['http', 'https', 'socks', 'bypass'])
    expect(proxyFields('pac')).toEqual(['pacUrl', 'bypass'])
    expect(proxyFields('system')).toEqual([])
    expect(appliesAtOnce('direct')).toBe(true)
    expect(appliesAtOnce('manual')).toBe(false)
  })

  it('is dirty only when what main applies would change', () => {
    const applied = manual({ http: 'p.example:80' })
    expect(proxyDirty({ ...applied, http: ' p.example:80 ' }, applied)).toBe(false)
    expect(proxyDirty({ ...applied, pacUrl: 'https://hidden.example/p.pac' }, applied)).toBe(false)
    expect(proxyDirty({ ...applied, http: 'q.example:80' }, applied)).toBe(true)
    expect(proxyDirty({ ...applied, mode: 'system' }, applied)).toBe(true)
  })

  it('has English for every label, hint and issue', () => {
    const has = (k: string): boolean => Boolean(strings[k as keyof typeof strings])
    for (const m of PROXY_MODES) expect(has(MODE_LABEL[m]), MODE_LABEL[m]).toBe(true)
    for (const k of [...Object.values(FIELD_LABEL), ...Object.values(FIELD_HINT)]) expect(has(k), k).toBe(true)
    for (const issue of ['required', 'host', 'port', 'scheme', 'url', 'rule'] as const) {
      expect(has(issueMessage(issue)), issue).toBe(true)
      expect(has(fieldIssueMessage('bypass', issue)), issue).toBe(true)
    }
  })
})

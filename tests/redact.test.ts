/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { originOf, redact, redactData, redactSecrets, registerSecret, setHomeForTests } from '../src/main/diagnostics/redact'
import { chatToken, newSecret } from '../src/main/mcp/secrets'

// Redaction: every secret shape, registered secrets,
// URLs and the home folder, plus a check that each secret source registers.

afterEach(() => setHomeForTests(null))

describe('redact', () => {
  it('masks key shapes', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnop in a line')).toBe('key [redacted] in a line')
    expect(redact('Authorization: Bearer abcdefgh12345')).toBe('Authorization: [redacted]')
    expect(redact('authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('authorization: [redacted]')
    expect(redact('x-api-key: abc123def456')).toBe('x-api-key: [redacted]')
    expect(redact('{"x-api-key":"abc123def456","ok":1}')).toBe('{"x-api-key":"[redacted]","ok":1}')
    expect(redact('X-API-KEY=zzz999yyy')).toBe('X-API-KEY=[redacted]')
  })

  it('masks every registered secret, longest first, and ignores short ones', () => {
    registerSecret('connector-token-123')
    registerSecret('connector-token-123-refresh')
    registerSecret('abc')
    expect(redact('a=connector-token-123-refresh b=connector-token-123')).toBe('a=[redacted] b=[redacted]')
    expect(redact('abc stays')).toBe('abc stays')
  })

  it('removes URL queries, fragments and sign-in parts but keeps the address', () => {
    expect(redact('GET https://example.com/path/page?token=abc&x=1 done')).toBe('GET https://example.com/path/page done')
    expect(redact('see https://example.com/#access_token=xyz')).toBe('see https://example.com/')
    expect(redact('wss://user:pass@host.example/socket?k=v')).toBe('wss://host.example/socket')
    expect(redact('apex://chat/123?highlight=a')).toBe('apex://chat/123')
    expect(redact('plain text? no url # here')).toBe('plain text? no url # here')
  })

  it('replaces the home folder with ~', () => {
    setHomeForTests('/Users/someone')
    expect(redact('opened /Users/someone/Documents/a.pdf')).toBe('opened ~/Documents/a.pdf')
    expect(redact('file:///Users/someone/x.txt')).toBe('file://~/x.txt')
  })

  it('redactSecrets leaves URLs and paths, for text you chose to include', () => {
    setHomeForTests('/Users/someone')
    expect(redactSecrets('see https://a.example/?q=1 at /Users/someone with sk-ant-abcdefghijk')).toBe('see https://a.example/?q=1 at /Users/someone with [redacted]')
  })

  it('redacts data values and keeps other types', () => {
    expect(redactData({ url: 'https://a.example/?q=1', n: 2, ok: true, none: null })).toEqual({ url: 'https://a.example/', n: 2, ok: true, none: null })
  })

  it('logs origins, not full URLs', () => {
    expect(originOf('https://mail.example.com/inbox?id=1')).toBe('https://mail.example.com')
    expect(originOf('not a url')).toBe('')
  })
})

describe('secret sources register their secrets', () => {
  it('the per-launch MCP secret and chat tokens', () => {
    const secret = newSecret()
    expect(redact(`hex ${secret.toString('hex')}`)).toBe('hex [redacted]')
    expect(redact(`b64 ${secret.toString('base64url')}`)).toBe('b64 [redacted]')
    const token = chatToken(secret, '00000000-0000-4000-8000-000000000000')
    expect(redact(`t=${token}`)).toBe('t=[redacted]')
  })

  it('the API key (load and save) and every connector and OAuth token', () => {
    const src = (path: string): string => readFileSync(join(__dirname, '..', 'src', 'main', path), 'utf8')
    const settings = src('settings.ts')
    expect(settings).toMatch(/apiKey\(\)[\s\S]*?registerSecret\(key\)/)
    expect(settings).toMatch(/setApiKey\([\s\S]*?registerSecret\(key\.trim\(\)\)/)
    const connectors = src('connectors/store.ts')
    for (const field of ['secret.token', 'secret.oauth.accessToken', 'secret.oauth.refreshToken', 'secret.oauth.clientSecret', 'secret.client.clientSecret']) {
      expect(connectors, field).toContain(`registerSecret(${field})`)
    }
  })
})

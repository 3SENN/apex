/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script module, without types
import { externalHosts, isLocalHost, isProxyDiscovery } from '../scripts/smoke/netGuard.mjs'

describe('the smoke network guard', () => {
  it('treats loopback and reserved test names as local', () => {
    for (const h of ['127.0.0.1', '127.4.5.6', 'localhost', '[::1]', '::1', 'dangerous.apex.test', 'x.invalid', 'a.localhost', 'site.example']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['example.com', 'api.anthropic.com', 'redirector.gvt1.com', '10.0.0.1', 'test.com']) expect(isLocalHost(h)).toBe(false)
  })

  it('lists the outside hosts a net log names, once each, and tolerates a cut-off log', () => {
    const log = [
      '{"constants":{},"events":[',
      '{"params":{"url":"http://127.0.0.1:5123/page"},"type":1},',
      '{"params":{"url":"https://user@Updates.Example.com/feed?x=1"},"type":1},',
      '{"params":{"host":"api.anthropic.com:443"},"type":2},',
      '{"params":{"url":"https://dangerous.apex.test/"},"type":1},',
      '{"params":{"url":"https://updates.example.com/other"},"type":1},',
      '{"params":{"url":"wss://[::1]:9/x"},"type":1},',
      '{"params":{"url":"https://cdn.somewhere.net/a',
    ].join('\n')
    expect(externalHosts(log)).toEqual(['api.anthropic.com', 'cdn.somewhere.net', 'updates.example.com'])
  })

  it('leaves out Windows’ proxy auto-discovery, and only that', () => {
    for (const h of ['wpad', 'WPAD', 'wpad.corp.example.org']) expect(isProxyDiscovery(h)).toBe(true)
    for (const h of ['mywpad.com', 'wpadx.net', 'redirector.gvt1.com']) expect(isProxyDiscovery(h)).toBe(false)
    const log = ['{"params":{"host":"wpad:80"},"type":2},', '{"params":{"host":"wpad.corp.example.org"},"type":2},', '{"params":{"url":"https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"},"type":1}'].join('\n')
    expect(externalHosts(log)).toEqual(['redirector.gvt1.com'])
  })
})

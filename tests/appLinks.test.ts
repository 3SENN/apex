/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { APP_LINK_RULES, appLinkFor, appLinkRuleFor } from '../src/shared/appLinks'

// SH-32/DS-24: which pages a desktop app can open.

describe('appLinkFor', () => {
  it('maps a Zoom meeting, with its passcode, to the Zoom app', () => {
    expect(appLinkFor('https://acme.zoom.us/j/123456789?pwd=a b')).toEqual({ app: 'Zoom', scheme: 'zoommtg', openUrl: 'zoommtg://zoom.us/join?action=join&confno=123456789&pwd=a%20b' })
    expect(appLinkFor('https://zoom.us/w/1234567890')?.openUrl).toBe('zoommtg://zoom.us/join?action=join&confno=1234567890')
    expect(appLinkFor('https://zoom.us/pricing')).toBeNull()
  })

  it('maps Spotify items, Figma files, Teams meetings and GitHub repos', () => {
    expect(appLinkFor('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')?.openUrl).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC')
    expect(appLinkFor('https://open.spotify.com/intl-nl/album/1DFixLWuPkv3KT3TnV35m3')?.openUrl).toBe('spotify:album:1DFixLWuPkv3KT3TnV35m3')
    expect(appLinkFor('https://www.figma.com/design/AbC123/My-file?node-id=1')?.openUrl).toBe('figma://design/AbC123/My-file?node-id=1')
    expect(appLinkFor('https://teams.microsoft.com/l/meetup-join/19%3a/0?context=x')?.app).toBe('Microsoft Teams')
    expect(appLinkFor('https://github.com/acme/widgets')?.openUrl).toBe('x-github-client://openRepo/https://github.com/acme/widgets')
    expect(appLinkFor('https://github.com/acme/widgets/issues/4')).toBeNull()
  })

  it('needs a workspace for Slack and a channel for Discord', () => {
    expect(appLinkFor('https://acme.slack.com/archives/C1')?.app).toBe('Slack')
    expect(appLinkFor('https://slack.com/')).toBeNull()
    expect(appLinkFor('https://discord.com/channels/1/2')?.openUrl).toBe('discord://-/channels/1/2')
    expect(appLinkFor('https://discord.com/')).toBeNull()
  })

  it('ignores lookalike hosts, other schemes and junk', () => {
    expect(appLinkFor('https://notzoom.us/j/123456789')).toBeNull()
    expect(appLinkFor('https://zoom.us.evil.example/j/123456789')).toBeNull()
    expect(appLinkFor('https://open.spotify.com.evil.example/track/x')).toBeNull()
    expect(appLinkFor('ftp://zoom.us/j/123456789')).toBeNull()
    expect(appLinkFor('apex://settings')).toBeNull()
    expect(appLinkFor('not a url')).toBeNull()
  })

  it('finds the rule even when the page itself has no app address', () => {
    expect(appLinkRuleFor('https://zoom.us/pricing')?.rule.key).toBe('zoom')
    expect(appLinkRuleFor('https://example.com/')).toBeNull()
  })

  it('has unique keys and schemes, and only lower-case hosts', () => {
    const keys = APP_LINK_RULES.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const rule of APP_LINK_RULES) for (const host of rule.hosts) expect(host).toBe(host.toLowerCase())
  })

  it('takes a custom table (smoke adds a test app)', () => {
    const rules = [{ key: 't', app: 'Test', scheme: 'apex-smoke', hosts: ['127.0.0.1'], map: (u: URL) => `apex-smoke://open${u.pathname}` }]
    expect(appLinkFor('http://127.0.0.1:4000/page', rules)).toEqual({ app: 'Test', scheme: 'apex-smoke', openUrl: 'apex-smoke://open/page' })
  })
})

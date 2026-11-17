/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Open-in-app links (SH-32/DS-24). Maps a web address onto the desktop app that handles it,
// from Apex's own small table; the chip offers it only when the app exists
// (main checks the scheme with app.getApplicationNameForProtocol).

export interface AppLink {
  /** The app's display name. */
  app: string
  /** Its URL scheme, checked against the system before offering. */
  scheme: string
  openUrl: string
}

/** One row of the table: which hosts, and how a page address becomes the app's address (null: no app page for it). */
export interface AppLinkRule {
  /** A stable key, also used for site-suggestion task templates. */
  key: string
  app: string
  scheme: string
  /** Exact hosts, or '.example.com' for any subdomain. */
  hosts: readonly string[]
  map(url: URL): string | null
}

const pathOf = (url: URL): string => url.pathname.replace(/^\/+/, '')

/** Apex's table of well-known sites with a desktop app. Only pages the app can open map; the rest return null. */
export const APP_LINK_RULES: readonly AppLinkRule[] = [
  {
    key: 'zoom',
    app: 'Zoom',
    scheme: 'zoommtg',
    hosts: ['zoom.us', '.zoom.us'],
    map: (url) => {
      const id = /^\/[jw]\/(\d{9,12})/.exec(url.pathname)?.[1]
      if (!id) return null
      const pwd = url.searchParams.get('pwd')
      return `zoommtg://zoom.us/join?action=join&confno=${id}${pwd ? `&pwd=${encodeURIComponent(pwd)}` : ''}`
    },
  },
  {
    key: 'teams',
    app: 'Microsoft Teams',
    scheme: 'msteams',
    hosts: ['teams.microsoft.com', 'teams.live.com'],
    map: (url) => (url.pathname.startsWith('/l/') ? `msteams:${url.pathname}${url.search}` : null),
  },
  {
    key: 'slack',
    app: 'Slack',
    scheme: 'slack',
    hosts: ['.slack.com'],
    map: (url) => (url.hostname === 'slack.com' || url.hostname === 'www.slack.com' ? null : 'slack://open'),
  },
  {
    key: 'spotify',
    app: 'Spotify',
    scheme: 'spotify',
    hosts: ['open.spotify.com'],
    map: (url) => {
      const m = /^(?:intl-[a-z]+\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/.exec(pathOf(url))
      return m ? `spotify:${m[1]}:${m[2]}` : null
    },
  },
  {
    key: 'figma',
    app: 'Figma',
    scheme: 'figma',
    hosts: ['figma.com', 'www.figma.com'],
    map: (url) => (/^(file|design|board|proto)\/[A-Za-z0-9]+/.test(pathOf(url)) ? `figma://${pathOf(url)}${url.search}` : null),
  },
  {
    key: 'notion',
    app: 'Notion',
    scheme: 'notion',
    hosts: ['notion.so', 'www.notion.so'],
    map: (url) => (pathOf(url) ? `notion://www.notion.so/${pathOf(url)}${url.search}` : null),
  },
  {
    key: 'linear',
    app: 'Linear',
    scheme: 'linear',
    hosts: ['linear.app'],
    map: (url) => (pathOf(url) && !/^(login|signup|pricing|about|changelog|docs|blog)\b/.test(pathOf(url)) ? `linear://${pathOf(url)}` : null),
  },
  {
    key: 'discord',
    app: 'Discord',
    scheme: 'discord',
    hosts: ['discord.com'],
    map: (url) => (/^channels\//.test(pathOf(url)) ? `discord://-/${pathOf(url)}` : null),
  },
  {
    key: 'apple-music',
    app: 'Music',
    scheme: 'music',
    hosts: ['music.apple.com'],
    map: (url) => (pathOf(url) ? `music://music.apple.com/${pathOf(url)}${url.search}` : null),
  },
  {
    key: 'github',
    app: 'GitHub Desktop',
    scheme: 'x-github-client',
    hosts: ['github.com'],
    map: (url) => {
      const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(pathOf(url))
      return m ? `x-github-client://openRepo/https://github.com/${m[1]}/${m[2]}` : null
    },
  },
]

function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith('.') ? host.endsWith(pattern) && host.length > pattern.length : host === pattern
}

/** The rule whose hosts cover this address, or null (only http and https pages). */
export function appLinkRuleFor(url: string, rules: readonly AppLinkRule[] = APP_LINK_RULES): { rule: AppLinkRule; url: URL } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  const rule = rules.find((r) => r.hosts.some((h) => hostMatches(host, h)))
  return rule ? { rule, url: parsed } : null
}

/** The app link for a page, or null. Main checks that the app is installed before showing it. */
export function appLinkFor(url: string, rules: readonly AppLinkRule[] = APP_LINK_RULES): AppLink | null {
  const hit = appLinkRuleFor(url, rules)
  if (!hit) return null
  const openUrl = hit.rule.map(hit.url)
  return openUrl ? { app: hit.rule.app, scheme: hit.rule.scheme, openUrl } : null
}

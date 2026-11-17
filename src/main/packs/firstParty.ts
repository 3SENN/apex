/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The packs that come with Atelier (docs/packs.md › First-party packs). The
// built-in skills pack holds no files of its own: its switch shows or hides
// the built-in skills. The example pack is a small, readable pack with a
// skill, a panel, a command, a page menu item and a tool, off by default; it
// is what companions read before building their own, and what Remix copies.
import { BRAND_NAME } from '@shared/branding'
import { BUILTIN_SKILLS_PACK_ID, EXAMPLE_PACK_ID, PACK_FORMAT, PACK_MANIFEST_FILE, PACK_MANIFEST_NEW_VERSION, type PackManifest } from '@shared/packs'
import type { PackFiles } from './manifest'
import type { FirstPartyPack } from './store'
import { worldsPack } from './firstPartyWorlds'

const manifest = (m: Omit<PackManifest, 'format' | 'manifestVersion'>): Buffer => Buffer.from(`${JSON.stringify({ format: PACK_FORMAT, manifestVersion: PACK_MANIFEST_NEW_VERSION, ...m }, null, 2)}\n`)

function builtinSkillsPack(): FirstPartyPack {
  const files: PackFiles = new Map([
    [
      PACK_MANIFEST_FILE,
      manifest({
        id: BUILTIN_SKILLS_PACK_ID,
        name: 'Built-in skills',
        version: '1.0.0',
        description: `The skills that come with ${BRAND_NAME}, such as /page-summary and /research-brief. Turn this off to hide them.`,
        author: { name: BRAND_NAME },
        contributes: {},
        permissions: { sites: [], network: [], pageScripts: false, notifications: false, model: false, clipboard: false },
      }),
    ],
  ])
  return { files, enabledByDefault: true }
}

const SKILL = `---
name: reading-time
description: Says how long the open page takes to read and what it covers, in a few lines.
---

Use the reading time tool from the Reading time example pack on the open page.
Then answer in at most four lines: the reading time, the word count, and the
page's main point in one sentence. If the page can't be read, say why.
`

const TOOL = `// The reading_time tool: counts the words on the open page.
// atelier.page.text() only works on sites the pack lists in permissions.sites.

const WORDS_PER_MINUTE = 230

export async function run(input, ctx) {
  const page = await atelier.page.info()
  if (!page) return 'There is no page open on a site this pack can read.'
  const text = await atelier.page.text()
  const words = text.split(/\\s+/).filter(Boolean).length
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE))
  atelier.log('Counted', words, 'words on', page.host)
  return { title: page.title, url: page.url, words, minutes }
}
`

const CARD = `// The new tab card: the last pages the panel counted. ${BRAND_NAME} draws the lines.
export async function run() {
  const items = (await atelier.storage.get('history')) ?? []
  if (items.length === 0) return 'Count a Wikipedia article in the panel to see it here.'
  return items.slice(0, 3).map((item) => item.title + ': ' + item.minutes + ' min')
}
`

const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reading time</title>
<link rel="stylesheet" href="panel.css">
</head>
<body>
<main>
  <h1>Reading time</h1>
  <p id="status" role="status">Open a Wikipedia article, then press Count.</p>
  <button id="count" type="button">Count the open page</button>
  <h2>Earlier</h2>
  <ul id="history" aria-label="Pages counted before"></ul>
</main>
<script type="module" src="panel.js"></script>
</body>
</html>
`

const PANEL_CSS = `:root { color-scheme: light dark; --bg: #ffffff; --text: #1c1a17; --muted: #6b665f; --accent: #6a4bff; }
@media (prefers-color-scheme: dark) { :root { --bg: #2b2a28; --text: #f2efe9; --muted: #b3ada4; --accent: #9d86ff; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 15px; margin: 28px 0 8px; color: var(--muted); }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
ul { padding-left: 18px; }
li { margin: 4px 0; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`

const PANEL_JS = `// The panel: counts the page you last used in this window and keeps a short history.
const status = document.getElementById('status')
const list = document.getElementById('history')

async function showHistory() {
  const items = (await atelier.storage.get('history')) ?? []
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li')
    li.textContent = item.title + ': ' + item.minutes + ' min (' + item.words + ' words)'
    return li
  }))
}

document.getElementById('count').addEventListener('click', async () => {
  const page = await atelier.page.info()
  if (!page) {
    status.textContent = 'This pack can only read Wikipedia articles. Open one in another tab first.'
    return
  }
  const words = (await atelier.page.text()).split(/\\s+/).filter(Boolean).length
  const minutes = Math.max(1, Math.round(words / 230))
  status.textContent = page.title + ' takes about ' + minutes + ' min to read.'
  const items = (await atelier.storage.get('history')) ?? []
  await atelier.storage.set('history', [{ title: page.title, words, minutes }, ...items].slice(0, 10))
  await showHistory()
})

showHistory()
`

function examplePack(): FirstPartyPack {
  const files: PackFiles = new Map([
    [
      PACK_MANIFEST_FILE,
      manifest({
        id: EXAMPLE_PACK_ID,
        name: 'Reading time (example)',
        version: '1.0.0',
        description: 'An example pack: a skill, a panel in the sidebar, a new tab card, a command, a page menu item and a tool that count how long a Wikipedia article takes to read. Remix it to make your own.',
        author: { name: BRAND_NAME },
        contributes: {
          skills: ['skills/reading-time'],
          panels: [{ id: 'main', title: 'Reading time', html: 'panel/index.html', sidebar: true }],
          cards: [{ id: 'recent', title: 'Reading time', module: 'cards/recent.js', open: 'panel:main' }],
          commands: [{ id: 'open', title: 'Show reading time', run: 'panel:main' }],
          menus: [{ id: 'ask', title: 'How long is this to read?', context: 'page', run: 'skill:reading-time' }],
          tools: [
            {
              name: 'reading_time',
              description: 'Counts the words on the open page and estimates how many minutes it takes to read.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              module: 'tools/reading-time.js',
            },
          ],
        },
        permissions: { sites: ['*.wikipedia.org'], network: [], pageScripts: false, notifications: false, model: false, clipboard: false },
      }),
    ],
    ['skills/reading-time/SKILL.md', Buffer.from(SKILL)],
    ['tools/reading-time.js', Buffer.from(TOOL)],
    ['cards/recent.js', Buffer.from(CARD)],
    ['panel/index.html', Buffer.from(PANEL_HTML)],
    ['panel/panel.css', Buffer.from(PANEL_CSS)],
    ['panel/panel.js', Buffer.from(PANEL_JS)],
  ])
  return { files, enabledByDefault: false }
}

export function firstPartyPacks(): FirstPartyPack[] {
  return [builtinSkillsPack(), examplePack(), worldsPack()]
}

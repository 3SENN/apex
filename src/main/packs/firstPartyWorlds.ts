/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Worlds pack (docs/apps.md › Worlds): Apex's world viewer and editor,
// built as a kit app on the same surfaces any pack has (apex.worlds,
// apex.cast, the kit's props and world modules), with one world to start in.
// It is off until the person wants it (Packs, or Open on a world), so the
// browser looks and runs as before: no sidebar row, nothing loaded.
// Its files live in src/firstParty/worlds/ as plain, readable modules and are
// bundled in as text.
import { BRAND_NAME } from '@shared/branding'
import { PACK_FORMAT, PACK_MANIFEST_FILE, type PackManifest } from '@shared/packs'
import { WORLDS_PACK_ID } from '@shared/worlds'
import editorJs from '../../firstParty/worlds/app/editor.js?raw'
import i18nJs from '../../firstParty/worlds/app/i18n.js?raw'
import indexHtml from '../../firstParty/worlds/app/index.html?raw'
import mainJs from '../../firstParty/worlds/app/main.js?raw'
import stageJs from '../../firstParty/worlds/app/stage.js?raw'
import styleCss from '../../firstParty/worlds/app/style.css?raw'
import harbourTown from '../../firstParty/worlds/worlds/harbour-town.json?raw'
import type { PackFiles } from './manifest'
import type { FirstPartyPack } from './store'

export function worldsPack(): FirstPartyPack {
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    manifestVersion: 2,
    id: WORLDS_PACK_ID,
    name: 'Worlds',
    version: '1.0.0',
    description: 'Walk around worlds with your companions, step into places, and build worlds of your own to share.',
    author: { name: BRAND_NAME },
    contributes: {
      apps: [{ id: 'main', name: 'Worlds', root: 'app', entry: 'index.html', build: 'kit', kit: 1, kind: 'game', sidebar: true, cast: { min: 0, max: 8 } }],
      worlds: ['worlds/harbour-town.json'],
    },
    permissions: { sites: [], network: [], pageScripts: false, notifications: false, model: true, clipboard: false, speak: true, worlds: true },
  }
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['app/index.html', Buffer.from(indexHtml)],
    ['app/style.css', Buffer.from(styleCss)],
    ['app/main.js', Buffer.from(mainJs)],
    ['app/stage.js', Buffer.from(stageJs)],
    ['app/editor.js', Buffer.from(editorJs)],
    ['app/i18n.js', Buffer.from(i18nJs)],
    ['worlds/harbour-town.json', Buffer.from(harbourTown)],
  ])
  return { files, enabledByDefault: false }
}

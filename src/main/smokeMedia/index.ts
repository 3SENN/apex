/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { MediaHubState, MediaSource } from '@shared/media'
import type { SmokeGroup, ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { assert, docWith, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'

// The media hub's smoke checks (MD-01 to MD-03; APEX_SMOKE_ONLY=MEDIA runs
// only these). A local looping video (tests/fixtures/media/loop.webm, a test
// pattern with a tone that Apex generated) plays muted on fixture pages, so
// no check needs a gesture or the network.

const ART = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const plain = (src: string): string => `<!doctype html><title>Muted loop</title><body style="margin:0;background:#222">
<video id="v" src="${src}" muted autoplay loop playsinline width="320" height="180"></video></body>`

const session = (src: string): string => `<!doctype html><title>Session loop</title><body style="margin:0;background:#222">
<video id="v" src="${src}" muted autoplay loop playsinline width="320" height="180"></video>
<script>
  let n = 0
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Apex loop', artist: 'Smoke fixture', artwork: [{ src: '${ART}', sizes: '96x96', type: 'image/png' }] })
  navigator.mediaSession.setActionHandler('nexttrack', () => { n += 1; document.title = 'next ' + n })
</script></body>`

function fixture(): Buffer | null {
  const file = join(app.getAppPath(), 'tests', 'fixtures', 'media', 'loop.webm')
  return existsSync(file) ? readFileSync(file) : null
}

async function mediaTab(ctx: SmokeContext, path: string, html: string): Promise<Tab> {
  ctx.server.page(path, html)
  const tab = ctx.tabs.create(`${ctx.server.http}${path}`, { activate: true })
  await waitForPage(tab.view.webContents, `the ${path} fixture`, 8000, (at) => at.includes(path))
  await waitFor(async () => (await tab.view.webContents.executeJavaScript('(() => { const v = document.getElementById("v"); return !!v && !v.paused && v.currentTime > 0 })()')) === true, 8000, `the ${path} video to play`)
  return tab
}

async function sourceOf(ctx: SmokeContext, tabId: string, ready: (s: MediaSource) => boolean, what: string): Promise<MediaSource> {
  let found: MediaSource | null = null
  await waitFor(async () => {
    const state = await ctx.chrome.invoke<MediaHubState>('media', 'state')
    found = state.sources.find((s) => s.tabId === tabId) ?? null
    return found !== null && ready(found)
  }, 6000, what)
  return found as unknown as MediaSource
}

const page = (tab: Tab, script: string): Promise<unknown> => tab.view.webContents.executeJavaScript(script, true)

function close(ctx: SmokeContext, ...tabs: Tab[]): void {
  for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

const sources: SmokeCheck = {
  name: 'MD-01/03: muted autoplay is no source; a Media Session one is, with next, speed, pause and the toolbar popover',
  async run(ctx) {
    const video = fixture()
    if (!video) return
    ctx.server.route('/md/loop.webm', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': String(video.length), 'accept-ranges': 'none' }).end(video)
    })
    const quiet = await mediaTab(ctx, '/md/plain', plain('/md/loop.webm'))
    const loud = await mediaTab(ctx, '/md/session', session('/md/loop.webm'))
    try {
      await sleep(600)
      const state = await ctx.chrome.invoke<MediaHubState>('media', 'state')
      assert(!state.sources.some((s) => s.tabId === quiet.id), 'muted autoplay without a Media Session is not a source')
      const s = await sourceOf(ctx, loud.id, (x) => x.canNext && x.title === 'Apex loop', 'the Media Session source with next')
      assert(s.artist === 'Smoke fixture' && s.artwork?.startsWith('data:image/png') && s.video && s.playing, `title, artist, artwork and state come from the page (got ${JSON.stringify(s)})`)
      assert(s.visible && s.active, 'the showing tab is visible and holds media focus')

      // Next runs the page's own handler, through the page-world wrapper.
      await ctx.chrome.invoke('media', 'control', loud.id, 'next')
      await waitFor(() => loud.view.webContents.getTitle() === 'next 1', 4000, "the page's nexttrack handler to run")

      await ctx.chrome.invoke('media', 'setRate', loud.id, 1.5)
      await waitFor(async () => (await page(loud, 'document.getElementById("v").playbackRate')) === 1.5, 4000, 'the video to play at 1.5×')
      await sourceOf(ctx, loud.id, (x) => x.rate === 1.5, 'the source to report 1.5×')

      // No pause handler on the page: the helper pauses the element and the source stays, paused.
      await ctx.chrome.invoke('media', 'control', loud.id, 'pause')
      await waitFor(async () => (await page(loud, 'document.getElementById("v").paused')) === true, 4000, 'the video to pause')
      await sourceOf(ctx, loud.id, (x) => !x.playing, 'the paused source to stay listed')
      await ctx.chrome.invoke('media', 'control', loud.id, 'play')
      await sourceOf(ctx, loud.id, (x) => x.playing, 'the source to play again')

      // The toolbar button shows, and opens the popover with the source in it.
      await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('.np-button button'))`, 4000, 'the now-playing button')
      await ctx.chrome.js(`document.querySelector('.np-button button').click(); return true`)
      const doc = await docWith(ctx.chrome, '.np-pop', 5000, 'the now-playing popover')
      const text = await doc.js<string>(`return document.querySelector('.np-pop')?.textContent ?? ''`)
      assert(text.includes('Apex loop') && text.includes('Smoke fixture'), `the popover lists the source (got ${text.slice(0, 120)})`)
      // The overlay frame placed it, at its full width (the frame sizes the overlay view to it).
      const placed = await doc.until<{ w: number; h: number }>(
        `const el = document.querySelector('.np-pop'); if (!el || !el.closest('.ov-frame[data-placed]')) return false
         const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }`,
        3000,
        'the popover to be placed',
      )
      assert(placed.w >= 300 && placed.h > 60, `the popover is drawn at its size (got ${JSON.stringify(placed)})`)
      await doc.escape()
      await waitFor(async () => !(await doc.js<boolean>(`return Boolean(document.querySelector('.np-pop'))`).catch(() => false)), 3000, 'the popover to close')
    } finally {
      close(ctx, quiet, loud)
    }
  },
}

const autoPip: SmokeCheck = {
  name: 'MD-02: leaving a tab whose video plays with sound moves it into picture-in-picture, and back on return',
  async run(ctx) {
    const video = fixture()
    if (!video || !ctx.settings.get().autoPictureInPicture) return
    ctx.server.route('/md/loop.webm', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': String(video.length), 'accept-ranges': 'none' }).end(video)
    })
    const tab = await mediaTab(ctx, '/md/pip', plain('/md/loop.webm'))
    const other = ctx.tabs.create('about:blank', { activate: false })
    try {
      await page(tab, 'document.getElementById("v").muted = false')
      await waitFor(async () => (await page(tab, 'document.getElementById("v").muted')) === false, 3000, 'the video to unmute')
      await sleep(400)
      ctx.tabs.activate(other.id)
      await waitFor(async () => (await page(tab, 'document.pictureInPictureElement !== null')) === true, 5000, 'the video to move into picture-in-picture')
      ctx.tabs.activate(tab.id)
      await waitFor(async () => (await page(tab, 'document.pictureInPictureElement === null')) === true, 5000, 'the video to come back')
    } finally {
      close(ctx, tab, other)
    }
  },
}

const shots: ShotSpec[] = [
  {
    name: 'md-now-playing',
    async run(ctx) {
      const video = fixture()
      if (!video) return
      ctx.server.route('/md/loop.webm', (_req, res) => {
        res.writeHead(200, { 'content-type': 'video/webm', 'content-length': String(video.length) }).end(video)
      })
      const tab = await mediaTab(ctx, '/md/shot', session('/md/loop.webm'))
      try {
        await sourceOf(ctx, tab.id, (x) => x.title === 'Apex loop', 'the source for the shot')
        await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('.np-button button'))`, 4000, 'the now-playing button')
        await ctx.chrome.js(`document.querySelector('.np-button button').click(); return true`)
        await docWith(ctx.chrome, '.np-pop', 5000, 'the now-playing popover')
        await sleep(300)
        await ctx.shot('md-now-playing')
      } finally {
        close(ctx, tab)
      }
    },
  },
]

export const mediaSmoke: SmokeGroup = { group: 'MEDIA', checks: [sources, autoPip], shots }

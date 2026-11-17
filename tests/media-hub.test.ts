/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEDIA_MEMORY,
  autoPipEligible,
  cardSource,
  clampRate,
  mediaHubState,
  mediaSources,
  nearestRate,
  observeMedia,
  parseSessionDetail,
  pickArtwork,
  playsForReal,
  rateLabel,
  usableArtwork,
  type MediaMemory,
  type MediaTabInput,
  type PageMediaReport,
} from '@shared/media'

// MD-01 to MD-03: which tabs are sources, in what order, which one media keys
// follow, the sidebar card's pick, the speed helpers and the auto PiP rule.

const report = (over: Partial<PageMediaReport> = {}): PageMediaReport => ({
  playing: true,
  video: true,
  sound: true,
  rate: 1,
  pip: false,
  canPip: true,
  resumable: true,
  title: '',
  artist: '',
  album: '',
  artwork: null,
  actions: [],
  ...over,
})

const tab = (id: string, over: Partial<MediaTabInput> = {}): MediaTabInput => ({
  id,
  title: `Tab ${id}`,
  url: `https://www.${id}.example/watch`,
  favicon: null,
  audible: false,
  muted: false,
  visible: false,
  elsewhere: false,
  report: null,
  ...over,
})

/** Runs observeMedia over a sequence of looks, as the hub does. */
function run(looks: MediaTabInput[][], memory: MediaMemory = EMPTY_MEDIA_MEMORY): MediaMemory {
  let m = memory
  let playing = new Map<string, boolean>()
  for (const tabs of looks) [m, playing] = observeMedia(m, playing, tabs)
  return m
}

describe('media sources', () => {
  it('counts sound, a Media Session or Chromium hearing it; not muted autoplay', () => {
    expect(playsForReal(tab('a', { report: report() }))).toBe(true)
    expect(playsForReal(tab('a', { report: report({ sound: false }) }))).toBe(false)
    expect(playsForReal(tab('a', { report: report({ sound: false, title: 'Song' }) }))).toBe(true)
    expect(playsForReal(tab('a', { audible: true }))).toBe(true)
    expect(playsForReal(tab('a', { report: report({ playing: false }) }))).toBe(false)
  })

  it('orders playing sources newest first and marks the newest active', () => {
    const a = tab('a', { report: report() })
    const b = tab('b', { report: report() })
    const m = run([[a, tab('b')], [a, b]])
    const sources = mediaSources([a, b], m)
    expect(sources.map((s) => s.tabId)).toEqual(['b', 'a'])
    expect(sources.map((s) => s.active)).toEqual([true, false])
    expect(sources[0]!.site).toBe('b.example')
  })

  it('keeps a paused source listed while it can resume, after the playing ones', () => {
    const playing = tab('a', { report: report() })
    const paused = tab('a', { report: report({ playing: false }) })
    const b = tab('b', { report: report() })
    const m = run([[playing, tab('b')], [playing, b], [paused, b]])
    const sources = mediaSources([paused, b], m)
    expect(sources.map((s) => [s.tabId, s.playing])).toEqual([
      ['b', true],
      ['a', false],
    ])
    // Nothing left to resume (the page ended it): it leaves the list.
    const gone = tab('a', { report: report({ playing: false, resumable: false }) })
    const after = run([[gone, b]], m)
    expect(mediaSources([gone, b], after).map((s) => s.tabId)).toEqual(['b'])
  })

  it('never lists a tab that only played muted autoplay', () => {
    const muted = tab('a', { report: report({ sound: false }) })
    const m = run([[muted], [muted]])
    expect(mediaSources([muted], m)).toEqual([])
  })

  it('hides a dismissed tab until it goes quiet and plays again', () => {
    const a = tab('a', { report: report() })
    let m = run([[a]])
    m = { ...m, dismissed: new Set(['a']) }
    m = run([[a]], m)
    expect(mediaSources([a], m)).toEqual([])
    const quiet = tab('a', { report: report({ playing: false }) })
    let playing = new Map([['a', true]])
    ;[m, playing] = observeMedia(m, playing, [quiet])
    expect(m.dismissed.has('a')).toBe(false)
    expect(mediaSources([quiet], m)).toEqual([])
    ;[m, playing] = observeMedia(m, playing, [a])
    expect(mediaSources([a], m).map((s) => s.tabId)).toEqual(['a'])
  })

  it('keeps the tab Apex paused until it plays again, and forgets closed tabs', () => {
    const a = tab('a', { report: report() })
    let [m, playing] = observeMedia(EMPTY_MEDIA_MEMORY, new Map(), [a])
    m = { ...m, held: 'a' }
    const paused = tab('a', { report: report({ playing: false, resumable: false }) })
    ;[m, playing] = observeMedia(m, playing, [paused])
    expect(mediaSources([paused], m).map((s) => s.tabId)).toEqual(['a'])
    ;[m, playing] = observeMedia(m, playing, [a])
    expect(m.held).toBeNull()
    ;[m] = observeMedia(m, playing, [])
    expect(m.started).toEqual([])
    expect(m.known.size).toBe(0)
  })

  it('uses the Media Session for title, artist, artwork and next/previous', () => {
    const a = tab('a', { report: report({ title: 'Song', artist: 'Band', artwork: 'https://a.example/c.png', actions: ['play', 'pause', 'nexttrack'] }) })
    const [s] = mediaSources([a], run([[a]]))
    expect(s).toMatchObject({ title: 'Song', artist: 'Band', artwork: 'https://a.example/c.png', canNext: true, canPrevious: false })
    const b = tab('b', { title: 'Page', report: report({ album: 'Album' }) })
    expect(mediaSources([b], run([[b]]))[0]).toMatchObject({ title: 'Page', artist: 'Album', canNext: false })
  })

  it('gives the sidebar card the first source that is not showing in this window', () => {
    const a = tab('a', { report: report(), visible: true })
    const b = tab('b', { report: report(), elsewhere: true })
    const c = tab('c', { report: report() })
    const state = mediaHubState([a, b, c], run([[a, tab('b'), tab('c')], [a, b, tab('c')], [a, b, c]]))
    expect(state.sources.map((s) => s.tabId)).toEqual(['c', 'b', 'a'])
    expect(state.cardId).toBe('c')
    expect(cardSource(state.sources.filter((s) => s.tabId !== 'c'))).toBeNull()
  })
})

describe('playback speed', () => {
  it('clamps to 0.5–3× and finds the offered speed', () => {
    expect(clampRate(0.1)).toBe(0.5)
    expect(clampRate(7)).toBe(3)
    expect(clampRate(Number.NaN)).toBe(1)
    expect(clampRate(1.333)).toBe(1.33)
    expect(nearestRate(1.3)).toBe(1.25)
    expect(nearestRate(2.9)).toBe(3)
    expect(rateLabel(1.5, 'en')).toBe('1.5×')
    expect(rateLabel(1.5, 'nl')).toBe('1,5×')
  })
})

describe('automatic picture-in-picture', () => {
  const base = { enabled: true, audible: false, tabMuted: false, agentControlled: false, chromeDrawn: false, report: report() }
  it('moves a video playing with sound, even in a quiet passage', () => {
    expect(autoPipEligible(base)).toBe(true)
  })
  it('skips audio alone, muted video, a page that forbids it and one already floating', () => {
    expect(autoPipEligible({ ...base, report: report({ video: false }) })).toBe(false)
    expect(autoPipEligible({ ...base, report: report({ sound: false }) })).toBe(false)
    expect(autoPipEligible({ ...base, report: report({ canPip: false }) })).toBe(false)
    expect(autoPipEligible({ ...base, report: report({ pip: true }) })).toBe(false)
    expect(autoPipEligible({ ...base, report: report({ playing: false }) })).toBe(false)
  })
  it('never for an agent tab, a muted tab, a page Apex draws or with the setting off', () => {
    expect(autoPipEligible({ ...base, enabled: false })).toBe(false)
    expect(autoPipEligible({ ...base, tabMuted: true })).toBe(false)
    expect(autoPipEligible({ ...base, agentControlled: true })).toBe(false)
    expect(autoPipEligible({ ...base, chromeDrawn: true })).toBe(false)
  })
  it('falls back to Chromium hearing the tab without a report', () => {
    expect(autoPipEligible({ ...base, report: null })).toBe(false)
    expect(autoPipEligible({ ...base, report: null, audible: true })).toBe(true)
  })
})

describe('Media Session details', () => {
  it('picks artwork near 96 px and only drawable addresses', () => {
    expect(pickArtwork([{ src: 'https://a/1.png', sizes: '48x48' }, { src: 'https://a/2.png', sizes: '512x512' }, { src: 'https://a/3.png', sizes: '128x128' }])).toBe('https://a/3.png')
    expect(pickArtwork([{ src: 'https://a/1.png', sizes: '48x48' }, { src: 'https://a/2.png', sizes: '64x64' }])).toBe('https://a/2.png')
    expect(pickArtwork([{ src: 'javascript:alert(1)', sizes: 'any' }])).toBeNull()
    expect(usableArtwork('data:image/png;base64,AAAA')).toBe(true)
    expect(usableArtwork('data:text/html,<b>')).toBe(false)
    expect(usableArtwork(`https://a/${'x'.repeat(5000)}`)).toBe(false)
  })
  it('parses the page world report and drops what it may not say', () => {
    const parsed = parseSessionDetail(JSON.stringify({ actions: ['nexttrack', 'seekto', 'play'], title: '  A   song ', artist: 7, artwork: [{ src: 'https://a/c.png', sizes: '96x96' }, { src: 1 }] }))
    expect(parsed).toEqual({ actions: ['play', 'nexttrack'], title: 'A song', artist: '', album: '', artwork: 'https://a/c.png' })
    expect(parseSessionDetail('not json').actions).toEqual([])
    expect(parseSessionDetail({ title: 'x' }).title).toBe('')
  })
})

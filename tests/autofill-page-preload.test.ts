/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The page preload entry (src/preload/page.ts): autofill installs in every
// frame, the other parts only in the top frame, and a part that throws on a
// page can't leave the parts after it (autofill above all) missing there. A
// page with no autofill reports on its first load came from exactly that.

const h = vi.hoisted(() => ({ calls: [] as string[], throwing: new Set<string>(), dialogs: [] as unknown[] }))
const part = (name: string) => () => {
  h.calls.push(name)
  if (h.throwing.has(name)) throw new Error(`${name} broke`)
}

vi.mock('../src/preload/page/bridge', () => ({ installBridge: part('bridge') }))
vi.mock('../src/preload/page/dialogs', () => ({
  installDialogs: (opts?: unknown) => {
    h.dialogs.push(opts)
    part('dialogs')()
  },
}))
vi.mock('../src/preload/page/links', () => ({ installLinks: part('links') }))
vi.mock('../src/preload/page/privacy', () => ({ installPrivacy: part('privacy') }))
vi.mock('../src/preload/page/scroll', () => ({ installScroll: part('scroll') }))
vi.mock('../src/preload/page/selection', () => ({ installSelection: part('selection') }))
vi.mock('../src/preload/page/capture', () => ({ installCapture: part('capture') }))
vi.mock('../src/preload/autofill', () => ({ installAutofill: part('autofill') }))
// MD-01's media helper needs a DOM; its own tests are tests/media-*.test.ts.
vi.mock('../src/preload/page/media', () => ({ installMedia: () => undefined }))
// TR-07's translate part needs a DOM too; its logic is tests/translate-dom.test.ts's.
vi.mock('../src/preload/page/translate', () => ({ installTranslate: () => undefined }))
// RD-01's reader probe and TWK-03's tweaks part need a DOM as well; their own
// tests are tests/reader.test.ts and tests/tweaks.test.ts.
vi.mock('../src/preload/page/reader', () => ({ installReader: () => undefined }))
vi.mock('../src/preload/page/tweaks', () => ({ installTweaks: () => undefined }))

async function load(top: boolean, hostname = 'example.com', path = '/'): Promise<void> {
  const win: Record<string, unknown> = { location: { hostname, href: `https://${hostname}${path}` } }
  win.top = top ? win : {}
  vi.stubGlobal('window', win)
  vi.resetModules()
  await import('../src/preload/page')
}

afterEach(() => {
  h.calls.length = 0
  h.dialogs.length = 0
  h.throwing.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('page preload entry', () => {
  it('installs every part in the top frame, autofill last', async () => {
    await load(true)
    expect(h.calls).toEqual(['bridge', 'links', 'selection', 'dialogs', 'privacy', 'scroll', 'capture', 'autofill'])
  })

  it("leaves a sign-in page's own world alone: no dialog override, GPC flag or capture tracker", async () => {
    await load(true, 'accounts.google.com')
    expect(h.calls).toEqual(['bridge', 'links', 'selection', 'dialogs', 'scroll', 'autofill'])
    expect(h.dialogs).toEqual([{ mainWorld: false }])
    await load(true)
    expect(h.dialogs.at(-1)).toEqual({ mainWorld: true })
  })

  it("counts a provider's sign-in path on its main site (github.com/login), not the rest of the site", async () => {
    await load(true, 'github.com', '/login')
    expect(h.dialogs.at(-1)).toEqual({ mainWorld: false })
    await load(true, 'github.com', '/anthropics')
    expect(h.dialogs.at(-1)).toEqual({ mainWorld: true })
  })

  it('installs only the GPC flag, the capture tracker and autofill in a subframe', async () => {
    await load(false)
    // A same-tab iframe's camera counts toward the tab's icons.
    expect(h.calls).toEqual(['privacy', 'capture', 'autofill'])
  })

  it('still installs autofill when every earlier part throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const name of ['bridge', 'links', 'selection', 'dialogs', 'privacy', 'scroll', 'capture']) h.throwing.add(name)
    await load(true)
    expect(h.calls.at(-1)).toBe('autofill')
    expect(h.calls).toHaveLength(8)
    expect(errors).toHaveBeenCalledTimes(7)
  })
})

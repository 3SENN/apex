/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ElectronBlocker } from '@ghostery/adblocker-electron'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { settledEvent } from '../src/main/adblock'

// Ghostery's cosmetic handler fires a page's styles and scriptlets without
// waiting on them, so a scriptlet that threw in the page reached main as an
// unhandled rejection ("Script failed to execute"). Run through settledEvent,
// the library's own handler leaves nothing unhandled.

const throwing = (name: string) => ({ name, aliases: [], body: 'function() { throw new Error("thrown in the page") }', dependencies: [], executionWorld: 'MAIN', requiresTrust: false })

function blocker(): ElectronBlocker {
  const b = ElectronBlocker.parse(['news.example##.ad-slot', 'news.example##+js(set-constant.js, adsShown, true)', 'news.example##+js(abort-on-property-read.js, trackMe)'].join('\n'))
  b.updateResources(JSON.stringify({ scriptlets: [throwing('set-constant.js'), throwing('abort-on-property-read.js')], redirects: [] }), 'test')
  return b
}

const failingSender = (calls: string[]) => ({
  insertCSS: async () => (calls.push('css'), 'key'),
  executeJavaScript: async () => {
    calls.push('js')
    throw new Error('Script failed to execute, this normally means an error was thrown.')
  },
})

describe('cosmetic filters', () => {
  it('a scriptlet that throws in the page leaves no unhandled rejection', async () => {
    const calls: string[] = []
    const unhandled: unknown[] = []
    const note = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', note)
    try {
      const event = { sender: failingSender(calls), frameId: 1, processId: 7 } as unknown as IpcMainInvokeEvent
      await blocker().onInjectCosmeticFilters(settledEvent(event), 'https://news.example/story', undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', note)
    }
    expect(calls).toEqual(['css', 'js', 'js'])
    expect(unhandled).toEqual([])
  })

  it('keeps the event’s frame and process, and the sender’s calls settle', async () => {
    const event = settledEvent({ sender: failingSender([]), frameId: 3, processId: 9 } as unknown as IpcMainInvokeEvent)
    expect([event.frameId, event.processId]).toEqual([3, 9])
    await expect(event.sender.executeJavaScript('throw 1')).resolves.toBeUndefined()
    await expect(event.sender.insertCSS('.x{}')).resolves.toBe('key')
  })
})

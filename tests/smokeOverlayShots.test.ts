/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { closeOverlaysSince, drawnScript, openOverlayIds, settleOverlays, withOverlaysClosed, type OverlayProbe } from '../src/main/smokeShots'

// The phase shots of overlay surfaces: a shot waits until its surface
// has drawn (main registers it a frame or more before the renderer paints
// it), and each shot closes what it opened, so the command bar opened for
// one shot never shows up in the next.

type Tier = 'interactive' | 'passive'

function fakeProbe(open: { instanceId: string; surface: string; tier: Tier }[], drawsAfter = 0): OverlayProbe & { closed: string[]; calls: number } {
  let bounds: { width: number; height: number } | null = null
  const probe = {
    closed: [] as string[],
    calls: 0,
    openSurfaces: () => open,
    interactiveBounds: () => bounds,
    tierWebContents: () => ({
      isDestroyed: () => false,
      executeJavaScript: async () => {
        probe.calls++
        const ready = probe.calls > drawsAfter
        // The view gets its bounds once the renderer has measured the surface.
        if (ready) bounds = { width: 320, height: 48 }
        return { ready, visible: true }
      },
    }),
    close: (id: string) => {
      probe.closed.push(id)
      open.splice(
        open.findIndex((s) => s.instanceId === id),
        1,
      )
    },
  }
  return probe as unknown as OverlayProbe & { closed: string[]; calls: number }
}

describe('settleOverlays', () => {
  it('waits until the surface has drawn and the interactive view has bounds', async () => {
    const probe = fakeProbe([{ instanceId: 'a', surface: 'command-bar', tier: 'interactive' }], 3)
    expect(await settleOverlays(() => [probe], 2000)).toBe(true)
    expect(probe.calls).toBeGreaterThan(3)
    expect(probe.interactiveBounds()?.width).toBe(320)
  })

  it('is ready at once with nothing open', async () => {
    expect(await settleOverlays(() => [fakeProbe([])], 200)).toBe(true)
  })

  it('gives up quietly when a surface never draws, so the shot is still taken', async () => {
    const probe = fakeProbe([{ instanceId: 'a', surface: 'find-bar', tier: 'interactive' }], Number.POSITIVE_INFINITY)
    expect(await settleOverlays(() => [probe], 150)).toBe(false)
  })

  it('names the surfaces it waits for as data in the tier script', () => {
    const script = drawnScript(['permission-prompt', "x'); alert(1); ('"])
    expect(script).toContain('["permission-prompt","x\'); alert(1); (\'"]')
    expect(script).toContain('data-placed')
  })
})

describe('closing what a shot opened', () => {
  it('closes only instances opened since, and leaves earlier ones', async () => {
    const open: { instanceId: string; surface: string; tier: Tier }[] = [{ instanceId: 'keep', surface: 'toast', tier: 'passive' }]
    const probe = fakeProbe(open)
    const before = await openOverlayIds(() => [probe])
    open.push({ instanceId: 'bar', surface: 'command-bar', tier: 'interactive' })
    expect(await closeOverlaysSince(before, () => [probe], 500)).toEqual(['command-bar'])
    expect(probe.closed).toEqual(['bar'])
    expect(open.map((s) => s.instanceId)).toEqual(['keep'])
  })

  it('closes the shot’s surfaces even when the shot fails', async () => {
    const open: { instanceId: string; surface: string; tier: Tier }[] = []
    const probe = fakeProbe(open)
    await expect(
      withOverlaysClosed(async () => {
        open.push({ instanceId: 'p', surface: 'permission-prompt', tier: 'interactive' })
        throw new Error('shot failed')
      }, () => [probe]),
    ).rejects.toThrow('shot failed')
    expect(probe.closed).toEqual(['p'])
  })
})

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import type { AppContext, Feature, ServiceParts, WindowContext } from '../src/main/features/types'
import { isWebPartition, withSafety } from '../src/main/features/sitesSafety'
import { log } from '../src/main/log'
import type { Tab } from '../src/main/tabs'

// How the errors and safety half joins the sites feature, and which
// sessions get the browsing layers.

describe('isWebPartition', () => {
  it('treats sandbox partitions as locked down, everything else as browsing', () => {
    expect(isWebPartition('')).toBe(true)
    expect(isWebPartition('persist:profile-work')).toBe(true)
    expect(isWebPartition('private-1')).toBe(true)
    expect(isWebPartition('apex-preprocess')).toBe(false)
    expect(isWebPartition('apex-artifacts')).toBe(false)
    expect(isWebPartition('persist:apex-app-notes')).toBe(false)
    expect(isWebPartition('apex-artifacts-extra')).toBe(true)
  })
})

describe('withSafety', () => {
  const app = { settings: { get: () => ({}) } } as unknown as AppContext
  // Each half's failure is logged and skipped; keep the run quiet.
  vi.spyOn(log, 'warn').mockImplementation(() => undefined)

  it('adds the page error services beside the inner feature’s', () => {
    const sitesPart = { isOnline: 'stub' } as unknown as ServiceParts['sites']
    const inner: Feature = { name: 'sites', app: () => ({ sites: sitesPart, network: { isOnline: () => true } }) }
    const parts = withSafety(inner).app?.(app) as Record<string, Record<string, unknown>>
    expect(parts.sites).toBe(sitesPart)
    expect(Object.keys(parts.network ?? {}).sort()).toEqual(['check', 'isOnline'])
    expect(Object.keys(parts.pageErrors ?? {}).sort()).toEqual(['allowAdblock', 'details', 'leave', 'proceed', 'retry'])
  })

  it('runs the inner tab hook first and survives either half failing', () => {
    const order: string[] = []
    const innerCleanup = vi.fn(() => order.push('inner cleanup'))
    const inner: Feature = {
      name: 'sites',
      tab: () => {
        order.push('inner')
        return innerCleanup
      },
      window: () => {
        throw new Error('inner window broke')
      },
    }
    const f = withSafety(inner)
    f.app?.(app)
    // The safety half throws on this fake tab (it has no webContents) and is skipped.
    const cleanup = f.tab?.({ id: 't1' } as Tab, {} as WindowContext)
    expect(order).toEqual(['inner'])
    cleanup?.()
    expect(innerCleanup).toHaveBeenCalledOnce()
    // An inner window hook that throws still lets the safety half decorate the window's tabs.
    const tabs = { decorate: vi.fn(), cover: vi.fn() }
    expect(f.window?.({ tabs } as unknown as WindowContext)).toBeUndefined()
    expect(tabs.decorate).toHaveBeenCalledOnce()
    expect(tabs.cover).toHaveBeenCalledOnce()
  })

  it('keeps the feature’s name and its other hooks', () => {
    const dispose = vi.fn()
    const f = withSafety({ name: 'sites', dispose })
    expect(f.name).toBe('sites')
    expect(f.dispose).toBe(dispose)
  })

  it('reports page errors on a closed tab as a clear error', () => {
    const parts = withSafety({ name: 'sites' }).app?.(app) as { pageErrors: { retry(id: string): void; details(id: string): unknown } }
    expect(() => parts.pageErrors.retry('missing')).toThrow('That tab is closed.')
    expect(parts.pageErrors.details('missing')).toBeNull()
  })
})

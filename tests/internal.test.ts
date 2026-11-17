/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { areaIncluded, internalAlias, internalBuild, internalDefines, internalPresent, isInternal, publicRelease } from '../scripts/internal.mjs'
import { withExtraResources } from '../scripts/release/builderConfig.mjs'
import { EXTRA_CHAT_ERROR_CODES, EXTRA_ENGINE_IDS, EXTRA_ENGINE_SETTINGS } from '../src/stubs/engines/shared'
import { createExtraEngines as stubEngines, EXTRA_SERVICE_SCHEMAS as STUB_SERVICE_SCHEMAS } from '../src/stubs/engines/main'
import { engines as STUB_EN } from '../src/stubs/engines/i18n/en'

// scripts/internal.mjs: builds use the private internal/ folder when it is there, else the stubs in src/stubs/.
// A public release takes the engines from the stubs even with the folder there: it offers only the API key.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(withInternal: boolean, marker = '{ "name": "apex-internal" }'): string {
  const dir = mkdtempSync(join(tmpdir(), 'apex-internal-'))
  made.push(dir)
  if (withInternal) {
    mkdirSync(join(dir, 'internal'), { recursive: true })
    writeFileSync(join(dir, 'internal', 'internal.json'), marker)
  }
  return dir
}

describe('builds with and without the internal folder', () => {
  it('uses internal/ only when its marker is there and APEX_INTERNAL is not 0', () => {
    const withIt = repo(true)
    expect(internalPresent(withIt)).toBe(true)
    expect(isInternal({}, withIt)).toBe(true)
    expect(isInternal({ APEX_INTERNAL: '0' }, withIt)).toBe(false)
    expect(isInternal({}, repo(false))).toBe(false)
    expect(isInternal({}, repo(true, '{ "name": "something-else" }'))).toBe(false)
    expect(isInternal({}, repo(true, 'not json'))).toBe(false)
  })

  it('points @internal at internal/ or at src/stubs, and says which in the define', () => {
    const withIt = repo(true)
    expect(internalAlias({}, withIt)['@internal']).toBe(join(withIt, 'internal'))
    expect(internalAlias({ APEX_INTERNAL: '0' }, withIt)['@internal']).toBe(join(withIt, 'src', 'stubs'))
    expect(internalDefines({}, withIt)).toEqual({ __APEX_INTERNAL__: 'true' })
    expect(internalDefines({}, repo(false))).toEqual({ __APEX_INTERNAL__: 'false' })
  })
})

describe('a public release', () => {
  it('takes the engines from the public stubs, though internal/ is there for its release values', () => {
    const withIt = repo(true)
    const alias = internalAlias({ APEX_PUBLIC_RELEASE: '1' }, withIt)
    expect(alias['@internal/engines']).toBe(join(withIt, 'src', 'stubs', 'engines'))
    expect(alias['@internal']).toBe(join(withIt, 'internal'))
    // The more specific alias comes first, so Vite matches it before the folder's.
    expect(Object.keys(alias)).toEqual(['@internal/engines', '@internal'])
    expect(areaIncluded('engines', { APEX_PUBLIC_RELEASE: 'true' }, withIt)).toBe(false)
    expect(areaIncluded('engines', {}, withIt)).toBe(true)
    expect(publicRelease({ APEX_PUBLIC_RELEASE: '0' })).toBe(false)
    // Not a public release: the folder's engines, with no override.
    expect(internalAlias({}, withIt)).toEqual({ '@internal': join(withIt, 'internal') })
  })

  it('runs none of the folder’s engine packaging and ships none of its resources', () => {
    const withIt = repo(true)
    writeFileSync(join(withIt, 'internal', 'build.json'), JSON.stringify({ areas: { engines: { prepackage: ['internal/scripts/stage.mjs'], extraResources: { mac: [{ from: 'vendor/x', to: 'x' }] } } } }))
    expect(internalBuild({}, withIt)).toEqual({ prepackage: ['internal/scripts/stage.mjs'], extraResources: { mac: [{ from: 'vendor/x', to: 'x' }] } })
    expect(internalBuild({ APEX_PUBLIC_RELEASE: '1' }, withIt)).toEqual({ prepackage: [], extraResources: {} })
    expect(internalBuild({}, repo(false))).toEqual({ prepackage: [], extraResources: {} })
    // electron-builder gets the folder's resources after the yml's own.
    const merged = withExtraResources({ mac: { extraResources: [{ from: 'a', to: 'a' }] } }, { mac: [{ from: 'b', to: 'b' }] })
    expect(merged.mac.extraResources).toEqual([{ from: 'a', to: 'a' }, { from: 'b', to: 'b' }])
  })

  it('has no engine besides the API key in the stubs', () => {
    expect(EXTRA_ENGINE_IDS).toEqual([])
    expect(EXTRA_CHAT_ERROR_CODES).toEqual([])
    expect(EXTRA_ENGINE_SETTINGS).toEqual({})
    expect(STUB_SERVICE_SCHEMAS).toEqual({})
    expect(stubEngines({} as never).ids).toEqual([])
    expect(stubEngines({} as never).backends).toEqual({})
    expect(Object.keys(STUB_EN)).toEqual([])
  })
})

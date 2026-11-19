/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { internalBuild, internalPresent, isInternal } from '../scripts/internal.mjs'
import { withExtraResources } from '../scripts/release/builderConfig.mjs'
import { EXTRA_ENGINE_IDS } from '../src/engines/shared'
import { CLAUDE_CODE_ENGINE_BUILT } from '../src/engines/claude-code/main/engine'

// scripts/internal.mjs: the private internal/ folder holds only the maintainer's
// own files (release values, private documents, packaging steps). Every build,
// public releases included, has the same app code and engines.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(withInternal: boolean, marker = '{ "name": "atelier-internal" }'): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-internal-'))
  made.push(dir)
  if (withInternal) {
    mkdirSync(join(dir, 'internal'), { recursive: true })
    writeFileSync(join(dir, 'internal', 'internal.json'), marker)
  }
  return dir
}

describe('builds with and without the internal folder', () => {
  it('uses internal/ only when its marker is there and ATELIER_INTERNAL is not 0', () => {
    const withIt = repo(true)
    expect(internalPresent(withIt)).toBe(true)
    expect(isInternal({}, withIt)).toBe(true)
    expect(isInternal({ ATELIER_INTERNAL: '0' }, withIt)).toBe(false)
    expect(isInternal({}, repo(false))).toBe(false)
    expect(isInternal({}, repo(true, '{ "name": "something-else" }'))).toBe(false)
    expect(isInternal({}, repo(true, 'not json'))).toBe(false)
  })

  it('runs the folder’s packaging steps and ships its resources only when it is there', () => {
    const withIt = repo(true)
    writeFileSync(join(withIt, 'internal', 'build.json'), JSON.stringify({ areas: { engines: { prepackage: ['internal/scripts/stage.mjs'], extraResources: { mac: [{ from: 'vendor/x', to: 'x' }] } } } }))
    expect(internalBuild({}, withIt)).toEqual({ prepackage: ['internal/scripts/stage.mjs'], extraResources: { mac: [{ from: 'vendor/x', to: 'x' }] } })
    expect(internalBuild({ ATELIER_INTERNAL: '0' }, withIt)).toEqual({ prepackage: [], extraResources: {} })
    expect(internalBuild({}, repo(false))).toEqual({ prepackage: [], extraResources: {} })
    // electron-builder gets the folder's resources after the yml's own.
    const merged = withExtraResources({ mac: { extraResources: [{ from: 'a', to: 'a' }] } }, { mac: [{ from: 'b', to: 'b' }] })
    expect(merged.mac.extraResources).toEqual([{ from: 'a', to: 'a' }, { from: 'b', to: 'b' }])
  })
})

describe('the engines', () => {
  it('are part of every build: your Claude subscription next to the API key', () => {
    expect(EXTRA_ENGINE_IDS).toEqual(['claude-code'])
    expect(CLAUDE_CODE_ENGINE_BUILT).toBe(true)
  })
})

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict'
// Loads Apex's haptics addon (build/apex_haptics.node, from
// scripts/build-native.mjs). When it can't (not macOS, not built, the
// wrong architecture, a broken binary), it returns a stub whose perform()
// accepts the same patterns and does nothing, so callers never branch.
//
//   const { loadHaptics } = require('./native/haptics')
//   const haptics = loadHaptics({ paths: [file] })
//   haptics.perform('alignment')   // true when handed to macOS, else false
//
// src/main/native/haptics.ts wraps this with the rate limit and
// the settings.haptics switch.

const fs = require('node:fs')
const path = require('node:path')

const BINARY = 'apex_haptics.node'

/** The patterns AppKit's NSHapticFeedbackManager offers. */
const PATTERNS = Object.freeze(['alignment', 'levelChange', 'generic'])

// The haptics service spells its kinds in kebab case.
const ALIASES = new Map([['level-change', 'levelChange']])

const MAX_NAME = 16

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, MAX_NAME + 4))
  if (value === null) return 'null'
  return typeof value
}

/**
 * Returns the canonical pattern name, or throws a TypeError.
 * @param {unknown} pattern
 * @returns {'alignment' | 'levelChange' | 'generic'}
 */
function normalisePattern(pattern) {
  if (typeof pattern === 'string' && pattern.length <= MAX_NAME) {
    const name = ALIASES.get(pattern) ?? pattern
    if (PATTERNS.includes(name)) return name
  }
  throw new TypeError(
    `Unknown haptic pattern ${describe(pattern)} (use alignment, levelChange or generic)`,
  )
}

/**
 * Where the addon is looked for, in order: the packaged app's
 * Resources/native folder (when running inside Electron), then this
 * folder's build output.
 * @param {string | undefined} [resourcesPath] defaults to Electron's process.resourcesPath
 * @returns {string[]}
 */
function defaultPaths(resourcesPath = process.resourcesPath) {
  const paths = []
  if (typeof resourcesPath === 'string' && resourcesPath) {
    paths.push(path.join(resourcesPath, 'native', BINARY))
  }
  paths.push(path.join(__dirname, 'build', BINARY))
  return paths
}

/**
 * A haptics object that does nothing.
 * @param {'unsupported-platform' | 'missing' | 'load-failed' | 'invalid-addon'} reason
 * @param {string} [error]
 */
function createStub(reason, error) {
  const stub = {
    available: false,
    reason,
    path: null,
    perform(pattern) {
      normalisePattern(pattern)
      return false
    },
  }
  if (error !== undefined) stub.error = error
  return Object.freeze(stub)
}

function errorMessage(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Loads the addon, or returns a stub saying why it couldn't.
 * @param {{
 *   paths?: readonly string[],
 *   platform?: string,
 *   dlopen?: (module: { exports: unknown }, filename: string) => void,
 *   exists?: (file: string) => boolean,
 * }} [options]
 */
function loadHaptics(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return createStub('unsupported-platform')

  const exists = options.exists ?? fs.existsSync
  const dlopen = options.dlopen ?? ((mod, file) => process.dlopen(mod, file))
  const candidates = options.paths ?? defaultPaths()

  const file = candidates.find((candidate) => {
    try {
      return exists(candidate)
    } catch {
      return false
    }
  })
  if (file === undefined) return createStub('missing')

  const mod = { exports: {} }
  try {
    dlopen(mod, file)
  } catch (err) {
    return createStub('load-failed', errorMessage(err))
  }

  const addon = mod.exports
  if (addon === null || typeof addon !== 'object' || typeof addon.perform !== 'function') {
    return createStub('invalid-addon', `${file} has no perform function`)
  }

  const nativePerform = addon.perform
  return Object.freeze({
    available: true,
    reason: 'loaded',
    path: file,
    perform(pattern) {
      const name = normalisePattern(pattern)
      try {
        return nativePerform(name) === true
      } catch {
        // A haptic tick is never worth an exception in a drag handler.
        return false
      }
    },
  })
}

let shared

/** Loads the addon on first use from the default paths, then reuses it. */
function getHaptics() {
  if (shared === undefined) shared = loadHaptics()
  return shared
}

/**
 * Plays one pattern through the shared instance.
 * @param {'alignment' | 'levelChange' | 'level-change' | 'generic'} pattern
 */
function perform(pattern) {
  return getHaptics().perform(pattern)
}

module.exports = {
  PATTERNS,
  BINARY,
  normalisePattern,
  defaultPaths,
  createStub,
  loadHaptics,
  getHaptics,
  perform,
}

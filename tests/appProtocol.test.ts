/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppPath } from '../src/main/appProtocol'

const root = resolve('/tmp/apex-renderer')

describe('resolveAppPath', () => {
  it('serves index.html for the root and maps paths under root', () => {
    expect(resolveAppPath(root, 'app://apex/')).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://apex/assets/index-abc.js')).toBe(join(root, 'assets/index-abc.js'))
  })

  it('refuses traversal, other hosts and other schemes', () => {
    // The URL parser collapses dot segments (including %2e%2e) before we see
    // them, so these stay inside root.
    expect(resolveAppPath(root, 'app://apex/../secrets.txt')).toBe(join(root, 'secrets.txt'))
    expect(resolveAppPath(root, 'app://apex/%2e%2e/%2e%2e/etc/passwd')).toBe(join(root, 'etc/passwd'))
    // Encoded slashes survive parsing and are caught after decoding.
    expect(resolveAppPath(root, 'app://apex/assets/..%2f..%2f..%2fetc%2fpasswd')).toBeNull()
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull()
    expect(resolveAppPath(root, 'file:///etc/passwd')).toBeNull()
    expect(resolveAppPath(root, 'app://apex/%00.js')).toBeNull()
    expect(resolveAppPath(root, 'app://apex/%E0%A4%A')).toBeNull()
  })
})

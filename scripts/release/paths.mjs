/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where things are on disk for the release scripts: the repo, dist/, and
// the unpacked app electron-builder leaves there for each platform and arch.

import { existsSync, readFileSync } from 'node:fs'
import { arch as hostArch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBranding } from '../branding.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DIST = join(REPO, 'dist')

export const packageJson = () => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

/** electron-builder's unpacked folder for a platform and arch. */
function unpackedDir(dist, platform, arch) {
  if (platform === 'darwin') return join(dist, arch === 'x64' ? 'mac' : `mac-${arch}`)
  const os = platform === 'win32' ? 'win' : 'linux'
  return join(dist, arch === 'x64' ? `${os}-unpacked` : `${os}-${arch}-unpacked`)
}

/**
 * The packaged app for this machine: its folder (the .app on macOS), the
 * executable to launch, and its Resources folder. Null when it isn't built.
 * It is named after the branding (Atelier.app, or Summit.app; scripts/branding.mjs).
 */
export function packagedApp({ dist = DIST, platform = process.platform, arch = hostArch(), productName = loadBranding().name } = {}) {
  const dir = unpackedDir(dist, platform, arch)
  if (platform === 'darwin') {
    const app = join(dir, `${productName}.app`)
    if (!existsSync(app)) return null
    return { app, executable: join(app, 'Contents', 'MacOS', productName), resources: join(app, 'Contents', 'Resources') }
  }
  const names = platform === 'win32' ? [`${productName}.exe`] : [packageJson().name, productName.toLowerCase(), productName]
  const executable = names.map((n) => join(dir, n)).find((p) => existsSync(p))
  return executable ? { app: dir, executable, resources: join(dir, 'resources') } : null
}

/** Every packaged app for this platform under dist/ (each arch electron-builder built), host arch first. */
export function packagedApps({ dist = DIST, platform = process.platform, arch = hostArch(), productName = loadBranding().name } = {}) {
  const arches = [arch, ...['x64', 'arm64'].filter((a) => a !== arch)]
  return arches.map((a) => ({ arch: a, ...packagedApp({ dist, platform, arch: a, productName }) })).filter((a) => a.executable)
}

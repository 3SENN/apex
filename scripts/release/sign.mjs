/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// electron-builder's mac.sign hook, set by builderConfig.mjs for every signed
// macOS build. electron-builder 26 finds the identity by SHA-1, then hands
// @electron/osx-sign its *name* (macPackager.js doSign), and codesign refuses
// a name two keychain certificates share ("ambiguous"). The options this hook
// gets still carry the hash (MacTargetHelper.buildSignOptions), so it signs
// with them as they are. Retried like electron-builder's own call, for the
// timestamp server's bad moments.

// Only Mach-O files get their own signature: osx-sign otherwise signs every
// non-text file (hundreds of locale .pak files), each with a timestamp request,
// and Apple's timestamp service starts refusing. The bundle's seal still covers
// the skipped resources.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { signAsync } from '@electron/osx-sign'

const ATTEMPTS = 3
const MACH_O = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

export function isMachO(path) {
  let fd
  try {
    if (!statSync(path).isFile()) return false
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && MACH_O.has(head.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function nonMachOFile(path) {
  try {
    return statSync(path).isFile() && !isMachO(path)
  } catch {
    return false
  }
}

export default async function sign(opts) {
  console.log(`  • Apex signing: codesign with ${opts.identity}`)
  const ignore = opts.ignore === undefined ? [] : Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore]
  const options = { ...opts, ignore: [...ignore, nonMachOFile] }
  for (let attempt = 1; ; attempt++) {
    try {
      return await signAsync(options)
    } catch (err) {
      if (attempt >= ATTEMPTS || /ambiguous|no identity found|not valid for use/i.test(String(err?.message ?? err))) throw err
      await new Promise((r) => setTimeout(r, 5000 * attempt))
    }
  }
}

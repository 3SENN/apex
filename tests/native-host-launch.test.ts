/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { idFromPublicKey } from '../src/main/extensions/crx'
import { unpackedId } from '../src/main/extensions/host'
import { NativePort, extensionOrigin, findHost, hostArgs, hostEnv, originAllowed } from '../src/main/extensions/nativeMessaging'
import { generateKeyPairSync } from 'node:crypto'
import { nodeLauncher, removeFolder } from './helpers/fakeProgram'

// password managers: a host starts the way Chrome starts it (the
// caller's origin, then --parent-window, from the host's own folder, with
// the browser's environment and none of Electron's switches), and the
// extension id a store package's key gives survives into the
// allowed_origins check. Fakes only: no real helper runs.

const ECHO_HOST = join(__dirname, 'fixtures/extensions/native-host/echo-host.mjs')
let dir = ''
let launcher = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-host-launch-'))
  mkdirSync(join(dir, 'bin'))
  // The launcher itself runs Node for the fake, so the host's own environment is what the fake reports
  // (on Windows a .bat, which starts through cmd.exe as Chrome starts it there).
  launcher = nodeLauncher(join(dir, 'bin', 'helper'), ECHO_HOST)
})
afterAll(() => removeFolder(dir))

describe('how Chrome starts a host', () => {
  it('passes the origin first, then --parent-window (0 on macOS and Linux, the window handle on Windows)', () => {
    const id = 'pejdijmoenmkgeppbflobdenhhabjlaj'
    expect(hostArgs(id, 'darwin')).toEqual(['chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/', '--parent-window=0'])
    expect(hostArgs(id, 'linux')).toEqual([extensionOrigin(id), '--parent-window=0'])
    expect(hostArgs(id, 'win32', 4242)).toEqual([extensionOrigin(id), '--parent-window=4242'])
  })

  it('drops Electron’s own switches from the environment and keeps the rest', () => {
    const env = hostEnv({ HOME: '/Users/x', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', NODE_OPTIONS: '--inspect', LANG: 'nl_NL.UTF-8' })
    expect(env).toEqual({ HOME: '/Users/x', PATH: '/usr/bin', LANG: 'nl_NL.UTF-8' })
  })

  it('runs the host from its own folder with those arguments and that environment', async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const port = new NativePort(launcher, hostArgs('pejdijmoenmkgeppbflobdenhhabjlaj', 'darwin'))
      const reply = new Promise<unknown>((resolve) => port.once('message', resolve))
      port.postMessage({ cmd: 'whoami' })
      const got = (await reply) as { args: string[]; cwd: string; runAsNode: string | null }
      port.disconnect()
      expect(got.args).toEqual(['chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/', '--parent-window=0'])
      expect(got.cwd.replace(/^\/private/, '')).toBe(join(dir, 'bin').replace(/^\/private/, ''))
      expect(got.runAsNode).toBeNull()
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = before
    }
  })
})

describe('allowed_origins', () => {
  const id = 'pejdijmoenmkgeppbflobdenhhabjlaj'

  it('admits the exact origin, with or without a trailing *, and nothing looser', () => {
    expect(originAllowed(`chrome-extension://${id}/`, id)).toBe(true)
    expect(originAllowed(`chrome-extension://${id}/*`, id)).toBe(true)
    expect(originAllowed(`chrome-extension://${id}`, id)).toBe(true)
    expect(originAllowed('chrome-extension://*/', id)).toBe(false)
    expect(originAllowed(`chrome-extension://${'a'.repeat(32)}/`, id)).toBe(false)
    expect(originAllowed(`https://${id}/`, id)).toBe(false)
    expect(originAllowed(42, id)).toBe(false)
  })

  it('finds a helper whose manifest lists two extensions, as Apple’s does', () => {
    const hosts = join(dir, 'hosts')
    mkdirSync(hosts, { recursive: true })
    writeFileSync(
      join(hosts, 'com.example.passwords.json'),
      JSON.stringify({ name: 'com.example.passwords', description: 'Helper', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`, 'chrome-extension://mfbcdcnpokpoajjciilocoachedjkima/'] }),
    )
    expect(findHost('com.example.passwords', id, [hosts])).toMatchObject({ ok: true, host: { path: launcher } })
    expect(findHost('com.example.passwords', 'mfbcdcnpokpoajjciilocoachedjkima', [hosts]).ok).toBe(true)
    expect(findHost('com.example.passwords', 'b'.repeat(32), [hosts])).toMatchObject({ ok: false, reason: expect.stringMatching(/forbidden/) })
  })
})

describe('the store package’s key keeps the id', () => {
  it('an unpacked copy whose manifest carries the package key loads under the store id, wherever it sits', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    const id = idFromPublicKey(spki)
    const key = spki.toString('base64')
    expect(unpackedId('/anywhere/one', { manifest_version: 3, key })).toBe(id)
    expect(unpackedId('/somewhere/else', { manifest_version: 3, key })).toBe(id)
    // Without the key the id comes from the folder, so it would not match the host's allowed_origins.
    expect(unpackedId('/anywhere/one', { manifest_version: 3 })).not.toBe(id)
  })
})

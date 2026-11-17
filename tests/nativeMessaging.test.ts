/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from 'electron'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionsAdapter, LoadedExtension } from '../src/main/extensions/adapter'
import { NATIVE_APIS } from '../src/main/extensions/compat'
import { ExtensionsHost, unpackedId, type ShimCaller } from '../src/main/extensions/host'
import { readManifest } from '../src/main/extensions/manifest'
import { CHROME_HOST_KEYS, FrameDecoder, NATIVE_MESSAGE_MAX_BYTES, NATIVE_MESSAGE_OUT_MAX_BYTES, NativePort, encodeMessage, findHost, hostDirs, manifestCandidates, sendOnce } from '../src/main/extensions/nativeMessaging'
import { parseDefaultValue } from '../src/main/system/registry'
import { installLauncher, nodeLauncher, removeFolder } from './helpers/fakeProgram'

// Chrome's native-messaging framing, host lookup, a port's
// life against a fake host process (tests/fixtures/extensions/native-host),
// and the Allow once / Always / Don't allow decision. Nothing leaves the machine.

const ECHO_HOST = join(__dirname, 'fixtures/extensions/native-host/echo-host.mjs')
const FIXTURE = join(__dirname, 'fixtures/extensions/mv3-basic')
const HOST_NAME = 'com.atelier.test_echo'

let dir = ''
let launcher = ''
let hostsDir = ''
let extensionId = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-native-'))
  hostsDir = join(dir, 'NativeMessagingHosts')
  mkdirSync(hostsDir)
  // Hosts run without a shell, so the fake host gets an executable launcher, as a real one would be
  // (a .bat on Windows, which Atelier then runs through cmd.exe as Chrome does).
  launcher = nodeLauncher(join(dir, 'echo-host'), ECHO_HOST)
  extensionId = unpackedId(FIXTURE, readManifest(FIXTURE)!)
  writeFileSync(join(hostsDir, `${HOST_NAME}.json`), JSON.stringify({ name: HOST_NAME, description: 'Echo', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
})

afterAll(() => removeFolder(dir))

describe('framing', () => {
  it('prefixes the UTF-8 byte length, little-endian', () => {
    const frame = encodeMessage({ text: 'héllo 👋' })
    const body = Buffer.from(JSON.stringify({ text: 'héllo 👋' }), 'utf8')
    expect(frame.readUInt32LE(0)).toBe(body.length)
    expect(frame.subarray(4).equals(body)).toBe(true)
  })

  it('refuses what is not JSON, or over the cap: 1 MB from a host, 64 MB from an extension (Chrome’s limits)', () => {
    expect(() => encodeMessage(undefined)).toThrow(/JSON/)
    expect(() => encodeMessage('x'.repeat(NATIVE_MESSAGE_MAX_BYTES), NATIVE_MESSAGE_MAX_BYTES)).toThrow(/1 MB/)
    // An extension may send a host more than 1 MB, as in Chrome.
    expect(encodeMessage('x'.repeat(NATIVE_MESSAGE_MAX_BYTES)).length).toBeGreaterThan(NATIVE_MESSAGE_MAX_BYTES)
    expect(NATIVE_MESSAGE_OUT_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  it('reassembles frames split or joined anywhere', () => {
    const d = new FrameDecoder()
    const bytes = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage([2, 3]), encodeMessage('four')])
    const out: unknown[] = []
    for (let i = 0; i < bytes.length; i += 3) out.push(...d.push(bytes.subarray(i, i + 3)))
    expect(out).toEqual([{ a: 1 }, [2, 3], 'four'])
  })

  it('throws on an oversized frame or a body that is not JSON', () => {
    const big = Buffer.alloc(4)
    big.writeUInt32LE(NATIVE_MESSAGE_MAX_BYTES + 1, 0)
    expect(() => new FrameDecoder().push(big)).toThrow(/1 MB/)
    const body = Buffer.from('{oops')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    expect(() => new FrameDecoder().push(Buffer.concat([head, body]))).toThrow(/JSON/)
  })
})

describe('host lookup', () => {
  it('looks in Atelier’s own folder first, then Chrome’s, read-only', () => {
    expect(hostDirs('/u', 'darwin', '/h')).toEqual([join('/u', 'NativeMessagingHosts'), join('/h', 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), '/Library/Google/Chrome/NativeMessagingHosts'])
    expect(hostDirs('/u', 'linux', '/h')[1]).toBe(join('/h', '.config/google-chrome/NativeMessagingHosts'))
    // Windows: Chrome's registry keys, per user before the machine's.
    expect(hostDirs('/u', 'win32', '/h')).toEqual([join('/u', 'NativeMessagingHosts'), 'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts', 'HKEY_LOCAL_MACHINE\\Software\\Google\\Chrome\\NativeMessagingHosts'])
  })

  it('reads a Windows registry key for the manifest it names, and a host relative to that manifest', () => {
    // As OneDrive registers its host: the machine's key, with the manifest next to the host.
    const installed = join(dir, 'OneDrive')
    mkdirSync(installed, { recursive: true })
    const host = nodeLauncher(join(installed, 'auth-host'), ECHO_HOST)
    const manifest = join(installed, `${HOST_NAME}.json`)
    writeFileSync(manifest, JSON.stringify({ name: HOST_NAME, path: process.platform === 'win32' ? 'auth-host.bat' : host, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
    const asked: string[] = []
    const registry = (key: string): string | null => {
      asked.push(key)
      return key.startsWith('HKEY_LOCAL_MACHINE') ? manifest : null
    }
    expect(manifestCandidates(HOST_NAME, [hostsDir, ...CHROME_HOST_KEYS], registry)).toEqual([join(hostsDir, `${HOST_NAME}.json`), manifest])
    expect(asked).toEqual(CHROME_HOST_KEYS.map((k) => `${k}\\${HOST_NAME}`))
    expect(findHost(HOST_NAME, extensionId, [join(dir, 'nowhere'), ...CHROME_HOST_KEYS], registry)).toMatchObject({ ok: true, host: { path: host } })
    // A name that isn't a host name never reaches the registry.
    asked.length = 0
    expect(manifestCandidates('a\\..\\b', CHROME_HOST_KEYS, registry)).toEqual([])
    expect(asked).toEqual([])
  })

  it('reads reg.exe’s answer, whatever language it labels the default value in', () => {
    const answer = (label: string, type: string, value: string): string => `\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.x\r\n    ${label}    ${type}    ${value}\r\n\r\n`
    expect(parseDefaultValue(answer('(Default)', 'REG_SZ', 'C:\\Windows\\BrowserCore\\manifest.json'))).toBe('C:\\Windows\\BrowserCore\\manifest.json')
    expect(parseDefaultValue(answer('(Standaard)', 'REG_SZ', 'C:\\Program Files\\Host\\m.json'))).toBe('C:\\Program Files\\Host\\m.json')
    expect(parseDefaultValue(answer('(Default)', 'REG_EXPAND_SZ', '%LOCALAPPDATA%\\Host\\m.json'), { LocalAppData: 'C:\\Users\\x\\AppData\\Local' })).toBe('C:\\Users\\x\\AppData\\Local\\Host\\m.json')
    expect(parseDefaultValue(answer('(Default)', 'REG_DWORD', '0x1'))).toBeNull()
    expect(parseDefaultValue('')).toBeNull()
  })

  it('finds a valid host for an allowed extension', () => {
    const found = findHost(HOST_NAME, extensionId, [join(dir, 'nowhere'), hostsDir])
    expect(found).toMatchObject({ ok: true, host: { name: HOST_NAME, path: launcher } })
  })

  it('explains why a host cannot be used', () => {
    expect(findHost('Bad Name', extensionId, [hostsDir])).toMatchObject({ ok: false, reason: 'Invalid native host name.' })
    expect(findHost('com.atelier.missing', extensionId, [hostsDir])).toMatchObject({ ok: false, reason: 'Specified native messaging host not found.' })
    expect(findHost(HOST_NAME, 'p'.repeat(32), [hostsDir])).toMatchObject({ ok: false, reason: expect.stringMatching(/forbidden/) })
    const other = join(dir, 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'com.atelier.broken.json'), '{')
    writeFileSync(join(other, 'com.atelier.relative.json'), JSON.stringify({ name: 'com.atelier.relative', path: 'host', type: 'stdio', allowed_origins: [] }))
    writeFileSync(join(other, 'com.atelier.gone.json'), JSON.stringify({ name: 'com.atelier.gone', path: join(dir, 'gone'), type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
    expect(findHost('com.atelier.broken', extensionId, [other])).toMatchObject({ ok: false, reason: expect.stringMatching(/damaged/) })
    // Chrome lets a Windows manifest name its host relative to itself; elsewhere a relative path is invalid.
    expect(findHost('com.atelier.relative', extensionId, [other])).toMatchObject({ ok: false, reason: expect.stringMatching(process.platform === 'win32' ? /forbidden/ : /invalid/) })
    expect(findHost('com.atelier.gone', extensionId, [other])).toMatchObject({ ok: false, reason: expect.stringMatching(/isn’t installed/) })
  })
})

/** Collects a port's messages until it disconnects, or until `count` arrive. */
function collect(port: NativePort, count = Infinity): Promise<{ messages: unknown[]; error: string | null | undefined }> {
  return new Promise((resolve) => {
    const messages: unknown[] = []
    port.on('message', (m) => {
      messages.push(m)
      if (messages.length >= count) resolve({ messages, error: undefined })
    })
    port.once('disconnect', (error) => resolve({ messages, error }))
  })
}

describe('NativePort against a fake host', () => {
  it('echoes, passing the extension’s origin as the host’s argument', async () => {
    const port = new NativePort(launcher, [`chrome-extension://${extensionId}/`])
    const got = collect(port, 1)
    port.postMessage({ hello: 'world' })
    expect((await got).messages).toEqual([{ echo: { hello: 'world' }, origin: `chrome-extension://${extensionId}/` }])
    const gone = collect(port)
    port.disconnect()
    expect((await gone).error).toBeNull()
    expect(port.closed).toBe(true)
    expect(() => port.postMessage({})).toThrow(/closed/)
  })

  it('reads replies split inside the length prefix, and two in one write', async () => {
    const port = new NativePort(launcher, [])
    // One at a time: the fake host's split reply is written in two parts.
    const first = collect(port, 1)
    port.postMessage({ cmd: 'split' })
    expect((await first).messages).toEqual([{ echo: { cmd: 'split' }, split: true }])
    port.removeAllListeners('message')
    const next = collect(port, 2)
    port.postMessage({ cmd: 'two' })
    expect((await next).messages).toEqual([{ n: 1 }, { n: 2 }])
    port.disconnect()
  })

  it('closes the port when the host breaks the framing', async () => {
    for (const cmd of ['big', 'garbage']) {
      const port = new NativePort(launcher, [])
      const got = collect(port)
      port.postMessage({ cmd })
      const { error } = await got
      expect(error).toMatch(cmd === 'big' ? /larger than 1 MB/ : /isn’t JSON/)
    }
  })

  it('delivers a host’s last reply before reporting that it exited', async () => {
    const port = new NativePort(launcher, [])
    const got = collect(port)
    port.postMessage({ cmd: 'exit' })
    expect(await got).toEqual({ messages: [{ bye: true }], error: 'Native host has exited.' })
  })

  it('records how a host ended by itself, so a refused launch can be told apart', async () => {
    const ran = new NativePort(launcher, [])
    const got = collect(ran)
    ran.postMessage({ cmd: 'exit' })
    await got
    expect(ran.exit).toMatchObject({ code: 0, signal: null, output: true })
    // Killed at exec (as the launch constraint does), and gone at once without a word. Windows has no signals.
    const hosts = [...(process.platform === 'win32' ? [] : [['killed-host', { sh: 'kill -9 $$', bat: '' }, 'SIGKILL'] as const]), ['silent-host', { sh: 'exit 1', bat: 'exit /b 1' }, null] as const]
    for (const [name, body, signal] of hosts) {
      const file = installLauncher(join(dir, name), body)
      const port = new NativePort(file, [])
      expect((await collect(port)).error).toBe('Native host has exited.')
      expect(port.exit).toMatchObject({ signal, output: false })
      expect(port.exit!.ms).toBeLessThan(2000)
    }
    // Ended by the extension: no exit of its own.
    const closed = new NativePort(launcher, [])
    closed.disconnect()
    expect(closed.exit).toBeNull()
  })

  it('reports a host that cannot start', async () => {
    const port = new NativePort(join(dir, 'no-such-host'), [])
    expect((await collect(port)).error).toMatch(/Could not start the native host/)
  })

  it('answers sendNativeMessage with the first reply, then ends the host', async () => {
    await expect(sendOnce(launcher, ['origin'], { ping: 1 })).resolves.toEqual({ echo: { ping: 1 }, origin: 'origin' })
  })
})

describe('the first connection asks', () => {
  function fakeAdapter(): ExtensionsAdapter {
    const loaded = new Map<string, LoadedExtension>()
    return {
      name: 'fake',
      apis: NATIVE_APIS,
      async load(_s, d) {
        const m = readManifest(d)!
        const ext = { id: unpackedId(d, m), name: String(m.name), version: String(m.version), path: d, url: '', manifest: m }
        loaded.set(ext.id, ext)
        return ext
      },
      unload: (_s, id) => void loaded.delete(id),
      get: (_s, id) => loaded.get(id) ?? null,
      all: () => [...loaded.values()],
      onUnloaded: () => () => {},
      installPreloads: () => {},
    }
  }

  async function setup(answer: 'once' | 'always' | 'deny') {
    const asked: string[] = []
    const host = new ExtensionsHost({
      adapter: fakeAdapter(),
      preloads: null,
      extensionsDir: (p) => join(dir, `profile-${answer}`, p, 'Extensions'),
      nativeHostDirs: [hostsDir],
      windows: () => [],
      openTab: () => null,
      changed: () => {},
      askInstall: async () => false,
      askNative: async (_p, prompt) => {
        asked.push(`${prompt.extensionName} → ${prompt.host}`)
        return answer
      },
      toast: () => {},
      registerShortcut: () => ({ ok: true, dispose: () => {} }),
      clashesWith: () => null,
      chromeVersion: '140.0.0.0',
    })
    host.attach({ serviceWorkers: { on: () => {} } } as unknown as Session, 'default')
    const id = await host.loadUnpacked('default', FIXTURE)
    const events: unknown[][] = []
    const caller: ShimCaller = { extensionId: id, send: (...args) => void events.push(args), webContents: null, keepAlive: () => () => {} }
    return { host, id, asked, caller, events }
  }

  it('Allow once lets this connection through and asks again next time', async () => {
    const { host, asked, caller, id } = await setup('once')
    await expect(host.nativeConnect('default', caller, HOST_NAME, 'p1')).resolves.toEqual({ ok: true })
    host.nativeDisconnect('default', id, 'p1')
    await expect(host.nativeConnect('default', caller, HOST_NAME, 'p2')).resolves.toEqual({ ok: true })
    host.nativeDisconnect('default', id, 'p2')
    expect(asked).toEqual(['Atelier Fixture Notes → com.atelier.test_echo', 'Atelier Fixture Notes → com.atelier.test_echo'])
    host.dispose()
  })

  it('Always is remembered, and messages flow both ways on the port', async () => {
    const { host, asked, caller, events, id } = await setup('always')
    await host.nativeConnect('default', caller, HOST_NAME, 'p1')
    const reply = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (events.some((e) => e[0] === 'native.message')) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    host.nativePost('default', id, 'p1', { hi: true })
    await reply
    expect(events.find((e) => e[0] === 'native.message')).toEqual(['native.message', 'p1', { echo: { hi: true }, origin: `chrome-extension://${id}/` }])
    host.nativeDisconnect('default', id, 'p1')
    await expect(host.nativeSend('default', id, HOST_NAME, { ping: 2 })).resolves.toEqual({ echo: { ping: 2 }, origin: `chrome-extension://${id}/` })
    expect(asked).toHaveLength(1)
    host.dispose()
  })

  it('Don’t allow gives the extension a clear error and doesn’t ask again this run', async () => {
    const { host, asked, caller } = await setup('deny')
    await expect(host.nativeConnect('default', caller, HOST_NAME, 'p1')).resolves.toEqual({ ok: false, error: 'Access to the native messaging host was not allowed.' })
    await expect(host.nativeConnect('default', caller, HOST_NAME, 'p2')).resolves.toMatchObject({ ok: false })
    await expect(host.nativeConnect('default', caller, 'com.atelier.missing', 'p3')).resolves.toEqual({ ok: false, error: 'Specified native messaging host not found.' })
    expect(asked).toHaveLength(1)
    host.dispose()
  })
})

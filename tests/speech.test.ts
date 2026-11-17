/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SpeechError, type HelperLine } from '../src/shared/speech'
import { HelperLink, LineSplitter, speechHelperPath, type HelperProcess } from '../src/main/speech/helper'
import { createFakeSpeechHelper } from '../src/main/speech/fake'

// The helper process link (protocol v2): the version handshake, an
// outdated binary, crashes and the one immediate restart.

/** Stands in for atelier-speech: records commands and prints whatever the test says. */
class ScriptedHelper extends EventEmitter implements HelperProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly commands: Record<string, unknown>[] = []
  killed = false

  constructor(private readonly onCommand: (cmd: Record<string, unknown>, self: ScriptedHelper) => void = () => {}) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const cmd = JSON.parse(line) as Record<string, unknown>
        this.commands.push(cmd)
        this.onCommand(cmd, this)
      }
    })
  }

  say(...events: object[]): void {
    this.stdout.write(events.map((e) => `${JSON.stringify(e)}\n`).join(''))
  }

  crash(code = 1): void {
    this.emit('exit', code)
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const v2 = (cmd: Record<string, unknown>, self: ScriptedHelper): void => {
  if (cmd.cmd === 'hello') setImmediate(() => self.say({ type: 'ready', version: 2 }))
}

function link(onCommand = v2, options: { handshakeMs?: number } = {}) {
  const helpers: ScriptedHelper[] = []
  const l = new HelperLink({
    path: '/fake/atelier-speech',
    assumeExists: true,
    handshakeMs: options.handshakeMs ?? 200,
    retryAfterMs: 1_000,
    spawn: () => {
      const helper = new ScriptedHelper(onCommand)
      helpers.push(helper)
      return helper
    },
  })
  return { link: l, helpers }
}

describe('LineSplitter', () => {
  it('holds a partial line until its newline arrives', () => {
    const lines = new LineSplitter()
    expect(lines.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(lines.push(':2}\n\n')).toEqual(['{"b":2}'])
  })
})

describe('speechHelperPath', () => {
  it('is macOS only and depends on packaging', () => {
    expect(speechHelperPath({ platform: 'linux', packaged: false, resourcesPath: '/r', appPath: '/a' })).toBeNull()
    expect(speechHelperPath({ platform: 'darwin', packaged: true, resourcesPath: '/r', appPath: '/a' })).toBe(join('/r', 'atelier-speech'))
    expect(speechHelperPath({ platform: 'darwin', packaged: false, resourcesPath: '/r', appPath: '/a' })).toBe(join('/a', 'native', 'speech', 'build', 'atelier-speech'))
  })
})

describe('HelperLink', () => {
  it('is missing without a helper binary', async () => {
    const l = new HelperLink({ path: '/nonexistent/atelier-speech' })
    expect(l.state).toBe('missing')
    await expect(l.ensure()).rejects.toMatchObject({ code: 'helper-missing' })
    expect(new HelperLink({ path: null }).state).toBe('missing')
  })

  it('says hello first and is ready once a v2 helper answers', async () => {
    const { link: l, helpers } = link()
    await l.ensure()
    expect(l.state).toBe('ready')
    expect(helpers[0]?.commands[0]).toEqual({ cmd: 'hello' })
    // A second ensure reuses the running helper.
    await l.ensure()
    expect(helpers).toHaveLength(1)
  })

  it('reports an old helper as outdated and never uses it', async () => {
    // A v1 helper printed a bare `ready` at launch and knew no `hello`.
    const { link: l, helpers } = link((cmd, self) => {
      if (cmd.cmd === 'hello') setImmediate(() => self.say({ type: 'ready' }, { type: 'error', message: 'Unknown command hello.' }))
    })
    await expect(l.ensure()).rejects.toMatchObject({ code: 'helper-outdated' })
    expect(l.state).toBe('outdated')
    expect(helpers[0]?.killed).toBe(true)
    await expect(l.ensure()).rejects.toBeInstanceOf(SpeechError)
    expect(helpers).toHaveLength(1)
  })

  it('fails a helper that never answers, then waits before trying again', async () => {
    const { link: l, helpers } = link(() => {}, { handshakeMs: 30 })
    await expect(l.ensure()).rejects.toMatchObject({ code: 'helper-failed' })
    await expect(l.ensure()).rejects.toMatchObject({ code: 'helper-failed' })
    expect(helpers).toHaveLength(1)
  })

  it('answers requests with the matching line and ignores unknown lines', async () => {
    const { link: l } = link((cmd, self) => {
      v2(cmd, self)
      if (cmd.cmd === 'devices') setImmediate(() => self.say({ type: 'mystery' }, { type: 'devices', items: [{ id: 'a', name: 'Mic', builtIn: true, isDefault: true }] }))
    })
    const seen: HelperLine['type'][] = []
    l.on('line', (line) => seen.push(line.type))
    const reply = await l.request({ cmd: 'devices' }, (x): x is Extract<HelperLine, { type: 'devices' }> => x.type === 'devices', 200)
    expect(reply.items[0]?.name).toBe('Mic')
    expect(seen).toEqual(['ready', 'devices'])
  })

  it('restarts a crashed helper once, straight away', async () => {
    const { link: l, helpers } = link()
    await l.ensure()
    const exits: Array<number | null> = []
    l.on('exit', (code) => exits.push(code))
    helpers[0]?.crash(9)
    expect(exits).toEqual([9])
    await tick()
    await tick()
    expect(helpers).toHaveLength(2)
    expect(l.state).toBe('ready')
  })

  it('rejects pending requests when the helper exits', async () => {
    const { link: l, helpers } = link()
    await l.ensure()
    const pending = l.request({ cmd: 'locales' }, (x): x is Extract<HelperLine, { type: 'locales' }> => x.type === 'locales', 1_000)
    await tick()
    helpers[0]?.crash()
    await expect(pending).rejects.toMatchObject({ code: 'helper-failed' })
  })

  it('recycles an idle helper without counting it as a crash', async () => {
    const { link: l, helpers } = link()
    await l.ensure()
    l.recycle()
    expect(l.running).toBe(false)
    await tick()
    expect(helpers).toHaveLength(1)
    await l.ensure()
    expect(helpers).toHaveLength(2)
  })

  it('works over the scripted fake helper', async () => {
    const spawn = createFakeSpeechHelper()
    const l = new HelperLink({ path: 'fake', assumeExists: true, spawn })
    const reply = await l.request({ cmd: 'permissions' }, (x): x is Extract<HelperLine, { type: 'permissions' }> => x.type === 'permissions', 500)
    expect(reply).toMatchObject({ microphone: 'granted', speech: 'granted', screen: 'granted' })
    l.dispose()
  })
})

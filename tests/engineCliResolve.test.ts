/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { commonPaths, loginShell, parseProbe, parseVersion, pickHighest, probeScript, probeShell, resolveCli, VersionReader, withTimeout, type RunResult } from '../src/engines/claude-code/main/cli'
import { compareVersions } from '../src/engines/claude-code/shared/status'

// Which `claude` Atelier runs when there are several (a Finder launch sees
// ~/.local/bin's old native install first; only the interactive shell knows
// npm's newer one). Everything here is a fake: no real CLI or shell runs.

const home = '/Users/test'
const local = `${home}/.local/bin/claude`
const npm = `${home}/.npm-global/bin/claude`

function resolver(versions: Record<string, string | null>, options: Partial<{ override: string | null; env: NodeJS.ProcessEnv; resourcesPath: string | null; login: string | null; interactive: string | null; real: Record<string, string> }> = {}) {
  const asked: string[] = []
  return {
    asked,
    run: () =>
      resolveCli({
        override: options.override ?? null,
        env: options.env ?? {},
        resourcesPath: options.resourcesPath ?? null,
        home,
        isExecutable: (path) => path in versions,
        loginShellLookup: async () => options.login ?? null,
        interactiveShellLookup: async () => options.interactive ?? null,
        readVersion: async (path) => {
          asked.push(path)
          return versions[path] ?? null
        },
        realPath: (path) => options.real?.[path] ?? path,
        platform: 'darwin',
      }),
  }
}

describe('choosing among installs', () => {
  it('runs the highest version, not the first path found (the Finder-launch bug)', async () => {
    // The login shell finds nothing; ~/.local/bin is 2.1.50; only the interactive shell finds npm's 2.1.266.
    const result = await resolver({ [local]: '2.1.50', [npm]: '2.1.266' }, { interactive: npm }).run()
    expect(result.found).toEqual({ path: npm, source: 'login-shell', version: '2.1.266' })
    expect(result.installs.map((i) => [i.path, i.version])).toEqual([[npm, '2.1.266'], [local, '2.1.50']])
  })

  it('gathers the bundled CLI, both shells and every usual path, and lists one install once', async () => {
    const bundled = '/App/Resources/claude-code/claude'
    const brew = '/opt/homebrew/bin/claude'
    const result = await resolver({ [bundled]: '2.1.200', '/shell/claude': '2.1.300', [local]: '2.1.300', [brew]: '2.1.10' }, { resourcesPath: '/App/Resources', login: '/shell/claude', real: { [local]: '/shell/claude' } }).run()
    // ~/.local/bin/claude links to the shell's one: listed once, under the first source.
    expect(result.installs.map((i) => i.source)).toEqual(['bundled', 'login-shell', 'common-path'])
    expect(result.found).toMatchObject({ path: '/shell/claude', version: '2.1.300' })
  })

  it('breaks a tie by the order Atelier looks, and puts unknown versions last', async () => {
    expect((await resolver({ [local]: '2.1.266', [npm]: '2.1.266' }).run()).found?.path).toBe(local)
    expect((await resolver({ [local]: null, [npm]: '2.0.1' }).run()).found?.path).toBe(npm)
    // Nothing answered --version: the first one found still runs.
    expect((await resolver({ [local]: null, [npm]: null }).run()).found).toEqual({ path: local, source: 'common-path', version: null })
  })

  it('a valid override still wins outright, even over a newer install, and the others are still listed', async () => {
    const pinned = '/opt/custom/claude'
    const result = await resolver({ [pinned]: '2.1.50', [npm]: '2.1.316' }, { override: pinned }).run()
    expect(result.found).toEqual({ path: pinned, source: 'override', version: '2.1.50' })
    expect(result.installs.map((i) => i.path)).toEqual([pinned, npm])
    const viaEnv = await resolver({ '/env/claude': '1.0.0', [npm]: '2.1.316' }, { env: { ATELIER_CLAUDE_PATH: '/env/claude' } }).run()
    expect(viaEnv.found?.source).toBe('environment')
  })

  it('an override that points at nothing runnable is reported, and the highest install runs', async () => {
    const result = await resolver({ [local]: '2.1.50', [npm]: '2.1.266' }, { override: '/nowhere/claude' }).run()
    expect(result).toMatchObject({ overrideInvalid: true, found: { path: npm } })
  })

  it('asks every install for its version at once', async () => {
    const versions = { [local]: '1.0.0', [npm]: '2.0.0' }
    let open = 0
    let most = 0
    await resolveCli({
      override: null,
      env: {},
      resourcesPath: null,
      home,
      isExecutable: (path) => path in versions,
      loginShellLookup: async () => null,
      platform: 'darwin',
      readVersion: async (path) => {
        open++
        most = Math.max(most, open)
        await new Promise((r) => setTimeout(r, 5))
        open--
        return versions[path as keyof typeof versions] ?? null
      },
    })
    expect(most).toBe(2)
  })

  it('finds nothing when nothing is installed', async () => {
    const { run } = resolver({})
    expect(await run()).toEqual({ found: null, installs: [], overrideInvalid: false })
    expect(commonPaths(home, 'darwin')).toContain(npm)
  })

  it('pickHighest keeps the first of equals', () => {
    expect(pickHighest([{ version: '2.1.9', n: 1 }, { version: '2.1.10', n: 2 }, { version: '2.1.10', n: 3 }])?.n).toBe(2)
    expect(pickHighest([])).toBeNull()
  })
})

describe('versions', () => {
  it('reads what --version prints', () => {
    expect(parseVersion('2.1.266 (Claude Code)')).toBe('2.1.266')
    expect(parseVersion('2.1.266 (Claude Code)\n')).toBe('2.1.266')
    expect(parseVersion('claude 2.2.0-beta.3')).toBe('2.2.0-beta.3')
    expect(parseVersion('command not found')).toBeNull()
  })

  it('compares as numbers, with a pre-release before its release', () => {
    expect(compareVersions('2.1.50', '2.1.280')).toBeLessThan(0)
    expect(compareVersions('2.1.266', '2.1.280')).toBeLessThan(0)
    expect(compareVersions('2.1.316', '2.1.280')).toBeGreaterThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0)
    expect(compareVersions('2.1.280-beta.1', '2.1.280')).toBeLessThan(0)
  })
})

describe('version reader', () => {
  afterEach(() => vi.useRealTimers())
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })

  it('caches by path and modification time, and asks again when the file changes', async () => {
    let mtime = 1
    const runs: string[] = []
    const reader = new VersionReader({ run: async (path) => (runs.push(path), ok(`2.1.${runs.length} (Claude Code)`)), env: () => ({}), mtime: () => mtime })
    expect(await reader.read(local)).toBe('2.1.1')
    expect(await reader.read(local)).toBe('2.1.1')
    expect(runs).toEqual([local])
    mtime = 2
    expect(await reader.read(local)).toBe('2.1.2')
    reader.clear()
    expect(await reader.read(local)).toBe('2.1.3')
  })

  it('gives up after 2.5 s on a CLI that never answers, and doesn’t remember that', async () => {
    vi.useFakeTimers()
    let calls = 0
    const reader = new VersionReader({ run: () => (calls++, new Promise<RunResult>(() => undefined)), env: () => ({}), mtime: () => 1 })
    const pending = reader.read(local)
    await vi.advanceTimersByTimeAsync(2000)
    let settled = false
    void pending.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBeNull()
    void reader.read(local)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
  })

  it('passes the 2.5 s cap to the runner and counts a timeout or failure as unknown', async () => {
    const seen: number[] = []
    const reader = new VersionReader({ run: async (_p, _a, o) => (seen.push(o.timeoutMs), { code: null, stdout: '', stderr: '', timedOut: true }), env: () => ({}), mtime: () => null })
    expect(await reader.read(local)).toBeNull()
    expect(seen).toEqual([2500])
    const failing = new VersionReader({ run: async () => ({ code: 1, stdout: '2.1.0', stderr: 'boom', timedOut: false }), env: () => ({}), mtime: () => null })
    expect(await failing.read(local)).toBeNull()
  })

  it('withTimeout resolves null once the time is up, and with the value before it', async () => {
    vi.useFakeTimers()
    const slow = withTimeout(new Promise<string>(() => undefined), 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await slow).toBeNull()
    expect(await withTimeout(Promise.resolve('x'), 100)).toBe('x')
    expect(await withTimeout(Promise.reject(new Error('no')), 100)).toBeNull()
  })
})

describe('asking the shell', () => {
  const marker = 'ATELIER_test123'

  it('reads only what sits between its markers, whatever the shell prints around them', () => {
    const output = [
      '\u001b]0;~\u0007Last login: Fri Oct 31 on ttys001',
      'Welcome to oh-my-zsh! Update? [Y/n]',
      '',
      `${marker}:begin`,
      `/Users/test/.npm-global/bin/claude`,
      '',
      `${marker}:path`,
      '/Users/test/.npm-global/bin:/usr/bin:/bin',
      `${marker}:end`,
      'zsh: exit 1',
    ].join('\n')
    expect(parseProbe(output, marker)).toEqual({ lookup: npm, path: '/Users/test/.npm-global/bin:/usr/bin:/bin' })
  })

  it('reads an alias, an empty answer, and nothing at all when a marker is missing', () => {
    expect(parseProbe(`${marker}:begin\nalias claude='/x/claude'\n${marker}:path\n/bin\n${marker}:end`, marker)?.lookup).toBe('/x/claude')
    expect(parseProbe(`${marker}:begin\n\n${marker}:path\n\n${marker}:end`, marker)).toEqual({ lookup: null, path: null })
    // Cut off before the end (a shell that hung and was stopped).
    expect(parseProbe(`${marker}:begin\n/x/claude\n${marker}:path\n/bin`, marker)).toBeNull()
    // A shell that echoes its commands prints the marker inside a longer line: not a marker line.
    expect(parseProbe(`printf '\\n%s\\n' '${marker}:begin'`, marker)).toBeNull()
    expect(parseProbe(null, marker)).toBeNull()
  })

  it('the script prints the markers on lines of their own around command -v and PATH', () => {
    const script = probeScript(marker)
    expect(script).toContain(`'${marker}:begin'`)
    expect(script).toContain('command -v claude')
    expect(script).toContain('"$PATH"')
    expect(script.indexOf(`${marker}:begin`)).toBeLessThan(script.indexOf(`${marker}:end`))
  })

  it('runs an interactive login shell with -ilc, in its own group, for at most 4 s, ending at the end marker', async () => {
    const calls: Array<{ program: string; args: readonly string[]; timeoutMs: number; group?: boolean; until?: (s: string) => boolean }> = []
    const run = async (program: string, args: readonly string[], options: { timeoutMs: number; group?: boolean; until?(s: string): boolean }): Promise<RunResult> => {
      calls.push({ program, args, ...options })
      return { code: 0, stdout: `noise\n${marker}:begin\n${npm}\n${marker}:path\n/bin\n${marker}:end\n`, stderr: '', timedOut: false }
    }
    const probe = await probeShell((script, until) => loginShell('/bin/zsh', script, { interactive: true, until, run: run as never }), marker)
    expect(probe).toEqual({ lookup: npm, path: '/bin' })
    expect(calls[0]?.args[0]).toBe('-ilc')
    expect(calls[0]).toMatchObject({ program: '/bin/zsh', timeoutMs: 4000, group: true })
    expect(calls[0]?.until?.(`x\n${marker}:end\n`)).toBe(true)
    expect(calls[0]?.until?.(`x\n${marker}:en`)).toBe(false)
    const login = await probeShell((script, until) => loginShell(undefined, script, { until, run: run as never }), marker)
    expect(login?.lookup).toBe(npm)
    expect(calls[1]?.args[0]).toBe('-lc')
  })

  it('a shell that never answers gives nothing once its time is up', async () => {
    const run = async (): Promise<RunResult> => ({ code: null, stdout: 'Do you want to update? [Y/n] ', stderr: '', timedOut: true })
    expect(await probeShell((script, until) => loginShell('/bin/zsh', script, { interactive: true, until, run: run as never }), marker)).toBeNull()
  })
})

describe('running a command never hangs', () => {
  it('stops at the timeout, and when something it started holds its pipes open', async () => {
    const { runCommand } = await import('../src/engines/claude-code/main/cli')
    // node stands in for the shell, so this runs on every platform.
    const node = process.execPath
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE'))
    const wait = 'setTimeout(() => {}, 5000)'
    let started = Date.now()
    const slow = await runCommand(node, ['-e', wait], { env, timeoutMs: 200, group: true })
    expect(slow).toMatchObject({ code: null, timedOut: true })
    expect(Date.now() - started).toBeLessThan(2000)
    // It exits at once; the waiting process it left behind keeps stdout open.
    started = Date.now()
    const left = await runCommand(node, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(wait)}], { stdio: 'inherit' }).unref(); console.log('hi')`], { env, timeoutMs: 4000, group: true })
    expect(left).toMatchObject({ code: 0, timedOut: false })
    expect(left.stdout.trim()).toBe('hi')
    expect(Date.now() - started).toBeLessThan(2000)
    // `until` ends the run as soon as the output says enough.
    started = Date.now()
    const marked = await runCommand(node, ['-e', `console.log('DONE'); ${wait}`], { env, timeoutMs: 4000, group: true, until: (s) => s.includes('DONE') })
    expect(marked.stdout).toContain('DONE')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

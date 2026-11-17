/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cmdArgument,
  commandFileNames,
  comspec,
  findCommand,
  killTree,
  launchFor,
  npmShimScript,
  pathDelimiter,
  pathExtensions,
  pathKey,
  quoteArgument,
  spawnProgram,
  windowsEssentials,
  withPath,
} from '../src/main/system/programs'
import { npmShim as SHIM } from './helpers/fakeProgram'

// Starting other programs on Windows the way macOS and
// Linux already do. The pure parts run everywhere with platform 'win32'; the
// last block runs real batch files, npm shims and process trees on Windows.

describe('PATH on each platform', () => {
  it('splits on ; on Windows and : elsewhere', () => {
    expect(pathDelimiter('win32')).toBe(';')
    expect(pathDelimiter('darwin')).toBe(':')
    expect(pathDelimiter('linux')).toBe(':')
  })

  it('finds the key Windows used and sets PATH under one key', () => {
    expect(pathKey({ Path: 'C:\\a' }, 'win32')).toBe('Path')
    expect(pathKey({}, 'win32')).toBe('PATH')
    expect(pathKey({ Path: 'x' }, 'darwin')).toBe('PATH')
    expect(withPath({ Path: 'old', PATH: 'older', HOME: 'h' }, 'new', 'win32')).toEqual({ HOME: 'h', Path: 'new' })
    expect(withPath({ PATH: 'old', Path: 'kept' }, 'new', 'linux')).toEqual({ Path: 'kept', PATH: 'new' })
  })

  it('reads PATHEXT, whatever its case, and falls back to Windows’ own', () => {
    expect(pathExtensions({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' })).toEqual(['.com', '.exe', '.bat', '.cmd', '.vbs', '.js'])
    expect(pathExtensions({ PathExt: '.EXE; .CMD ;;nope' })).toEqual(['.exe', '.cmd'])
    expect(pathExtensions({})).toEqual(['.com', '.exe', '.bat', '.cmd'])
  })
})

describe('findCommand', () => {
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD' }

  it('tries each PATHEXT extension for a bare name on Windows, in PATH order', () => {
    const files = new Set(['C:\\nodejs\\npx.cmd', 'C:\\nodejs\\npx', 'C:\\tools\\npx.exe', 'C:\\uv\\uvx.exe'])
    const o = { platform: 'win32' as const, env, isExecutable: (p: string) => files.has(p) }
    // npm also leaves an extensionless sh script next to the .cmd; Windows can't run it.
    expect(commandFileNames('npx', 'win32', env)).toEqual(['npx.com', 'npx.exe', 'npx.bat', 'npx.cmd'])
    expect(findCommand('npx', 'C:\\nodejs;C:\\tools', o)).toBe('C:\\nodejs\\npx.cmd')
    expect(findCommand('uvx', ' ;C:\\uv ', o)).toBe('C:\\uv\\uvx.exe')
    expect(findCommand('uvx.exe', 'C:\\uv', o)).toBe('C:\\uv\\uvx.exe')
    expect(findCommand('C:\\nodejs\\npx', '', o)).toBe('C:\\nodejs\\npx.cmd')
    expect(findCommand('C:\\uv\\uvx.exe', '', o)).toBe('C:\\uv\\uvx.exe')
  })

  it('never resolves a relative path, with either slash', () => {
    const o = { platform: 'win32' as const, env, isExecutable: () => true }
    expect(findCommand('.\\node', 'C:\\bin', o)).toBeNull()
    expect(findCommand('bin/node', 'C:\\bin', o)).toBeNull()
    expect(findCommand('./node', '/usr/bin', { platform: 'linux', isExecutable: () => true })).toBeNull()
  })

  it('keeps the name as is on macOS and Linux', () => {
    const o = { platform: 'darwin' as const, isExecutable: (p: string) => p === '/usr/local/bin/node' }
    expect(findCommand('node', '/nope:/usr/local/bin', o)).toBe('/usr/local/bin/node')
    expect(commandFileNames('node', 'linux')).toEqual(['node'])
  })
})

describe('launchFor', () => {
  it('runs programs directly, and batch files only on Windows go elsewhere', () => {
    expect(launchFor('/usr/local/bin/tool', ['--quiet'], { platform: 'darwin' })).toEqual({ file: '/usr/local/bin/tool', args: ['--quiet'], verbatim: false })
    expect(launchFor('C:\\Users\\me\\.local\\bin\\tool.exe', ['--quiet'], { platform: 'win32' })).toEqual({ file: 'C:\\Users\\me\\.local\\bin\\tool.exe', args: ['--quiet'], verbatim: false })
  })

  it('runs an npm shim as the node script it wraps, so no argument passes through cmd.exe', () => {
    const shim = 'C:\\Program Files\\nodejs\\tool.cmd'
    const script = 'C:\\Program Files\\nodejs\\node_modules\\x\\cli.js'
    const files = new Set([script, 'C:\\Program Files\\nodejs\\node.exe'])
    const launch = launchFor(shim, ['--message', 'line one\nline two'], { platform: 'win32', env: {}, readText: () => SHIM('node_modules\\x\\cli.js'), exists: (p) => files.has(p) })
    expect(launch).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: [script, '--message', 'line one\nline two'], verbatim: false })
  })

  it('uses node from PATH when the shim’s folder has none', () => {
    const files = new Set(['C:\\npm\\node_modules\\x\\cli.js', 'C:\\nvm\\node.exe'])
    const launch = launchFor('C:\\npm\\x.cmd', [], { platform: 'win32', env: { Path: 'C:\\nope;C:\\nvm' }, readText: () => SHIM('node_modules\\x\\cli.js'), exists: (p) => files.has(p) })
    expect(launch.file).toBe('C:\\nvm\\node.exe')
    expect(launch.args).toEqual(['C:\\npm\\node_modules\\x\\cli.js'])
  })

  it('runs any other batch file through cmd.exe with no AutoRun, escaped twice', () => {
    const launch = launchFor('C:\\My Tools\\serve (x86).bat', ['--port', 'a&b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, readText: () => '@python serve.py %*' })
    expect(launch.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(launch.verbatim).toBe(true)
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(launch.args[3]).toBe(`"C:\\My^ Tools\\serve^ ^(x86^).bat --port ${cmdArgument('a&b')}"`)
    expect(cmdArgument('a&b')).toBe('^^^"a^^^&b^^^"')
    expect(cmdArgument('a&b', false)).toBe('^"a^&b^"')
  })

  it('opens a host that isn’t a program through cmd.exe, as Chrome starts native hosts', () => {
    const o = { platform: 'win32' as const, env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, openAny: true, exists: () => true }
    expect(launchFor('C:\\hosts\\host.exe', ['chrome-extension://abc/'], o)).toEqual({ file: 'C:\\hosts\\host.exe', args: ['chrome-extension://abc/'], verbatim: false })
    // The origin and --parent-window need no quoting, and a script reads its arguments once.
    expect(launchFor('C:\\hosts\\host.py', ['chrome-extension://abc/', '--parent-window=0'], o).args).toEqual(['/d', '/s', '/c', '"C:\\hosts\\host.py chrome-extension://abc/ --parent-window=0"'])
    expect(launchFor('C:\\hosts\\host.py', [], { ...o, openAny: false }).file).toBe('C:\\hosts\\host.py')
  })

  it('refuses a line break it can’t pass through cmd.exe, rather than cutting the command short', () => {
    expect(() => launchFor('C:\\x.bat', ['one\ntwo'], { platform: 'win32', env: {}, readText: () => '@echo %*' })).toThrow(/line break/)
  })

  it('finds cmd.exe in System32 when ComSpec is missing or relative', () => {
    expect(comspec({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe')
    expect(comspec({ COMSPEC: 'cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('npmShimScript', () => {
  it('reads both cmd-shim formats and nothing else', () => {
    expect(npmShimScript(SHIM('node_modules\\npm\\bin\\npx-cli.js'))).toBe('node_modules\\npm\\bin\\npx-cli.js')
    // cmd-shim before v3.
    expect(npmShimScript('@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\lib\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\lib\\cli.js" %*\r\n)')).toBe('..\\lib\\cli.js')
    expect(npmShimScript('@python "%~dp0\\serve.py" %*')).toBeNull()
    expect(npmShimScript('@echo off\r\necho hi')).toBeNull()
  })
})

describe('quoteArgument', () => {
  it('follows how Windows programs split a command line', () => {
    expect(quoteArgument('plain')).toBe('"plain"')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(quoteArgument('a\\\\"b')).toBe('"a\\\\\\\\\\"b"')
    expect(quoteArgument('a\\b')).toBe('"a\\b"')
  })
})

describe('windowsEssentials', () => {
  it('keeps what Windows programs need, in the case the system used', () => {
    expect(windowsEssentials({ SystemRoot: 'C:\\Windows', APPDATA: 'a', Temp: 't', SECRET_TOKEN: 'x', PATH: 'p', ELECTRON_RUN_AS_NODE: '1' })).toEqual({ SystemRoot: 'C:\\Windows', APPDATA: 'a', Temp: 't' })
  })
})

describe.runIf(process.platform === 'win32')('on Windows itself', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  const run = (file: string, args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve, reject) => {
      const child = spawnProgram(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out }))
    })

  // Everything cmd.exe gives a meaning to, plus the backslash and quote rules.
  const ARGS = ['plain', 'with space', 'a&b', 'say "hi"', '100%', '%PATH%', 'C:\\dir\\', 'a\\"b', '^caret', '(paren)', '!bang!', '', 'semi;colon', 'a,b', '<lt>', 'x|y', '*?', 'ünïcode']

  it('hands every argument to a batch file’s program exactly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-programs-'))
    writeFileSync(join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(dir, 'run me.bat'), `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`)
    const result = await run(join(dir, 'run me.bat'), ARGS)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual(ARGS)
  })

  it('runs an npm shim as node, with line breaks intact', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-programs-'))
    writeFileSync(join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(dir, 'tool.cmd'), SHIM('echo.cjs'))
    const args = [...ARGS, 'line one\nline two']
    const result = await run(join(dir, 'tool.cmd'), args)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual(args)
  })

  it('ends a process and the processes it started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-programs-'))
    const pidFile = join(dir, 'grandchild.pid')
    // The child starts a grandchild that would outlive it, then both wait.
    const child = spawnProgram(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000)`], { stdio: 'ignore' })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    await expect.poll(() => { try { return readFileSync(pidFile, 'utf8') } catch { return '' } }, { timeout: 5000 }).not.toBe('')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    killTree(child)
    await exited
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await expect.poll(() => alive(grandchild), { timeout: 5000 }).toBe(false)
  })
})

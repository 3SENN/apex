/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { childEnv, commonPaths, looksSignedOut, mergePath, parseAuthStatus, parseLookup, parseVersion, pathProbe, resolveCli, shellQuote, STRIPPED_ENV } from '../src/engines/claude-code/main/cli'
import { BUILT_IN_TOOLS_OFF, launchArgs } from '../src/engines/claude-code/main/process'
import { engineReady, type EngineStatus } from '@shared/engine'
import { claudeCodeReady, IDLE_UPDATE } from '../src/engines/claude-code/shared/status'

// Finding the CLI, its environment and its arguments. Nothing here runs a
// real `claude`. Most cases are a Mac's; the last block is Windows'.

const home = '/Users/test'

function resolver(executables: string[], options: Partial<{ override: string | null; env: NodeJS.ProcessEnv; resourcesPath: string | null; shell: string | null }> = {}) {
  const asked: string[] = []
  return {
    asked,
    run: () =>
      resolveCli({
        override: options.override ?? null,
        env: options.env ?? {},
        resourcesPath: options.resourcesPath ?? null,
        home,
        isExecutable: (path) => {
          asked.push(path)
          return executables.includes(path)
        },
        loginShellLookup: async () => options.shell ?? null,
        platform: 'darwin',
      }),
  }
}

describe('CLI resolution', () => {
  it('prefers the settings override, then ATELIER_CLAUDE_PATH; with no versions to compare, the bundled CLI, the login shell and the usual paths in that order', async () => {
    const all = ['/opt/custom/claude', '/env/claude', '/App/Resources/claude-code/claude', '/shell/claude', `${home}/.local/bin/claude`]
    expect((await resolver(all, { override: '/opt/custom/claude', env: { ATELIER_CLAUDE_PATH: '/env/claude' }, resourcesPath: '/App/Resources', shell: '/shell/claude' }).run()).found).toEqual({ path: '/opt/custom/claude', source: 'override', version: null })
    expect((await resolver(all, { env: { ATELIER_CLAUDE_PATH: '/env/claude' }, resourcesPath: '/App/Resources', shell: '/shell/claude' }).run()).found).toEqual({ path: '/env/claude', source: 'environment', version: null })
    expect((await resolver(all, { resourcesPath: '/App/Resources', shell: '/shell/claude' }).run()).found).toEqual({ path: '/App/Resources/claude-code/claude', source: 'bundled', version: null })
    expect((await resolver(all, { shell: '/shell/claude' }).run()).found).toEqual({ path: '/shell/claude', source: 'login-shell', version: null })
    expect((await resolver(all).run()).found).toEqual({ path: `${home}/.local/bin/claude`, source: 'common-path', version: null })
  })

  it('reports an override that points at nothing runnable and keeps looking', async () => {
    const result = await resolver(['/opt/homebrew/bin/claude'], { override: '/nowhere/claude' }).run()
    expect(result).toMatchObject({ found: { path: '/opt/homebrew/bin/claude', source: 'common-path', version: null }, overrideInvalid: true })
    // A relative override is never run.
    expect((await resolver(['claude'], { override: 'claude' }).run()).overrideInvalid).toBe(true)
  })

  it('finds nothing when nothing is installed', async () => {
    const { asked, run } = resolver([])
    expect(await run()).toEqual({ found: null, installs: [], overrideInvalid: false })
    expect(asked).toEqual(commonPaths(home, 'darwin'))
  })

  it('reads `command -v` output, including aliases, and ignores anything relative', () => {
    expect(parseLookup('/usr/local/bin/claude\n')).toBe('/usr/local/bin/claude')
    expect(parseLookup('motd line\n/Users/x/.claude/local/claude')).toBe('/Users/x/.claude/local/claude')
    expect(parseLookup("alias claude='/Users/x/.claude/local/claude'")).toBe('/Users/x/.claude/local/claude')
    expect(parseLookup('claude')).toBeNull()
    expect(parseLookup('')).toBeNull()
    expect(parseLookup(null)).toBeNull()
  })
})

describe('child environment', () => {
  it('strips what would nest or break the CLI, turns off its updater and keeps the rest', () => {
    const env = childEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1234', CLAUDE_CODE_ENTRYPOINT: 'cli', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', HOME: home, PATH: '/usr/bin:/bin', KEEP_ME: 'yes' },
      '/opt/homebrew/bin:/usr/bin',
      home,
      'darwin',
    )
    for (const key of STRIPPED_ENV) expect(env).not.toHaveProperty(key)
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    expect(env.KEEP_ME).toBe('yes')
    expect(env.PATH?.split(':').slice(0, 3)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin'])
  })

  it('merges PATH entries once, login shell first', () => {
    const path = mergePath('/a:/b', '/b:/c', home, 'darwin').split(':')
    expect(path.slice(0, 3)).toEqual(['/a', '/b', '/c'])
    expect(new Set(path).size).toBe(path.length)
    expect(path).toContain(`${home}/.local/bin`)
  })
})

describe('version and sign-in', () => {
  it('reads the version', () => {
    expect(parseVersion('2.1.266 (Claude Code)\n')).toBe('2.1.266')
    expect(parseVersion('nonsense')).toBeNull()
  })

  it('reads `claude auth status --json`', () => {
    expect(parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: '' })).toMatchObject({ state: 'ready', account: 'subscription' })
    expect(parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}', stderr: '' })).toMatchObject({ state: 'ready', account: 'api-key' })
    expect(parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"other","apiProvider":"bedrock"}', stderr: '' })).toMatchObject({ state: 'ready', account: 'other' })
    expect(parseAuthStatus({ code: 1, stdout: '{"loggedIn":false}', stderr: '' }).state).toBe('signed-out')
    expect(parseAuthStatus({ code: 1, stdout: '', stderr: 'Not logged in. Please run /login' }).state).toBe('signed-out')
    expect(parseAuthStatus({ code: 1, stdout: '', stderr: "error: unknown command 'auth'" }).state).toBe('unknown')
    expect(parseAuthStatus({ code: null, stdout: '', stderr: '', timedOut: true }).state).toBe('unknown')
  })

  it('spots a signed-out failure in a chat', () => {
    expect(looksSignedOut('Invalid API key · Please run /login')).toBe(true)
    expect(looksSignedOut('OAuth token has expired')).toBe(true)
    expect(looksSignedOut('Overloaded')).toBe(false)
  })

  it('quotes for a shell', () => {
    expect(shellQuote('/usr/local/bin/claude', 'darwin')).toBe('/usr/local/bin/claude')
    expect(shellQuote("/Users/o'neil/My Apps/claude", 'darwin')).toBe(`'/Users/o'\\''neil/My Apps/claude'`)
  })
})

describe('on Windows', () => {
  const winHome = 'C:\\Users\\test'
  const env = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }

  it('looks where the native installer, npm and winget put claude', () => {
    expect(commonPaths(winHome, 'win32', env)).toEqual([
      'C:\\Users\\test\\.local\\bin\\claude.exe',
      'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Program Files\\nodejs\\claude.cmd',
      'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe',
      'C:\\Users\\test\\.bun\\bin\\claude.exe',
    ])
  })

  it('finds claude along the inherited PATH, as a terminal there would, and lists one install once whatever its case', async () => {
    const files = new Set(['C:\\Program Files\\nodejs\\claude', 'C:\\Program Files\\nodejs\\claude.cmd', 'C:\\Users\\test\\.local\\bin\\claude.exe'])
    // npm's extensionless sh script comes first in the folder, but only the .cmd runs.
    const probe = pathProbe({ Path: 'C:\\Windows;C:\\Program Files\\nodejs', PATHEXT: '.EXE;.CMD' }, 'win32', (p) => files.has(p))
    expect(probe).toEqual({ lookup: 'C:\\Program Files\\nodejs\\claude.cmd', path: 'C:\\Windows;C:\\Program Files\\nodejs' })
    const result = await resolveCli({
      override: null,
      env,
      resourcesPath: 'C:\\Program Files\\Atelier\\resources',
      home: winHome,
      // Windows' file names ignore case.
      isExecutable: (p) => [...files, 'C:\\Program Files\\Atelier\\resources\\claude-code\\claude.exe'].some((f) => f.toLowerCase() === p.toLowerCase()),
      loginShellLookup: async () => 'c:\\users\\test\\.local\\bin\\CLAUDE.exe',
      platform: 'win32',
    })
    expect(result.installs.map((i) => [i.path, i.source])).toEqual([
      ['C:\\Program Files\\Atelier\\resources\\claude-code\\claude.exe', 'bundled'],
      ['c:\\users\\test\\.local\\bin\\CLAUDE.exe', 'login-shell'],
      ['C:\\Program Files\\nodejs\\claude.cmd', 'common-path'],
    ])
  })

  it('keeps PATH under one key, split on ;', () => {
    const child = childEnv({ Path: 'C:\\Windows;C:\\Tools', ELECTRON_RUN_AS_NODE: '1', SystemRoot: 'C:\\Windows' }, null, winHome, 'win32')
    expect(child).not.toHaveProperty('PATH')
    expect(child.Path).toBe('C:\\Windows;C:\\Tools;C:\\Users\\test\\.local\\bin')
    expect(child.SystemRoot).toBe('C:\\Windows')
    expect(mergePath('C:\\a;C:\\B', 'c:\\b;C:\\c', winHome, 'win32').split(';').slice(0, 3)).toEqual(['C:\\a', 'C:\\B', 'C:\\c'])
  })

  it('quotes for Command Prompt', () => {
    expect(shellQuote('C:\\Users\\test\\.local\\bin\\claude.exe', 'win32')).toBe('C:\\Users\\test\\.local\\bin\\claude.exe')
    expect(shellQuote('C:\\Program Files\\nodejs\\claude.cmd', 'win32')).toBe('"C:\\Program Files\\nodejs\\claude.cmd"')
    expect(shellQuote('Authorization: Bearer x', 'win32')).toBe('"Authorization: Bearer x"')
  })
})

describe('launch arguments', () => {
  const base = { model: 'claude-opus-5-5', effort: 'high' as const, mcpConfigPath: '/data/mcp/c.json', appendSystemPrompt: 'You are Pip.', allowedTools: ['mcp__atelier__navigate', 'mcp__atelier__memory'], webSearch: false, resume: null, fork: false }
  const value = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

  it('runs headless stream-json with only Atelier’s tools and none of the user’s own settings', () => {
    const args = launchArgs(base)
    expect(args.slice(0, 2)).toEqual(['-p', '--verbose'])
    expect(value(args, '--input-format')).toBe('stream-json')
    expect(value(args, '--output-format')).toBe('stream-json')
    expect(args).toContain('--include-partial-messages')
    expect(value(args, '--model')).toBe('claude-opus-5-5')
    expect(value(args, '--effort')).toBe('high')
    expect(value(args, '--permission-mode')).toBe('dontAsk')
    expect(value(args, '--setting-sources')).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(value(args, '--mcp-config')).toBe('/data/mcp/c.json')
    expect(value(args, '--tools')).toBe('')
    expect(value(args, '--disallowedTools')?.split(',')).toEqual(BUILT_IN_TOOLS_OFF)
    expect(value(args, '--allowedTools')).toBe('mcp__atelier__navigate,mcp__atelier__memory')
    expect(value(args, '--append-system-prompt')).toBe('You are Pip.')
    expect(args).not.toContain('--resume')
    // No secret ever goes on the command line.
    expect(args.join(' ')).not.toMatch(/Bearer/)
  })

  it('adds web search when the chat has web tools, and resumes or forks a stored session', () => {
    const web = launchArgs({ ...base, webSearch: true })
    expect(value(web, '--tools')).toBe('WebSearch')
    expect(value(web, '--allowedTools')).toBe('mcp__atelier__navigate,mcp__atelier__memory,WebSearch')
    expect(BUILT_IN_TOOLS_OFF).toContain('WebFetch')
    const resumed = launchArgs({ ...base, resume: 'abc-123' })
    expect(value(resumed, '--resume')).toBe('abc-123')
    expect(resumed).not.toContain('--fork-session')
    expect(launchArgs({ ...base, resume: 'abc-123', fork: true })).toContain('--fork-session')
  })
})

describe('engine readiness', () => {
  const status = (patch: Partial<EngineStatus>, claude: Partial<EngineStatus['claudeCode']> = {}): EngineStatus => {
    const base: Omit<EngineStatus, 'others'> = {
      engine: 'api-key',
      engines: ['api-key', 'claude-code'],
      claudeCodeAvailable: true,
      apiKey: { state: 'saved' },
      claudeCode: { state: 'ready', path: '/x', source: 'common-path', version: '1.0.0', account: 'subscription', detail: '', nextStep: null, overrideInvalid: false, rateLimit: null, checkedAt: 1, installs: [], tooOld: null, update: IDLE_UPDATE, ...claude },
      external: { enabled: false, url: null, command: null, tabs: 'own', added: false, activeTabs: 0, lastUsedAt: null, problem: null },
      processes: 0,
      ...patch,
    }
    // As the engine reports itself (ClaudeCodeEngine.summary).
    return { ...base, others: base.claudeCodeAvailable ? [{ id: 'claude-code', ready: claudeCodeReady(base.claudeCode), checking: false, detail: '', badge: '', tone: 'success' }] : [] }
  }

  it('needs a key for the API key and a found, signed-in CLI for Claude Code', () => {
    expect(engineReady(status({}), 'api-key')).toBe(true)
    expect(engineReady(status({ apiKey: { state: 'missing' } }), 'api-key')).toBe(false)
    expect(engineReady(status({}), 'claude-code')).toBe(true)
    expect(engineReady(status({}, { state: 'signed-out' }), 'claude-code')).toBe(false)
    expect(engineReady(status({}, { state: 'not-found' }), 'claude-code')).toBe(false)
    expect(engineReady(status({ claudeCodeAvailable: false }), 'claude-code')).toBe(false)
  })
})

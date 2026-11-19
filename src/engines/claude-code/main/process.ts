/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Effort } from '@shared/ipc'
import { killTree, spawnProgram } from '../../../../src/main/system/programs'
import { commandLine, effortLine, interruptLine, StreamJsonReader, userLine, type BridgeEvent, type LineBlock } from './streamJson'

// One long-lived `claude` process for one chat: prompts go in on stdin,
// events come out on stdout. stderr is always drained (a full pipe would
// stall the CLI mid-turn) and its tail explains an unexpected exit.

/** Claude Code's built-in tools, off unless the launch policy turns one on (web reading with web tools; files and shell only in a documents chat's workspace). */
export const BUILT_IN_TOOLS_OFF = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'Task', 'WebFetch', 'TodoWrite', 'SlashCommand', 'Skill', 'ExitPlanMode', 'LS',
]

export interface LaunchOptions {
  model: string
  effort: Effort
  /** The generated --mcp-config file (mode 0600) naming only Atelier's server. */
  mcpConfigPath: string
  /** Atelier's persona and safety rules, appended to Claude Code's own prompt. */
  appendSystemPrompt: string
  /** Fully qualified tools the chat may use, e.g. mcp__atelier__navigate. */
  allowedTools: readonly string[]
  /** Claude Code's server-side web search, for chats with web tools. */
  webSearch: boolean
  /** A stored Claude Code session to continue. */
  resume: string | null
  /** Continue the stored session under a new id (a duplicated chat). */
  fork: boolean
  // See launchPolicy.ts, which fills these from the chat's capabilities
  /** Claude Code's page reading, for chats with web tools (with web search). */
  webFetch?: boolean
  /** More built-ins to make available (a documents chat's file and shell tools). */
  builtInTools?: readonly string[]
  /** The allow rules for builtInTools (e.g. Read(./**)); the bare names when absent. */
  builtInRules?: readonly string[]
  /** Tools always refused on top of the built-ins that stay off (connector tools the chat has off). */
  disallowedTools?: readonly string[]
  /** The model a declined or overloaded request falls back to. */
  fallbackModel?: string | null
  /** False: Claude Code writes nothing of the conversation to disk (a private chat). */
  persistSession?: boolean
  /** Folders the file tools may use besides the working directory. */
  addDirs?: readonly string[]
  /** Plugin folders to load (document skills). */
  pluginDirs?: readonly string[]
  /** Settings JSON for --settings (a documents chat's sandbox). */
  settings?: string | null
}

/** The argument list, every flag checked against `claude --help` (2.1.x). */
export function launchArgs(options: LaunchOptions): string[] {
  const builtIns = [...(options.webSearch ? ['WebSearch'] : []), ...(options.webFetch ? ['WebFetch'] : []), ...(options.builtInTools ?? [])]
  const builtInRules = [...(options.webSearch ? ['WebSearch'] : []), ...(options.webFetch ? ['WebFetch'] : []), ...(options.builtInRules ?? options.builtInTools ?? [])]
  const allowed = [...options.allowedTools, ...builtInRules]
  const off = [...BUILT_IN_TOOLS_OFF.filter((tool) => !builtIns.includes(tool)), ...(options.disallowedTools ?? [])]
  const args = [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', options.model,
    '--effort', options.effort,
    // Never ask: anything not allowed below is refused without a prompt.
    '--permission-mode', 'dontAsk',
    // The user's own Claude Code settings, hooks and CLAUDE.md files stay out of Atelier chats.
    '--setting-sources', '',
    // Only Atelier's server, never the MCP servers configured for the user's own sessions.
    '--strict-mcp-config',
    '--mcp-config', options.mcpConfigPath,
    // Built-in tools: none, web search and page reading, or a documents chat's file and shell tools.
    '--tools', builtIns.join(','),
    '--disallowedTools', off.join(','),
  ]
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(','))
  if (options.fallbackModel && options.fallbackModel !== options.model) args.push('--fallback-model', options.fallbackModel)
  if (options.persistSession === false) args.push('--no-session-persistence')
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)
  for (const dir of options.pluginDirs ?? []) args.push('--plugin-dir', dir)
  if (options.settings) args.push('--settings', options.settings)
  args.push('--append-system-prompt', options.appendSystemPrompt)
  if (options.resume && options.persistSession !== false) {
    args.push('--resume', options.resume)
    if (options.fork) args.push('--fork-session')
  }
  return args
}

export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** The last lines of stderr. */
  stderr: string
  /** True when Atelier stopped it (stop or idle shutdown). */
  expected: boolean
}

export interface SpawnSpec {
  path: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

const STDERR_TAIL = 8 * 1024
const KILL_GRACE_MS = 2000

export class ClaudeProcess extends EventEmitter<{ event: [BridgeEvent]; exit: [ProcessExit] }> {
  readonly #reader = new StreamJsonReader()
  readonly #child: ChildProcessWithoutNullStreams
  #buffer = ''
  #stderr = ''
  #stopping = false
  #exited = false
  readonly exited: Promise<ProcessExit>

  constructor(spec: SpawnSpec) {
    super()
    this.#child = spawnProgram(spec.path, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#ingest(chunk))
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    // A write to a CLI that already died must not crash main.
    this.#child.stdin.on('error', () => undefined)
    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.#exited) return
        this.#exited = true
        if (this.#buffer.trim()) this.#line(this.#buffer)
        this.#buffer = ''
        const exit: ProcessExit = { code, signal, stderr: tail(this.#stderr), expected: this.#stopping }
        this.emit('exit', exit)
        resolve(exit)
      }
      this.#child.on('error', (err) => {
        this.#stderr += `\n${err.message}`
        finish(null, null)
      })
      this.#child.on('close', finish)
    })
  }

  get alive(): boolean {
    return !this.#exited && !this.#stopping
  }

  get pid(): number | undefined {
    return this.#child.pid
  }

  send(blocks: ReadonlyArray<LineBlock> /* PDFs as documents */): boolean {
    return this.#write(userLine(blocks))
  }

  /** A slash command as its own user line (Compact now writes /compact). */
  command(text: string): boolean {
    return this.#write(commandLine(text))
  }

  interrupt(requestId: string): boolean {
    return this.#write(interruptLine(requestId))
  }

  /** DC-15: the effort for the messages after this one (see effortLine). */
  setEffort(requestId: string, effort: Effort): boolean {
    return this.#write(effortLine(requestId, effort))
  }

  /**
   * Closes stdin so the CLI ends its loop, then SIGTERM, then SIGKILL after a
   * grace period. On Windows SIGTERM is already a hard stop of the one
   * process, so the CLI gets the grace period first and then its whole tree
   * goes (the tools it started with it).
   */
  stop(): Promise<ProcessExit> {
    if (!this.#exited && !this.#stopping) {
      this.#stopping = true
      this.#child.stdin.end()
      const windows = process.platform === 'win32'
      if (!windows) this.#child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (this.#exited) return
        if (windows) killTree(this.#child)
        else this.#child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      void this.exited.then(() => clearTimeout(timer))
    }
    return this.exited
  }

  #write(line: string): boolean {
    if (!this.alive || !this.#child.stdin.writable) return false
    this.#child.stdin.write(line)
    return true
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      this.#line(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #line(line: string): void {
    for (const event of this.#reader.read(line)) this.emit('event', event)
  }
}

function tail(text: string): string {
  return text.trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' ').slice(-600)
}

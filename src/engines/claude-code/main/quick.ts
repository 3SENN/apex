/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Effort } from '@shared/ipc'
import { noteQuickUsage, type QuickEngine, type QuickUsage } from '../../../../src/main/agent/quick'
import { killTree, spawnProgram } from '../../../../src/main/system/programs'

// Quick calls (QuickModel) on Claude Code: a one-shot headless `claude -p`
// with every tool, MCP server and setting off, the prompt on stdin and the
// reply as JSON. It runs on the person's own Claude sign-in.

const CLAUDE_CODE_TIMEOUT_MS = 120_000

export interface ClaudeCodeOneShot {
  /** Whether Claude Code is found and signed in. */
  ready(): Promise<{ ok: boolean; reason?: string }>
  /** Runs `claude` with these arguments and the prompt on stdin; resolves to stdout. */
  run(args: readonly string[], input: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }>
}

/** QuickModel's engine for Claude Code. */
export function claudeQuickEngine(cc: ClaudeCodeOneShot): QuickEngine {
  return {
    ready: () => cc.ready(),
    call: async (r, model, jsonSchema) => {
      let out = await cc.run(quickClaudeArgs({ system: r.system, model, ...(r.effort ? { effort: r.effort } : {}), jsonSchema }), r.prompt, r.signal)
      let parsed = parseClaudeResult(out.stdout)
      // A Claude Code that refuses --effort or --json-schema exits before any model call, with nothing on stdout:
      // once more without them (the zod check in json() stays).
      if (!parsed.ok && (r.effort || jsonSchema) && out.code !== 0 && !out.stdout.trim()) {
        out = await cc.run(quickClaudeArgs({ system: r.system, model }), r.prompt, r.signal)
        parsed = parseClaudeResult(out.stdout)
      }
      noteQuickUsage(r, 'claude-code', model, claudeUsage(out.stdout))
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.text.trim()
    },
  }
}

/** Arguments for a tool-free, settings-free, one-shot Claude Code call (prompt on stdin). */
export function quickClaudeArgs(r: { system: string; model: string; effort?: Effort; jsonSchema?: Record<string, unknown> | null }): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', r.model,
    '--system-prompt', r.system,
    // No tools, no MCP servers and none of the person's own settings, hooks or CLAUDE.md files.
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--permission-mode', 'dontAsk',
    // A one-shot call leaves no session behind under ~/.claude/projects.
    '--no-session-persistence',
  ]
  if (r.effort) args.push('--effort', r.effort)
  if (r.jsonSchema) args.push('--json-schema', JSON.stringify(r.jsonSchema))
  return args
}

/** The reply text of `claude -p --output-format json`, or an error. */
export function parseClaudeResult(stdout: string): { ok: true; text: string } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '')
  } catch {
    return { ok: false, error: `Claude Code returned something ${BRAND_NAME} could not read.` }
  }
  const result = parsed && typeof parsed === 'object' ? (parsed as { result?: unknown; is_error?: unknown; structured_output?: unknown }) : {}
  if (result.is_error === true) return { ok: false, error: typeof result.result === 'string' && result.result ? result.result : 'Claude Code could not answer.' }
  // With --json-schema the checked value arrives on its own; the text may be empty.
  if (result.structured_output !== undefined && result.structured_output !== null) return { ok: true, text: JSON.stringify(result.structured_output) }
  if (typeof result.result !== 'string') return { ok: false, error: 'Claude Code returned no answer.' }
  return { ok: true, text: result.result }
}

/** The token counts in `claude -p --output-format json` output, when it has them. */
export function claudeUsage(stdout: string): QuickUsage | undefined {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '') as { usage?: QuickUsage }
    return parsed && typeof parsed.usage === 'object' ? parsed.usage : undefined
  } catch {
    return undefined
  }
}

/** Windows' longest command line (CreateProcess takes 32,767 characters), less room for the program's path. */
export const WIN_COMMAND_LINE_MAX = 30_000

/** About how long `args` are on a Windows command line: quoted, with a backslash before each quote or backslash. */
function commandLineLength(args: readonly string[]): number {
  return args.reduce((n, a) => n + a.length + (a.match(/["\\]/g)?.length ?? 0) + 3, 0)
}

/**
 * Arguments that fit on this system's command line. macOS allows about 1 MB;
 * Windows 32,767 characters, which a pack's system prompt with its tools, or
 * a large JSON schema, can pass (spawn then fails with ENAMETOOLONG). There
 * the system prompt goes in a file (`toFile` writes it, --system-prompt-file),
 * and a schema that still doesn't fit is left out: the prompt asks for the
 * shape and the caller's zod check holds the reply to it.
 */
export function fitClaudeArgs(args: readonly string[], platform: string, toFile: (text: string) => string): string[] {
  const out = [...args]
  if (platform !== 'win32' || commandLineLength(out) <= WIN_COMMAND_LINE_MAX) return out
  const system = out.indexOf('--system-prompt')
  if (system >= 0 && system + 1 < out.length) out.splice(system, 2, '--system-prompt-file', toFile(out[system + 1]!))
  const schema = out.indexOf('--json-schema')
  if (commandLineLength(out) > WIN_COMMAND_LINE_MAX && schema >= 0) out.splice(schema, 2)
  return out
}

/** Runs the claude program once with the prompt on stdin (the wiring's ClaudeCodeOneShot.run). */
export function spawnClaudeOnce(
  path: string,
  args: readonly string[],
  input: string,
  options: { env: Record<string, string>; cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    // A system prompt too long for Windows' command line goes in a private file, removed once claude is done.
    let promptDir: string | null = null
    const cleanUp = (): void => {
      if (promptDir) rmSync(promptDir, { recursive: true, force: true })
      promptDir = null
    }
    try {
      const fitted = fitClaudeArgs(args, process.platform, (text) => {
        promptDir = mkdtempSync(join(tmpdir(), 'atelier-claude-'))
        const file = join(promptDir, 'system-prompt.txt')
        writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
        return file
      })
      child = spawnProgram(path, fitted, { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    } catch (err) {
      cleanUp()
      reject(err)
      return
    }
    child.on('close', cleanUp)
    child.on('error', cleanUp)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => killTree(child), options.timeoutMs ?? CLAUDE_CODE_TIMEOUT_MS)
    const abort = (): void => {
      killTree(child)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      if (stdout.length < 4_000_000) stdout += c
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      stderr = (stderr + c).slice(-4000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error('aborted'))
      else resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { ChatCapabilities } from '../src/main/chats'
import { BUILT_IN_TOOLS_OFF } from '../src/engines/claude-code/main/process'
import {
  connectorServerList,
  DOCUMENT_BUILT_INS,
  DOCUMENTS_SETTINGS,
  engineNote,
  fallbackModelFor,
  launchPolicy,
  mcpToolName,
  offConnectorTools,
  type LaunchPolicyInput,
} from '../src/engines/claude-code/main/launchPolicy'

// The per-chat `claude` launch, built from the chat's capabilities. Pure:
// nothing here spawns a process or calls a model.

const caps = (patch: Partial<ChatCapabilities> = {}): ChatCapabilities => ({ model: 'claude-opus-5-5', effort: 'high', browser: true, webTools: false, memory: true, connectorIds: [], ...patch })
const input = (patch: Partial<LaunchPolicyInput> = {}): LaunchPolicyInput => ({
  caps: caps(),
  system: 'You are Pip.',
  mcpConfigPath: '/data/mcp/c1.json',
  atelierTools: ['navigate', 'mcp__atelier__memory'],
  connectors: [],
  session: null,
  companionFolder: '/data/companions/pip',
  ...patch,
})
const value = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const values = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []))
const list = (args: string[], flag: string): string[] => (value(args, flag) ?? '').split(',').filter(Boolean)

describe('launch policy: the defaults', () => {
  it('keeps every built-in off, qualifies Atelier’s tools and runs in the companion’s folder', () => {
    const plan = launchPolicy(input())
    expect(plan.cwd).toBe('/data/companions/pip')
    expect(plan.documents).toBe(false)
    expect(plan.persist).toBe(true)
    expect(value(plan.args, '--tools')).toBe('')
    expect(list(plan.args, '--disallowedTools')).toEqual(BUILT_IN_TOOLS_OFF)
    expect(list(plan.args, '--allowedTools')).toEqual(['mcp__atelier__navigate', 'mcp__atelier__memory'])
    expect(value(plan.args, '--permission-mode')).toBe('dontAsk')
    expect(value(plan.args, '--setting-sources')).toBe('')
    expect(plan.args).toContain('--strict-mcp-config')
    expect(plan.args).not.toContain('--no-session-persistence')
    expect(plan.args).not.toContain('--add-dir')
    expect(plan.args).not.toContain('--settings')
    expect(value(plan.args, '--append-system-prompt')).toMatch(/^You are Pip\.\n\nThis chat runs through Claude Code/)
    expect(value(plan.args, '--append-system-prompt')).toContain('no access to files, a terminal or code')
  })

  it('takes the chat’s effort, else the app’s, else high', () => {
    expect(value(launchPolicy(input({ caps: caps({ effort: 'low' }), settings: { effort: 'max' } })).args, '--effort')).toBe('low')
    expect(value(launchPolicy(input({ caps: caps({ effort: undefined }), settings: { effort: 'medium' } })).args, '--effort')).toBe('medium')
    expect(value(launchPolicy(input({ caps: caps({ effort: undefined }) })).args, '--effort')).toBe('high')
  })

  it('resumes or forks a stored session', () => {
    expect(value(launchPolicy(input({ session: { id: 's-1' } })).args, '--resume')).toBe('s-1')
    expect(launchPolicy(input({ session: { id: 's-1' } })).args).not.toContain('--fork-session')
    expect(launchPolicy(input({ session: { id: 's-1', fork: true } })).args).toContain('--fork-session')
  })
})

describe('launch policy: model fallback', () => {
  it('mirrors the API key’s server-side fallback: every model but Haiku, never to itself', () => {
    expect(fallbackModelFor('claude-sonnet-5-5')).toBe('claude-opus-5-5')
    expect(fallbackModelFor('claude-fable-5-1')).toBe('claude-opus-5-5')
    expect(fallbackModelFor('claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(fallbackModelFor('claude-haiku-5-5')).toBeNull()
    expect(value(launchPolicy(input()).args, '--fallback-model')).toBe('claude-sonnet-5-5')
    expect(value(launchPolicy(input({ caps: caps({ model: 'claude-sonnet-5-5' }) })).args, '--fallback-model')).toBe('claude-opus-5-5')
    expect(launchPolicy(input({ caps: caps({ model: 'claude-haiku-5-5' }) })).args).not.toContain('--fallback-model')
  })
})

describe('launch policy: web tools', () => {
  it('turns on web search and page reading together, and nothing else', () => {
    const plan = launchPolicy(input({ caps: caps({ webTools: true }) }))
    expect(list(plan.args, '--tools')).toEqual(['WebSearch', 'WebFetch'])
    expect(list(plan.args, '--allowedTools')).toEqual(['mcp__atelier__navigate', 'mcp__atelier__memory', 'WebSearch', 'WebFetch'])
    const off = list(plan.args, '--disallowedTools')
    expect(off).not.toContain('WebFetch')
    expect(off).toEqual(BUILT_IN_TOOLS_OFF.filter((t) => t !== 'WebFetch'))
    expect(off).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Skill', 'Task']))
    expect(value(plan.args, '--append-system-prompt')).toContain('web search and reading web pages')
  })

  it('keeps page reading off without web tools', () => {
    const plan = launchPolicy(input({ caps: caps({ webTools: false }) }))
    expect(list(plan.args, '--disallowedTools')).toContain('WebFetch')
    expect(list(plan.args, '--allowedTools')).not.toContain('WebFetch')
  })
})

describe('launch policy: connectors', () => {
  const connectors = [
    { id: 'c-linear', name: 'Linear', url: 'https://mcp.linear.example/mcp', token: 'secret-1' },
    { id: 'c-notes', name: 'Team Notes', url: 'https://notes.example/mcp', token: null },
    { id: 'c-atelier', name: 'Atelier', url: 'https://other.example/mcp', token: null },
  ]

  it('names each server as the --mcp-config does', () => {
    expect(connectorServerList(connectors).map(([name]) => name)).toEqual(['linear', 'team-notes', 'atelier-connector'])
    expect(mcpToolName('team-notes', 'delete page')).toBe('mcp__team-notes__delete_page')
  })

  it('denies, tool by tool, the connector tools the chat has off and allows the rest of each server', () => {
    const chat = caps({
      connectorIds: ['c-linear', 'c-notes', 'c-atelier'],
      toolPolicies: { 'c-linear': { delete_issue: 'off', create_issue: 'ask', archive: 'off' }, 'c-notes': { 'delete page': 'off' }, 'c-gone': { x: 'off' } },
    })
    const off = offConnectorTools(chat, connectors)
    expect(off).toEqual(['mcp__linear__archive', 'mcp__linear__delete_issue', 'mcp__team-notes__delete_page'])
    const plan = launchPolicy(input({ caps: chat, connectors }))
    expect(plan.offTools).toEqual(off)
    const denied = list(plan.args, '--disallowedTools')
    expect(denied).toEqual([...BUILT_IN_TOOLS_OFF, ...off])
    expect(list(plan.args, '--allowedTools')).toEqual(expect.arrayContaining(['mcp__linear', 'mcp__team-notes', 'mcp__atelier-connector']))
    // Tokens live in the 0600 config file, never in the arguments.
    expect(plan.args.join(' ')).not.toContain('secret-1')
  })

  it('denies nothing extra when no tool is off', () => {
    const plan = launchPolicy(input({ caps: caps({ connectorIds: ['c-linear'], toolPolicies: { 'c-linear': { create_issue: 'allow' } } }), connectors: connectors.slice(0, 1) }))
    expect(list(plan.args, '--disallowedTools')).toEqual(BUILT_IN_TOOLS_OFF)
  })
})

describe('launch policy: private chats', () => {
  it('tells Claude Code to keep nothing on disk and never resumes a stored session', () => {
    const plan = launchPolicy(input({ caps: caps({ private: true }), session: { id: 'leftover', fork: true } }))
    expect(plan.persist).toBe(false)
    expect(plan.args).toContain('--no-session-persistence')
    expect(plan.args).not.toContain('--resume')
    expect(plan.args).not.toContain('--fork-session')
  })
})

describe('launch policy: Files and documents', () => {
  const workspace = '/Users/someone/Library/Application Support/Atelier/documents/chats/c1'
  const documents = (patch: Partial<LaunchPolicyInput> = {}): LaunchPolicyInput =>
    input({ caps: caps({ documents: true }), documentsFolder: workspace, pluginDirs: ['/data/documents/plugin'], documentsNote: '\n\n<files_and_documents>outputs/</files_and_documents>', ...patch })

  it('runs in the chat’s own workspace with the file and shell tools scoped to it', () => {
    const plan = launchPolicy(documents())
    expect(plan.documents).toBe(true)
    expect(plan.cwd).toBe(workspace)
    expect(values(plan.args, '--add-dir')).toEqual([workspace])
    expect(values(plan.args, '--plugin-dir')).toEqual(['/data/documents/plugin'])
    expect(list(plan.args, '--tools')).toEqual([...DOCUMENT_BUILT_INS])
    const allowed = list(plan.args, '--allowedTools')
    expect(allowed).toEqual(['mcp__atelier__navigate', 'mcp__atelier__memory', 'Bash', 'Read(./**)', 'Write(./**)', 'Edit(./**)', 'Skill'])
    // No rule names an absolute path (the CLI would split it at the space).
    expect(allowed.some((rule) => rule.includes('Application Support'))).toBe(false)
    const off = list(plan.args, '--disallowedTools')
    for (const tool of DOCUMENT_BUILT_INS) expect(off).not.toContain(tool)
    expect(off).toEqual(expect.arrayContaining(['WebFetch', 'Task', 'Glob', 'Grep', 'NotebookEdit']))
    // Bash runs in Claude Code's sandbox: writes only in the working directory, no way out.
    expect(JSON.parse(value(plan.args, '--settings') ?? '{}')).toEqual(DOCUMENTS_SETTINGS)
    expect(DOCUMENTS_SETTINGS.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false })
    const prompt = value(plan.args, '--append-system-prompt') ?? ''
    expect(prompt).toContain('private workspace folder')
    expect(prompt).not.toContain('no access to files')
    expect(prompt.endsWith('<files_and_documents>outputs/</files_and_documents>')).toBe(true)
  })

  it('combines with web tools', () => {
    const plan = launchPolicy(documents({ caps: caps({ documents: true, webTools: true }) }))
    expect(list(plan.args, '--tools')).toEqual(['WebSearch', 'WebFetch', ...DOCUMENT_BUILT_INS])
  })

  it('gives a chat without documents (or without its folder) none of it', () => {
    for (const plan of [launchPolicy(documents({ caps: caps({ documents: false }) })), launchPolicy(documents({ documentsFolder: null }))]) {
      expect(plan.documents).toBe(false)
      expect(plan.cwd).toBe('/data/companions/pip')
      expect(value(plan.args, '--tools')).toBe('')
      expect(plan.args).not.toContain('--add-dir')
      expect(plan.args).not.toContain('--plugin-dir')
      expect(plan.args).not.toContain('--settings')
      expect(value(plan.args, '--append-system-prompt')).not.toContain('files_and_documents')
    }
  })
})

describe('engine note', () => {
  it('lists what the chat has', () => {
    expect(engineNote(true, true, true)).toContain('Your tools are the browser tools, memory and web search and reading web pages')
    expect(engineNote(false, false, false)).toContain('You have no tools in this chat.')
    expect(engineNote(false, false, false, { documents: true })).toContain('a private workspace folder for files and code')
  })
})

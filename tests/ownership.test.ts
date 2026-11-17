/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryService, memoryCommandPaths, routeMemoryPath, sharedToAgent } from '../src/main/memory'
import { ConnectorStore, RoutineStore, SkillStore } from '../src/main/stores'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atelier-owner-'))

describe('ownership migration', () => {
  it('marks skills, routines and connectors saved before owners as shared', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'skills.json'), JSON.stringify([{ id: 's1', name: 'recap', description: '', instructions: 'Recap.', updatedAt: 1 }]))
    writeFileSync(join(dir, 'routines.json'), JSON.stringify([{ id: 'r1', name: 'R', prompt: 'p', schedule: { kind: 'interval', hours: 1 }, enabled: true, lastRunAt: null, nextRunAt: null, lastChatId: null, lastStatus: null }]))
    writeFileSync(join(dir, 'connectors.json'), JSON.stringify([{ id: 'c1', name: 'docs', url: 'https://mcp.example', enabled: true }]))
    expect(new SkillStore(dir).list()).toEqual([expect.objectContaining({ owner: 'shared', lastUsedAt: null })])
    expect(new RoutineStore(dir).list()).toEqual([expect.objectContaining({ owner: 'shared' })])
    expect(new ConnectorStore(dir).views()).toEqual([expect.objectContaining({ owner: 'shared', hasToken: false })])
  })
})

describe('owned skills', () => {
  it('are unique per owner, and a companion’s own skill wins over a shared one', () => {
    const skills = new SkillStore(tmp())
    const shared = skills.save({ name: 'recap', description: '', instructions: 'Shared recap.' })
    const own = skills.save({ name: 'Recap', description: '', instructions: 'Own recap.', owner: 'c1' })
    expect(() => skills.save({ name: 'recap', description: '', instructions: 'Again.', owner: 'c1' })).toThrow(/already exists/)
    expect(skills.resolve('recap', 'c1')?.id).toBe(own.id)
    expect(skills.resolve('recap', 'c2')?.id).toBe(shared.id)
    expect(skills.resolve('missing', 'c1')).toBeUndefined()
    // Saving keeps the owner unless it is given.
    expect(skills.save({ id: own.id, name: 'recap', description: 'd', instructions: 'Own recap.' }).owner).toBe('c1')
    skills.markUsed(own.id, 42)
    expect(skills.get(own.id)?.lastUsedAt).toBe(42)
    skills.removeOwned('c1')
    expect(skills.list().map((s) => s.id)).toEqual([shared.id])
  })
})

describe('owned connectors and routines', () => {
  it('give a chat the shared connectors and its companion’s own', () => {
    const connectors = new ConnectorStore(tmp())
    const shared = connectors.save({ name: 'docs', url: 'https://mcp.example/docs', enabled: true })
    const mine = connectors.save({ name: 'crm', url: 'https://mcp.example/crm', enabled: true, owner: 'c1' })
    connectors.save({ name: 'off', url: 'https://mcp.example/off', enabled: false, owner: 'c1' })
    expect(connectors.enabledIds('c1')).toEqual([shared.id, mine.id])
    expect(connectors.enabledIds('c2')).toEqual([shared.id])
    expect(connectors.enabledIds()).toEqual([shared.id, mine.id])
    expect(connectors.save({ id: mine.id, name: 'crm', url: 'https://mcp.example/crm', enabled: true }).owner).toBe('c1')
  })

  it('keep a routine’s owner across saves', () => {
    const routines = new RoutineStore(tmp())
    const routine = routines.save({ name: 'R', prompt: 'p', schedule: { kind: 'interval', hours: 1 }, enabled: true, owner: 'c1' })
    expect(routines.save({ id: routine.id, name: 'R2', prompt: 'p', schedule: { kind: 'interval', hours: 1 }, enabled: false }).owner).toBe('c1')
    expect(routines.ownedBy('c1')).toHaveLength(1)
  })
})

describe('memory routing', () => {
  it('sends /memories/shared to the shared folder', () => {
    expect(routeMemoryPath('/memories/shared/user.md')).toEqual({ shared: true, path: '/memories/user.md' })
    expect(routeMemoryPath('/memories/shared/')).toEqual({ shared: true, path: '/memories' })
    expect(routeMemoryPath('/memories/sharedx/a')).toEqual({ shared: false, path: '/memories/sharedx/a' })
    expect(routeMemoryPath('/memories/')).toEqual({ shared: false, path: '/memories' })
  })

  it('translates shared replies back without touching file contents', () => {
    expect(sharedToAgent('File created successfully at: /memories/user.md')).toBe('File created successfully at: /memories/shared/user.md')
    expect(sharedToAgent("Here's the content of /memories/a.md with line numbers:\n     1\tsee /memories/b.md")).toBe(
      "Here's the content of /memories/shared/a.md with line numbers:\n     1\tsee /memories/b.md",
    )
    expect(sharedToAgent("Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n4.0K\t/memories\n12B\t/memories/a.md")).toBe(
      "Here're the files and directories up to 2 levels deep in /memories/shared, excluding hidden items and node_modules:\n4.0K\t/memories/shared\n12B\t/memories/shared/a.md",
    )
  })

  it('reports the paths a call changes', () => {
    expect(memoryCommandPaths({ command: 'view', path: '/memories' })).toEqual([])
    expect(memoryCommandPaths({ command: 'create', path: '/memories/a.md', file_text: '' })).toEqual(['/memories/a.md'])
    expect(memoryCommandPaths({ command: 'rename', old_path: '/memories/a', new_path: '/memories/shared/a' })).toEqual(['/memories/a', '/memories/shared/a'])
    expect(memoryCommandPaths({ command: 'nope' })).toEqual([])
  })
})

describe('memory per companion', () => {
  it('gives a chat its companion’s folder at /memories and the shared one at /memories/shared', async () => {
    const memory = new MemoryService(tmp())
    await memory.execute({ command: 'create', path: '/memories/own.md', file_text: 'mine' }, 'c1')
    expect(await memory.execute({ command: 'create', path: '/memories/shared/user.md', file_text: 'name: Sam' }, 'c1')).toBe('File created successfully at: /memories/shared/user.md')
    expect(memory.list('c1').map((f) => f.path)).toEqual(['/memories/own.md'])
    expect(memory.list().map((f) => [f.path, f.owner])).toEqual([['/memories/user.md', 'shared']])

    // Another companion sees the shared note but not c1's own.
    const view = await memory.execute({ command: 'view', path: '/memories' }, 'c2')
    expect(view).toContain('\t/memories/shared/\n')
    expect(view).toContain('\t/memories/shared/user.md')
    expect(view).not.toContain('own.md')
    await expect(memory.execute({ command: 'view', path: '/memories/own.md' }, 'c2')).rejects.toThrow(/does not exist/)
    await expect(memory.execute({ command: 'view', path: '/memories/shared/missing.md' }, 'c2')).rejects.toThrow('/memories/shared/missing.md')

    // Moving between the two folders.
    expect(await memory.execute({ command: 'rename', old_path: '/memories/own.md', new_path: '/memories/shared/own.md' }, 'c1')).toBe('Successfully renamed /memories/own.md to /memories/shared/own.md')
    expect(memory.read('/memories/own.md')).toBe('mine')
    await expect(memory.execute({ command: 'rename', old_path: '/memories/shared/user.md', new_path: '/memories/shared/own.md' }, 'c1')).rejects.toThrow(/already exists/)
    await expect(memory.execute({ command: 'delete', path: '/memories/shared' }, 'c1')).rejects.toThrow('/memories/shared directory itself')
    await expect(memory.execute({ command: 'view', path: '/memories/shared/../../etc' }, 'c1')).rejects.toThrow()
  })

  it('records who last wrote each note, through renames and deletes', async () => {
    const dir = tmp()
    const memory = new MemoryService(dir)
    writeFileSync(join(memory.root, 'old.md'), 'from before')
    await memory.execute({ command: 'create', path: '/memories/notes/trip.md', file_text: 'Lisbon' }, 'c1')
    await memory.execute({ command: 'create', path: '/memories/shared/user.md', file_text: 'Sam' }, 'c1')
    memory.write('/memories/mine.md', 'typed by me', 'c1')
    const authors = (owner: string): Record<string, string | null> => Object.fromEntries(memory.list(owner).map((f) => [f.path, f.author]))
    expect(authors('c1')).toEqual({ '/memories/notes/trip.md': 'agent', '/memories/mine.md': 'you' })
    expect(authors('shared')).toEqual({ '/memories/old.md': null, '/memories/user.md': 'agent' })

    // Moving a folder into the shared one keeps the credit; editing it in the UI changes it.
    await memory.execute({ command: 'rename', old_path: '/memories/notes', new_path: '/memories/shared/notes' }, 'c1')
    expect(authors('shared')['/memories/notes/trip.md']).toBe('agent')
    memory.write('/memories/notes/trip.md', 'Porto', 'shared')
    expect(authors('shared')['/memories/notes/trip.md']).toBe('you')
    await memory.execute({ command: 'delete', path: '/memories/shared/notes' }, 'c1')
    expect(new MemoryService(dir).list('shared').map((f) => f.path).sort()).toEqual(['/memories/old.md', '/memories/user.md'])

    // A duplicated companion keeps the record.
    memory.copyOwner('c1', 'c2')
    expect(authors('c2')).toEqual({ '/memories/mine.md': 'you' })
  })

  it('keeps old chats on the shared folder, and keeps the UI out of the reserved path', async () => {
    const memory = new MemoryService(tmp())
    await memory.execute({ command: 'create', path: '/memories/legacy.md', file_text: 'old' }, null)
    expect(memory.read('/memories/legacy.md', 'shared')).toBe('old')
    expect(() => memory.write('/memories/shared/x.md', 'x', 'c1')).toThrow(/shared folder/)
    expect(() => memory.rootFor('../c1')).toThrow(/Unknown memory owner/)
    memory.write('/memories/a.md', 'a', 'c1')
    expect(memory.ownerFolder('c1')).not.toBeNull()
    memory.removeOwner('c1')
    expect(existsSync(memory.rootFor('c1'))).toBe(false)
  })
})

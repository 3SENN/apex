/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { PROJECT_MENU_PREFIX, filterProjects, projectColor, projectMenuAction, projectMenuSpec, projectOfChats, type Project } from '@shared/workspace'
import { openDb } from '../src/main/db'
import { ProjectStore, type ChatLinks } from '../src/main/workspace/projects'

function setup() {
  const chats = new Map<string, { id: string; projectId: string | null; private: boolean; draft: boolean }>()
  for (const id of ['c1', 'c2', 'c3']) chats.set(id, { id, projectId: null, private: false, draft: false })
  chats.set('secret', { id: 'secret', projectId: null, private: true, draft: false })
  const links: ChatLinks = {
    list: () => [...chats.values()],
    setProject: (ids, projectId) => {
      for (const id of ids) {
        const c = chats.get(id)
        if (c) c.projectId = projectId
      }
    },
  }
  let now = 1000
  const events: number[] = []
  const store = new ProjectStore({ db: openDb(':memory:'), chats: links, now: () => (now += 10), onChange: (items) => events.push(items.length) })
  return { store, chats, events }
}

describe('projects', () => {
  it('creates, edits and lists projects, newest change first', () => {
    const s = setup()
    const a = s.store.save({ name: '  Garden  ', color: 'fern', description: 'Beds and paths', instructions: 'Use metric units.' })
    const b = s.store.save({ name: 'Trip', color: 'not-a-colour', description: '', instructions: '' })
    expect(a).toMatchObject({ name: 'Garden', color: 'fern', chatIds: [], files: [] })
    expect(b.color).toBe('graphite')
    expect(s.store.list().map((p) => p.name)).toEqual(['Trip', 'Garden'])
    const edited = s.store.save({ id: a.id, name: 'Garden 2026', color: 'honey', description: 'x', instructions: 'y' })
    expect(edited).toMatchObject({ name: 'Garden 2026', color: 'honey', createdAt: a.createdAt })
    expect(() => s.store.save({ name: ' ', color: 'fern', description: '', instructions: '' })).toThrow('name')
    expect(() => s.store.get('nope')).toThrow('no longer exists')
  })

  it('links chats through projectId, never private ones', () => {
    const s = setup()
    const p = s.store.save({ name: 'Garden', color: 'fern', description: '', instructions: '' })
    expect(s.store.addChats(p.id, ['c1', 'c2', 'secret', 'unknown']).chatIds.sort()).toEqual(['c1', 'c2'])
    expect(s.chats.get('c1')?.projectId).toBe(p.id)
    expect(s.store.removeChats(p.id, ['c1']).chatIds).toEqual(['c2'])
    expect(s.chats.get('c1')?.projectId).toBeNull()
  })

  it('adds and removes files without duplicates', () => {
    const s = setup()
    const p = s.store.save({ name: 'Garden', color: 'fern', description: '', instructions: '' })
    const ref = { kind: 'folder' as const, folderId: 'f1', path: 'beds.md' }
    s.store.addFiles(p.id, [ref, ref, { kind: 'library', id: 'L1' }])
    expect(s.store.get(p.id).files).toHaveLength(2)
    expect(s.store.removeFiles(p.id, [ref]).files).toEqual([{ kind: 'library', id: 'L1' }])
    s.store.forgetFile({ kind: 'library', id: 'L1' })
    expect(s.store.get(p.id).files).toEqual([])
  })

  it('deleting clears projectId on its chats; restoring re-files the ones still unfiled', () => {
    const s = setup()
    const p = s.store.save({ name: 'Garden', color: 'fern', description: '', instructions: 'Metric.' })
    s.store.addChats(p.id, ['c1', 'c2'])
    const payload = s.store.trashPayload(p.id)
    s.store.remove(p.id)
    expect(s.store.list()).toEqual([])
    expect(s.chats.get('c1')?.projectId).toBeNull()
    const other = s.store.save({ name: 'Other', color: 'iris', description: '', instructions: '' })
    s.store.addChats(other.id, ['c2'])
    // A project with the same name was made meanwhile: the restored one gets a number.
    s.store.save({ name: 'Garden', color: 'fern', description: '', instructions: '' })
    expect(s.store.restore(payload)).toBe('Garden 2')
    const restored = s.store.get(p.id)
    expect(restored).toMatchObject({ name: 'Garden 2', instructions: 'Metric.', chatIds: ['c1'] })
    expect(s.chats.get('c2')?.projectId).toBe(other.id)
  })
})

describe('the Move to project menu and the project list', () => {
  const project = (id: string, name: string, chatIds: string[], updatedAt = 1): Project => ({ id, name, color: 'iris', description: '', instructions: '', chatIds, files: [], createdAt: 1, updatedAt })
  const labels = { title: 'Move to project', none: 'No project', new: 'New project…' }

  it('lists No project, each project by name (checked when every chat is in it) and New project…', () => {
    const projects = [project('p2', 'Trip', ['c2']), project('p1', 'Garden', ['c1', 'c3'])]
    const spec = projectMenuSpec(projects, ['c1', 'c3'], labels)
    expect(spec.label).toBe('Move to project')
    expect(spec.submenu?.filter((i) => i.type !== 'separator').map((i) => [i.id, i.label, i.checked ?? null])).toEqual([
      ['project:none', 'No project', false],
      ['project:p1', 'Garden', true],
      ['project:p2', 'Trip', false],
      ['project:new', 'New project…', null],
    ])
    expect(projectMenuSpec(projects, ['c4'], labels).submenu?.[0]?.checked).toBe(true)
    expect(projectMenuSpec(projects, ['c1', 'c2'], labels).submenu?.some((i) => i.checked)).toBe(false)
    expect(projectMenuSpec([], [], labels).enabled).toBe(false)
    expect(projectOfChats(projects, ['c1', 'c2', 'c9'])).toEqual(new Map([['c1', 'p1'], ['c2', 'p2']]))
  })

  it('reads a clicked id, ignoring separators and other menus', () => {
    expect(projectMenuAction('project:none')).toEqual({ kind: 'none' })
    expect(projectMenuAction('project:new')).toEqual({ kind: 'new' })
    expect(projectMenuAction('project:p1')).toEqual({ kind: 'project', id: 'p1' })
    expect(projectMenuAction('project:sep-new')).toBeNull()
    expect(projectMenuAction('project:menu')).toBeNull()
    expect(projectMenuAction('export')).toBeNull()
    expect(PROJECT_MENU_PREFIX).toBe('project:')
  })

  it('filters projects by every word, newest change first, and keeps colours to the palette', () => {
    const projects = [{ ...project('a', 'Garden shed', []), description: 'Roof and paint' }, project('b', 'Garden pond', [], 5), project('c', 'Trip', [], 9)]
    expect(filterProjects(projects, 'garden').map((p) => p.id)).toEqual(['b', 'a'])
    expect(filterProjects(projects, 'garden roof').map((p) => p.id)).toEqual(['a'])
    expect(filterProjects(projects, '').map((p) => p.id)).toEqual(['c', 'b', 'a'])
    expect(projectColor('lagoon')).toBe('lagoon')
    expect(projectColor('#ff0000')).toBe('graphite')
    expect(projectColor(null)).toBe('graphite')
  })
})

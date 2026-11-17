/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, SearchHit, SpaceInfo, TrashItem, WatchedFolder } from '@shared/workspace'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { docWith, waitFor } from '../smokeKit'

// Search everything, watched folders and confinement, versions, Recently Deleted, projects and spaces.
// Offline only: folders are temp dirs, nothing calls a model, and every
// check removes what it made (the project, the grant, the temp folder).
// Shots cover the hub's Home, Projects (list and a project), Files (a
// shared folder), Search, Recently deleted and the Space row, in light and
// dark. The hub check walks its four tabs, the search field and the old
// Timeline address.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rejects(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn()
  } catch {
    return
  }
  throw new Error(`${label} should have been refused`)
}

/** A temp folder with a note, a sub folder and a symlink that points outside it. */
function fixtureFolder(): { root: string; outside: string; cleanup(): void } {
  const base = mkdtempSync(join(tmpdir(), 'atelier-smoke-ws-'))
  const root = join(base, 'Kitchen plans')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'quotes'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'notes.md'), '# Kitchen\nThe oak worktop quote came in under budget.\n')
  writeFileSync(join(root, 'quotes', 'tiles.txt'), 'Tiles: 42 boxes of terracotta.\n')
  writeFileSync(join(outside, 'secret.txt'), 'not for Atelier')
  try {
    symlinkSync(outside, join(root, 'escape'), 'dir')
  } catch {
    // Windows only lets an admin make a symlink, but anyone a junction; elsewhere the .. check still runs.
    try {
      if (process.platform === 'win32') symlinkSync(outside, join(root, 'escape'), 'junction')
    } catch {
      // Neither: the .. check still runs.
    }
  }
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

async function withFolder(ctx: SmokeContext, fn: (folder: WatchedFolder) => Promise<void>, mode: WatchedFolder['mode'] = 'read'): Promise<void> {
  const fixture = fixtureFolder()
  const folder = await ctx.chrome.invoke<WatchedFolder>('folders', 'grant', { path: fixture.root, mode, scope: 'all-chats', companionId: null })
  try {
    await fn(folder)
  } finally {
    await ctx.chrome.invoke('folders', 'revoke', folder.id).catch(() => undefined)
    fixture.cleanup()
  }
}

async function withProject(ctx: SmokeContext, fn: (project: Project) => Promise<void>): Promise<void> {
  const project = await ctx.chrome.invoke<Project>('projects', 'save', { name: 'Kitchen renovation', color: 'fern', description: 'Worktops, tiles and the plumber.', instructions: 'Keep answers short and list costs in euros.' })
  try {
    await fn(project)
  } finally {
    const left = await ctx.chrome.invoke<Project[]>('projects', 'list')
    if (left.some((p) => p.id === project.id)) await ctx.chrome.invoke('projects', 'remove', project.id)
    const trashed = await ctx.chrome.invoke<TrashItem[]>('trash', 'list', { kind: 'project' })
    const mine = trashed.filter((i) => i.title === project.name).map((i) => i.id)
    if (mine.length > 0) await ctx.chrome.invoke('trash', 'purge', mine)
  }
}

async function waitIndexed(ctx: SmokeContext, query: string, timeout = 10_000): Promise<SearchHit[]> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const { hits } = await ctx.chrome.invoke<{ hits: SearchHit[]; total: number }>('search', 'query', query)
    if (hits.length > 0) return hits
    await new Promise((r) => setTimeout(r, 150))
  }
  return []
}

export const checks: SmokeCheck[] = [
  {
    name: 'workspace-folder-confinement',
    async run(ctx) {
      await withFolder(ctx, async (folder) => {
        const entries = await ctx.chrome.invoke<Array<{ name: string }>>('folders', 'entries', folder.id, '')
        assert(entries.some((e) => e.name === 'notes.md') && entries.some((e) => e.name === 'quotes'), 'the shared folder lists its files')
        const text = await ctx.chrome.invoke<string>('folders', 'readText', folder.id, 'quotes/tiles.txt')
        assert(text.includes('terracotta'), 'a file inside the grant reads')
        await rejects(() => ctx.chrome.invoke('folders', 'readText', folder.id, '../outside/secret.txt'), 'a .. escape')
        await rejects(() => ctx.chrome.invoke('folders', 'readText', folder.id, 'escape/secret.txt'), 'a symlink escape')
      })
    },
  },
  {
    name: 'workspace-search-files',
    async run(ctx) {
      await withFolder(ctx, async () => {
        const hits = await waitIndexed(ctx, 'terracotta')
        assert(hits.some((h) => h.source === 'files' && h.ref?.kind === 'folder'), 'a shared folder file is found by its text')
        const state = await ctx.chrome.invoke<{ building: boolean; total: number }>('search', 'state')
        assert(typeof state.building === 'boolean', 'the index reports its state')
      })
      const after = await ctx.chrome.invoke<{ hits: SearchHit[] }>('search', 'query', 'terracotta')
      assert(!after.hits.some((h) => h.source === 'files' && h.ref?.kind === 'folder'), 'a revoked folder leaves the index')
    },
  },
  {
    name: 'workspace-projects-trash',
    async run(ctx) {
      await withProject(ctx, async (project) => {
        const listed = await ctx.chrome.invoke<Project[]>('projects', 'list')
        assert(listed.some((p) => p.id === project.id && p.color === 'fern'), 'a new project is listed with its colour')
        const spaces = await ctx.chrome.invoke<SpaceInfo[]>('spaces', 'list')
        assert(spaces.length >= 2 && spaces[0]?.projectId === null, 'a project adds a space after "No project"')
        await ctx.chrome.invoke('projects', 'remove', project.id)
        const trashed = await ctx.chrome.invoke<TrashItem[]>('trash', 'list', { kind: 'project' })
        const item = trashed.find((i) => i.title === project.name)
        assert(item, 'a deleted project is in Recently deleted')
        const restored = await ctx.chrome.invoke<{ restored: number }>('trash', 'restore', [item.id])
        assert(restored.restored === 1, 'it restores')
        const back = await ctx.chrome.invoke<Project[]>('projects', 'list')
        assert(back.some((p) => p.name === project.name), 'the restored project is listed again')
      })
    },
  },
  {
    // The Space row's switcher is the overlay surface (not a native menu), and a pick switches.
    name: 'workspace-space-switcher',
    async run(ctx) {
      await withProject(ctx, async (project) => {
        try {
          await ctx.chrome.until(`return document.querySelector('.space-row')`, 8000, 'the Space row')
          await ctx.chrome.js(`document.querySelector('.space-row').click(); return true`)
          const menu = await docWith(ctx.chrome, '.space-switcher [role="menu"]', 8000, 'the space switcher')
          assert(menu.ui !== ctx.chrome.ui, 'the switcher is drawn in the overlay')
          const rows = await menu.js<string[]>(`return [...document.querySelectorAll('.space-switcher [role^="menuitem"]')].map((r) => r.textContent || '')`)
          assert(rows.some((r) => r.includes(project.name)) && rows.length >= 3, 'every space is a row, then New project…')
          await menu.js(`[...document.querySelectorAll('.space-switcher [role^="menuitem"]')].find((r) => (r.textContent || '').includes(${JSON.stringify(project.name)})).click(); return true`)
          await waitFor(async () => (await ctx.chrome.invoke<SpaceInfo[]>('spaces', 'list')).some((s) => s.projectId === project.id && s.active), 8000, 'the switch to the project space')
        } finally {
          await ctx.chrome.invoke('spaces', 'switchTo', null).catch(() => undefined)
        }
      })
    },
  },
  {
    name: 'workspace-hub-sections',
    async run(ctx) {
      // Four tabs; Tables shows under Files; Search and Recently deleted under none.
      const under: Record<string, string | null> = { home: 'home', projects: 'projects', files: 'files', apps: 'apps', tables: 'files', search: null, trash: null }
      let first = true
      for (const [section, tab] of Object.entries(under)) {
        ctx.tabs.openInternal(`atelier://workspace/${section}`)
        // The hub is a destination: it shows on the rail, over the active tab (whose own page stays mounted behind).
        const seen = `const page = document.querySelector('.pane--rail .ws-page')
           const tabs = page ? [...page.querySelectorAll('.ws-tabsrow [role="tab"]')] : []
           const selected = tabs.filter((el) => el.getAttribute('aria-selected') === 'true').map((el) => el.id)`
        // The first section also loads the hub's code, after the new tab the check before made (a busy chrome on a slow machine).
        await ctx.chrome.until(`${seen}
           return (tabs.length === 4 && page.matches('[data-section="${section}"]') && page.querySelector('.ws-card__head') && JSON.stringify(selected) === ${JSON.stringify(JSON.stringify(tab ? [`ws-tabs-tab-${tab}`] : []))}) || null`, first ? 20_000 : 8000, `the ${section} section under ${tab ?? 'no tab'}`).catch(async (err: unknown) => {
          const got = await ctx.chrome.js<unknown>(`${seen}
           return { section: page && page.getAttribute('data-section'), tabs: tabs.length, selected, head: !!(page && page.querySelector('.ws-card__head')), pages: [...document.querySelectorAll('.ws-page')].map((p) => p.getAttribute('data-section') + (p.closest('.pane--rail') ? ' (rail)' : '')), text: page ? (page.querySelector('.ws-main')?.textContent || '').trim().slice(0, 120) : null }`).catch(() => null)
          throw new Error(`${err instanceof Error ? err.message : String(err)} (rail ${ctx.tabs.rail() ?? 'none'}; saw ${JSON.stringify(got)})`)
        })
        first = false
      }
      // The search field above the tabs: Enter shows the results.
      // The field of the Home section on the rail: the section before it (Recently deleted) has a field too, and a
      // section change empties it, so typing there before Home shows (a slow machine) would search for nothing.
      ctx.tabs.openInternal('atelier://workspace')
      const field = `document.querySelector('.pane--rail .ws-page[data-section="home"] .ws-top .ws-search input')`
      await ctx.chrome.until(`return ${field} || null`, 8000, 'the hub search field')
      await ctx.chrome.js(`const input = ${field}
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'worktop')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true`)
      await ctx.chrome.until(`return ${field}?.value === 'worktop' || null`, 3000, 'the hub field to hold the words')
      await ctx.chrome.js(`${field}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true`)
      await waitFor(() => ctx.tabs.rail()?.startsWith('atelier://workspace/search?q=worktop') === true, 8000, 'the search view from the hub field')
      // An old Timeline address goes to History's timeline.
      ctx.tabs.openInternal('atelier://workspace/timeline?scope=week')
      await waitFor(() => ctx.tabs.all().some((t) => t.internalUrl?.startsWith('atelier://history?view=timeline&scope=week') === true), 8000, 'the old Timeline address to open History')
      for (const t of ctx.tabs.all()) if (t.internalUrl?.startsWith('atelier://history')) ctx.tabs.close(t.id)
      ctx.tabs.leaveRail()
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'workspace-home',
    async run(ctx) {
      await withProject(ctx, async () => {
        ctx.tabs.openInternal('atelier://workspace')
        await ctx.chrome.until(`return document.querySelector('.ws-home .ws-tile')`, 8000, 'the hub home')
        await ctx.shot('workspace-home')
      })
    },
  },
  {
    name: 'workspace-projects',
    async run(ctx) {
      await withProject(ctx, async (project) => {
        ctx.tabs.openInternal('atelier://workspace/projects')
        await ctx.chrome.until(`return document.querySelector('.ws-table tbody tr')`, 8000, 'the project list')
        await ctx.shot('workspace-projects')
        ctx.tabs.openInternal(`atelier://workspace/projects/${project.id}`)
        await ctx.chrome.until(`return document.querySelector('.ws-project__instructions')`, 8000, 'a project page')
        await ctx.shot('workspace-project')
        await ctx.chrome.js(`document.querySelector('.space-row')?.click(); return true`)
        const menu = await docWith(ctx.chrome, '.space-switcher [role="menu"]', 8000, 'the space switcher')
        await new Promise((r) => setTimeout(r, 200))
        await ctx.shot('space-row')
        await menu.escape()
      })
    },
  },
  {
    name: 'workspace-files',
    async run(ctx) {
      await withFolder(ctx, async (folder) => {
        ctx.tabs.openInternal('atelier://workspace/files')
        await ctx.chrome.until(`return document.querySelector('.ws-table tbody tr')`, 8000, 'the shared folders')
        await ctx.shot('workspace-files')
        ctx.tabs.openInternal(`atelier://workspace/files/${folder.id}`)
        await ctx.chrome.until(`return document.querySelector('.ws-crumbs') && document.querySelector('.ws-table tbody tr')`, 8000, 'a shared folder')
        await ctx.shot('workspace-folder')
      })
    },
  },
  {
    name: 'workspace-search',
    async run(ctx) {
      await withFolder(ctx, async () => {
        await waitIndexed(ctx, 'worktop')
        ctx.tabs.openInternal('atelier://workspace/search?q=worktop')
        await ctx.chrome.until(`return document.querySelector('.ws-hit mark')`, 8000, 'search results with the match marked')
        await ctx.shot('workspace-search')
      })
    },
  },
  {
    name: 'workspace-trash',
    async run(ctx) {
      await withProject(ctx, async (project) => {
        await ctx.chrome.invoke('projects', 'remove', project.id)
        ctx.tabs.openInternal('atelier://workspace/trash')
        await ctx.chrome.until(`return document.querySelector('.ws-table tbody tr')`, 8000, 'Recently deleted')
        await ctx.shot('workspace-trash')
      })
    },
  },
]

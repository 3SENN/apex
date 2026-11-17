/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadDanger } from '@shared/downloads'
import { DownloadManager, downloadOrigin, heldFileName, type DownloadDeps, type DownloadStartedEvent } from '../src/main/downloads'

// The download manager against a fake session and fake download items:
// danger holds with Keep and Discard, ask-where-to-save, the auto-open event,
// agent attribution and the folder fallback. No Electron, no network.

class FakeItem extends EventEmitter {
  savePath = ''
  received = 0
  paused = false
  cancelled = false
  constructor(
    readonly name: string,
    readonly total: number,
    readonly url = `https://files.example.com/${name}`,
  ) {
    super()
  }
  getFilename(): string {
    return this.name
  }
  getURL(): string {
    return this.url
  }
  getMimeType(): string {
    return 'application/octet-stream'
  }
  getTotalBytes(): number {
    return this.total
  }
  getReceivedBytes(): number {
    return this.received
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
  isPaused(): boolean {
    return this.paused
  }
  canResume(): boolean {
    return false
  }
  resume(): void {}
  cancel(): void {
    this.cancelled = true
    this.emit('done', {}, 'cancelled')
  }
  /** Writes the bytes where Electron would, then finishes. */
  finish(): void {
    this.received = this.total
    writeFileSync(this.savePath, Buffer.alloc(this.total, 1))
    this.emit('done', {}, 'completed')
  }
  progress(bytes: number): void {
    this.received = bytes
    this.emit('updated', {}, 'progressing')
  }
}

class FakeSession extends EventEmitter {
  downloadURL = vi.fn()
  start(item: FakeItem, source: unknown = null): void {
    this.emit('will-download', {}, item, source)
  }
}

interface Setup {
  manager: DownloadManager
  session: FakeSession
  dir: string
  events: DownloadStartedEvent[]
  changes: { type: string; error?: string | null; path?: string | null }[]
  notices: unknown[]
  deps: Partial<DownloadDeps>
}

function setup(patch: Partial<DownloadDeps> = {}, prefs: { downloadDir: string | null; askWhereToSave: boolean } = { downloadDir: null, askWhereToSave: false }): Setup {
  const root = mkdtempSync(join(tmpdir(), 'atelier-dl-'))
  const dir = join(root, 'Downloads')
  mkdirSync(dir)
  const session = new FakeSession()
  const events: DownloadStartedEvent[] = []
  const notices: unknown[] = []
  let clock = 1000
  const deps: Partial<DownloadDeps> = {
    prefs: () => prefs,
    setFolder: (downloadDir) => {
      prefs.downloadDir = downloadDir
    },
    origin: () => ({ tabId: 't1', byAgent: false, windowId: 1 }),
    classify: () => 'none',
    broadcast: (event) => events.push(event),
    notify: (spec) => notices.push(spec),
    appFocused: () => true,
    saveDialog: async () => null,
    folderDialog: async () => null,
    dragOut: async () => undefined,
    openPath: async () => '',
    reveal: () => undefined,
    now: () => (clock += 500),
    ...patch,
  }
  const manager = new DownloadManager(session as unknown as Session, join(root, 'data'), dir, deps)
  const changes: Setup['changes'] = []
  manager.on('stateChange', (c) => changes.push(c as Setup['changes'][number]))
  return { manager, session, dir, events, changes, notices, deps }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('download manager', () => {
  it('saves to the folder, measures speed and opens the popover for a small file', async () => {
    const { manager, session, dir, events, changes } = setup()
    const item = new FakeItem('report.pdf', 4000)
    session.start(item)
    expect(item.savePath).toBe(join(dir, 'report.pdf'))
    expect(events).toEqual([{ type: 'download-started', id: manager.list()[0]!.id, byAgent: false, autoOpen: true }])
    item.progress(1000)
    item.progress(2000)
    const running = manager.list()[0]!
    expect(running.speedBps).toBeGreaterThan(0)
    expect(running.etaSeconds).not.toBeNull()
    expect(running.tabId).toBe('t1')
    item.finish()
    await flush()
    expect(manager.list()[0]).toMatchObject({ state: 'completed', speedBps: 0, etaSeconds: null })
    expect(changes.map((c) => c.type)).toEqual(['download_started', 'download_completed'])
  })

  it('does not open the popover for agent downloads, and never asks where to save them', async () => {
    const saveDialog = vi.fn(async () => '/elsewhere/x.pdf')
    const { manager, session, dir, events } = setup({ origin: () => ({ tabId: 't2', byAgent: true, windowId: 1 }), saveDialog }, { downloadDir: null, askWhereToSave: true })
    const item = new FakeItem('agent.pdf', 10)
    session.start(item)
    expect(saveDialog).not.toHaveBeenCalled()
    expect(item.savePath).toBe(join(dir, 'agent.pdf'))
    expect(events[0]).toMatchObject({ byAgent: true, autoOpen: false })
    expect(manager.list()[0]!.byAgent).toBe(true)
  })

  it('holds a flagged file until Keep, then moves it into place', async () => {
    const { manager, session, dir, events, changes } = setup({ classify: (): DownloadDanger => 'dangerous' })
    const item = new FakeItem('tool.exe', 50_000_000)
    session.start(item)
    const id = manager.list()[0]!.id
    expect(item.savePath).toBe(join(dir, heldFileName('tool.exe', id)))
    expect(events[0]!.autoOpen).toBe(true)
    item.finish()
    await flush()
    expect(manager.list()[0]).toMatchObject({ state: 'completed', danger: 'dangerous' })
    expect(existsSync(join(dir, 'tool.exe'))).toBe(false)
    await expect(manager.open(id)).rejects.toThrow(/Keep or discard/)
    expect(changes.at(-1)).toMatchObject({ type: 'download_failed' })
    await manager.keep(id)
    expect(existsSync(join(dir, 'tool.exe'))).toBe(true)
    expect(existsSync(item.savePath)).toBe(false)
    expect(manager.list()[0]!.danger).toBe('none')
    expect(changes.at(-1)).toMatchObject({ type: 'download_completed', path: join(dir, 'tool.exe') })
  })

  it('discards a flagged file: the held bytes go and the row leaves the list', async () => {
    const { manager, session } = setup({ classify: (): DownloadDanger => 'uncommon' })
    const item = new FakeItem('odd.bin', 100)
    session.start(item)
    const id = manager.list()[0]!.id
    item.finish()
    await flush()
    const held = item.savePath
    expect(existsSync(held)).toBe(true)
    await manager.discard(id)
    expect(existsSync(held)).toBe(false)
    expect(manager.list()).toEqual([])
  })

  it('discarding a running flagged download cancels it and cleans up', async () => {
    const { manager, session } = setup({ classify: (): DownloadDanger => 'dangerous' })
    const item = new FakeItem('run.exe', 100)
    session.start(item)
    writeFileSync(item.savePath, 'partial')
    await manager.discard(manager.list()[0]!.id)
    await flush()
    expect(item.cancelled).toBe(true)
    expect(existsSync(item.savePath)).toBe(false)
  })

  it('keeping a flagged file while it runs moves it into place when it finishes', async () => {
    const { manager, session, dir } = setup({ classify: (): DownloadDanger => 'uncommon' })
    const item = new FakeItem('later.bin', 100)
    session.start(item)
    await manager.keep(manager.list()[0]!.id)
    item.finish()
    // The row is done when the item is; the file moves into place just after (slower on a busy Windows disk).
    await vi.waitFor(() => expect(existsSync(join(dir, 'later.bin'))).toBe(true))
  })

  it('asks where to save, keeps the row hidden until then, and opens the popover after', async () => {
    let answer: (path: string | null) => void = () => undefined
    const saveDialog = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)))
    const { manager, session, dir, events } = setup({ saveDialog }, { downloadDir: null, askWhereToSave: true })
    const item = new FakeItem('big.zip', 90_000_000)
    session.start(item)
    expect(saveDialog).toHaveBeenCalledWith(1, join(dir, 'big.zip'))
    expect(manager.list()).toEqual([])
    item.finish()
    await flush()
    const target = join(dir, 'picked.zip')
    answer(target)
    await flush()
    expect(manager.list()[0]).toMatchObject({ filename: 'picked.zip', path: target, state: 'completed' })
    await vi.waitFor(() => expect(existsSync(target)).toBe(true))
    // Large, but you chose where to save it.
    expect(events[0]).toMatchObject({ autoOpen: true })
  })

  it('cancels the download when the save dialog is dismissed', async () => {
    const { manager, session, events } = setup({ saveDialog: async () => null }, { downloadDir: null, askWhereToSave: true })
    const item = new FakeItem('nope.zip', 10)
    session.start(item)
    await flush()
    expect(item.cancelled).toBe(true)
    expect(manager.list()).toEqual([])
    expect(events).toEqual([])
  })

  it('falls back to the default folder when the chosen one is missing', () => {
    const prefs = { downloadDir: '/definitely/not/here', askWhereToSave: false }
    const { manager, session, dir } = setup({}, prefs)
    expect(manager.folder()).toEqual({ path: dir, defaultPath: dir, custom: true, missing: true })
    const item = new FakeItem('a.txt', 1)
    session.start(item)
    expect(item.savePath).toBe(join(dir, 'a.txt'))
  })

  it('uses a chosen folder that exists, and picks a free name there', () => {
    const chosen = mkdtempSync(join(tmpdir(), 'atelier-dl-chosen-'))
    writeFileSync(join(chosen, 'a.txt'), 'x')
    const { manager, session } = setup({}, { downloadDir: chosen, askWhereToSave: false })
    expect(manager.folder()).toMatchObject({ path: chosen, custom: true, missing: false })
    const item = new FakeItem('a.txt', 1)
    session.start(item)
    expect(item.savePath).toBe(join(chosen, 'a (1).txt'))
  })

  it('changes and resets the folder through settings', async () => {
    const prefs = { downloadDir: null as string | null, askWhereToSave: false }
    const { manager } = setup({ folderDialog: async () => '/Users/me/Inbox' }, prefs)
    expect(await manager.chooseFolder()).toBe('/Users/me/Inbox')
    expect(prefs.downloadDir).toBe('/Users/me/Inbox')
    manager.resetFolder()
    expect(prefs.downloadDir).toBeNull()
  })

  it('clears finished rows but keeps running ones and those awaiting a decision', async () => {
    let danger: DownloadDanger = 'none'
    const { manager, session } = setup({ classify: () => danger })
    const done = new FakeItem('done.txt', 1)
    session.start(done)
    done.finish()
    session.start(new FakeItem('running.txt', 10))
    danger = 'dangerous'
    session.start(new FakeItem('flagged.exe', 10))
    await flush()
    manager.clear()
    expect(manager.list().map((d) => d.filename).sort()).toEqual(['flagged.exe', 'running.txt'])
  })

  it('retries a cancelled download by starting it again', async () => {
    const { manager, session } = setup()
    const item = new FakeItem('again.txt', 10)
    session.start(item)
    const id = manager.list()[0]!.id
    manager.cancel(id)
    await flush()
    expect(manager.list()[0]!.state).toBe('cancelled')
    manager.retry(id)
    expect(session.downloadURL).toHaveBeenCalledWith(item.url)
    expect(manager.list()).toEqual([])
  })

  it('notifies about a finished download only when Atelier is not in front', async () => {
    const focused = setup({ appFocused: () => true })
    const a = new FakeItem('a.txt', 1)
    focused.session.start(a)
    a.finish()
    await flush()
    expect(focused.notices).toEqual([])
    const away = setup({ appFocused: () => false })
    const b = new FakeItem('b.txt', 1)
    away.session.start(b)
    b.finish()
    await flush()
    expect(away.notices).toEqual([expect.objectContaining({ category: 'downloads', body: 'b.txt' })])
  })

  it('reloads a saved list: running rows become failed, held files stay reviewable', async () => {
    const { manager, session, dir } = setup({ classify: (): DownloadDanger => 'uncommon' })
    const item = new FakeItem('keepme.bin', 5)
    session.start(item)
    item.finish()
    await flush()
    const running = new FakeItem('cut.bin', 5)
    session.start(running)
    const dataDir = join(dir, '..', 'data')
    const saved = JSON.parse(readFileSync(join(dataDir, 'downloads.json'), 'utf8')) as unknown[]
    expect(saved).toHaveLength(1)
    // Clearing saves again, now with the running row (neither row is clearable).
    manager.clear()
    const again = new DownloadManager(new FakeSession() as unknown as Session, dataDir, dir, { prefs: () => ({ downloadDir: null, askWhereToSave: false }), appFocused: () => true })
    expect(again.list().find((d) => d.filename === 'keepme.bin')).toMatchObject({ state: 'completed', danger: 'uncommon' })
    expect(again.list().find((d) => d.filename === 'cut.bin')).toMatchObject({ state: 'interrupted', speedBps: 0 })
    await again.keep(again.list().find((d) => d.filename === 'keepme.bin')!.id)
    expect(existsSync(join(dir, 'keepme.bin'))).toBe(true)
  })

  it('tracks a private session without saving its rows', async () => {
    const { manager, dir } = setup()
    const privateSession = new FakeSession()
    manager.attach(privateSession as unknown as Session, true)
    manager.attach(privateSession as unknown as Session, true)
    const item = new FakeItem('secret.txt', 1)
    privateSession.start(item)
    expect(manager.list()).toHaveLength(1)
    item.finish()
    await flush()
    const saved = JSON.parse(readFileSync(join(dir, '..', 'data', 'downloads.json'), 'utf8')) as unknown[]
    expect(saved).toEqual([])
  })

  it('refuses to open or drag a file that is not finished or no longer there', async () => {
    const dragOut = vi.fn(async () => undefined)
    const { manager, session, dir } = setup({ dragOut })
    const item = new FakeItem('gone.txt', 1)
    session.start(item)
    const id = manager.list()[0]!.id
    await expect(manager.startDrag(id)).rejects.toThrow(/hasn’t finished/)
    item.finish()
    await flush()
    await manager.startDrag(id)
    expect(dragOut).toHaveBeenCalledWith(join(dir, 'gone.txt'))
    const { unlinkSync } = await import('node:fs')
    unlinkSync(join(dir, 'gone.txt'))
    await expect(manager.open(id)).rejects.toThrow(/no longer where/)
  })
})

describe('download origin', () => {
  const tab = (agentControlled: boolean, agentChatId: string | null) => ({ id: 't9', agentControlled, agentChatId })
  const ctx = (t: ReturnType<typeof tab> | undefined, running: boolean) =>
    ({
      tabsRegistry: { byWebContents: () => t },
      windows: { fromWebContents: () => ({ id: 3 }) },
      agent: { isRunning: () => running },
    }) as unknown as Parameters<typeof downloadOrigin>[0]
  const source = { id: 5, isDestroyed: () => false } as unknown as WebContents

  it('names the tab and window', () => {
    expect(downloadOrigin(ctx(tab(false, null), false), source)).toEqual({ tabId: 't9', byAgent: false, windowId: 3 })
  })
  it('counts a download as the agent’s only while its chat runs in that tab', () => {
    expect(downloadOrigin(ctx(tab(true, 'c1'), true), source).byAgent).toBe(true)
    expect(downloadOrigin(ctx(tab(true, 'c1'), false), source).byAgent).toBe(false)
    expect(downloadOrigin(ctx(tab(true, null), false), source).byAgent).toBe(true)
  })
  it('has no origin without a source page', () => {
    expect(downloadOrigin(ctx(undefined, false), null)).toEqual({ tabId: null, byAgent: false, windowId: null })
  })
})

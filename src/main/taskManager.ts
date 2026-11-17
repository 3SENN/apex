/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { app, webContents as allWebContents } from 'electron'
import type { TaskKind, TaskRow } from '@shared/dialogs'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'

// The task manager: every Apex process with its memory and CPU, by
// what it serves: the browser itself, the GPU, each window's chrome and
// overlay views, and each tab. Only a tab can be ended; the crash page
// then offers a reload. The rows are built by a pure function so the
// grouping is tested.

export interface ProcessSample {
  pid: number
  type: string
  name?: string
  serviceName?: string
  cpuPercent: number
  /** Kilobytes, as Electron reports workingSetSize. */
  memoryKb: number
}

export interface ViewSample {
  id: string
  kind: TaskKind
  title: string
  icon: string | null
  pid: number
  canEnd: boolean
}

const ORDER: Record<TaskKind, number> = { browser: 0, gpu: 1, chrome: 2, overlay: 3, tab: 4, view: 5, utility: 6 }

/** One row per view (several views can share a process), plus the processes no view claims. */
export function buildRows(processes: readonly ProcessSample[], views: readonly ViewSample[]): TaskRow[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const claimed = new Set<number>()
  const rows: TaskRow[] = []
  for (const v of views) {
    const p = byPid.get(v.pid)
    if (!p) continue
    claimed.add(v.pid)
    rows.push({ id: v.id, kind: v.kind, title: v.title, icon: v.icon, pid: v.pid, memoryBytes: p.memoryKb * 1024, cpuPercent: round(p.cpuPercent), canEnd: v.canEnd })
  }
  for (const p of processes) {
    if (claimed.has(p.pid)) continue
    const kind: TaskKind = p.type === 'Browser' ? 'browser' : p.type === 'GPU' ? 'gpu' : p.type === 'Tab' ? 'view' : 'utility'
    const title =
      kind === 'browser' ? mainT('menus.taskManager.browser') : kind === 'gpu' ? mainT('menus.taskManager.gpu') : kind === 'view' ? mainT('menus.taskManager.otherView') : p.serviceName || p.name || mainT('menus.taskManager.utility')
    rows.push({ id: kind === 'browser' || kind === 'gpu' ? kind : `pid:${p.pid}`, kind, title, icon: null, pid: p.pid, memoryBytes: p.memoryKb * 1024, cpuPercent: round(p.cpuPercent), canEnd: false })
  }
  return rows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.memoryBytes - a.memoryBytes)
}

function round(n: number): number {
  return Math.round(Math.max(0, n) * 10) / 10
}

function pidOf(wc: Electron.WebContents): number {
  try {
    return wc.isDestroyed() ? 0 : wc.getOSProcessId()
  } catch {
    return 0
  }
}

/** The views of every window, named. */
function viewSamples(windows: readonly WindowContext[]): ViewSample[] {
  const out: ViewSample[] = []
  const seen = new Set<number>()
  for (const win of windows) {
    if (win.window.isDestroyed()) continue
    const name = win.window.getTitle() || BRAND_NAME
    out.push({ id: `chrome:${win.id}`, kind: 'chrome', title: mainT('menus.taskManager.chrome', { name }), icon: null, pid: pidOf(win.chrome), canEnd: false })
    seen.add(win.chrome.id)
    for (const tab of win.tabs.all()) {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) continue
      seen.add(wc.id)
      const internal = win.tabs.isChromeDrawn(tab)
      out.push({
        id: `tab:${tab.id}`,
        kind: 'tab',
        title: mainT('menus.taskManager.tab', { title: win.tabs.info(tab).title || wc.getURL() }),
        icon: tab.favicon,
        pid: pidOf(wc),
        // An apex:// page is drawn by the chrome; its hidden view has nothing to end.
        canEnd: !internal && !wc.isCrashed(),
      })
    }
  }
  for (const wc of allWebContents.getAllWebContents()) {
    if (seen.has(wc.id) || wc.isDestroyed()) continue
    const win = windows.find((w) => w.overlay.ownsWebContents(wc.id))
    if (win) out.push({ id: `overlay:${wc.id}`, kind: 'overlay', title: mainT('menus.taskManager.overlay'), icon: null, pid: pidOf(wc), canEnd: false })
  }
  return out
}

export function listTasks(windows: readonly WindowContext[]): TaskRow[] {
  const processes: ProcessSample[] = app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    ...(m.name ? { name: m.name } : {}),
    ...(m.serviceName ? { serviceName: m.serviceName } : {}),
    cpuPercent: m.cpu.percentCPUUsage,
    memoryKb: m.memory.workingSetSize,
  }))
  return buildRows(processes, viewSamples(windows))
}

/** Ends a tab's renderer (End process); anything else is refused. */
export function endTask(windows: readonly WindowContext[], id: string): void {
  const match = /^tab:(.+)$/.exec(id)
  if (!match) throw new Error('Only a tab’s process can be ended.')
  for (const win of windows) {
    const tab = win.tabs.find(match[1] ?? '')
    if (!tab) continue
    const wc = tab.view.webContents
    if (!wc.isDestroyed() && !win.tabs.isChromeDrawn(tab)) wc.forcefullyCrashRenderer()
    return
  }
}

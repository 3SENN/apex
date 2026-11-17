/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UI } from '@shared/ipc'
import { registerMenuContribution } from '@shared/menuModel'
import type { CommandId } from '@shared/shortcuts'
import type { Settings } from '@shared/ipc'
import type { CommandRun } from '../commands'
import { bootDiagnostics } from '../diagnostics/boot'
import { captureAgentErrors, captureChromeConsole, captureRoutineOutcomes } from '../diagnostics/capture'
import { helpMenuItems, setHelpMenuRunner } from '../diagnostics/menu'
import { setupDiagnostics } from '../diagnostics/service'
import type { Feature, WindowContext } from './types'

// The diagnostics feature module: logs, crash reports, the problem report and feedback.
// The Help items go to the native Help menu and the main menu's Help
// submenu, beside the other features' Help contributions; their commands are
// registered here.
let unregister: Array<() => void> = []
let disposeRuntime: (() => void) | null = null

export const diagnosticsFeature: Feature = {
  name: 'diagnostics',
  app(ctx) {
    // early.ts already booted with the real userData; a smoke run boots here, on its temp folder.
    bootDiagnostics(ctx.dataDir)
    const runtime = setupDiagnostics({
      settings: ctx.settings,
      tabs: ctx.tabsRegistry,
      agent: ctx.agent,
      chats: ctx.maintenance.chats,
      windows: ctx.windows,
      broadcast: (event) => ctx.broadcast(event),
      // Read when a report is saved: the migrations feature fills the slot after this one.
      migrations: () => ctx.maintenance.migrations.report(),
    })
    disposeRuntime = runtime.dispose
    const { diagnostics } = runtime.services

    const onSettings = (next: Settings, previous: Settings): void => {
      if (next.crashReports !== previous.crashReports) runtime.onCrashSetting(next.crashReports)
    }
    ctx.settings.on('changed', onSettings)

    const target = (win: WindowContext | null): WindowContext | null => win ?? ctx.windows.focused() ?? ctx.windows.all()[0] ?? null
    const register = (id: CommandId, run: CommandRun): (() => void) => (ctx.commands.has(id) ? () => undefined : ctx.commands.register(id, run))

    unregister = [
      registerMenuContribution({ id: 'diagnostics:help', target: 'help', build: () => helpMenuItems() }),
      registerMenuContribution({ id: 'diagnostics:main-menu-help', target: 'main-menu:help', build: () => helpMenuItems() }),
      // ⇧⌘H: the chrome of that window opens the dialog over itself.
      register('report-problem', (win) => {
        const w = target(win)
        if (!w || w.chrome.isDestroyed()) return
        if (w.window.isMinimized()) w.window.restore()
        w.window.focus()
        w.chrome.focus()
        w.chrome.send(UI.command, 'report-problem')
      }),
      // The outcome reaches the window as a 'feedback-draft' event, for its toast.
      register('send-feedback', () => Promise.resolve(diagnostics.sendFeedback()).catch(() => undefined)),
      register('show-logs', (win) => target(win)?.tabs.openInternal('atelier://logs', { newTab: true })),
      () => ctx.settings.off('changed', onSettings),
      // Outcomes as kinds only: agent error codes and routine run results.
      captureAgentErrors(ctx.agent),
      ...(ctx.skillRoutines ? [captureRoutineOutcomes(ctx.skillRoutines.routines)] : []),
    ]
    setHelpMenuRunner((id) => void ctx.commands.run(id, ctx.windows.focused()))

    return runtime.services
  },
  window(win) {
    captureChromeConsole(win.chrome)
  },
  dispose() {
    for (const off of unregister) off()
    unregister = []
    setHelpMenuRunner(null)
    disposeRuntime?.()
    disposeRuntime = null
  },
}

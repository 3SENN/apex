/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Services } from '@shared/services'
import { dialogResultSchema, dialogs, openTracked, areaOf, toasts } from './dialogs'
import type { AppContext, WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { watchUnload } from './leavePage'
import { log } from './log'
import { createPageActions, openQrCard, pageToolsMenu } from './pageActions'
import { installPageDialogs, watchTab } from './pageDialogs'
import { registerPageMenuSection } from './pageMenu'
import { shortcuts } from './shortcuts'
import { installSignIn } from './signIn'
import type { Tab } from './tabs'
import { endTask, listTasks } from './taskManager'
import { loadSource } from './viewSource'
import type { CommandId } from '@shared/shortcuts'
import type { CommandOptions, CommandRun } from './commands'

// The dialogs wiring (dialogs, toasts, page actions and tools), called from
// the menus feature: app-wide handlers once, services per window, and the
// per-tab page dialog and Leave this page? hooks.

type PageActions = Services['pageActions']

const actionsByWindow = new Map<number, PageActions>()
let appContext: AppContext | null = null

function actionsFor(win: WindowContext): PageActions {
  let actions = actionsByWindow.get(win.id)
  if (!actions) {
    actions = createPageActions(win)
    actionsByWindow.set(win.id, actions)
    win.window.once('closed', () => actionsByWindow.delete(win.id))
  }
  return actions
}

function hasWebTab(win: WindowContext | null): boolean {
  const tab = win?.tabs.active()
  return !!tab && !win?.tabs.isChromeDrawn(tab) && !tab.view.webContents.isDestroyed() && /^https?:/i.test(tab.view.webContents.getURL())
}

function openTaskManager(win: WindowContext): void {
  const area = areaOf(win, null)
  openTracked(win, 'task-manager', { kind: 'window', rect: area }, { area }, null).result.catch((err: unknown) => {
    log.warn('dialogs', 'The task manager could not open', { error: err instanceof Error ? err.message : String(err) })
    void toasts.show(win, { kind: 'error', text: mainT('menus.taskManager.unavailable') })
  })
}

type L5bServices = Pick<Services, 'pageActions' | 'dialogs' | 'toasts' | 'taskManager' | 'viewSource'>

const METHODS: { [K in keyof L5bServices]: (keyof L5bServices[K])[] } = {
  pageActions: ['copyUrl', 'copyMarkdownLink', 'copyAsMarkdown', 'screenshotToClipboard', 'copyLinkToHighlight', 'print', 'saveAsPdf', 'savePage', 'share', 'qrCode', 'viewSource', 'devtools', 'copyQrCode', 'saveQrCode'],
  dialogs: ['show', 'answer'],
  toasts: ['show', 'dismiss', 'outcome'],
  taskManager: ['list', 'end'],
  viewSource: ['load'],
}

const servicesByWindow = new Map<number, L5bServices>()

function servicesFor(win: WindowContext): L5bServices {
  let s = servicesByWindow.get(win.id)
  if (!s) {
    s = buildWindowServices(win)
    servicesByWindow.set(win.id, s)
    win.window.once('closed', () => servicesByWindow.delete(win.id))
  }
  return s
}

/** App-wide services that act on the focused window (window parts, routed by sender, take over from these). */
function focusedServices(ctx: AppContext): L5bServices {
  const out: Record<string, Record<string, (...args: unknown[]) => unknown>> = {}
  for (const [ns, names] of Object.entries(METHODS) as [keyof L5bServices, string[]][]) {
    out[ns] = Object.fromEntries(
      names.map((name) => [
        name,
        (...args: unknown[]) => {
          const win = ctx.windows.focused()
          if (!win) throw new Error('There is no window to act on.')
          return (servicesFor(win)[ns] as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args)
        },
      ]),
    )
  }
  return out as unknown as L5bServices
}

/** Once at start: the page dialog and sign-in handlers, the commands, ⇧Esc and the page menu section. Returns the app-wide services. */
export function setupDialogs(ctx: AppContext): L5bServices {
  appContext = ctx
  installPageDialogs(ctx)
  installSignIn(ctx)

  const windowOf = (win: WindowContext | null): WindowContext | null => win ?? ctx.windows.focused()
  const web: CommandOptions = { enabled: (win) => hasWebTab(windowOf(win)) }
  const onTab = (fn: (a: PageActions, win: WindowContext) => unknown): CommandRun => (win) => {
    const w = windowOf(win)
    if (w) void fn(actionsFor(w), w)
  }
  const commands: [CommandId, CommandRun, CommandOptions?][] = [
    ['copy-url', onTab((a) => a.copyUrl())],
    ['copy-markdown-link', onTab((a) => a.copyMarkdownLink())],
    ['print', onTab((a) => a.print()), web],
    ['save-as-pdf', onTab((a) => a.saveAsPdf()), web],
    ['save-page', onTab((a) => a.savePage()), web],
    ['share', onTab((a) => a.share()), web],
    ['view-source', onTab((a) => a.viewSource()), web],
    ['qr-code', onTab((a, w) => openQrCard(w, a)), web],
    ['devtools', onTab((a) => a.devtools('page'))],
    ['console', onTab((a) => a.devtools('console'))],
    ['task-manager', (win) => {
      const w = windowOf(win)
      if (w) openTaskManager(w)
    }],
  ]
  if (typeof ctx.commands?.register === 'function') {
    for (const [id, run, opts] of commands) {
      if (ctx.commands.has(id)) continue
      ctx.commands.register(id, run, opts)
    }
  }

  // ⇧Esc opens the task manager from the chrome, a page or an overlay.
  shortcuts.addInputInterceptor((input, _wc, win) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || !input.shift || input.control || input.meta || input.alt || input.isAutoRepeat) return 'pass'
    void ctx.commands.run('task-manager', win ?? ctx.windows.focused())
    return 'handled'
  })

  registerPageMenuSection({
    id: 'page-tools',
    order: 90,
    build: (params, tab, win) => pageToolsMenu(win, actionsFor(win), (tabId) => openQrCard(win, actionsFor(win), tabId))(params, tab),
  })
  return focusedServices(ctx)
}

/** For the dialogs smoke checks (smokeBrowser/menusDialogs.ts): the focused window, and its task manager and QR card. */
export const dialogsSmoke = {
  window: (): WindowContext | null => appContext?.windows.focused() ?? null,
  taskManager: (win: WindowContext): void => openTaskManager(win),
  qrCode: (win: WindowContext, tabId: string): void => openQrCard(win, actionsFor(win), tabId),
}

/** Per window: the services the chrome (and the overlay surfaces) call, made once per window. */
export function dialogsWindowServices(win: WindowContext): L5bServices {
  return servicesFor(win)
}

function buildWindowServices(win: WindowContext): L5bServices {
  // The task manager lists every window's processes.
  const windows = (): WindowContext[] => appContext?.windows.all() ?? [win]
  return {
    pageActions: actionsFor(win),
    dialogs: {
      show: (spec, tabId) => dialogs.open(win, spec, tabId ? { tabId } : {}, { fromChrome: true }).result,
      answer: (id, result) => dialogs.answer(win, id, dialogResultSchema.parse(result)),
    },
    toasts: {
      show: (toast) => toasts.showFromChrome(win, toast),
      dismiss: (id) => toasts.dismiss(win, id),
      outcome: (id, outcome) => toasts.outcome(id, outcome),
    },
    taskManager: {
      list: async () => listTasks(windows()),
      end: (id) => endTask(windows(), id),
    },
    viewSource: {
      load: (url) => loadSource(win.session, url),
    },
  }
}

/** Per tab: page dialogs, then Leave this page? (it reads the state the broker keeps). */
export function dialogsTab(tab: Tab, win: WindowContext): () => void {
  const offDialogs = watchTab(tab, win)
  const offUnload = watchUnload(tab, win)
  return () => {
    offUnload()
    offDialogs()
  }
}

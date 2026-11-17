/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, sep } from 'node:path'
import { BrowserWindow, app, dialog, shell, type OpenDialogOptions } from 'electron'
import {
  REPORT_FILES_MAX_BYTES,
  REPORT_MAX_BYTES,
  REPORT_MAX_FILES,
  type CrashState,
  type DiagnosticsEvent,
  type DiagnosticsServices,
  type PickedReportFile,
  type ReportDraft,
  type ReportEstimate,
  type ReportResult,
} from '@shared/diagnostics'
import type { MigrationReport } from '@shared/migrations'
import { RELEASE } from '@shared/release'
import type { AppEvent } from '@shared/services'
import type { AgentHost } from '../agent/host'
import type { ChatStore } from '../chats'
import { mainT } from '../i18n/mainT'
import { errorMessage, log } from '../log'
import type { SettingsStore } from '../settings'
import type { TabRegistry } from '../tabRegistry'
import type { WindowManager } from '../windows'
import { crashSession, startCrashReporter } from './boot'
import { crashStateOf, deleteDumps, listDumps } from './crash'
import { logger } from './logger'
import { cleanAddress, feedbackMail, reportMail } from './mail'
import { redactSecrets } from './redact'
import {
  REPORT_LOGS_MAX_BYTES,
  REPORT_SCHEMA,
  dataUrlBytes,
  decodeImage,
  estimateReport,
  reportEntries,
  reportFileName,
  reportLogs,
  settingsSummary,
  uniquePath,
  zipReport,
  type ReportJson,
} from './report'
import { collectSystemInfo, systemLine } from './systemInfo'

// The diagnostics service (OV-30):
// the log viewer's queries and live tail, file picking by token, the size
// estimate, saving the report bundle and its email draft, Send Feedback and
// the crash state. Nothing here sends anything anywhere: a report is a file
// in Downloads that you choose to attach.

export interface DiagnosticsDeps {
  settings: SettingsStore
  /** The TabRegistry (AppContext.tabsRegistry): the tab captured for a report's screenshot. */
  tabs: TabRegistry
  /** chat.md for a report (agent.markdown). */
  agent: AgentHost
  chats: ChatStore
  /** The WindowManager: the focused window the dialog opens in. */
  windows: WindowManager
  /** 'log' (while tailing), 'crash' and 'feedback-draft' events. */
  broadcast?(event: AppEvent): void
  /** The chat migration report for report.json; read when a report is saved (null when there is none). */
  migrations?(): MigrationReport | null
}

/** What the service does to the desktop; smoke swaps it so nothing opens. */
export interface DiagnosticsShell {
  showItemInFolder(path: string): void
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  downloads(): string
}

const realShell: DiagnosticsShell = {
  showItemInFolder: (path) => shell.showItemInFolder(path),
  openPath: (path) => shell.openPath(path),
  openExternal: (url) => shell.openExternal(url),
  downloads: () => app.getPath('downloads'),
}
let desktop: DiagnosticsShell = realShell

/** Smoke only: records instead of revealing files and opening drafts. Null restores the real shell. */
export function setDiagnosticsShell(fake: DiagnosticsShell | null): void {
  desktop = fake ?? realShell
}

// Picked files are remembered by token for the session; the renderer never sees paths.
const PICKED_MAX = 100
// A screenshot's size for the estimate is reused this long, not captured on every keystroke.
const SHOT_CACHE_MS = 20_000

export interface DiagnosticsRuntime {
  services: DiagnosticsServices
  /** The crashReports setting changed. */
  onCrashSetting(on: boolean): void
  dispose(): void
}

function crashDumpsDir(): string | null {
  try {
    return app.getPath('crashDumps')
  } catch {
    return null
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** The path as you'd say it: the home folder as ~. */
function friendlyPath(path: string): string {
  let home = ''
  try {
    home = app.getPath('home')
  } catch {
    home = ''
  }
  return home && (path === home || path.startsWith(home + sep)) ? `~${path.slice(home.length)}` : path
}

export function setupDiagnostics(deps: DiagnosticsDeps): DiagnosticsRuntime {
  const picked = new Map<string, { path: string; name: string; bytes: number }>()
  const shots = new Map<string, { bytes: number; at: number }>()
  let tailing = 0
  let dismissed = false
  let lastReport: { path: string; mailto: string } | null = null

  const emit = (event: DiagnosticsEvent): void => {
    try {
      deps.broadcast?.(event)
    } catch {
      // A window closing mid-send is not an error worth reporting.
    }
  }

  const offWrite = logger.onWrite((entry) => {
    if (tailing > 0) emit({ type: 'log', entry })
  })

  const engineKind = (): string => {
    try {
      return deps.settings.get().engine
    } catch {
      return 'api-key'
    }
  }
  const systemInfo = (): Record<string, string> => collectSystemInfo(engineKind())
  const crashState = (): CrashState => crashStateOf(crashSession(), listDumps(crashDumpsDir()), dismissed)

  const resolveFiles = (tokens: readonly string[]): Array<{ path: string; name: string; bytes: number }> =>
    tokens.map((token) => {
      const file = picked.get(token)
      if (!file) throw new Error(mainT('diagnostics.report.fileGone'))
      return file
    })

  const chatMarkdown = (chatId: string | null): string | null => {
    if (!chatId) return null
    try {
      const { title, text } = deps.agent.markdown(chatId)
      return redactSecrets(text.startsWith('#') ? text : `# ${title}\n\n${text}`)
    } catch {
      // An empty chat has nothing to export; the report says it isn't included.
      return null
    }
  }

  const capture = async (tabId: string | null): Promise<Uint8Array | null> => {
    if (!tabId) return null
    const tab = deps.tabs.get(tabId)
    const contents = tab?.view.webContents
    if (!contents || contents.isDestroyed()) return null
    try {
      const image = await contents.capturePage()
      if (image.isEmpty()) return null
      return new Uint8Array(image.toPNG())
    } catch (err) {
      log.warn('diagnostics', 'The tab screenshot failed', { error: errorMessage(err) })
      return null
    }
  }

  const screenshotSize = async (tabId: string | null): Promise<number> => {
    if (!tabId) return 0
    const cached = shots.get(tabId)
    if (cached && Date.now() - cached.at < SHOT_CACHE_MS) return cached.bytes
    const png = await capture(tabId)
    const bytes = png?.length ?? 0
    shots.set(tabId, { bytes, at: Date.now() })
    return bytes
  }

  const logBudget = (): { bytes: number; files: number } => {
    let bytes = 0
    let files = 0
    for (const file of logger.files()) {
      if (files > 0 && bytes + file.bytes > REPORT_LOGS_MAX_BYTES) break
      bytes += Math.min(file.bytes, REPORT_LOGS_MAX_BYTES)
      files++
    }
    return { bytes, files }
  }

  const estimate = async (d: ReportDraft): Promise<ReportEstimate> => {
    const files = d.fileTokens.flatMap((t) => picked.get(t) ?? [])
    const dumps = d.includeCrashDumps ? listDumps(crashDumpsDir()) : []
    const logs = logBudget()
    const chat = d.includeChatId ? (chatMarkdown(d.includeChatId)?.length ?? 0) : 0
    const shot = await screenshotSize(d.includeScreenshotTabId)
    const result = estimateReport({
      systemBytes: 4096 + Buffer.byteLength(d.description),
      logBytes: logs.bytes,
      chatBytes: chat,
      screenshotBytes: shot,
      fileBytes: sum(files.map((f) => f.bytes)),
      imageBytes: sum(d.images.map((i) => dataUrlBytes(i.dataUrl))),
      crashBytes: sum(dumps.map((x) => x.bytes)),
      entries: 2 + d.images.length + files.length + (chat ? 1 : 0) + (shot ? 1 : 0) + logs.files + dumps.length,
    })
    // Files alone have their own cap.
    return sum(files.map((f) => f.bytes)) > REPORT_FILES_MAX_BYTES ? { ...result, overLimit: true } : result
  }

  const saveReport = async (d: ReportDraft, options: { email: boolean }): Promise<ReportResult> => {
    if (!d.description.trim()) throw new Error(mainT('diagnostics.report.descriptionRequired'))
    const images = d.images.map((image, i) => {
      const { ext, bytes } = decodeImage(image.dataUrl)
      const stem = basename(image.name, extname(image.name)).trim() || `image-${i + 1}`
      return { name: `${stem}.${ext}`, bytes }
    })
    const files = resolveFiles(d.fileTokens).map((f) => {
      // Sizes are checked again now: a file can grow after it was picked.
      const bytes = statSync(f.path).size
      return { ...f, bytes }
    })
    if (files.length > REPORT_MAX_FILES) throw new Error(mainT('diagnostics.report.tooManyFiles', { count: REPORT_MAX_FILES }))
    if (sum(files.map((f) => f.bytes)) > REPORT_FILES_MAX_BYTES) throw new Error(mainT('diagnostics.report.tooLarge', { limit: '25 MB' }))

    const chat = chatMarkdown(d.includeChatId)
    const screenshot = await capture(d.includeScreenshotTabId)
    logger.flushSync()
    const logs = reportLogs(logger.files())
    const dumps = d.includeCrashDumps ? listDumps(crashDumpsDir()) : []
    const info = systemInfo()
    let migrations: MigrationReport | null = null
    try {
      migrations = deps.migrations?.() ?? null
    } catch {
      migrations = null
    }
    const count = (fn: () => number): number => {
      try {
        return fn()
      } catch {
        return 0
      }
    }
    const json: ReportJson = {
      schema: REPORT_SCHEMA,
      createdAt: new Date().toISOString(),
      app: app.getVersion(),
      channel: RELEASE.channel,
      os: info.os ?? '',
      arch: info.arch ?? '',
      electron: info.electron ?? '',
      chrome: info.chrome ?? '',
      node: info.node ?? '',
      locale: info.locale ?? '',
      engineKind: engineKind(),
      settingsSummary: settingsSummary(deps.settings.get()),
      counts: {
        chats: count(() => deps.chats.list().length),
        windows: count(() => deps.windows.all().length),
        tabs: count(() => deps.tabs.all().length),
      },
      migrations,
      crash: crashState(),
      included: {
        chat: chat !== null,
        screenshot: d.includeScreenshotTabId ? (screenshot ? 'yes' : 'unavailable') : 'no',
        images: images.length,
        files: files.length,
        crashDumps: dumps.length,
        logFiles: logs.length,
      },
    }
    const zip = zipReport(
      reportEntries({ json, description: redactSecrets(d.description), images, files: files.map((f) => ({ name: f.name, path: f.path })), chatMarkdown: chat, screenshot, logs, dumps: dumps.map((x) => ({ name: x.name, path: x.path })) }),
    )
    if (zip.length > REPORT_MAX_BYTES) throw new Error(mainT('diagnostics.report.tooLarge', { limit: '25 MB' }))

    const folder = desktop.downloads()
    mkdirSync(folder, { recursive: true })
    const path = uniquePath(folder, reportFileName(new Date()))
    writeFileSync(path, zip)
    const mail = reportMail({ supportEmail: RELEASE.supportEmail, version: app.getVersion(), path: friendlyPath(path), description: redactSecrets(d.description), systemLine: systemLine(info) })
    lastReport = { path, mailto: mail.url }
    log.info('diagnostics', 'Saved a problem report', { bytes: zip.length, images: images.length, files: files.length, chat: chat !== null, screenshot: screenshot !== null, crashDumps: dumps.length })
    desktop.showItemInFolder(path)
    if (options.email) {
      await desktop.openExternal(mail.url).catch((err: unknown) => log.warn('diagnostics', 'The email draft did not open', { error: errorMessage(err) }))
    }
    return { path, bytes: zip.length, mailto: mail.url }
  }

  const sendFeedback = async (): Promise<void> => {
    const line = systemLine(systemInfo())
    const mail = feedbackMail({ supportEmail: RELEASE.supportEmail, version: app.getVersion(), systemLine: line })
    const notify = (ok: boolean): void => {
      const event: DiagnosticsEvent = { type: 'feedback-draft', ok, address: cleanAddress(RELEASE.supportEmail), system: line }
      // Only the window you asked from shows the toast.
      const win = deps.windows.focused?.() ?? null
      if (win) win.send(event)
      else emit(event)
    }
    try {
      await desktop.openExternal(mail.url)
      notify(true)
    } catch (err) {
      log.warn('diagnostics', 'The feedback draft did not open', { error: errorMessage(err) })
      notify(false)
      throw new Error(mainT('diagnostics.feedback.failed'))
    }
  }

  const pickFiles = async (): Promise<PickedReportFile[]> => {
    const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const owner = BrowserWindow.getFocusedWindow() ?? deps.windows.focused?.()?.window ?? null
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const out: PickedReportFile[] = []
    for (const path of result.filePaths.slice(0, REPORT_MAX_FILES)) {
      let bytes = 0
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        bytes = stat.size
      } catch {
        continue
      }
      const token = randomUUID()
      picked.set(token, { path, name: basename(path), bytes })
      // The oldest picks go first once the session has picked a lot.
      while (picked.size > PICKED_MAX) picked.delete(picked.keys().next().value as string)
      out.push({ token, name: basename(path), bytes })
    }
    return out
  }

  const services: DiagnosticsServices = {
    diagnostics: {
      logs: (q) => logger.query(q),
      tail: (on) => {
        tailing = Math.max(0, tailing + (on ? 1 : -1))
      },
      clearLogs: () => {
        logger.clear()
        log.info('diagnostics', 'Logs cleared')
      },
      revealLogs: () => {
        logger.flushSync()
        const file = logger.file
        if (file) desktop.showItemInFolder(file)
        else throw new Error(mainT('diagnostics.logs.unavailable'))
      },
      systemInfo,
      pickFiles,
      estimate,
      saveReport,
      sendFeedback,
      crashState,
      dismissCrash: () => {
        dismissed = true
        emit({ type: 'crash', state: crashState() })
      },
      log: (level, message) => log[level]('chrome', message),
      revealReport: () => {
        if (!lastReport) throw new Error(mainT('diagnostics.report.noneSaved'))
        desktop.showItemInFolder(lastReport.path)
      },
      emailReport: async () => {
        if (!lastReport) throw new Error(mainT('diagnostics.report.noneSaved'))
        await desktop.openExternal(lastReport.mailto)
      },
    },
  }

  return {
    services,
    onCrashSetting(on) {
      if (on) {
        startCrashReporter()
        log.info('crash', 'Crash reports are kept on this computer')
      } else {
        const removed = deleteDumps(crashDumpsDir())
        log.info('crash', 'Crash reports turned off', { deleted: removed })
      }
      emit({ type: 'crash', state: crashState() })
    },
    dispose() {
      offWrite()
      logger.flushSync()
    },
  }
}

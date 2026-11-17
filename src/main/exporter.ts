/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exporting chats, skills, transcripts and documents (CH-36): text,
// Markdown, HTML and PDF, copy, print and a mail draft. Each feature
// registers what it can export with
// registerExportSource; the exporter turns a source into each format. PDF
// and print render the HTML in a hidden, sandboxed window with scripts off.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell, type WebContents } from 'electron'
import type { ExportFormat, ExportKind, ExporterService } from '@shared/exportFormat'
import { EXPORT_FORMATS } from '@shared/exportFormat'
import { exportFileName } from './chats'
import { markdownDocument } from './exportTemplates/html'
import { mainT } from './i18n/mainT'
import { log } from './log'

export interface ExportSource {
  title(id: string): string
  markdown(id: string): string
  html?(id: string): string
  /** Plain text for Copy and the mail draft; defaults to the Markdown. */
  text?(id: string): string
}

const sources = new Map<ExportKind, ExportSource>()

/** One source per kind; a later registration replaces the earlier (the owning feature registers once at startup). */
export function registerExportSource(kind: ExportKind, source: ExportSource): void {
  sources.set(kind, source)
}

export function exportSource(kind: ExportKind): ExportSource | undefined {
  return sources.get(kind)
}

const EXTENSION: Record<ExportFormat, string> = { text: 'txt', markdown: 'md', html: 'html', pdf: 'pdf' }
const FILTER_KEY: Record<ExportFormat, Parameters<typeof mainT>[0]> = {
  text: 'chatTools.export.filter.text',
  markdown: 'chatTools.export.filter.markdown',
  html: 'chatTools.export.filter.html',
  pdf: 'chatTools.export.filter.pdf',
}

/** Mail clients cut mailto links somewhere past 2,000 characters; stay under that. */
export const MAILTO_MAX = 1900

/**
 * A mailto link with the text inline. Past the limit the body is cut on a
 * line or word boundary and ends with a note that it was shortened.
 */
export function mailtoUrl(subject: string, body: string, note: string, max = MAILTO_MAX): string {
  const head = `mailto:?subject=${encodeURIComponent(subject)}&body=`
  const full = head + encodeURIComponent(body)
  if (full.length <= max) return full
  const tail = encodeURIComponent(`\n\n${note}`)
  const room = max - head.length - tail.length
  // Encoded length grows unevenly, so shrink the text until it fits.
  let lo = 0
  let hi = body.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (encodeURIComponent(body.slice(0, mid)).length <= room) lo = mid
    else hi = mid - 1
  }
  let cut = body.slice(0, lo)
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  if (boundary > lo * 0.6) cut = cut.slice(0, boundary)
  return head + encodeURIComponent(cut.trimEnd()) + tail
}

/** A free name in a folder: "Title.md", then "Title 2.md" and so on. */
export function uniqueName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10_000; n++) {
    const next = `${base} ${n}${ext}`
    if (!taken(next)) return next
  }
  return `${base} ${randomUUID().slice(0, 8)}${ext}`
}

/** What the exporter needs from Electron; tests pass fakes. */
export interface ExporterDeps {
  documentsDir(): string
  saveDialog(options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  folderDialog(options: { defaultPath: string; buttonLabel: string }): Promise<string | null>
  writeFile(path: string, data: string | Uint8Array): void
  exists(path: string): boolean
  /** HTML to PDF in a hidden, sandboxed window. */
  pdf(html: string): Promise<Uint8Array>
  /** Opens the system print dialog for the HTML. */
  print(html: string): Promise<void>
  openExternal(url: string): void
  showItemInFolder(path: string): void
}

export function createExporter(deps: ExporterDeps): ExporterService {
  // Reveal only opens what this session saved, never a path a renderer names.
  const saved = new Set<string>()

  const sourceOf = (kind: ExportKind): ExportSource => {
    const source = sources.get(kind)
    if (!source) throw new Error(mainT('chatTools.export.error.noSource'))
    return source
  }
  const htmlOf = (source: ExportSource, id: string): string => source.html?.(id) ?? markdownDocument(source.title(id), source.markdown(id))
  const textOf = (source: ExportSource, id: string): string => source.text?.(id) ?? source.markdown(id)

  const render = async (source: ExportSource, id: string, format: ExportFormat): Promise<string | Uint8Array> => {
    switch (format) {
      case 'text':
        return textOf(source, id)
      case 'markdown':
        return source.markdown(id)
      case 'html':
        return htmlOf(source, id)
      case 'pdf':
        return deps.pdf(htmlOf(source, id))
    }
  }

  return {
    formats(kind) {
      return sources.has(kind) ? [...EXPORT_FORMATS] : []
    },
    copyText(kind, id) {
      return textOf(sourceOf(kind), id)
    },
    async save(kind, ids, format) {
      const source = sourceOf(kind)
      const ext = EXTENSION[format]
      if (ids.length === 1) {
        const id = ids[0] ?? ''
        const target = await deps.saveDialog({
          defaultPath: join(deps.documentsDir(), exportFileName(source.title(id), ext)),
          filters: [{ name: mainT(FILTER_KEY[format]), extensions: [ext] }],
        })
        if (!target) return null
        deps.writeFile(target, await render(source, id, format))
        saved.add(target)
        return target
      }
      // Several at once go into a folder you pick, one file each.
      const folder = await deps.folderDialog({ defaultPath: deps.documentsDir(), buttonLabel: mainT('chatTools.export.folderButton') })
      if (!folder) return null
      const written = new Set<string>()
      let failed = 0
      for (const id of ids) {
        try {
          const name = uniqueName(exportFileName(source.title(id), ext), (n) => written.has(n) || deps.exists(join(folder, n)))
          deps.writeFile(join(folder, name), await render(source, id, format))
          written.add(name)
          saved.add(join(folder, name))
        } catch (err) {
          failed++
          log.warn('exporter', 'One item could not be exported', { kind, error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (written.size === 0) throw new Error(mainT('chatTools.export.error.noneSaved'))
      saved.add(folder)
      if (failed > 0) log.info('exporter', 'Exported with some items skipped', { saved: written.size, failed })
      return folder
    },
    async print(kind, id) {
      const source = sourceOf(kind)
      await deps.print(htmlOf(source, id))
    },
    mailDraft(kind, id) {
      const source = sourceOf(kind)
      deps.openExternal(mailtoUrl(source.title(id), textOf(source, id), mainT('chatTools.export.mailTruncated')))
    },
    reveal(path) {
      if (!saved.has(path) || !deps.exists(path)) throw new Error(mainT('chatTools.export.error.revealMissing'))
      deps.showItemInFolder(path)
    },
  }
}

/** The Electron side of the exporter: dialogs on the focused window, a hidden sandboxed window for PDF and print. */
export function electronExporterDeps(getWindow: () => BrowserWindow | null): ExporterDeps {
  // Renders the export in its own in-memory partition, with scripts, plugins and navigation off.
  const withPage = async <T>(html: string, use: (wc: WebContents) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(app.getPath('temp'), 'atelier-export-'))
    const file = join(dir, 'export.html')
    writeFileSync(file, html, 'utf8')
    const win = new BrowserWindow({
      show: false,
      width: 816,
      height: 1056,
      webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'atelier-export', spellcheck: false },
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await win.loadFile(file)
      return await use(win.webContents)
    } finally {
      if (!win.isDestroyed()) win.destroy()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    documentsDir: () => app.getPath('documents'),
    async saveDialog(options) {
      const parent = getWindow()
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    async folderDialog(options) {
      const parent = getWindow()
      const opts = { defaultPath: options.defaultPath, buttonLabel: options.buttonLabel, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    writeFile: (path, data) => writeFileSync(path, data),
    exists: (path) => existsSync(path),
    pdf: (html) => withPage(html, async (wc) => new Uint8Array(await wc.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }))),
    print: (html) =>
      withPage(
        html,
        (wc) =>
          new Promise<void>((resolve, reject) => {
            wc.print({ silent: false, printBackground: true }, (ok, reason) => {
              // Cancelling the print dialog is not an error.
              if (ok || reason === 'cancelled') resolve()
              else reject(new Error(mainT('chatTools.export.error.print')))
            })
          }),
      ),
    openExternal: (url) => void shell.openExternal(url),
    showItemInFolder: (path) => shell.showItemInFolder(path),
  }
}

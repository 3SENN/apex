/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for Library › Files, the file viewer and quick look.
// Generated files and artifacts live in Apex's own store (src/main/files/**);
// the viewer opens any file Apex holds through one token-based service, and
// media is served over apex-file://<token>.

/** How a file can be shown; the shared preview renderers (src/renderer/src/files/preview/**) switch on it. */
export type FilePreviewable = 'image' | 'svg' | 'text' | 'markdown' | 'code' | 'html' | 'sheet' | 'pdf' | 'audio' | 'video' | 'binary' | 'empty' | 'unknown'

export type LibraryFileKind = 'generated' | 'report' | 'artifact'
export type LibraryFileState = 'writing' | 'ready' | 'failed'

export interface LibraryFileRef {
  id: string
  name: string
  mediaType: string
  size: number
  kind: LibraryFileKind
  /** The chat that produced it; null once that chat is deleted (the file stays in Library › Files). */
  chatId: string | null
  companionId: string
  createdAt: number
  /** A report is 'writing' while the agent streams it. */
  state: LibraryFileState
  /** Opens as an artifact tab (sandboxed) rather than in the viewer. */
  artifact: boolean
}

export interface LibraryFilesFilter {
  kind?: LibraryFileKind
  chatId?: string
  companionId?: string
  query?: string
}

/** Everything the viewer can open. `local` paths open only when granted this session (pickLocal). */
export type ViewerTarget =
  | { kind: 'library'; id: string }
  | { kind: 'companion-file'; companionId: string; path: string }
  | { kind: 'memory'; owner: string; path: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'chat-file'; chatId: string; path: string }
  | { kind: 'attachment'; chatId: string; attachmentId: string }
  | { kind: 'local'; path: string }

export type ViewerDocState = 'ready' | 'writing' | 'missing' | 'error'

/** A spreadsheet's first sheet, capped (SHEET_LIMITS); main reads CSV, TSV and XLSX. */
export interface SheetData {
  rows: string[][]
  /** Rows and columns in the whole sheet, before the cap. */
  totalRows: number
  totalColumns: number
  truncated: boolean
  /** The sheet's name in a workbook; null for CSV and TSV. */
  sheetName: string | null
  /** How many sheets the workbook has (1 for CSV and TSV). */
  sheetCount: number
}

export const SHEET_LIMITS = { rows: 200, columns: 50 } as const

export interface ViewerDoc {
  /** Opaque, per open; every later call names the document by it. */
  token: string
  name: string
  mediaType: string
  previewable: FilePreviewable
  size: number
  /** Text kinds carry their text; binary kinds use `url`. */
  text?: string
  /** apex-file://<token> for images, PDFs and media. */
  url?: string
  editable: boolean
  /** Front matter of Markdown files (skills, memory), shown above the body. */
  frontmatter?: Record<string, string>
  state: ViewerDocState
  error?: string
  /** Where it came from (the target's kind). */
  source: ViewerTarget['kind']
  /** The first sheet, for 'sheet' documents. */
  sheet?: SheetData
  /** The text was cut at the viewer's cap; it can't be edited then. */
  truncated?: boolean
  revealable: boolean
  renamable: boolean
  deletable: boolean
  exportable: boolean
  /** HTML, SVG and Markdown can open as a sandboxed artifact tab. */
  artifactable: boolean
  /** The Library › Files entry behind it, if any. */
  libraryId: string | null
  modifiedAt: number | null
}

export interface FilesServices {
  files: {
    list(filter?: LibraryFilesFilter): LibraryFileRef[]
    rename(id: string, name: string): LibraryFileRef
    /** Moves the file to the Trash. */
    remove(id: string): Promise<void>
    reveal(id: string): void
    /** Saves a copy through a save dialog; resolves to the path, or null when cancelled. */
    export(id: string): Promise<string | null>
    /** Opens the file as a sandboxed artifact tab in the caller's window, after the active tab. */
    openArtifact(id: string): void
  }
  viewer: {
    /**
     * Opens a target and hands out a token for it. `owner` is the tab that
     * shows it: the token expires when that tab closes (or on release).
     */
    open(target: ViewerTarget, owner?: string): Promise<ViewerDoc>
    save(token: string, text: string): ViewerDoc
    rename(token: string, name: string): ViewerDoc
    remove(token: string): Promise<void>
    reveal(token: string): void
    export(token: string): Promise<string | null>
    /** An open dialog; the picked path is granted for this session. Null when cancelled. */
    pickLocal(): Promise<ViewerTarget | null>
    /** A file dropped onto the window: granted for this session like a picked one. Null when it isn't a readable file outside Apex's data. */
    grantDropped(path: string): ViewerTarget | null
    /** The viewer is done with the token (its page or quick look closed). */
    release(token: string): void
    /** The document's bytes, for renderers that parse them (PDF); capped at VIEWER_BYTES_MAX. */
    bytes(token: string): Promise<Uint8Array>
    /** Opens HTML, SVG or Markdown as a sandboxed artifact tab (copied into Library › Files when it isn't there yet). */
    openArtifact(token: string): void
  }
}

/** viewer.bytes refuses larger files (the PDF attachment cap). */
export const VIEWER_BYTES_MAX = 32_000_000
/** Text past this many characters is shown cut and read-only. */
export const VIEWER_TEXT_MAX = 2_000_000

export type FilesEvent = { type: 'library-files'; items: LibraryFileRef[] }

/** Privileged schemes the file viewer serves (appended to PRIVILEGED_SCHEMES). */
export const FILE_SCHEME = 'apex-file'
export const ARTIFACT_SCHEME = 'apex-artifact'
/** The in-memory, locked-down partition artifact tabs render in. */
export const ARTIFACTS_PARTITION = 'apex-artifacts'

export const LIBRARY_FILES_URL = 'apex://library/files'

// apex-artifact://<fileId>/ serves one Library file in the apex-artifacts partition
const ARTIFACT_URL = /^apex-artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:index\.html)?(?:[?#].*)?$/

export function artifactUrl(fileId: string): string {
  return `${ARTIFACT_SCHEME}://${fileId.toLowerCase()}/`
}

/** The Library file id an artifact tab shows, or null for any other address. */
export function artifactIdOf(url: string): string | null {
  return ARTIFACT_URL.exec(url)?.[1] ?? null
}

export function isArtifactUrl(url: string): boolean {
  return url.startsWith(`${ARTIFACT_SCHEME}:`)
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(value)) return null
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** apex://file?src=<base64url ViewerTarget>[&edit=1][&name=…]. `name` only titles the tab; the viewer reads the real one. */
export function fileViewerUrl(target: ViewerTarget, options: { edit?: boolean; name?: string } = {}): string {
  const name = options.name ? `&name=${encodeURIComponent(options.name.slice(0, 120))}` : ''
  return `apex://file?src=${toBase64Url(JSON.stringify(target))}${options.edit ? '&edit=1' : ''}${name}`
}

/**
 * The target an apex://file address names, or null for anything malformed.
 * The shape is checked here only loosely; main validates it again (zod) and
 * confines every path before it opens anything.
 */
export function parseFileViewerUrl(url: string): { target: ViewerTarget; edit: boolean } | null {
  if (!url.startsWith('apex://file?') && !url.startsWith('apex://file/?')) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(url.slice(url.indexOf('?') + 1).split('#')[0])
  } catch {
    return null
  }
  const json = fromBase64Url(params.get('src') ?? '')
  if (!json) return null
  try {
    const target = JSON.parse(json) as unknown
    if (typeof target !== 'object' || target === null || typeof (target as { kind?: unknown }).kind !== 'string') return null
    return { target: target as ViewerTarget, edit: params.get('edit') === '1' }
  } catch {
    return null
  }
}

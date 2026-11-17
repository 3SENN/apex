/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for the workspace: Search everything, watched folders, version
// history (OV-33), Recently Deleted, projects (SH-64), spaces and the hub at
// atelier://workspace.
import type { ViewerTarget } from './files'
import type { TabsSnapshot } from './ipc'
import type { MenuItemSpec } from './menu'
import type { Owner } from './services'

/** Any file Atelier can version, trash or hand to the agent. `library` ids are LibraryFileRef ids. */
export type FileRef =
  | { kind: 'folder'; folderId: string; path: string }
  | { kind: 'companion'; companionId: string; path: string }
  | { kind: 'memory'; owner: Owner; path: string }
  | { kind: 'skill'; skillId: string; path: string }
  | { kind: 'library'; id: string }
  | { kind: 'app'; appId: string }

/** The file a skill target opens when it names no file. */
export const SKILL_MAIN_FILE = 'SKILL.md'

/**
 * Maps the file viewer's targets onto FileRefs; null for targets that have no
 * version history (meetings, chat files, attachments, and local files, which
 * main maps through the folder grants instead).
 */
export function fileRefFromViewerTarget(t: ViewerTarget): FileRef | null {
  switch (t.kind) {
    case 'library':
      return { kind: 'library', id: t.id }
    case 'companion-file':
      return { kind: 'companion', companionId: t.companionId, path: t.path }
    case 'memory':
      return { kind: 'memory', owner: t.owner, path: t.path }
    case 'skill':
      return { kind: 'skill', skillId: t.skillId, path: SKILL_MAIN_FILE }
    default:
      return null
  }
}

/** One stable string per file, for maps, React keys and the version store. */
export function fileRefKey(ref: FileRef): string {
  switch (ref.kind) {
    case 'folder':
      return `folder:${ref.folderId}:${ref.path}`
    case 'companion':
      return `companion:${ref.companionId}:${ref.path}`
    case 'memory':
      return `memory:${ref.owner}:${ref.path}`
    case 'skill':
      return `skill:${ref.skillId}:${ref.path}`
    case 'library':
      return `library:${ref.id}`
    case 'app':
      return `app:${ref.appId}`
  }
}

export function sameFileRef(a: FileRef, b: FileRef): boolean {
  return fileRefKey(a) === fileRefKey(b)
}

/** The last path part of a ref, for titles. */
export function fileRefName(ref: FileRef): string {
  if (ref.kind === 'library') return ref.id
  if (ref.kind === 'app') return ref.appId
  const parts = ref.path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ref.path
}

/**
 * Files Atelier reads as text: indexing, the folder tools and write_file. Up to
 * TEXT_FILE_MAX_BYTES; anything else is listed but never read or written.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css',
  'scss', 'less', 'svg', 'log', 'tex', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'zsh', 'bash', 'fish', 'sql', 'graphql', 'vue', 'svelte', 'lua', 'r', 'pl', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj',
  'gitignore', 'dockerfile', 'makefile', 'srt', 'vtt', 'ics', 'vcf',
])

export const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024

/** What write_file accepts in one call. */
export const WRITE_FILE_MAX_BYTES = 1024 * 1024

/** Files indexed per watched folder, at most. */
export const FOLDER_INDEX_MAX_FILES = 20_000

export function isTextFileName(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower
  return TEXT_EXTENSIONS.has(ext)
}

/** Search snippets wrap each matched term in these two characters; the UI turns them into highlights. */
export const HIT_OPEN = '\u0002'
export const HIT_CLOSE = '\u0003'

/** Splits a snippet into plain and highlighted parts. */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = []
  let rest = snippet
  while (rest.length > 0) {
    const open = rest.indexOf(HIT_OPEN)
    if (open < 0) {
      parts.push({ text: rest, hit: false })
      break
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), hit: false })
    const close = rest.indexOf(HIT_CLOSE, open + 1)
    const end = close < 0 ? rest.length : close
    if (end > open + 1) parts.push({ text: rest.slice(open + 1, end), hit: true })
    rest = close < 0 ? '' : rest.slice(close + 1)
  }
  return parts
}

/** The plain text of a snippet, for the agent and screen readers. */
export function plainSnippet(snippet: string): string {
  return snippet.split(HIT_OPEN).join('').split(HIT_CLOSE).join('')
}

export interface WatchedFolder {
  id: string
  path: string
  name: string
  mode: 'read' | 'read-write'
  scope: 'all-chats' | { chatId: string }
  companionId: string | null
  addedAt: number
  fileCount: number | null
}

export interface FolderEntry {
  path: string
  name: string
  kind: 'file' | 'folder'
  size: number
  modifiedAt: number
  readable: boolean
}

export interface FileVersion {
  id: string
  at: number
  label: 'saved' | 'restored' | 'deleted' | 'moved'
  size: number
  current: boolean
}

/** Versions kept per file: the last 50, or 30 days. */
export const VERSION_LIMITS = { count: 50, days: 30 } as const

export type SearchSource = 'chats' | 'memory' | 'history' | 'bookmarks' | 'files'
export const SEARCH_SOURCES = ['chats', 'memory', 'history', 'bookmarks', 'files'] as const satisfies readonly SearchSource[]

export interface SearchHit {
  source: SearchSource
  id: string
  title: string
  snippet: string
  url: string | null
  ref: FileRef | null
  at: number
  score: number
}

export interface IndexState {
  building: boolean
  done: number
  total: number
  updatedAt: number | null
}

/** Project colours: Atelier's palette ids (the tab-group colours), drawn from tokens in light and dark. */
export const PROJECT_COLORS = ['graphite', 'berry', 'honey', 'fern', 'lagoon', 'iris', 'coral', 'sage'] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]
export const PROJECT_NAME_MAX = 80
/** Files a new chat in a project is offered as context, at most. */
export const PROJECT_CONTEXT_MAX = 10

export interface Project {
  id: string
  name: string
  /** A palette token id from Atelier's project colours, never a raw hex. */
  color: string
  description: string
  instructions: string
  chatIds: string[]
  files: FileRef[]
  createdAt: number
  updatedAt: number
}


/** The project each chat is in, from the project list. */
export function projectOfChats(projects: readonly Project[], chatIds: readonly string[]): Map<string, string> {
  const of = new Map<string, string>()
  for (const p of projects) for (const id of p.chatIds) if (chatIds.includes(id)) of.set(id, p.id)
  return of
}

export const PROJECT_MENU_PREFIX = 'project:'

/** The "Move to project" submenu: No project, each project (checked when every chat is in it), New project…. */
export function projectMenuSpec(projects: readonly Project[], chatIds: readonly string[], labels: { title: string; none: string; new: string }): MenuItemSpec {
  const of = projectOfChats(projects, chatIds)
  const all = (id: string | null): boolean => chatIds.length > 0 && chatIds.every((c) => (of.get(c) ?? null) === id)
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const submenu: MenuItemSpec[] = [
    { id: `${PROJECT_MENU_PREFIX}none`, label: labels.none, type: 'checkbox', checked: all(null) },
    ...(sorted.length > 0 ? [{ id: `${PROJECT_MENU_PREFIX}sep`, label: '', type: 'separator' as const }] : []),
    ...sorted.map((p): MenuItemSpec => ({ id: `${PROJECT_MENU_PREFIX}${p.id}`, label: p.name, type: 'checkbox', checked: all(p.id) })),
    { id: `${PROJECT_MENU_PREFIX}sep-new`, label: '', type: 'separator' },
    { id: `${PROJECT_MENU_PREFIX}new`, label: labels.new },
  ]
  return { id: `${PROJECT_MENU_PREFIX}menu`, label: labels.title, enabled: chatIds.length > 0, submenu }
}

export type ProjectMenuAction = { kind: 'none' } | { kind: 'new' } | { kind: 'project'; id: string }

/** What a clicked submenu id asks for; null for ids that aren't the submenu's. */
export function projectMenuAction(itemId: string): ProjectMenuAction | null {
  if (!itemId.startsWith(PROJECT_MENU_PREFIX)) return null
  const rest = itemId.slice(PROJECT_MENU_PREFIX.length)
  if (rest === 'none') return { kind: 'none' }
  if (rest === 'new') return { kind: 'new' }
  if (!rest || rest === 'menu' || rest.startsWith('sep')) return null
  return { kind: 'project', id: rest }
}

export interface SpaceInfo {
  projectId: string | null
  name: string
  color: string | null
  tabCount: number
  active: boolean
  /** The space's unpinned tabs, so the chrome shows only the current space's tabs. */
  tabIds: string[]
}

export type TrashKind = 'file' | 'companion-file' | 'memory' | 'skill' | 'project' | 'app' | 'table'
export const TRASH_KINDS = ['file', 'companion-file', 'memory', 'skill', 'project', 'app', 'table'] as const satisfies readonly TrashKind[]

export interface TrashItem {
  id: string
  kind: TrashKind
  title: string
  deletedAt: number
  expiresAt: number
  size: number | null
}

/** Recently Deleted keeps items for 30 days. */
export const TRASH_RETENTION_DAYS = 30

/** Sections of atelier://workspace (its addresses; timeline only redirects to History). */
export const WORKSPACE_SECTIONS = ['home', 'projects', 'files', 'apps', 'tables', 'timeline', 'trash', 'search'] as const
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number]

/** The hub's four tabs, in order. */
export const WORKSPACE_TABS = ['home', 'projects', 'files', 'apps'] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]

/** The tab a section shows under: Tables live in Files; Search, Recently deleted and the old Timeline under none. */
export function workspaceTabOf(section: WorkspaceSection): WorkspaceTab | null {
  if (section === 'tables') return 'files'
  return (WORKSPACE_TABS as readonly string[]).includes(section) ? (section as WorkspaceTab) : null
}


export interface WorkspaceServices {
  search: {
    query(q: string, options?: { sources?: SearchSource[]; limit?: number; offset?: number }): { hits: SearchHit[]; total: number }
    /** The newest indexed items of some sources, newest first, with empty snippets (Home's recent files, the project file picker). */
    recent(options?: { sources?: SearchSource[]; limit?: number }): SearchHit[]
    state(): IndexState
    rebuild(): void
  }
  folders: {
    list(): WatchedFolder[]
    pick(): Promise<string | null>
    grant(input: { path: string; mode: WatchedFolder['mode']; scope: WatchedFolder['scope']; companionId?: string | null }): WatchedFolder
    update(id: string, patch: { mode?: WatchedFolder['mode']; scope?: WatchedFolder['scope'] }): WatchedFolder
    revoke(id: string): void
    entries(id: string, sub: string): FolderEntry[]
    readText(id: string, path: string): string
    reveal(id: string, path: string): void
    open(id: string, path: string): Promise<void>
  }
  versions: {
    list(ref: FileRef): FileVersion[]
    read(ref: FileRef, versionId: string): string
    restore(ref: FileRef, versionId: string): FileVersion
    /** The FileRef a viewer target has history under, local files included (through the folder grants); null when it has none. */
    refFor(target: ViewerTarget): FileRef | null
  }
  projects: {
    list(): Project[]
    get(id: string): Project
    save(input: { id?: string; name: string; color: string; description: string; instructions: string }): Project
    remove(id: string): void
    addChats(id: string, chatIds: string[]): Project
    removeChats(id: string, chatIds: string[]): Project
    addFiles(id: string, refs: FileRef[]): Project
    removeFiles(id: string, refs: FileRef[]): Project
    /** Starts a chat in the project; returns its id. */
    newChat(id: string, text?: string): string
    /** The project's text files (up to PROJECT_CONTEXT_MAX), read for a new chat's attachments. */
    contextFiles(id: string): Array<{ name: string; base64: string }>
  }
  spaces: {
    list(windowId?: number): SpaceInfo[]
    switchTo(projectId: string | null, windowId?: number): void
    moveTabs(tabIds: string[], projectId: string | null): void
  }
  trash: {
    list(q?: { kind?: TrashKind; query?: string }): TrashItem[]
    restore(ids: string[]): { restored: number; renamed: string[] }
    purge(ids: string[]): number
    empty(): number
  }
}

/** The workspace's AppEvent additions. */
export type WorkspaceEvent =
  | { type: 'search-index'; state: IndexState }
  | { type: 'folders'; items: WatchedFolder[] }
  | { type: 'versions'; ref: FileRef }
  | { type: 'projects'; items: Project[] }
  | { type: 'spaces'; windowId: number }
  | { type: 'trash'; count: number }

// Folder listings (breadcrumbs, filter, sort), search results grouped by
// source, Recently Deleted countdowns, the tabs a window shows for its
// current space, viewer targets, selections and the space menus.

export type EntrySort = 'name' | 'modified' | 'size'

/** The crumbs of a relative folder path: the root ('') first. */
export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  return [{ name: '', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))]
}

/** The parent of a relative path ('' for the root's children). */
export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

/** Folders first, then by the chosen key; names compare naturally (file 2 before file 10). */
export function sortEntries(entries: readonly FolderEntry[], sort: EntrySort, filter = ''): FolderEntry[] {
  const q = filter.trim().toLowerCase()
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : [...entries]
  const byName = (a: FolderEntry, b: FolderEntry): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return shown.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    if (sort === 'modified') return b.modifiedAt - a.modifiedAt || byName(a, b)
    if (sort === 'size') return b.size - a.size || byName(a, b)
    return byName(a, b)
  })
}

/** Hits grouped by source, in the fixed source order, each group keeping rank order. */
export function groupHits(hits: readonly SearchHit[]): Array<{ source: SearchSource; hits: SearchHit[] }> {
  return SEARCH_SOURCES.map((source) => ({ source, hits: hits.filter((h) => h.source === source) })).filter((g) => g.hits.length > 0)
}

const DAY_MS = 86_400_000

/** Whole days until an item goes for good (0 on its last day). */
export function daysLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((expiresAt - now) / DAY_MS))
}

/**
 * The tabs a window shows in its current space: pinned tabs always, and
 * every tab not known to belong to another space (a brand-new tab joins the
 * current one before the next space list arrives). The split and the
 * selection drop tabs that are hidden. With no projects, nothing changes.
 */
export function spaceView(snapshot: TabsSnapshot, spaces: readonly SpaceInfo[] | null): TabsSnapshot {
  if (!spaces || spaces.length < 2) return snapshot
  const hidden = new Set(spaces.filter((s) => !s.active).flatMap((s) => s.tabIds))
  if (hidden.size === 0) return snapshot
  const shown = (id: string): boolean => !hidden.has(id) || snapshot.tabs.some((t) => t.id === id && t.pinned)
  const tabs = snapshot.tabs.filter((t) => t.pinned || !hidden.has(t.id))
  const split = snapshot.split && shown(snapshot.split.primaryId) && shown(snapshot.split.secondaryId) ? snapshot.split : null
  const selection = (snapshot.selection ?? []).filter(shown)
  return { ...snapshot, tabs, split, selection }
}

// ── Files, projects and menus ──

/** The viewer target a FileRef opens in the file viewer; folder files need their grant's absolute path. Null when it can't be opened there (apps, a revoked folder). */
export function viewerTargetOf(ref: FileRef, folders: readonly WatchedFolder[]): ViewerTarget | null {
  switch (ref.kind) {
    case 'folder': {
      const folder = folders.find((f) => f.id === ref.folderId)
      return folder ? { kind: 'local', path: joinPath(folder.path, ref.path) } : null
    }
    case 'companion':
      return { kind: 'companion-file', companionId: ref.companionId, path: ref.path }
    case 'memory':
      return { kind: 'memory', owner: ref.owner, path: ref.path }
    case 'skill':
      return { kind: 'skill', skillId: ref.skillId }
    case 'library':
      return { kind: 'library', id: ref.id }
    case 'app':
      return null
  }
}

/** An absolute folder path joined with a relative '/'-separated one. */
export function joinPath(root: string, rel: string): string {
  const parts = rel.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0) return root
  return `${root.replace(/[\\/]+$/, '')}/${parts.join('/')}`
}

/** A project's colour id, falling back to graphite for anything unknown (never a raw value in a class name). */
export function projectColor(color: string | null | undefined): ProjectColor {
  return (PROJECT_COLORS as readonly string[]).includes(color ?? '') ? (color as ProjectColor) : 'graphite'
}

/** Projects whose name, description or instructions contain every word, newest change first. */
export function filterProjects(projects: readonly Project[], query: string): Project[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return projects
    .filter((p) => {
      const hay = `${p.name} ${p.description} ${p.instructions}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** Whether a selection covers none, some or all of the shown ids (the select-all box). */
export function selectionState(shown: readonly string[], selected: ReadonlySet<string>): 'none' | 'some' | 'all' {
  const n = shown.filter((id) => selected.has(id)).length
  return n === 0 ? 'none' : n === shown.length ? 'all' : 'some'
}

/** The selection with `id` flipped. */
export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The selection kept to ids still shown (after a restore, purge or filter). */
export function pruneSelection(selected: ReadonlySet<string>, shown: readonly string[]): Set<string> {
  const keep = new Set(shown)
  return new Set([...selected].filter((id) => keep.has(id)))
}

/** atelier://workspace/search with its query. */
export function searchPageUrl(query: string): string {
  const q = query.trim()
  return q ? `atelier://workspace/search?q=${encodeURIComponent(q)}` : 'atelier://workspace/search'
}

/** The space the Space row names: the active one, or "no project". */
export function activeSpace(spaces: readonly SpaceInfo[] | null): SpaceInfo | null {
  return spaces?.find((s) => s.active) ?? null
}

/** Spaces show once a project exists: more than the "no project" space. */
export function spacesShown(spaces: readonly SpaceInfo[] | null): boolean {
  return (spaces?.length ?? 0) > 1
}

export const SPACE_MOVE_PREFIX = 'move-space:'

/** A tab menu's "Move to space" submenu (each space but the tabs' own); null until a project exists. */
export function spaceMoveSpec(spaces: readonly SpaceInfo[] | null, tabIds: readonly string[], title: string): MenuItemSpec | null {
  if (!spaces || !spacesShown(spaces) || tabIds.length === 0) return null
  const inSpace = (s: SpaceInfo): boolean => tabIds.every((id) => s.tabIds.includes(id))
  return {
    id: `${SPACE_MOVE_PREFIX}menu`,
    label: title,
    submenu: spaces.map((s) => ({ id: `${SPACE_MOVE_PREFIX}${s.projectId ?? 'none'}`, label: s.name, type: 'checkbox', checked: inSpace(s), enabled: !inSpace(s) })),
  }
}

/** The space a clicked "Move to space" id names: a project id, null for "No project", undefined for other ids. */
export function spaceMoveTarget(itemId: string): string | null | undefined {
  if (!itemId.startsWith(SPACE_MOVE_PREFIX)) return undefined
  const rest = itemId.slice(SPACE_MOVE_PREFIX.length)
  if (rest === 'menu' || !rest) return undefined
  return rest === 'none' ? null : rest
}

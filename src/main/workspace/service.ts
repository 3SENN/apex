/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace, assembled: the stores (versions, Recently Deleted,
// folders, projects, the search index), the adapters other modules call, the
// client tools, the command-bar provider and per-window spaces. feature.ts
// creates it once at start-up from the stores index.ts passes in.
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { AppEvent } from '@shared/services'
import { SHARED_OWNER, type ChatSummary } from '@shared/chats'
import { fileViewerUrl } from '@shared/files'
import type { OmniboxRow } from '@shared/omnibox'
import { workspaceUrl } from '@shared/url'
import { PROJECT_CONTEXT_MAX, TEXT_FILE_MAX_BYTES, fileRefFromViewerTarget, fileRefName, isTextFileName, plainSnippet, type FileRef, type IndexState, type SearchHit, type SearchSource, type SpaceInfo, type WorkspaceServices } from '@shared/workspace'
import type { ChatStore } from '../chats'
import type { CompanionFiles } from '../companionFiles'
import type { CompanionStore } from '../companions'
import { openDb, type DatabaseSync } from '../db'
import type { HistoryStore } from '../history'
import { log } from '../log'
import { mainT } from '../i18n/mainT'
import type { MemoryService } from '../memory'
import { omnibox } from '../omnibox'
import { registerPermissionSources, registerProjectLookup } from '../agent/feature'
import { registerSavedWindowPart } from '../sessionRestore'
import { registerStorageCategory } from '../storage'
import type { BookmarkStore } from '../stores'
import type { WindowContext } from '../features/types'
import type { ContentRuntime } from '../features/contentRuntime'
import type { ViewerDeletion } from '../files/types'
import { bindWorkspace, registerTrashAdapter, registerVersionTarget, trashAdapter, versionTarget } from './adapters'
import { FolderStore } from './folders'
import { freePath, movePath, pathSize, writeAtomic } from './fsutil'
import { Indexer, bookmarkSource, chatSource, fileSource, historySource, librarySource, memorySource } from './indexer'
import { ProjectStore, type ProjectTrashPayload } from './projects'
import { SearchIndex } from './search'
import { SpaceModel, spaceCommandRows } from './spaces'
import { registerWorkspaceClientTools, type CompanionFilesReader } from './tools'
import { TrashStore } from './trash'
import { VersionStore } from './versions'

/** The stores index.ts hands the workspace (AppContext.workspaceStores). */
export interface WorkspaceStores {
  chats: ChatStore
  history: HistoryStore
  bookmarks: BookmarkStore
  memory: MemoryService
  companionFiles: CompanionFiles
  companions: CompanionStore
}

export interface WorkspaceDeps {
  dataDir: string
  stores: WorkspaceStores
  broadcast(event: AppEvent): void
  /** Every open window, for spaces. */
  windows: { all(): WindowContext[]; get(id: number): WindowContext | undefined; focused(): WindowContext | null }
  /** Drafts and first messages for "new chat in project". */
  agent: { create(options: { projectId?: string }): { id: string }; start(text: string, options: { projectId?: string }): string }
  content?: Pick<ContentRuntime, 'viewer' | 'libraryFiles'>
  /** Electron's folder picker, Finder and default-app calls. */
  shell: { pickFolder(): Promise<string | null>; reveal(path: string): void; openPath(path: string): Promise<string> }
  /** The browsing profile a window shows; 'default' until profiles land. */
  profileOf?(windowId: number | null): string
  smoke?: boolean
}

export interface Workspace {
  services: WorkspaceServices
  attachWindow(win: WindowContext): void
  /** For smoke checks. */
  internals: { indexer: Indexer; index: SearchIndex; folders: FolderStore; trash: TrashStore; versions: VersionStore; projects: ProjectStore }
  dispose(): void
}

const DAY_MS = 86_400_000
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Opens search.sqlite; a damaged file is thrown away (the index is disposable). */
function openSearchDb(path: string): DatabaseSync {
  try {
    const db = openDb(path)
    db.prepare('PRAGMA quick_check').get()
    return db
  } catch (err) {
    log.warn('workspace', 'Rebuilding a damaged search index', { error: err instanceof Error ? err.message : String(err) })
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
    return openDb(path)
  }
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const { dataDir, stores, broadcast } = deps
  const undo: Array<() => void> = []
  const timers: NodeJS.Timeout[] = []
  const db = openDb(join(dataDir, 'workspace.sqlite'))
  const searchDb = openSearchDb(join(dataDir, 'search.sqlite'))

  // ── Versions ──
  const versions = new VersionStore({ db, dir: join(dataDir, 'versions'), target: versionTarget, onChange: (ref) => broadcast({ type: 'versions', ref }) })

  // ── Folders and the index ──
  let knownFolders = new Set<string>()
  const index = new SearchIndex(searchDb)
  // Filled below; folder events can arrive before the indexer exists.
  let indexer: Indexer | null = null
  const folders = new FolderStore({
    db,
    blocked: [dataDir],
    snapshot: (ref, text, label) => versions.snapshot(ref, text, label),
    watch: !deps.smoke,
    onChange: (items) => {
      broadcast({ type: 'folders', items })
      const ids = new Set(items.map((f) => f.id))
      for (const gone of knownFolders) if (!ids.has(gone)) index.removePrefix(`folder:${gone}:`)
      if ([...ids].some((id) => !knownFolders.has(id))) indexer?.touchSource('folder:')
      knownFolders = ids
    },
    onFiles: (id, path) => (path ? indexer?.touch(`folder:${id}:${path}`) : indexer?.touchSource('folder:')),
  })
  knownFolders = new Set(folders.list().map((f) => f.id))

  const companionIds = (): string[] => stores.companions.list().map((c) => c.id)
  const companionFilesOf = (companionId: string): Array<{ path: string; size: number; modifiedAt: number }> => {
    const out: Array<{ path: string; size: number; modifiedAt: number }> = []
    const walk = (folder: string): void => {
      for (const e of stores.companionFiles.list(companionId, folder)) {
        if (out.length >= 5000) return
        if (e.kind === 'folder') walk(e.path)
        else out.push({ path: e.path, size: e.size, modifiedAt: e.modifiedAt })
      }
    }
    try {
      walk('')
    } catch {
      // A missing or unreadable folder has no files.
    }
    return out
  }
  const companionReader: CompanionFilesReader = {
    files: companionFilesOf,
    entries: (companionId, folder) => stores.companionFiles.list(companionId, folder),
    resolve: (companionId, path) => stores.companionFiles.resolve(companionId, path),
    read: (companionId, path) => {
      const file = stores.companionFiles.resolve(companionId, path)
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error('That file no longer exists.')
      return readFileSync(file)
    },
  }
  const statOf = (file: string): { size: number; modifiedAt: number } | null => {
    try {
      const info = statSync(file)
      return info.isFile() ? { size: info.size, modifiedAt: info.mtimeMs } : null
    } catch {
      return null
    }
  }

  const libraryList = (): ReturnType<NonNullable<WorkspaceDeps['content']>['libraryFiles']['listByChat']> => {
    const library = deps.content?.libraryFiles
    if (!library) return []
    const seen = new Map<string, ReturnType<typeof library.listByChat>[number]>()
    try {
      for (const chat of stores.chats.list()) for (const f of library.listByChat(chat.id)) seen.set(f.id, f)
    } catch {
      // Library files not available yet.
    }
    return [...seen.values()]
  }

  let lastState: IndexState | null = null
  let stateTimer: NodeJS.Timeout | null = null
  indexer = new Indexer({
    index,
    sources: [
      chatSource(stores.chats),
      memorySource({
        owners: () => [SHARED_OWNER, ...companionIds()],
        list: (owner) => stores.memory.list(owner),
        read: (path, owner) => stores.memory.read(path, owner),
      }),
      historySource({ profile: 'default', entries: () => stores.history.search('', 5000) }),
      bookmarkSource({ profile: 'default', list: () => stores.bookmarks.list() }),
      fileSource('folder:', {
        roots: () => folders.list().map((f) => ({ id: f.id, ref: (path: string): FileRef => ({ kind: 'folder', folderId: f.id, path }) })),
        files: (id) => folders.files(id),
        stat: (id, path) => {
          try {
            return statOf(folders.resolve(id, path))
          } catch {
            return null
          }
        },
        read: (id, path) => folders.readBytes(id, path),
      }),
      fileSource('companion:', {
        roots: () => companionIds().map((id) => ({ id, ref: (path: string): FileRef => ({ kind: 'companion', companionId: id, path }) })),
        files: async (id) => companionFilesOf(id),
        stat: (id, path) => {
          try {
            return statOf(stores.companionFiles.resolve(id, path))
          } catch {
            return null
          }
        },
        read: (id, path) => {
          try {
            return readFileSync(stores.companionFiles.resolve(id, path))
          } catch {
            return null
          }
        },
      }),
      librarySource({ list: libraryList }),
    ],
    // Progress is sent at most every 250 ms, and always when a build starts or ends.
    onState: (state) => {
      const edge = state.building !== lastState?.building
      lastState = state
      if (edge) {
        broadcast({ type: 'search-index', state })
        return
      }
      if (stateTimer) return
      stateTimer = setTimeout(() => {
        stateTimer = null
        if (lastState) broadcast({ type: 'search-index', state: lastState })
      }, 250)
    },
  })

  // ── Recently Deleted ──
  const trash = new TrashStore({ db, dir: join(dataDir, 'trash'), adapter: trashAdapter, onChange: (count) => broadcast({ type: 'trash', count }) })

  // ── Projects ──
  const spaceWindows = new Map<number, { model: SpaceModel; win: WindowContext }>()
  const projectStore = new ProjectStore({
    db,
    chats: {
      list: () => stores.chats.list().map((c) => ({ id: c.id, projectId: c.projectId ?? null, private: c.private === true, draft: c.draft })),
      setProject: (ids, projectId) => {
        stores.chats.update(ids, { projectId })
      },
    },
    onChange: (items) => {
      broadcast({ type: 'projects', items })
      const ids = new Set(items.map((p) => p.id))
      for (const { model, win } of spaceWindows.values()) {
        const active = model.active()
        if (active !== null && !ids.has(active)) model.dropProject(active)
        win.send({ type: 'spaces', windowId: win.id })
      }
    },
  })
  // A chat started in a project before its first save gets its projectId when it is saved.
  const pendingProject = new Map<string, string>()
  const fileChats = (items: ChatSummary[]): void => {
    for (const [chatId, projectId] of pendingProject) {
      const chat = items.find((c) => c.id === chatId)
      if (!chat) continue
      pendingProject.delete(chatId)
      if (chat.projectId !== projectId && projectStore.find(projectId)) stores.chats.update([chatId], { projectId })
    }
  }

  const companionFile = (ref: FileRef): string => {
    if (ref.kind !== 'companion') throw new Error('Not a companion file.')
    return stores.companionFiles.resolve(ref.companionId, ref.path)
  }
  const register = (fn: () => () => void): void => {
    try {
      undo.push(fn())
    } catch (err) {
      log.warn('workspace', 'Registration skipped', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // New chats in a project start with its name and instructions (PromptOptions.project, frozen at the chat's first turn).
  register(() => {
    registerProjectLookup((id) => {
      const project = projectStore.find(id)
      return project ? { name: project.name, instructions: project.instructions } : null
    })
    return () => registerProjectLookup(() => null)
  })
  // Saved permissions lists the folders shared with the agent.
  register(() => {
    registerPermissionSources({ folders: () => folders.list() })
    return () => registerPermissionSources({ folders: undefined })
  })
  register(() =>
    registerVersionTarget('folder', {
      read: (ref) => (ref.kind === 'folder' ? folders.readBytes(ref.folderId, ref.path) : null),
      write: (ref, data) => {
        if (ref.kind === 'folder') folders.writeBytes(ref.folderId, ref.path, data)
      },
    }),
  )
  register(() =>
    registerVersionTarget('companion', {
      read: (ref) => {
        const file = companionFile(ref)
        return existsSync(file) ? readFileSync(file) : null
      },
      write: (ref, data) => {
        if (ref.kind !== 'companion') return
        writeAtomic(companionFile(ref), data)
        stores.companionFiles.emit('changed', ref.companionId, ref.path)
      },
    }),
  )
  register(() =>
    registerVersionTarget('memory', {
      read: (ref) => {
        if (ref.kind !== 'memory') return null
        try {
          return Buffer.from(stores.memory.read(ref.path, ref.owner), 'utf8')
        } catch {
          return null
        }
      },
      write: (ref, data) => {
        if (ref.kind === 'memory') stores.memory.write(ref.path, data.toString('utf8'), ref.owner)
      },
    }),
  )

  const fileIdOf = (id: string): { abs: string; ref: FileRef | null } => {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(id)
    } catch {
      // A plain absolute path (a viewer delete).
    }
    if (isObject(parsed) && typeof parsed.folderId === 'string' && typeof parsed.path === 'string') {
      return { abs: folders.resolve(parsed.folderId, parsed.path), ref: { kind: 'folder', folderId: parsed.folderId, path: parsed.path } }
    }
    if (isAbsolute(id)) {
      const grant = folders.folderFor(id)
      return { abs: id, ref: grant ? { kind: 'folder', folderId: grant.id, path: relative(grant.path, id).split(sep).join('/') } : null }
    }
    throw new Error('That file can’t be found.')
  }
  /** Keeps a text file's last content as a 'deleted' version before it moves. */
  const snapshotDeleted = (ref: FileRef | null, abs: string): void => {
    if (!ref) return
    try {
      if (statSync(abs).isFile()) versions.snapshot(ref, readFileSync(abs), 'deleted')
    } catch {
      // No version for an unreadable file.
    }
  }
  const restoreFile = (target: string, files: string[]): string => {
    const from = files[0]
    if (!from) throw new Error('Nothing to restore.')
    const to = freePath(target)
    movePath(from, to)
    return basename(to)
  }
  register(() => {
    registerTrashAdapter({
      kind: 'file',
      title: (id) => basename(fileIdOf(id).abs),
      snapshot: (id) => {
        const { abs, ref } = fileIdOf(id)
        if (!existsSync(abs)) throw new Error('That file no longer exists.')
        snapshotDeleted(ref, abs)
        return { payload: { path: abs, ref }, files: [abs] }
      },
      restore: (payload, files) => {
        if (!isObject(payload) || typeof payload.path !== 'string') throw new Error('This item can’t be restored.')
        const name = restoreFile(payload.path, files)
        const ref = payload.ref as FileRef | null
        if (ref?.kind === 'folder') indexer?.touchSource('folder:')
        return name
      },
    })
    return () => {}
  })
  register(() => {
    registerTrashAdapter({
      kind: 'companion-file',
      title: (id) => {
        const p = JSON.parse(id) as { path: string }
        return basename(p.path)
      },
      snapshot: (id) => {
        const p = JSON.parse(id) as { companionId: string; path: string }
        const ref: FileRef = { kind: 'companion', companionId: p.companionId, path: p.path }
        const abs = companionFile(ref)
        if (!existsSync(abs)) throw new Error('That file no longer exists.')
        snapshotDeleted(ref, abs)
        return { payload: { companionId: p.companionId, path: p.path }, files: [abs] }
      },
      restore: (payload, files) => {
        if (!isObject(payload) || typeof payload.companionId !== 'string' || typeof payload.path !== 'string') throw new Error('This item can’t be restored.')
        if (!stores.companions.find(payload.companionId)) throw new Error('The companion this file belonged to no longer exists.')
        const name = restoreFile(stores.companionFiles.resolve(payload.companionId, payload.path), files)
        const dir = dirname(payload.path)
        stores.companionFiles.emit('changed', payload.companionId, dir === '.' ? name : `${dir}/${name}`)
        return name
      },
    })
    return () => {}
  })
  register(() => {
    registerTrashAdapter({
      kind: 'project',
      title: (id) => projectStore.get(id).name,
      snapshot: (id) => ({ payload: projectStore.trashPayload(id) }),
      restore: (payload) => projectStore.restore(payload as ProjectTrashPayload),
    })
    return () => {}
  })

  // Companion file deletes from the card go to Recently Deleted.
  stores.companionFiles.useRecentlyDeleted((companionId, path) => {
    trash.put('companion-file', JSON.stringify({ companionId, path }))
  })

  // OV-32: deletes in the file viewer become restorable.
  const onViewerDelete = (deleted: ViewerDeletion): void => {
    try {
      const target = isObject(deleted.target) ? deleted.target : null
      if (target?.kind === 'companion-file' && typeof target.companionId === 'string' && typeof target.path === 'string') {
        const abs = stores.companionFiles.resolve(target.companionId, target.path)
        if (existsSync(abs)) trash.put('companion-file', JSON.stringify({ companionId: target.companionId, path: target.path }))
        else if (deleted.trashedPath) trashFromOsTrash(deleted.trashedPath, abs)
        return
      }
      if (target?.kind === 'local' && typeof target.path === 'string') {
        if (existsSync(target.path)) trash.put('file', target.path)
        else if (deleted.trashedPath) trashFromOsTrash(deleted.trashedPath, target.path)
      }
    } catch (err) {
      log.warn('workspace', 'A viewer delete could not be kept in Recently Deleted', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  /** The viewer already moved the file to the system Trash: bring it into Recently Deleted from there. */
  const trashFromOsTrash = (trashed: string, original: string): void => {
    if (!existsSync(trashed)) return
    const holding = freePath(original)
    movePath(trashed, holding)
    try {
      trash.put('file', holding)
    } catch (err) {
      movePath(holding, trashed)
      throw err
    }
  }
  try {
    if (deps.content?.viewer) undo.push(deps.content.viewer.onDelete(onViewerDelete))
  } catch {
    // The file viewer is not available.
  }

  // ── Store events → the index ──
  const on = <T extends { on(e: string, fn: (...args: never[]) => void): unknown; off(e: string, fn: (...args: never[]) => void): unknown }>(emitter: T, event: string, fn: (...args: never[]) => void): void => {
    emitter.on(event, fn)
    undo.push(() => emitter.off(event, fn))
  }
  on(stores.chats, 'changed', ((items: ChatSummary[]) => {
    fileChats(items)
    indexer?.touchSource('chat:')
    projectStore.refresh()
  }) as never)
  on(stores.chats, 'removed', ((ids: string[]) => {
    for (const id of ids) {
      index.remove(`chat:${id}`)
      folders.revokeChat(id)
    }
  }) as never)
  on(stores.history, 'recorded', ((url: string) => indexer?.touch(`history:default:${url}`)) as never)
  on(stores.history, 'removed', ((url: string) => indexer?.touch(`history:default:${url}`)) as never)
  on(stores.history, 'cleared', (() => index.removePrefix('history:default:')) as never)
  on(stores.bookmarks, 'changed', (() => indexer?.touchSource('bookmark:default:')) as never)
  on(stores.memory, 'changed', (() => indexer?.touchSource('memory:')) as never)
  on(stores.companionFiles, 'changed', (() => indexer?.touchSource('companion:')) as never)

  // ── Adapters for other modules ──
  bindWorkspace({
    snapshot: (ref, text, label) => {
      try {
        versions.snapshot(ref, text, label)
      } catch (err) {
        log.warn('workspace', 'A version could not be kept', { error: err instanceof Error ? err.message : String(err) })
      }
    },
    put: (kind, id) => trash.put(kind, id),
    projectPrompt: (projectId) => {
      const p = projectStore.find(projectId)
      return p ? { name: p.name, instructions: p.instructions } : null
    },
    folderFor: (path) => folders.folderFor(path),
  })
  undo.push(() => bindWorkspace(null))

  const profileOf = (windowId: number | null): string => deps.profileOf?.(windowId) ?? 'default'
  const query = (q: string, options: { sources?: SearchSource[]; limit?: number; offset?: number; profile?: string } = {}): { hits: SearchHit[]; total: number } =>
    index.query(q, { ...options, profile: options.profile ?? profileOf(deps.windows.focused()?.id ?? null) })

  // ── Client tools ──
  try {
    registerWorkspaceClientTools({
      folders,
      companionFiles: companionReader,
      companionName: (id) => stores.companions.find(id)?.name ?? 'Companion',
      search: (q, options) => query(q, options),
    })
  } catch (err) {
    log.warn('workspace', 'Client tools already registered', { error: err instanceof Error ? err.message : String(err) })
  }

  const openRow = (hit: SearchHit): OmniboxRow['action'] => {
    if (hit.source === 'history' || hit.source === 'bookmarks') return { kind: 'navigate', url: hit.url ?? '' }
    if (hit.source === 'chats' && hit.url) return { kind: 'open-internal', url: hit.url }
    const ref = hit.ref
    if (ref?.kind === 'memory') return { kind: 'open-internal', url: fileViewerUrl({ kind: 'memory', owner: ref.owner, path: ref.path }) }
    if (ref?.kind === 'companion') return { kind: 'open-internal', url: fileViewerUrl({ kind: 'companion-file', companionId: ref.companionId, path: ref.path }) }
    if (ref?.kind === 'library') return { kind: 'open-internal', url: fileViewerUrl({ kind: 'library', id: ref.id }) }
    if (ref?.kind === 'folder') {
      try {
        return { kind: 'open-internal', url: fileViewerUrl({ kind: 'local', path: folders.resolve(ref.folderId, ref.path) }) }
      } catch {
        // Fall through to the search page.
      }
    }
    return { kind: 'open-internal', url: `${workspaceUrl('search')}?q=${encodeURIComponent(hit.title)}` }
  }
  try {
    undo.push(
      omnibox.registerProvider({
        id: 'search-everything',
        group: mainT('workspace.search.group'),
        order: 70,
        maxRows: 4,
        async query(text, ctx) {
          if (text.trim().length < 2 || ctx.signal.aborted) return []
          const { hits, total } = index.query(text, { limit: 3, profile: ctx.profileId ?? profileOf(ctx.windowId) })
          // Web history already has its own command-bar group; this one shows what only Atelier keeps.
          const rows: OmniboxRow[] = hits.map((hit) => ({ id: `search:${hit.id}`, group: mainT('workspace.search.group'), title: hit.title, subtitle: plainSnippet(hit.snippet), icon: hit.source, action: openRow(hit) }))
          if (total > hits.length) rows.push({ id: 'search:all', group: mainT('workspace.search.group'), title: mainT('workspace.search.seeAll', { count: total }), icon: 'search', action: { kind: 'open-internal', url: `${workspaceUrl('search')}?q=${encodeURIComponent(text.trim())}` } })
          return rows
        },
      }),
    )
  } catch (err) {
    log.warn('workspace', 'Command-bar provider not registered', { error: err instanceof Error ? err.message : String(err) })
  }

  // Switching space from the command bar.
  try {
    undo.push(
      omnibox.registerProvider({
        id: 'spaces',
        group: mainT('workspace.space.switcher'),
        order: 65,
        maxRows: 4,
        async query(text, ctx) {
          const entry = spaceWindows.get(ctx.windowId)
          if (!entry || ctx.signal.aborted || text.trim().length < 2) return []
          const order = unpinned(entry.win)
          const spaces = entry.model.list(projectStore.list(), order, mainT('workspace.space.none'))
          return spaceCommandRows(spaces, text, (projectId) => entry.model.peek(projectId, order), {
            group: mainT('workspace.space.switcher'),
            title: (name) => mainT('workspace.space.switchTo', { name }),
            tabs: (count) => mainT('workspace.space.tabs', { count }),
            keyword: mainT('workspace.space.keyword'),
          })
        },
      }),
    )
  } catch (err) {
    log.warn('workspace', 'Space provider not registered', { error: err instanceof Error ? err.message : String(err) })
  }

  // ── Settings › Storage ──
  register(() =>
    registerStorageCategory({
      id: 'workspace',
      label: mainT('workspace.storage.label'),
      order: 27,
      measure: async () => versions.size() + trash.size() + pathSize(join(dataDir, 'search.sqlite')),
      clear: {
        label: mainT('workspace.storage.clear'),
        run: async () => {
          trash.empty()
          await indexer?.rebuild()
        },
      },
    }),
  )

  // ── Spaces ──
  const unpinned = (win: WindowContext): string[] => win.tabs.all().filter((t) => !t.pinned).map((t) => t.id)
  const pickWindow = (windowId?: number): { model: SpaceModel; win: WindowContext } => {
    const win = windowId !== undefined ? deps.windows.get(windowId) : deps.windows.focused()
    const entry = win ? spaceWindows.get(win.id) : [...spaceWindows.values()][0]
    if (!entry) throw new Error('That window is closed.')
    return entry
  }
  const spacesChanged = (win: WindowContext): void => win.send({ type: 'spaces', windowId: win.id })
  const spaceList = (windowId?: number): SpaceInfo[] => {
    const { model, win } = pickWindow(windowId)
    return model.list(projectStore.list(), unpinned(win), mainT('workspace.space.none'))
  }
  register(() =>
    registerSavedWindowPart({
      save: (windowId, tabIds) => {
        const entry = spaceWindows.get(windowId)
        return entry ? { spaces: entry.model.save(tabIds) } : {}
      },
      restore: (windowId, saved, tabIds) => {
        const entry = spaceWindows.get(windowId)
        if (!entry) return
        entry.model.restore(saved.spaces, tabIds, saved.activeIndex)
        spacesChanged(entry.win)
      },
    }),
  )

  const attachWindow = (win: WindowContext): void => {
    const model = new SpaceModel()
    for (const tab of win.tabs.all()) model.add(tab.id, null)
    const active = win.tabs.active()
    if (active) model.activated(active.id, active.pinned)
    spaceWindows.set(win.id, { model, win })
    win.tabs.on('created', (tab) => {
      model.add(tab.id)
      spacesChanged(win)
    })
    win.tabs.on('closed', (tab) => {
      model.remove(tab.id)
      spacesChanged(win)
    })
    win.tabs.on('activated', (tab) => {
      if (model.activated(tab.id, tab.pinned)) spacesChanged(win)
    })
    win.window.once('closed', () => spaceWindows.delete(win.id))
  }

  // ── Background work ──
  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    timers.push(timer)
  }
  later(deps.smoke ? 50 : 4000, () => void indexer?.build())
  later(deps.smoke ? 100 : 10_000, () => trash.purgeExpired())
  const daily = setInterval(() => trash.purgeExpired(), DAY_MS)
  daily.unref?.()

  const services: WorkspaceServices = {
    search: {
      query: (q, options) => query(q, options),
      recent: (options) => index.recent({ ...options, profile: profileOf(deps.windows.focused()?.id ?? null) }),
      state: () => indexer?.state() ?? { building: false, done: 0, total: 0, updatedAt: null },
      rebuild: () => void indexer?.rebuild(),
    },
    folders: {
      list: () => folders.list(),
      pick: () => deps.shell.pickFolder(),
      grant: (input) => folders.grant(input),
      update: (id, patch) => folders.update(id, patch),
      revoke: (id) => folders.revoke(id),
      entries: (id, sub) => folders.entries(id, sub),
      readText: (id, path) => folders.readText(id, path),
      reveal: (id, path) => deps.shell.reveal(folders.resolve(id, path)),
      open: async (id, path) => {
        const failure = await deps.shell.openPath(folders.resolve(id, path))
        if (failure) throw new Error(failure)
      },
    },
    versions: {
      list: (ref) => versions.list(ref),
      read: (ref, versionId) => versions.read(ref, versionId),
      restore: (ref, versionId) => versions.restore(ref, versionId),
      refFor: (target) => {
        if (target.kind !== 'local') return fileRefFromViewerTarget(target)
        const folder = folders.folderFor(target.path)
        if (!folder) return null
        let real: string
        try {
          real = realpathSync(target.path)
        } catch {
          return null
        }
        const rel = relative(folder.path, real).split(sep).join('/')
        return rel && !rel.startsWith('..') ? { kind: 'folder', folderId: folder.id, path: rel } : null
      },
    },
    projects: {
      list: () => projectStore.list(),
      get: (id) => projectStore.get(id),
      save: (input) => projectStore.save(input),
      remove: (id) => {
        trash.put('project', id)
        projectStore.remove(id)
      },
      addChats: (id, chatIds) => projectStore.addChats(id, chatIds),
      removeChats: (id, chatIds) => projectStore.removeChats(id, chatIds),
      addFiles: (id, refs) => projectStore.addFiles(id, refs),
      removeFiles: (id, refs) => projectStore.removeFiles(id, refs),
      newChat: (id, text) => {
        projectStore.get(id)
        const chatId = text?.trim() ? deps.agent.start(text, { projectId: id }) : deps.agent.create({ projectId: id }).id
        pendingProject.set(chatId, id)
        fileChats(stores.chats.list())
        return chatId
      },
      contextFiles: (id) => {
        const out: Array<{ name: string; base64: string }> = []
        for (const ref of projectStore.get(id).files) {
          if (out.length >= PROJECT_CONTEXT_MAX) break
          const name = fileRefName(ref)
          if (!isTextFileName(name)) continue
          try {
            const bytes = versionTarget(ref.kind)?.read(ref) ?? null
            if (bytes && bytes.length <= TEXT_FILE_MAX_BYTES) out.push({ name, base64: bytes.toString('base64') })
          } catch {
            // A file that moved or went away is left out.
          }
        }
        return out
      },
    },
    spaces: {
      list: (windowId) => spaceList(windowId),
      switchTo: (projectId, windowId) => {
        if (projectId !== null) projectStore.get(projectId)
        const { model, win } = pickWindow(windowId)
        const target = model.switchTo(projectId, unpinned(win))
        if (target) win.tabs.activate(target)
        // An empty space gets a fresh tab, which joins it.
        else win.tabs.create('about:blank', { position: 'top' })
        spacesChanged(win)
      },
      moveTabs: (tabIds, projectId) => {
        if (projectId !== null) projectStore.get(projectId)
        for (const { model, win } of spaceWindows.values()) {
          const mine = tabIds.filter((id) => win.tabs.find(id))
          if (mine.length === 0) continue
          model.move(mine, projectId)
          // The active tab moved away: show another tab of this space, or follow it when none is left.
          const active = win.tabs.active()
          if (active && !active.pinned && mine.includes(active.id) && projectId !== model.active()) {
            const next = model.tabsOf(model.active(), unpinned(win))[0]
            if (next) win.tabs.activate(next)
            else model.activated(active.id)
          }
          spacesChanged(win)
        }
      },
    },
    trash: {
      list: (q) => trash.list(q),
      restore: (ids) => trash.restore(ids),
      purge: (ids) => trash.purge(ids),
      empty: () => trash.empty(),
    },
  }

  return {
    services,
    attachWindow,
    internals: { indexer, index, folders, trash, versions, projects: projectStore },
    dispose() {
      for (const fn of undo.splice(0).reverse()) {
        try {
          fn()
        } catch {
          // Best effort on quit.
        }
      }
      for (const timer of timers) clearTimeout(timer)
      clearInterval(daily)
      if (stateTimer) clearTimeout(stateTimer)
      indexer?.dispose()
      folders.dispose()
      db.close()
      searchDb.close()
    },
  }
}

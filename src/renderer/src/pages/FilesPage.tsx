/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://library/files: the reports, generated files and
// artifacts companions made, grouped by kind. Segments pick a kind; the
// filter button narrows by companion and chat and sorts; search matches
// names. A card opens the file in the viewer (Space looks at it in quick
// look) and its menu reveals, renames, exports or deletes it.
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { AudioLines, ChevronDown, Ellipsis, FileCode2, FileSpreadsheet, FileText, FolderOpen, Globe, Image as ImageIcon, LoaderCircle, Plus, Sparkles, TriangleAlert, Video, File as FileIcon } from 'lucide-react'
import type { ChatSummary, Companion } from '@shared/services'
import type { FilePreviewable, LibraryFileKind, LibraryFileRef } from '@shared/files'
import { kindLabelKey, previewableOf } from '@shared/fileKinds'
import { LIBRARY_SORTS, LIBRARY_VIEW_DEFAULT, chatsWithFiles, filterLibrary, groupLibrary, type LibrarySort, type LibraryView } from '@shared/filesLogic'
import { apex, call, errorText, formatBytes } from '../api'
import { RenameDialog, openQuickLook, openViewer } from '../files'
import { libraryCompanionIds } from '../files/libraryCompanions'
import '../files/files.css'
import { t } from '../i18n/useT'
import { useCompanions, useLiveResource, useLocalPreference } from '../settings/data'
import { DestinationFrame, ListState } from '../settings/destinations/common'
import { DestinationToolbar, PageHeader } from '../settings/kit'
import { CompanionAvatar } from '../settings/companions/CompanionAvatar'
import { Badge, Button, EmptyState, IconButton, RelativeTime, menuSeparator, showContextMenu, showMenu, useConfirm, useToast } from '../ui'
import type { MenuItemSpec } from '@shared/menu'
import { internalQuery } from '@shared/url'

type Segment = LibraryFileKind | 'all'

const GROUP_LABEL: Record<LibraryFileKind, Parameters<typeof t>[0]> = {
  generated: 'files.page.generated',
  report: 'files.page.reports',
  artifact: 'files.page.artifacts',
}

/** Dropping a pile of files opens the first few, each in its own tab. */
const DROP_OPEN_MAX = 5

const SORT_LABEL: Record<LibrarySort, Parameters<typeof t>[0]> = {
  newest: 'files.page.sort.newest',
  oldest: 'files.page.sort.oldest',
  name: 'files.page.sort.name',
  size: 'files.page.sort.size',
}

function KindIcon({ kind }: { kind: FilePreviewable }): ReactElement {
  switch (kind) {
    case 'image':
    case 'svg':
      return <ImageIcon aria-hidden />
    case 'code':
      return <FileCode2 aria-hidden />
    case 'sheet':
      return <FileSpreadsheet aria-hidden />
    case 'html':
      return <Globe aria-hidden />
    case 'audio':
      return <AudioLines aria-hidden />
    case 'video':
      return <Video aria-hidden />
    case 'markdown':
    case 'text':
    case 'pdf':
      return <FileText aria-hidden />
    default:
      return <FileIcon aria-hidden />
  }
}

export interface FilesPageProps {
  tabId: string
  /** The page's address; ?companion=<id> opens it narrowed to that companion (DS-115). */
  url?: string
}

export function FilesPage({ url }: FilesPageProps): ReactElement {
  const files = useLiveResource(() => call('files', 'list'), 'library-files', (e) => e.items)
  const companions = useCompanions()
  const [segment, setSegment] = useState<Segment>('all')
  const [query, setQuery] = useState('')
  const linkedCompanion = url ? internalQuery(url, 'companion') : null
  const [companionId, setCompanionId] = useState(linkedCompanion ?? 'all')
  // A new link (the card's Open in Library) narrows an open page too.
  useEffect(() => {
    if (linkedCompanion) setCompanionId(linkedCompanion)
  }, [linkedCompanion])
  const [chatId, setChatId] = useState('all')
  const [sort, setSort] = useLocalPreference<LibrarySort>('apex.files.sort', 'newest', LIBRARY_SORTS)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [renaming, setRenaming] = useState<LibraryFileRef | null>(null)
  const confirm = useConfirm()
  const toast = useToast()

  const view: LibraryView = { ...LIBRARY_VIEW_DEFAULT, kind: segment, companionId, chatId, query, sort }
  const shown = useMemo(() => filterLibrary(files.data ?? [], view), [files.data, segment, companionId, chatId, query, sort])
  const groups = groupLibrary(shown)
  const filtered = query !== '' || companionId !== 'all' || chatId !== 'all' || segment !== 'all'

  // Chat titles for the cards and the chat filter; deleted chats read as such.
  useEffect(() => {
    void call('chats', 'list').then(setChats, () => setChats([]))
  }, [files.data?.length])
  const chatTitle = (id: string | null): string => {
    if (!id) return t('files.page.deletedChat')
    const chat = chats?.find((c) => c.id === id)
    return chat ? chat.title || t('files.page.untitledChat') : t('files.page.deletedChat')
  }
  const companionName = (id: string): string | null => companions.items?.find((c) => c.id === id)?.name ?? null

  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })
  const open = (file: LibraryFileRef): void => void openViewer({ kind: 'library', id: file.id }, { name: file.name }).catch(fail)

  const remove = async (file: LibraryFileRef): Promise<void> => {
    if (!(await confirm({ title: t('files.delete.title', { name: file.name }), message: t('files.delete.message'), confirmLabel: t('files.delete.confirm'), destructive: true }))) return
    try {
      await call('files', 'remove', file.id)
      toast.show({ message: t('files.toast.deleted', { name: file.name }) })
    } catch (err) {
      fail(err)
    }
  }
  const exportCopy = async (file: LibraryFileRef): Promise<void> => {
    try {
      if (await call('files', 'export', file.id)) toast.show({ tone: 'success', message: t('files.toast.exported') })
    } catch (err) {
      fail(err)
    }
  }

  const menu = (file: LibraryFileRef): MenuItemSpec[] => {
    const ready = file.state === 'ready'
    const kind = previewableOf(file.name, file.mediaType, file.size)
    return [
      { id: 'open', label: t('files.action.open') },
      { id: 'quick-look', label: t('files.action.quickLook') },
      ...(kind === 'html' || kind === 'svg' || kind === 'markdown' ? [{ id: 'artifact', label: t('files.action.openArtifact'), enabled: ready }] : []),
      menuSeparator(),
      { id: 'reveal', label: t('files.action.reveal'), enabled: file.state !== 'writing' },
      { id: 'rename', label: t('files.action.rename'), enabled: file.state !== 'writing' },
      { id: 'export', label: t('files.action.export'), enabled: ready },
      menuSeparator(),
      { id: 'delete', label: t('files.action.delete'), enabled: file.state !== 'writing', danger: true },
    ]
  }
  const act = (file: LibraryFileRef, id: string | null, anchor?: HTMLElement): void => {
    if (id === 'open') open(file)
    else if (id === 'quick-look') void openQuickLook({ kind: 'library', id: file.id }, anchor).catch(fail)
    else if (id === 'artifact') void call('files', 'openArtifact', file.id).catch(fail)
    else if (id === 'reveal') void call('files', 'reveal', file.id).catch(fail)
    else if (id === 'rename') setRenaming(file)
    else if (id === 'export') void exportCopy(file)
    else if (id === 'delete') void remove(file)
  }

  const openFilters = async (anchor: HTMLElement): Promise<void> => {
    const known = chatsWithFiles(files.data ?? [])
    const picked = await showMenu(
      [
        {
          id: 'chat',
          label: t('files.page.filter.chat'),
          submenu: [
            { id: 'chat:all', label: t('files.page.filter.anyChat'), type: 'radio', checked: chatId === 'all' },
            ...known.slice(0, 30).map((id): MenuItemSpec => ({ id: `chat:${id}`, label: chatTitle(id), type: 'radio', checked: chatId === id })),
          ],
        },
        menuSeparator(),
        ...LIBRARY_SORTS.map((s): MenuItemSpec => ({ id: `sort:${s}`, label: t(SORT_LABEL[s]), type: 'radio', checked: sort === s })),
      ],
      anchor,
    )
    if (!picked) return
    const [kind, value] = [picked.slice(0, picked.indexOf(':')), picked.slice(picked.indexOf(':') + 1)]
    if (kind === 'chat') setChatId(value)
    else if (kind === 'sort' && (LIBRARY_SORTS as readonly string[]).includes(value)) setSort(value as LibrarySort)
  }

  // DS-105: the selector pill beside the title narrows the Library to one companion's files.
  const pickCompanion = async (anchor: HTMLElement): Promise<void> => {
    const ids = libraryCompanionIds(companions.items ?? [], files.data ?? [])
    const picked = await showMenu(
      [
        { id: 'all', label: t('files.page.allCompanions'), type: 'radio', checked: companionId === 'all' },
        menuSeparator(),
        ...ids.map((id): MenuItemSpec => ({ id, label: companionName(id) ?? id, type: 'radio', checked: companionId === id })),
      ],
      anchor,
    )
    if (picked) setCompanionId(picked)
  }

  const pickLocal = async (): Promise<void> => {
    try {
      const target = await call('viewer', 'pickLocal')
      if (target) await openViewer(target, { newTab: true })
    } catch (err) {
      fail(err)
    }
  }

  // A file dropped onto the page opens in the viewer, granted for this session like a picked one.
  const hasFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes('Files')
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    void openDropped([...e.dataTransfer.files].slice(0, DROP_OPEN_MAX))
  }
  const openDropped = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      try {
        const path = apex.pathForFile?.(file) ?? null
        const target = path ? await call('viewer', 'grantDropped', path) : null
        if (target) await openViewer(target, { newTab: true })
        else toast.show({ tone: 'error', message: t('files.page.dropUnreadable', { name: file.name }) })
      } catch (err) {
        fail(err)
      }
    }
  }

  const clear = (): void => {
    setQuery('')
    setCompanionId('all')
    setChatId('all')
    setSegment('all')
  }

  return (
    <div style={{ display: 'contents' }} onDragOver={onDragOver} onDrop={onDrop}>
      <DestinationFrame label={t('files.page.label')} variant="fluid">
        <PageHeader
          title={t('files.page.title')}
          aside={
            <CompanionPill
              label={companionId === 'all' ? t('files.page.allCompanions') : (companionName(companionId) ?? t('files.page.allCompanions'))}
              companion={companionId === 'all' ? null : (companions.items?.find((c) => c.id === companionId) ?? null)}
              onPick={(el) => void pickCompanion(el)}
            />
          }
          description={t('files.page.description')}
          actions={
            <Button variant="secondary" icon={<Plus />} onClick={() => void pickLocal()}>
              {t('files.page.openFile')}
            </Button>
          }
        />
        <DestinationToolbar<Segment>
          segments={{
            label: t('files.page.segments'),
            value: segment,
            onChange: setSegment,
            options: [
              { value: 'all', label: t('files.page.all') },
              { value: 'generated', label: t('files.page.generated') },
              { value: 'report', label: t('files.page.reports') },
              { value: 'artifact', label: t('files.page.artifacts') },
            ],
          }}
          search={{ value: query, onChange: setQuery, placeholder: t('files.page.search') }}
          filter={{ label: t('files.page.filter'), active: chatId !== 'all' || sort !== 'newest', onOpen: (el) => void openFilters(el) }}
        />
        <ListState
          items={files.data}
          shown={shown.length}
          error={files.error}
          onRetry={files.reload}
          loadingLabel={t('files.page.loading')}
          onClearFilters={filtered ? clear : undefined}
          empty={
            <EmptyState
              icon={<FolderOpen />}
              title={t('files.page.empty.title')}
              description={t('files.page.empty.description')}
              action={
                <Button variant="primary" onClick={() => void call('pages', 'open', 'apex://chats').catch(fail)}>
                  {t('files.page.empty.chat')}
                </Button>
              }
            />
          }
        >
          {groups.map((group) => (
            <section key={group.kind} aria-labelledby={`lf-group-${group.kind}`}>
              <h2 id={`lf-group-${group.kind}`} className="lf-group__label">
                {t(GROUP_LABEL[group.kind])} <span className="lf-group__count">{group.items.length}</span>
              </h2>
              <ul className="lf-grid">
                {group.items.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    owner={companionName(file.companionId)}
                    chat={chatTitle(file.chatId)}
                    onOpen={() => open(file)}
                    onQuickLook={(el) => act(file, 'quick-look', el)}
                    onMenu={(el) => void showMenu(menu(file), el).then((id) => act(file, id, el))}
                    onContextMenu={(e) => void showContextMenu(e, menu(file)).then((id) => act(file, id))}
                  />
                ))}
              </ul>
            </section>
          ))}
        </ListState>
        <RenameDialog
          name={renaming?.name ?? null}
          onClose={() => setRenaming(null)}
          onRename={async (name) => {
            if (renaming) await call('files', 'rename', renaming.id, name)
          }}
        />
      </DestinationFrame>
    </div>
  )
}

/** DS-105: the selector pill beside the Library title (a floating head when one companion is picked). */
function CompanionPill({ label, companion, onPick }: { label: string; companion: Companion | null; onPick(anchor: HTMLElement): void }): ReactElement {
  return (
    <button type="button" className="lf-selector" aria-haspopup="menu" aria-label={`${t('files.page.whose')}: ${label}`} onClick={(e) => onPick(e.currentTarget)}>
      {companion && (
        <span className="lf-selector__face" aria-hidden>
          <CompanionAvatar look={companion.look} name={companion.name} size={20} />
        </span>
      )}
      <span className="lf-selector__label">{label}</span>
      <ChevronDown size={14} aria-hidden />
    </button>
  )
}

interface FileCardProps {
  file: LibraryFileRef
  owner: string | null
  chat: string
  onOpen(): void
  onQuickLook(anchor: HTMLElement): void
  onMenu(anchor: HTMLElement): void
  onContextMenu(e: MouseEvent): void
}

function FileCard({ file, owner, chat, onOpen, onQuickLook, onMenu, onContextMenu }: FileCardProps): ReactElement {
  const kind = previewableOf(file.name, file.mediaType, file.size)
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    // Space looks at the file in quick look, as in Finder; Enter opens it.
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault()
      onQuickLook(e.currentTarget)
    }
  }
  return (
    <li className={`lf-card${file.state === 'writing' ? ' lf-card--writing' : ''}`} onContextMenu={onContextMenu}>
      <button type="button" className="lf-card__open" onClick={onOpen} onKeyDown={onKeyDown} aria-label={`${file.name}, ${t(kindLabelKey(kind))}, ${formatBytes(file.size)}`} aria-describedby={`lf-meta-${file.id}`}>
        <span className="lf-card__thumb" aria-hidden>
          <span className="lf-card__glyph">{file.artifact ? <Sparkles /> : <KindIcon kind={kind} />}</span>
        </span>
        <span className="lf-card__name" title={file.name}>
          {file.name}
        </span>
        <span id={`lf-meta-${file.id}`} className="lf-card__meta">
          {file.state === 'writing' ? (
            <span className="lf-card__state">
              <LoaderCircle size={12} aria-hidden />
              {t('files.card.writing')}
            </span>
          ) : file.state === 'failed' ? (
            <span className="lf-card__state">
              <TriangleAlert size={12} aria-hidden />
              {t('files.card.failed')}
            </span>
          ) : (
            <span>{formatBytes(file.size)}</span>
          )}
          <span aria-hidden>·</span>
          <span>
            <RelativeTime value={file.createdAt} />
          </span>
          <span className="lf-card__source" title={chat}>
            {[owner, chat].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="lf-card__foot">
          <Badge>{t(kindLabelKey(kind))}</Badge>
        </span>
      </button>
      <span className="lf-card__more">
        <IconButton size="sm" label={t('files.card.more', { name: file.name })} aria-haspopup="menu" icon={<Ellipsis />} onClick={(e) => onMenu(e.currentTarget)} />
      </span>
    </li>
  )
}

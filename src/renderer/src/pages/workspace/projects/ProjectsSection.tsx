/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Projects (SH-64), atelier://workspace/projects[/<id>]: a
// project keeps a name, a colour from Atelier's palette, a description, the
// instructions every new chat in it starts with, its chats and its files.
// The list searches and opens; a project's page lists its chats and files
// with add and remove, starts a chat in it, edits and deletes it (to
// Recently deleted; its chats stay, outside any project).
import { useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, Brain, File, FolderKanban, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import type { ChatSummary } from '@shared/chats'
import { chatUrl } from '@shared/url'
import { fileRefKey, fileRefName, sameFileRef, type FileRef, type Project } from '@shared/workspace'
import { call } from '../../../api'
import { addSource } from '../../../chat/composer/store'
import { useT } from '../../../i18n/useT'
import { useEvent, useResource } from '../../../settings/data'
import { Button, EmptyState, ErrorState, IconButton, RelativeTime, SegmentedControl, SkeletonRows, VisuallyHidden, confirm, menuSeparator, showMenu, toast } from '../../../ui'
import { openProjectEditor } from '../../../workspace/ProjectEditor'
import { useFolders, useProjects } from '../../../workspace/data'
import { ProjectDot, SearchBox, SectionHead } from '../../../workspace/kit'
import { filterProjects, projectColor } from '../../../workspace/logic'
import { fail, goWorkspace, openFileRef } from '../../../workspace/open'
import { mountDialog } from '../../../workspace/mount'
import type { WorkspaceSectionProps } from '../sections'
import { PickDialog, type PickItem } from './PickDialog'

type T = ReturnType<typeof useT>

export default function ProjectsSection({ itemId = null }: WorkspaceSectionProps): ReactElement {
  const projects = useProjects()
  if (!itemId) return <ProjectList projects={projects.data} loading={projects.loading} error={projects.error} reload={projects.reload} />
  const project = projects.data?.find((p) => p.id === itemId) ?? null
  if (projects.loading && !projects.data) return <SkeletonRows rows={6} />
  if (!project) return <MissingProject error={projects.error} reload={projects.reload} />
  return <ProjectPage key={project.id} project={project} />
}

/** Starts a chat in the project (its instructions go into the chat's prompt) and offers the project's text files as attachments. */
async function newChatIn(project: Project): Promise<void> {
  try {
    const chatId = await call('projects', 'newChat', project.id)
    if (project.files.length > 0) {
      const files = await call('projects', 'contextFiles', project.id).catch(() => [])
      for (const file of files) void addSource(chatId, { type: 'file', name: file.name, base64: file.base64 })
    }
    await call('pages', 'open', chatUrl(chatId))
  } catch (err) {
    fail(err)
  }
}

async function deleteProject(t: T, project: Project): Promise<boolean> {
  const ok = await confirm({ title: t('workspace.projects.deleteTitle', { name: project.name }), message: t('workspace.projects.deleteText'), confirmLabel: t('workspace.projects.deleteConfirm'), destructive: true })
  if (!ok) return false
  try {
    await call('projects', 'remove', project.id)
    toast.show({ message: t('workspace.projects.deleted', { name: project.name }), tone: 'success', action: { label: t('workspace.section.trash'), onAction: () => goWorkspace('trash') } })
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

function createProject(): void {
  openProjectEditor(null)
    .then((created) => created && goWorkspace('projects', created.id))
    .catch(fail)
}

function ProjectList({ projects, loading, error, reload }: { projects: Project[] | null; loading: boolean; error: string | null; reload(): Promise<void> }): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterProjects(projects ?? [], query), [projects, query])

  const rowMenu = async (project: Project, anchor: Element): Promise<void> => {
    const id = await showMenu(
      [
        { id: 'open', label: t('workspace.projects.open') },
        { id: 'chat', label: t('workspace.projects.newChat') },
        { id: 'edit', label: t('workspace.projects.edit') },
        menuSeparator(),
        { id: 'delete', label: t('workspace.projects.delete'), danger: true },
      ],
      anchor,
    )
    if (id === 'open') goWorkspace('projects', project.id)
    else if (id === 'chat') void newChatIn(project)
    else if (id === 'edit') void openProjectEditor(project).catch(fail)
    else if (id === 'delete') void deleteProject(t, project)
  }

  let body: ReactElement
  if (loading && !projects) body = <SkeletonRows rows={5} label={t('workspace.section.projects')} />
  else if (error && !projects) body = <ErrorState title={t('workspace.loadError')} message={error} onRetry={reload} />
  else if (!projects || projects.length === 0)
    body = (
      <EmptyState
        icon={<FolderKanban />}
        title={t('workspace.projects.emptyTitle')}
        description={t('workspace.projects.emptyText')}
        action={
          <Button variant="primary" icon={<Plus />} onClick={createProject}>
            {t('workspace.projects.new')}
          </Button>
        }
      />
    )
  else if (shown.length === 0) body = <EmptyState compact title={t('workspace.projects.noMatch', { query })} />
  else
    body = (
      <table className="ws-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.projects.colName')}</th>
            <th className="ws-col-num" scope="col">
              {t('workspace.projects.colChats')}
            </th>
            <th className="ws-col-num" scope="col">
              {t('workspace.projects.colFiles')}
            </th>
            <th className="ws-col-time" scope="col">
              {t('workspace.projects.colChanged')}
            </th>
            <th className="ws-col-more" scope="col">
              <VisuallyHidden>{t('workspace.more')}</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="ws-name">
                  <ProjectDot color={p.color} />
                  <button type="button" className="ws-link" onClick={() => goWorkspace('projects', p.id)} title={p.description || p.name}>
                    {p.name}
                  </button>
                  {p.description && <span className="ws-muted ws-name__extra">{p.description}</span>}
                </span>
              </td>
              <td>{p.chatIds.length}</td>
              <td>{p.files.length}</td>
              <td>
                <RelativeTime value={p.updatedAt} />
              </td>
              <td className="ws-col-more">
                <IconButton size="sm" label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void rowMenu(p, e.currentTarget)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )

  return (
    <>
      <SectionHead
        title={t('workspace.section.projects')}
        subtitle={t('workspace.projects.subtitle')}
        actions={
          projects && projects.length > 0 ? (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={createProject}>
              {t('workspace.projects.new')}
            </Button>
          ) : null
        }
      />
      <div className="ws-card__body">
        {projects && projects.length > 0 && (
          <div className="ws-toolbar">
            <SearchBox className="ws-toolbar__grow" value={query} onChange={setQuery} placeholder={t('workspace.projects.searchPlaceholder')} />
          </div>
        )}
        {body}
      </div>
    </>
  )
}

function MissingProject({ error, reload }: { error: string | null; reload(): Promise<void> }): ReactElement {
  const t = useT()
  return (
    <>
      <SectionHead title={t('workspace.section.projects')} />
      <div className="ws-card__body">
        {error ? (
          <ErrorState title={t('workspace.loadError')} message={error} onRetry={reload} />
        ) : (
          <EmptyState
            icon={<FolderKanban />}
            title={t('workspace.projects.missing')}
            action={
              <Button icon={<ArrowLeft />} onClick={() => goWorkspace('projects')}>
                {t('workspace.projects.back')}
              </Button>
            }
          />
        )}
      </div>
    </>
  )
}

function fileIcon(ref: FileRef): ReactElement {
  return ref.kind === 'memory' ? <Brain aria-hidden /> : <File aria-hidden />
}

function ProjectPage({ project }: { project: Project }): ReactElement {
  const t = useT()
  const [tab, setTab] = useState<'chats' | 'files'>('chats')
  const chats = useResource(() => call('chats', 'list'))
  useEvent('chats', (e) => chats.set(e.items))
  const folders = useFolders()
  const mine = useMemo(() => (chats.data ?? []).filter((c) => c.projectId === project.id || project.chatIds.includes(c.id)), [chats.data, project.chatIds, project.id])

  const removeChat = (chat: ChatSummary): void => {
    Promise.resolve(call('projects', 'removeChats', project.id, [chat.id])).catch(fail)
  }
  const removeFile = (ref: FileRef): void => {
    Promise.resolve(call('projects', 'removeFiles', project.id, [ref])).catch(fail)
  }

  const addChats = (): void => {
    void mountDialog<void>((done) => (
      <PickDialog
        title={t('workspace.projects.pickChats', { name: project.name })}
        load={async (query) => {
          const list = await call('chats', 'list', query ? { query } : undefined)
          return list
            .filter((c) => !c.private && !c.draft && c.projectId !== project.id && !project.chatIds.includes(c.id))
            .slice(0, 200)
            .map((c): PickItem => ({ id: c.id, label: c.title || t('workspace.projects.untitled'), icon: <MessageSquare aria-hidden />, detail: <RelativeTime value={c.lastActiveAt} style="short" /> }))
        }}
        onAdd={async (ids) => {
          try {
            await call('projects', 'addChats', project.id, ids)
            toast.show({ message: t('workspace.projects.added', { count: ids.length }), tone: 'success' })
          } catch (err) {
            fail(err)
            throw err
          }
        }}
        onClose={() => done()}
      />
    ))
  }

  const addFiles = (): void => {
    const refs = new Map<string, FileRef>()
    void mountDialog<void>((done) => (
      <PickDialog
        title={t('workspace.projects.pickFiles', { name: project.name })}
        load={async (query) => {
          const hits = query ? (await call('search', 'query', query, { sources: ['files', 'memory'], limit: 100 })).hits : await call('search', 'recent', { sources: ['files', 'memory'], limit: 100 })
          return hits
            .filter((h) => h.ref && !project.files.some((f) => sameFileRef(f, h.ref!)))
            .map((h): PickItem => {
              const ref = h.ref!
              const key = fileRefKey(ref)
              refs.set(key, ref)
              return { id: key, label: h.title || fileRefName(ref), icon: fileIcon(ref), detail: <RelativeTime value={h.at} style="short" /> }
            })
        }}
        onAdd={async (ids) => {
          const chosen = ids.map((id) => refs.get(id)).filter((r): r is FileRef => Boolean(r))
          if (chosen.length === 0) return
          try {
            await call('projects', 'addFiles', project.id, chosen)
            toast.show({ message: t('workspace.projects.added', { count: chosen.length }), tone: 'success' })
          } catch (err) {
            fail(err)
            throw err
          }
        }}
        onClose={() => done()}
      />
    ))
  }

  const more = async (anchor: Element): Promise<void> => {
    const id = await showMenu([{ id: 'edit', label: t('workspace.projects.edit') }, menuSeparator(), { id: 'delete', label: t('workspace.projects.delete'), danger: true }], anchor)
    if (id === 'edit') void openProjectEditor(project).catch(fail)
    else if (id === 'delete' && (await deleteProject(t, project))) goWorkspace('projects')
  }

  let list: ReactElement
  if (tab === 'chats') {
    if (chats.loading && !chats.data) list = <SkeletonRows rows={4} />
    else if (chats.error && !chats.data) list = <ErrorState compact title={t('workspace.loadError')} message={chats.error} onRetry={() => chats.reload()} />
    else if (mine.length === 0)
      list = (
        <EmptyState
          compact
          icon={<MessageSquare />}
          title={t('workspace.projects.noChats')}
          description={t('workspace.projects.noChatsText')}
          action={
            <Button size="sm" icon={<MessageSquarePlus />} onClick={() => void newChatIn(project)}>
              {t('workspace.projects.newChat')}
            </Button>
          }
        />
      )
    else
      list = (
        <ul className="ws-plain-list ws-rows">
          {mine.map((c) => (
            <li key={c.id} className="ws-row">
              <span className="ws-name__tile">
                <MessageSquare aria-hidden />
              </span>
              <button type="button" className="ws-link ws-row__main" onClick={() => Promise.resolve(call('pages', 'open', chatUrl(c.id))).catch(fail)}>
                {c.title || t('workspace.projects.untitled')}
              </button>
              <RelativeTime value={c.lastActiveAt} style="short" className="ws-muted" />
              <IconButton size="sm" label={`${t('workspace.projects.remove')}: ${c.title || t('workspace.projects.untitled')}`} icon={<X />} onClick={() => removeChat(c)} />
            </li>
          ))}
        </ul>
      )
  } else if (project.files.length === 0)
    list = <EmptyState compact icon={<File />} title={t('workspace.projects.noFiles')} description={t('workspace.projects.noFilesText')} action={<Button size="sm" icon={<Plus />} onClick={addFiles}>{t('workspace.projects.addFiles')}</Button>} />
  else
    list = (
      <ul className="ws-plain-list ws-rows">
        {project.files.map((ref) => (
          <li key={fileRefKey(ref)} className="ws-row">
            <span className="ws-name__tile">{fileIcon(ref)}</span>
            <button type="button" className="ws-link ws-row__main" onClick={() => openFileRef(ref, folders.data ?? [])}>
              {fileRefName(ref)}
            </button>
            <span className="ws-muted">{t(`workspace.projects.fileKind.${ref.kind}`)}</span>
            <IconButton size="sm" label={`${t('workspace.projects.remove')}: ${fileRefName(ref)}`} icon={<X />} onClick={() => removeFile(ref)} />
          </li>
        ))}
      </ul>
    )

  return (
    <>
      <SectionHead
        lead={<IconButton label={t('workspace.projects.back')} icon={<ArrowLeft />} onClick={() => goWorkspace('projects')} />}
        title={
          <span className="ws-project__meta">
            <ProjectDot color={project.color} label={t(`workspace.color.${projectColor(project.color)}`)} />
            {project.name}
          </span>
        }
        subtitle={project.description || undefined}
        actions={
          <>
            <Button size="sm" variant="primary" icon={<MessageSquarePlus />} onClick={() => void newChatIn(project)}>
              {t('workspace.projects.newChat')}
            </Button>
            <IconButton label={t('workspace.projects.edit')} icon={<Pencil />} onClick={() => void openProjectEditor(project).catch(fail)} />
            <IconButton label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void more(e.currentTarget)} />
          </>
        }
      />
      <div className="ws-card__body">
        <h3 className="ws-subhead">{t('workspace.projects.instructions')}</h3>
        {project.instructions ? <p className="ws-project__instructions">{project.instructions}</p> : <p className="ws-muted ws-project__none">{t('workspace.projects.noInstructions')}</p>}
        <div className="ws-toolbar ws-segments">
          <SegmentedControl<'chats' | 'files'>
            label={t('workspace.projects.contents')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'chats', label: `${t('workspace.projects.chats')} · ${mine.length}` },
              { value: 'files', label: `${t('workspace.projects.files')} · ${project.files.length}` },
            ]}
          />
          <span className="ws-toolbar__grow" />
          {tab === 'chats' ? (
            <Button size="sm" icon={<Plus />} onClick={addChats}>
              {t('workspace.projects.addChats')}
            </Button>
          ) : (
            <Button size="sm" icon={<Plus />} onClick={addFiles}>
              {t('workspace.projects.addFiles')}
            </Button>
          )}
        </div>
        {list}
      </div>
    </>
  )
}


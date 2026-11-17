/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Workspace hub's Home: the newest files Apex knows, projects
// and apps, each with a way to see them all under its tab. With nothing in
// any of them, one empty state offers the three ways to start. Search
// everything is the hub's own field, above the tabs.
import { useState, type ReactElement, type ReactNode } from 'react'
import { AppWindow, Brain, File, FolderPlus, LayoutGrid, Plus } from 'lucide-react'
import type { AppSummary } from '@shared/apps'
import { appRunUrl } from '@shared/url'
import type { SearchHit, WorkspaceSection } from '@shared/workspace'
import { apex, call } from '../../../api'
import { NewAppSheet } from '../../../apps/NewAppSheet'
import { useT } from '../../../i18n/useT'
import { useEvent, useResource, type Resource } from '../../../settings/data'
import { Button, EmptyState, ErrorState, RelativeTime, SkeletonRows, useToast } from '../../../ui'
import { shareFolder } from '../../../workspace/FolderAccessDialog'
import { openProjectEditor } from '../../../workspace/ProjectEditor'
import { useFolders, useProjects } from '../../../workspace/data'
import { ProjectDot, SectionHead } from '../../../workspace/kit'
import { fail, goWorkspace, openFileRef } from '../../../workspace/open'

const TILES = 6

export default function HomeSection(): ReactElement {
  const t = useT()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const folders = useFolders()
  const projects = useProjects()
  const recent = useResource(() => call('search', 'recent', { sources: ['files', 'memory'], limit: TILES }))
  useEvent('search-index', (e) => {
    if (!e.state.building) void recent.reload()
  })
  const apps = useResource(() => call('apps', 'list'))
  useEvent('apps', (e) => apps.set(e.items))

  const newest = <T extends { updatedAt: number }>(items: readonly T[] | null): T[] => [...(items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, TILES)
  const newProject = (): void => void openProjectEditor(null).then((p) => p && goWorkspace('projects', p.id)).catch(fail)
  const share = (): void => void shareFolder(null).catch(fail)
  const empty = recent.data?.length === 0 && projects.data?.length === 0 && apps.data?.length === 0

  return (
    <>
      <SectionHead title={t('workspace.section.home')} subtitle={empty ? undefined : t('workspace.home.subtitle')} />
      <div className="ws-card__body">
        {empty ? (
          <EmptyState
            icon={<LayoutGrid />}
            title={t('workspace.home.emptyTitle')}
            description={t('workspace.home.emptyText')}
            action={
              <div className="ws-home__starts">
                <Button variant="primary" icon={<Plus />} onClick={newProject}>
                  {t('workspace.projects.new')}
                </Button>
                <Button icon={<FolderPlus />} onClick={share}>
                  {t('workspace.files.add')}
                </Button>
                <Button icon={<AppWindow />} onClick={() => setCreating(true)}>
                  {t('platform.apps.new.button')}
                </Button>
              </div>
            }
          />
        ) : (
          <div className="ws-home">
            <HomeBlock
              title={t('workspace.home.recentFiles')}
              section="files"
              resource={recent}
              empty={
                <>
                  <span className="ws-home__empty">{t('workspace.home.noFiles')}</span>{' '}
                  <Button size="sm" variant="ghost" icon={<FolderPlus />} onClick={share}>
                    {t('workspace.files.add')}
                  </Button>
                </>
              }
              render={(hits: SearchHit[]) =>
                hits.map((hit) => (
                  <button key={hit.id} type="button" className="ws-tile" onClick={() => hit.ref && openFileRef(hit.ref, folders.data ?? [], hit.title)}>
                    <span className="ws-tile__title">
                      {hit.source === 'memory' ? <Brain aria-hidden /> : <File aria-hidden />}
                      {hit.title}
                    </span>
                    <RelativeTime value={hit.at} className="ws-tile__meta" />
                  </button>
                ))
              }
            />

            <HomeBlock
              title={t('workspace.home.projects')}
              section="projects"
              resource={projects}
              empty={
                <>
                  <span className="ws-home__empty">{t('workspace.home.noProjects')}</span>{' '}
                  <Button size="sm" variant="ghost" icon={<Plus />} onClick={newProject}>
                    {t('workspace.projects.new')}
                  </Button>
                </>
              }
              render={(items) =>
                newest(items).map((p) => (
                  <button key={p.id} type="button" className="ws-tile" onClick={() => goWorkspace('projects', p.id)}>
                    <span className="ws-tile__title">
                      <ProjectDot color={p.color} />
                      {p.name}
                    </span>
                    <span className="ws-tile__meta">
                      {t('workspace.projects.chatCount', { count: p.chatIds.length })} · {t('workspace.projects.fileCount', { count: p.files.length })}
                    </span>
                  </button>
                ))
              }
            />

            <HomeBlock
              title={t('workspace.home.apps')}
              section="apps"
              resource={apps}
              empty={
                <>
                  <span className="ws-home__empty">{t('workspace.home.noApps')}</span>{' '}
                  <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setCreating(true)}>
                    {t('platform.apps.new.button')}
                  </Button>
                </>
              }
              render={(items: AppSummary[]) =>
                newest(items).map((a) => (
                  <button key={a.id} type="button" className="ws-tile" onClick={() => apex.tabs.create(appRunUrl(a.id)).catch(fail)}>
                    <span className="ws-tile__title">
                      <AppWindow aria-hidden />
                      {a.name}
                    </span>
                    <span className="ws-tile__meta">{a.description || <RelativeTime value={a.updatedAt} />}</span>
                  </button>
                ))
              }
            />
          </div>
        )}
      </div>
      <NewAppSheet
        open={creating}
        onClose={(chatId) => {
          setCreating(false)
          if (chatId) toast.show({ message: t('platform.apps.new.started') })
        }}
      />
    </>
  )
}

function HomeBlock<T>({ title, section, resource, empty, render }: { title: string; section: WorkspaceSection; resource: Resource<T[]>; empty: ReactNode; render(items: T[]): ReactNode }): ReactElement {
  const t = useT()
  const id = `ws-home-${section}`
  const items = resource.data
  let content: ReactNode
  if (resource.loading && !items) content = <SkeletonRows rows={2} label={title} />
  else if (resource.error && !items) content = <ErrorState compact title={t('workspace.loadError')} message={resource.error} onRetry={() => resource.reload()} />
  else if (!items || items.length === 0) content = <p>{empty}</p>
  else content = <div className="ws-home__grid">{render(items)}</div>
  return (
    <section className="ws-home__section" aria-labelledby={id}>
      <h3 id={id}>
        {title}
        <button type="button" className="ws-link ws-muted" onClick={() => goWorkspace(section)}>
          {t('workspace.home.seeAll')}
        </button>
      </h3>
      {content}
    </section>
  )
}

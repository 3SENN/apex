/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://skills[/<id>] (SK-01): saved instructions you call with /name, in
// three groups (yours, companions', built-in), with search, sort and
// filters, cards with Run, and create and import. apex://skills/<id> (and
// /new) opens the skill as a page; ?tab= picks the group and ?file= a file.
import { useMemo, useState, type ReactElement } from 'react'
import { Copy, MoreHorizontal, Play, Plus, Upload, WandSparkles } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import { filterSkills, skillSegment, type Skill, type SkillFilter } from '@shared/skills'
import { chatUrl, internalQuery, skillUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button, ErrorState, IconButton, RelativeTime, SkeletonRows, showMenu, useConfirm, useToast } from '../ui'
import { ExportDialog } from '../ui/ExportDialog'
import { useCompanions, useEvent, useLocalPreference, useResource } from '../settings/data'
import { DestinationEmpty, DestinationFrame } from '../settings/destinations/common'
import { DestinationToolbar, PageHeader, TileGrid } from '../settings/kit'
import { updatedSince, type UpdatedWithin } from '../companion-card/logic/skills'
import { SkillEditorPage } from '../skills/SkillEditorPage'
import '../skills/skills.css'
import { shareAsPack } from '../packs/share'

type Segment = 'yours' | 'companions' | 'builtin' | 'packs'
type Sort = NonNullable<SkillFilter['sort']>
const SEGMENTS: readonly Segment[] = ['yours', 'companions', 'builtin', 'packs']
const SORTS: readonly Sort[] = ['recent-use', 'recent-update', 'name']
const WITHIN: readonly UpdatedWithin[] = ['any', 'week', 'month', 'year']

export interface SkillsPageProps {
  tabId: string
  /** apex://skills/<id> opens that skill; 'new' starts one. */
  itemId?: string | null
  /** The whole address, for ?tab= and ?file=. */
  url?: string
}

export function SkillsPage({ tabId, itemId = null, url = '' }: SkillsPageProps): ReactElement {
  if (itemId) return <SkillEditorPage key={itemId} tabId={tabId} skillId={itemId} file={internalQuery(url, 'file')} />
  return <SkillsList tabId={tabId} url={url} />
}

function SkillsList({ tabId, url }: { tabId: string; url: string }): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const skills = useResource(() => call('skills', 'list'))
  useEvent('skills', (e) => skills.set(e.items))
  const companions = useCompanions()
  const tab = internalQuery(url, 'tab')
  const [stored, setSegment] = useLocalPreference<Segment>('apex.skills.segment', 'yours', SEGMENTS)
  const segment: Segment = tab && (SEGMENTS as readonly string[]).includes(tab) ? (tab as Segment) : stored
  const [query, setQuery] = useState('')
  const [sort, setSort] = useLocalPreference<Sort>('apex.skills.sortD', 'recent-use', SORTS)
  const [owner, setOwner] = useState<string>('')
  const [within, setWithin] = useState<UpdatedWithin>('any')
  const [exporting, setExporting] = useState<Skill | null>(null)
  const all = skills.data ?? []
  const names = new Map((companions.items ?? []).map((c) => [c.id, c.name]))

  const counts = useMemo(() => {
    const c = { yours: 0, companions: 0, builtin: 0, packs: 0 }
    for (const s of all) c[skillSegment(s, SHARED_OWNER)]++
    return c
  }, [all])
  const shown = useMemo(() => {
    const since = updatedSince(within)
    return filterSkills(all, { source: segment, query, sort, ...(owner && segment === 'companions' ? { owner } : {}), ...(since !== undefined && segment !== 'builtin' && segment !== 'packs' ? { updatedSince: since } : {}) }, SHARED_OWNER)
  }, [all, segment, query, sort, owner, within])
  const filtered = query !== '' || owner !== '' || within !== 'any'

  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })
  const pickSegment = (next: Segment): void => {
    setSegment(next)
    if (tab) void apex.nav.go(tabId, 'apex://skills')
  }
  const open = (s: Skill): void => void apex.nav.go(tabId, skillUrl(s.id))
  const newSkill = (): void => void apex.nav.go(tabId, 'apex://skills/new')
  const importSkill = (): void => {
    call('skills', 'importFile').then((s) => {
      if (!s) return
      toast.show({ tone: 'success', message: t('skills.page.imported', { name: s.name }), action: { label: t('skills.page.open'), onAction: () => open(s) } })
    }, fail)
  }
  const run = (s: Skill): void => {
    call('skills', 'run', s.id).then((chatId) => void call('pages', 'open', chatUrl(chatId)), fail)
  }
  const duplicate = (s: Skill): void => {
    call('skills', 'duplicate', s.id).then((copy) => {
      toast.show({ tone: 'success', message: t('skills.page.duplicated', { name: copy.name }), action: { label: t('skills.page.open'), onAction: () => open(copy) } })
    }, fail)
  }
  const remove = async (s: Skill): Promise<void> => {
    const ok = await confirm({ title: t('skills.page.deleteTitle', { name: s.name }), message: t('skills.page.deleteBody'), destructive: true })
    if (!ok) return
    call('skills', 'remove', s.id).then(() => toast.show({ message: t('skills.page.deleted', { name: s.name }) }), fail)
  }
  const menu = async (s: Skill, anchor: Element): Promise<void> => {
    const user = s.source === 'user'
    const choice = await showMenu(
      [
        { id: 'open', label: t('skills.page.open') },
        { id: 'duplicate', label: user ? t('skills.page.duplicate') : t('skills.page.duplicateToEdit') },
        { id: 'export', label: t('skills.page.exportFile') },
        ...(user ? [{ id: 'share-pack', label: t('packs.share.action') }, { id: 'folder', label: t('skills.page.exportFolder') }, { id: 'reveal', label: t('skills.page.reveal') }, { id: 'sep', label: '', type: 'separator' as const }, { id: 'delete', label: t('skills.page.delete'), danger: true }] : []),
      ],
      anchor,
    )
    if (choice === 'open') open(s)
    else if (choice === 'duplicate') duplicate(s)
    else if (choice === 'export') setExporting(s)
    else if (choice === 'folder') call('skills', 'exportFile', s.id).then((path) => path && toast.show({ tone: 'success', message: t('skills.page.saved', { file: path.split(/[\\/]/).pop() ?? path }) }), fail)
    else if (choice === 'reveal') call('skills', 'reveal', s.id).catch(fail)
    else if (choice === 'share-pack') void shareAsPack('skill', s.id)
    else if (choice === 'delete') void remove(s)
  }
  const filterMenu = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'sort', label: t('skills.page.sort'), submenu: SORTS.map((v) => ({ id: `sort:${v}`, label: t(v === 'recent-use' ? 'skills.page.sort.recentUse' : v === 'recent-update' ? 'skills.page.sort.recentUpdate' : 'skills.page.sort.name'), type: 'radio' as const, checked: sort === v })) },
        ...(segment === 'companions'
          ? [{ id: 'owner', label: t('skills.page.owner'), submenu: [{ id: 'owner:', label: t('skills.page.owner.all'), type: 'radio' as const, checked: owner === '' }, ...(companions.items ?? []).map((c) => ({ id: `owner:${c.id}`, label: c.name, type: 'radio' as const, checked: owner === c.id }))] }]
          : []),
        ...(segment !== 'builtin' && segment !== 'packs' ? [{ id: 'updated', label: t('skills.page.updated'), submenu: WITHIN.map((w) => ({ id: `within:${w}`, label: t(`skills.page.updated.${w}`), type: 'radio' as const, checked: within === w })) }] : []),
      ],
      anchor,
    )
    if (!choice) return
    const [key, value = ''] = choice.split(':')
    if (key === 'sort') setSort(value as Sort)
    else if (key === 'owner') setOwner(value)
    else if (key === 'within') setWithin(value as UpdatedWithin)
  }

  const label = (s: Segment): string => t(s === 'yours' ? 'skills.page.yours' : s === 'companions' ? 'skills.page.companions' : s === 'packs' ? 'skills.page.packs' : 'skills.page.builtins')
  return (
    <DestinationFrame label={t('skills.page.title')}>
      <PageHeader
        title={t('skills.page.title')}
        description={t('skills.page.description')}
        actions={
          <>
            <Button variant="secondary" icon={<Upload />} onClick={importSkill}>
              {t('skills.page.import')}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={newSkill}>
              {t('skills.page.new')}
            </Button>
          </>
        }
      />
      <DestinationToolbar
        segments={{ label: t('skills.page.segments'), value: segment, options: SEGMENTS.map((s) => ({ value: s, label: <>{label(s)}{skills.data && <span className="sk-count">{counts[s]}</span>}</> })), onChange: pickSegment }}
        search={{ value: query, onChange: setQuery, placeholder: t('skills.page.search') }}
        filter={{ label: t('skills.page.filters'), active: owner !== '' || within !== 'any' || sort !== 'recent-use', onOpen: (a) => void filterMenu(a) }}
      />
      {skills.loading && !skills.data && <SkeletonRows rows={4} label={t('skills.page.loading')} />}
      {skills.error && !skills.data && <ErrorState message={skills.error} onRetry={skills.reload} />}
      {skills.data && shown.length === 0 && (
        filtered ? (
          <DestinationEmpty
            icon={<WandSparkles />}
            title={t('skills.page.noMatch')}
            primary={
              <Button variant="secondary" onClick={() => { setQuery(''); setOwner(''); setWithin('any') }}>
                {t('skills.page.clear')}
              </Button>
            }
          />
        ) : (
          <DestinationEmpty
            icon={<WandSparkles />}
            title={t(segment === 'yours' ? 'skills.page.empty.yours' : segment === 'companions' ? 'skills.page.empty.companions' : segment === 'packs' ? 'skills.page.empty.packs' : 'skills.page.empty.builtins')}
            description={segment === 'builtin' ? undefined : t(segment === 'yours' ? 'skills.page.empty.yoursHint' : segment === 'packs' ? 'skills.page.empty.packsHint' : 'skills.page.empty.companionsHint')}
            primary={segment === 'builtin' || segment === 'packs' ? undefined : <Button variant="primary" icon={<Plus />} onClick={newSkill}>{t('skills.page.new')}</Button>}
            secondary={segment === 'builtin' || segment === 'packs' ? undefined : <Button variant="secondary" icon={<Upload />} onClick={importSkill}>{t('skills.page.import')}</Button>}
          />
        )
      )}
      {shown.length > 0 && (
        <TileGrid columns={2} label={t('skills.page.list')}>
          {shown.map((s) => (
            <SkillCard key={s.id} skill={s} ownerName={s.owner !== SHARED_OWNER ? (names.get(s.owner) ?? null) : null} onOpen={() => open(s)} onRun={() => run(s)} onMenu={(a) => void menu(s, a)} onDuplicate={() => duplicate(s)} />
          ))}
        </TileGrid>
      )}
      {exporting && <ExportDialog kind="skill" ids={[exporting.id]} title={`/${exporting.name}`} onClose={() => setExporting(null)} />}
    </DestinationFrame>
  )
}

function SkillCard({ skill: s, ownerName, onOpen, onRun, onMenu, onDuplicate }: { skill: Skill; ownerName: string | null; onOpen(): void; onRun(): void; onMenu(anchor: Element): void; onDuplicate(): void }): ReactElement {
  const t = useT()
  const builtin = s.source !== 'user'
  return (
    <article className="sk-card" role="listitem" aria-label={`/${s.name}`}>
      <button type="button" className="sk-card__main" onClick={onOpen}>
        <span className="sk-card__name sp-mono">/{s.name}</span>
        <span className="sk-card__desc">{s.description}</span>
      </button>
      <div className="sk-card__meta">
        {s.source === 'builtin' && <Badge>{t('skills.builtin')}</Badge>}
        {s.source === 'pack' && s.pack && <Badge tone="info">{t('skills.fromPack', { pack: s.pack.name })}</Badge>}
        {!builtin && s.owner === SHARED_OWNER && <Badge tone="accent">{t('skills.page.sharedMarker')}</Badge>}
        {ownerName && <Badge>{ownerName}</Badge>}
        {s.steps.length > 0 && <span>{t('skills.page.steps', { count: s.steps.length })}</span>}
        {s.files.length > 0 && <span>{t('skills.page.files', { count: s.files.length })}</span>}
        <span>{s.lastUsedAt ? <>{t('skills.page.used')} <RelativeTime value={s.lastUsedAt} /></> : t('skills.page.neverUsed')}</span>
      </div>
      <div className="sk-card__actions">
        {builtin && <IconButton size="sm" label={t('skills.page.duplicateToEdit')} icon={<Copy />} onClick={onDuplicate} />}
        <IconButton size="sm" label={t('skills.page.more', { name: s.name })} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)} />
        <Button size="sm" variant="secondary" icon={<Play />} aria-label={t('skills.page.runLabel', { name: s.name })} onClick={onRun}>
          {t('skills.page.run')}
        </Button>
      </div>
    </article>
  )
}

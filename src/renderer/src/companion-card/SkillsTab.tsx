/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState } from 'react'
import { ListFilter, MoreHorizontal, Plus, WandSparkles } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { SHARED_OWNER } from '@shared/services'
import type { Skill } from '@shared/skills'
import { skillUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { Button, Dialog, ErrorState, IconButton, RelativeTime, Select, confirm, menuSeparator, showMenu, toast } from '../ui'
import { t } from '../i18n/useT'
import { SKILL_USE_FILTERS, skillUseMatches, type SkillUseFilter } from './logic/listTemplate'
import { SKILL_NAME, skillMatches, skillNameInput } from './logic/skills'
import { GroupToggle, ListEmpty, ListRoundButton, ListSearch, ListSkeleton, ListTabHeader, useSkeletonPhase } from './ListTab'
import { Nested } from './Nested'
import { useLoaded } from './useLoaded'

interface SkillsTabProps {
  companion: Companion
  /** A skill id from a deep link: shown open and scrolled to. */
  focusId: string | null
  /** Leaves the card for a chat. */
  onOpenChat(chatId: string): void
}

export function SkillsTab({ companion, focusId, onOpenChat }: SkillsTabProps) {
  const skills = useLoaded(() => call('skills', 'list'), [], (e) => (e.type === 'skills' ? { data: e.items } : false))
  const [query, setQuery] = useState('')
  const [useFilter, setUseFilter] = useState<SkillUseFilter>('all')
  const matches = (skill: Skill, q: string): boolean => skillMatches(skill, q) && skillUseMatches(skill, useFilter)
  const phase = useSkeletonPhase(skills.status === 'loading' && !skills.data)
  const [sharedOpen, setSharedOpen] = useState(true)
  const [builtinOpen, setBuiltinOpen] = useState(false)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [expanded, setExpanded] = useState<string | null>(focusId)
  const createButton = useRef<HTMLButtonElement>(null)
  useEffect(() => setExpanded(focusId), [focusId])

  const all = skills.data ?? []
  const own = all.filter((s) => s.owner === companion.id && matches(s, query))
  const shared = all.filter((s) => s.owner === SHARED_OWNER && s.source !== 'builtin' && matches(s, query))
  // The skills that ship with Apex, read-only.
  const builtins = all.filter((s) => s.source === 'builtin' && matches(s, query))
  // A shared skill with the same name as one of this companion's is hidden behind it in chats.
  const ownNames = new Set(all.filter((s) => s.owner === companion.id).map((s) => s.name))

  const use = (skill: Skill): void => {
    apex.agent.start(`/${skill.name}`, { companionId: companion.id }).then(onOpenChat, (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }
  const buildInChat = (): void => {
    const prompt = t('coCard.skills.helpMeWriteA', { name: companion.name })
    apex.agent.start(prompt, { companionId: companion.id }).then(onOpenChat, (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }
  const openCreateMenu = async (): Promise<void> => {
    const anchor = createButton.current
    if (!anchor) return
    const choice = await showMenu(
      [
        { id: 'blank', label: t('coCard.skills.writeANewSkill') },
        { id: 'chat', label: t('coCard.skills.buildOneWithIn', { name: companion.name }) },
        { id: 'import', label: t('coCard.skills.importASkillFile') },
      ],
      anchor,
    )
    if (choice === 'blank') setEditing('new')
    else if (choice === 'chat') buildInChat()
    else if (choice === 'import') {
      call('skills', 'importFile', companion.id).then(
        (skill) => {
          if (!skill) return
          setExpanded(skill.id)
          toast.show({ message: t('coCard.skills.addedToSSkills', { name: skill.name, name2: companion.name }), tone: 'success' })
        },
        (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }),
      )
    }
  }
  const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })
  const rowMenu = async (skill: Skill, anchor: Element): Promise<void> => {
    const isOwn = skill.owner === companion.id
    // Built-ins are read-only (Duplicate to edit); your skills open in the full editor and can be revealed in Finder.
    const choice = await showMenu(
      skill.source === 'builtin'
        ? [
            { id: 'use', label: t('coCard.skills.useInANew') },
            { id: 'open', label: t('coCard.skills.open') },
            { id: 'duplicate', label: t('coCard.skills.duplicateFor', { name: companion.name }) },
            { id: 'export', label: t('coCard.skills.exportAsAFile') },
          ]
        : [
            { id: 'use', label: t('coCard.skills.useInANew') },
            { id: 'edit', label: t('coCard.skills.edit') },
            { id: 'export', label: t('coCard.skills.exportAsAFile') },
            { id: 'reveal', label: t('coCard.skills.revealInFinder') },
            isOwn ? { id: 'share', label: t('coCard.skills.shareWithEveryCompanion') } : { id: 'own', label: t('coCard.skills.keepForOnly', { name: companion.name }) },
            menuSeparator(),
            { id: 'delete', label: t('coCard.skills.delete'), danger: true },
          ],
      anchor,
    )
    if (choice === 'open' || choice === 'edit') void call('pages', 'open', skillUrl(skill.id)).catch(fail)
    else if (choice === 'reveal') call('skills', 'reveal', skill.id).catch(fail)
    else if (choice === 'duplicate') {
      call('skills', 'duplicate', skill.id, companion.id).then((copy) => {
        setExpanded(copy.id)
        toast.show({ message: t('coCard.skills.madeFor', { name: copy.name, name2: companion.name }), tone: 'success' })
      }, fail)
    }
    else if (choice === 'use') use(skill)
    else if (choice === 'export') {
      call('skills', 'exportFile', skill.id).then(
        (path) => path && toast.show({ message: t('coCard.skills.saved', { value: path.split(/[\\/]/).pop() ?? path }), tone: 'success' }),
        (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }),
      )
    } else if (choice === 'share' || choice === 'own') {
      const owner = choice === 'share' ? SHARED_OWNER : companion.id
      call('skills', 'save', { id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, steps: skill.steps, owner }).catch((err: unknown) =>
        toast.show({ message: errorText(err), tone: 'error' }),
      )
    } else if (choice === 'delete') {
      const ok = await confirm({
        title: t('coCard.skills.delete2', { name: skill.name }),
        message: skill.owner === SHARED_OWNER ? t('coCard.skills.everyCompanionLosesThis') : t('coCard.skills.losesThisSkillChats', { name: companion.name }),
        destructive: true,
      })
      if (ok) call('skills', 'remove', skill.id).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
    }
  }

  const filterLabels: Record<SkillUseFilter, string> = {
    all: t('coCard.skills.filter.all'),
    used: t('coCard.skills.filter.used'),
    unused: t('coCard.skills.filter.unused'),
  }
  const openFilter = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(
      SKILL_USE_FILTERS.map((id) => ({ id, label: filterLabels[id], type: 'radio' as const, checked: useFilter === id })),
      anchor,
    )
    if (choice && (SKILL_USE_FILTERS as readonly string[]).includes(choice)) setUseFilter(choice as SkillUseFilter)
  }

  // DS-114: one 54 px line. A click opens the row to show what the skill does.
  const row = (skill: Skill) => {
    const open = expanded === skill.id
    const shadowed = skill.owner === SHARED_OWNER && ownNames.has(skill.name)
    const detailsId = `skill-${skill.id}-details`
    return (
      <li key={skill.id} className={`co-item co-skillrow${open ? ' co-item--open' : ''}${focusId === skill.id ? ' co-item--linked' : ''}`} ref={(el) => {
        if (el && focusId === skill.id) el.scrollIntoView({ block: 'nearest' })
      }}>
        <button type="button" className="co-skillrow__open" aria-expanded={open} aria-controls={open ? detailsId : undefined} title={skill.description || undefined} onClick={() => setExpanded(open ? null : skill.id)}>
          <WandSparkles aria-hidden />
          <span className="co-skillrow__name">/{skill.name}</span>
          <span className="co-skillrow__used">
            {skill.lastUsedAt ? <>{t('skills.page.used')} <RelativeTime value={skill.lastUsedAt} /></> : t('skills.page.neverUsed')}
          </span>
        </button>
        <button type="button" className="co-skillrow__use" aria-label={t('coCard.skills.useLabel', { name: skill.name })} onClick={() => use(skill)}>
          {t('coCard.skills.use')}
        </button>
        <IconButton label={t('coCard.skills.more', { name: skill.name })} icon={<MoreHorizontal />} size="sm" className="co-skillrow__more" aria-haspopup="menu" onClick={(e) => void rowMenu(skill, e.currentTarget)} />
        {open && (
          <div id={detailsId} className="co-skillrow__details">
            <p>
              {skill.description || t('coCard.skills.noDescription')}
              {skill.steps.length > 0 && ` · ${t('skills.page.steps', { count: skill.steps.length })}`}
              {skill.files.length > 0 && ` · ${t('skills.page.files', { count: skill.files.length })}`}
            </p>
            {shadowed && <p>{t('coCard.skills.shadowed', { companion: companion.name, name: skill.name })}</p>}
            <pre className="co-item__body">{skill.instructions}</pre>
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="co-tab">
      <ListTabHeader
        title={t('coCard.skills.skills')}
        help={<>{t('coCard.skills.skillsAreSavedInstructions', { name: companion.name })}</>}
        action={{ label: t('coCard.skills.newSkill'), icon: <Plus aria-hidden />, menu: true, ref: createButton, onClick: () => void openCreateMenu() }}
      />
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder={t('skills.page.search')}
        trailing={
          <ListRoundButton
            label={useFilter === 'all' ? t('coCard.skills.filter') : `${t('coCard.skills.filter')}: ${filterLabels[useFilter]}`}
            icon={<ListFilter aria-hidden />}
            pressed={useFilter !== 'all'}
            onClick={(e) => void openFilter(e.currentTarget)}
          />
        }
      />
      {phase === 'skeleton' && <ListSkeleton label={t('coCard.list.loading.skills')} />}
      {skills.status === 'error' && <ErrorState compact message={skills.error ?? undefined} onRetry={skills.reload} />}
      {skills.data && phase === 'done' && (
        <>
          {own.length > 0 ? (
            <ul className="co-list">{own.map(row)}</ul>
          ) : (
            <ListEmpty>{query || useFilter !== 'all' ? t('coCard.skills.empty.match') : t('coCard.skills.empty.own', { companion: companion.name })}</ListEmpty>
          )}
          <GroupToggle label={t('coCard.skills.group.shared')} count={shared.length} open={sharedOpen} onToggle={() => setSharedOpen((v) => !v)} />
          {sharedOpen && (shared.length > 0 ? <ul className="co-list">{shared.map(row)}</ul> : <ListEmpty>{query || useFilter !== 'all' ? t('coCard.skills.empty.sharedMatch') : t('coCard.skills.empty.shared')}</ListEmpty>)}
          {builtins.length > 0 && (
            <>
              <GroupToggle label={t('coCard.skills.group.builtin')} count={builtins.length} open={builtinOpen} onToggle={() => setBuiltinOpen((v) => !v)} />
              {builtinOpen && <ul className="co-list">{builtins.map(row)}</ul>}
            </>
          )}
        </>
      )}
      {editing && (
        <Nested>
          <SkillDialog companion={companion} skill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
        </Nested>
      )}
    </div>
  )
}

function SkillDialog({ companion, skill, onClose }: { companion: Companion; skill: Skill | null; onClose(): void }) {
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  const [owner, setOwner] = useState(skill?.owner ?? companion.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { name: useId(), description: useId(), instructions: useId(), owner: useId() }
  const nameOk = SKILL_NAME.test(name)
  const save = (): void => {
    if (!nameOk || !instructions.trim()) return
    setBusy(true)
    setError(null)
    call('skills', 'save', { ...(skill ? { id: skill.id } : {}), name, description, instructions, owner }).then(onClose, (err: unknown) => {
      setBusy(false)
      setError(errorText(err))
    })
  }
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={skill ? `Edit /${skill.name}` : t('coCard.skills.newSkill')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('coCard.skills.cancel')}</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!nameOk || !instructions.trim()}>{t('coCard.skills.saveSkill')}</Button>
        </>
      }
    >
      <div className="co-form">
        <div className="co-field">
          <label className="co-field__label" htmlFor={ids.name}>{t('coCard.skills.name')}</label>
          <div className="co-prefixed">
            <span aria-hidden>/</span>
            <input id={ids.name} className="co-input" value={name} placeholder={t('coCard.skills.weeklyReport')} data-autofocus onChange={(e) => setName(skillNameInput(e.target.value))} />
          </div>
          <p className={name && !nameOk ? 'co-field__error' : 'co-hint'}>{t('coCard.skills.lowercaseLettersDigitsAnd', { value: name || 'name' })}</p>
        </div>
        <div className="co-field">
          <label className="co-field__label" htmlFor={ids.description}>{t('coCard.skills.description')}</label>
          <input id={ids.description} className="co-input" value={description} maxLength={500} placeholder={t('coCard.skills.whatItDoesIn')} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="co-field">
          <label className="co-field__label" htmlFor={ids.instructions}>{t('coCard.skills.instructions')}</label>
          <textarea id={ids.instructions} className="co-textarea co-textarea--code" rows={9} maxLength={20_000} value={instructions} placeholder={t('coCard.skills.stepByStepWhat')} onChange={(e) => setInstructions(e.target.value)} />
        </div>
        <div className="co-field">
          <label className="co-field__label" htmlFor={ids.owner}>{t('coCard.skills.whoCanUseIt')}</label>
          <Select id={ids.owner} fullWidth value={owner} onChange={setOwner} options={[{ value: companion.id, label: t('coCard.skills.only', { name: companion.name }) }, { value: SHARED_OWNER, label: t('coCard.skills.everyCompanion') }]} />
        </div>
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}

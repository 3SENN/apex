/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Profiles (ST-37 to ST-39, SH-64): the current profile with an
// inline rename and its colour, the other profiles with Switch, and Add and
// Delete through the profile-create and profile-delete window dialogs.
// Companions, chats and the library are shared, so nothing here touches them.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { ProfileHue } from '@shared/profile'
import { profileDeleteBlock, type Profile } from '@shared/profiles'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { anchorFromElement, openSurface } from '../../overlay/useSurface'
import { CreateProfileDialog, DeleteProfileDialog } from '../../profiles/ProfileDialogs'
import { HueSwatches, ProfileBadge } from '../../profiles/HueSwatches'
import { deleteBlockMessage, nameMessage, type Message } from '../../profiles/logic'
import { Button, useToast } from '../../ui'
import { useLiveResource } from '../data'
import { Card, Notice, PageError, PageHeader, PageSkeleton, Row, Section, TextInput } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import '../../profiles/profiles.css'

type Inline = { kind: 'create' } | { kind: 'delete'; profileId: string } | null

export function ProfilesPage({ settings, onOpenPage, autoCreate = false }: Pick<SettingsPageProps, 'settings'> & { onOpenPage(id: string): void; autoCreate?: boolean }): ReactElement {
  const t = useT()
  const text = (m: Message): string => t(m.key, m.vars)
  const toast = useToast()
  const profiles = useLiveResource(() => call('profiles', 'list'), 'profiles', (e) => e.items)
  // Dialogs open over the window; where the overlay can't host them they open in the page.
  const [inline, setInline] = useState<Inline>(null)
  const [error, setError] = useState<string | null>(null)

  const header = <PageHeader title={t('profiles.settings.title')} description={t('profiles.settings.lede')} />
  const items = profiles.data
  const currentId = settings.profile?.id ?? 'default'
  const current = items?.find((p) => p.id === currentId) ?? items?.[0] ?? null

  const openCreate = (el: HTMLElement | null): void => {
    const anchor = el ? anchorFromElement(el) : { kind: 'window' as const, rect: { x: 0, y: 0, width: 0, height: 0 } }
    openSurface('profile-create', anchor, {}).then(
      (result) => {
        if ('value' in result && result.value && typeof result.value === 'object') toast.show({ tone: 'success', message: t('profiles.toast.created', { name: String((result.value as { name?: unknown }).name ?? '') }) })
      },
      () => setInline({ kind: 'create' }),
    )
  }
  const openDelete = (el: HTMLElement, profileId: string): void => {
    openSurface('profile-delete', anchorFromElement(el), { profileId }).then(
      (result) => {
        if ('value' in result && result.value && typeof result.value === 'object') toast.show({ tone: 'success', message: t('profiles.toast.deleted', { name: String((result.value as { name?: unknown }).name ?? '') }) })
      },
      () => setInline({ kind: 'delete', profileId }),
    )
  }

  // ?new=1 (the menus' Add Profile…) opens the dialog once.
  const created = useRef(false)
  useEffect(() => {
    if (autoCreate && items && !created.current) {
      created.current = true
      openCreate(null)
    }
  }, [autoCreate, items])

  if (!items || !current) {
    return (
      <>
        {header}
        {profiles.error ? <PageError title={t('settings.loadFailed')} message={profiles.error} onRetry={profiles.reload} /> : <PageSkeleton label={t('settings.kit.loading')} rows={3} />}
      </>
    )
  }

  const others = items.filter((p) => p.id !== current.id)
  const switchTo = (id: string): void => void call('profiles', 'switchTo', id).catch((err: unknown) => setError(errorText(err)))
  const currentBlock = profileDeleteBlock(current.id, items)

  return (
    <>
      {header}
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <Section title={t('profiles.current.heading')}>
        <Card>
          <div className="pf-current" data-settings-anchor="profile-current">
            <ProfileBadge name={current.name} hue={current.hue} size={44} />
            <div className="pf-row__text">
              <span className="pf-row__name">{current.name}</span>
              <span className="pf-row__meta">
                <span className="pf-tag">{t('profiles.current.badge')}</span>
              </span>
            </div>
          </div>
          <RenameRow profile={current} profiles={items} onRenamed={(p) => toast.show({ tone: 'success', message: t('profiles.toast.renamed', { name: p.name }) })} onError={setError} />
          <HueRow profile={current} onError={setError} onOpenAppearance={() => onOpenPage('appearance')} />
          <Row title={t('profiles.delete')} description={currentBlock ? text(deleteBlockMessage(currentBlock)) : undefined}>
            <Button variant="secondary" disabled={currentBlock !== null} onClick={(e) => openDelete(e.currentTarget, current.id)}>
              {t('profiles.delete')}
            </Button>
          </Row>
        </Card>
      </Section>

      <Section
        title={t('profiles.others.heading')}
        actions={
          <Button variant="secondary" onClick={(e) => openCreate(e.currentTarget)}>
            {t('profiles.add')}
          </Button>
        }
      >
        <Card>
          {others.length === 0 ? (
            <div className="pf-row">
              <span className="pf-row__meta">{t('profiles.others.empty')}</span>
            </div>
          ) : (
            <ul className="pf-rows" role="list">
              {others.map((p) => (
                <OtherRow key={p.id} profile={p} block={profileDeleteBlock(p.id, items)} onSwitch={() => switchTo(p.id)} onDelete={(el) => openDelete(el, p.id)} />
              ))}
            </ul>
          )}
        </Card>
      </Section>

      {inline?.kind === 'create' && (
        <CreateProfileDialog
          open
          onClose={() => setInline(null)}
          onCreated={(p) => {
            setInline(null)
            toast.show({ tone: 'success', message: t('profiles.toast.created', { name: p.name }) })
          }}
        />
      )}
      {inline?.kind === 'delete' && (
        <DeleteProfileDialog
          open
          profileId={inline.profileId}
          onClose={() => setInline(null)}
          onDeleted={(p) => {
            setInline(null)
            toast.show({ tone: 'success', message: t('profiles.toast.deleted', { name: p.name }) })
          }}
        />
      )}
    </>
  )
}

/** ST-37: rename in place; an empty or taken name is refused with the reason, Escape puts the old name back. */
function RenameRow({ profile, profiles, onRenamed, onError }: { profile: Profile; profiles: Profile[]; onRenamed(p: Profile): void; onError(message: string): void }): ReactElement {
  const t = useT()
  const id = useId()
  const [name, setName] = useState(profile.name)
  const [busy, setBusy] = useState(false)
  useEffect(() => setName(profile.name), [profile.name])
  const problem = nameMessage(name, profiles, profile.id)
  const dirty = name.trim() !== profile.name
  const save = async (): Promise<void> => {
    if (!dirty || problem || busy) return
    setBusy(true)
    try {
      onRenamed(await call('profiles', 'rename', profile.id, name.trim()))
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape' && dirty) {
      e.preventDefault()
      setName(profile.name)
    }
  }
  return (
    <Row title={t('profiles.current.name')} htmlFor={id} anchor="profile-name" stack>
      <div className="pf-rename">
        <div>
          <TextInput
            id={id}
            value={name}
            maxLength={60}
            aria-label={t('profiles.current.renameLabel')}
            invalid={problem !== null}
            aria-invalid={problem !== null}
            aria-describedby={problem ? `${id}-error` : undefined}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
          />
          {problem && (
            <p id={`${id}-error`} className="pf-dialog__error" role="alert">
              {t(problem.key, problem.vars)}
            </p>
          )}
        </div>
        <Button variant="secondary" disabled={!dirty || problem !== null} loading={busy} onClick={() => void save()}>
          {t('profiles.current.rename')}
        </Button>
      </div>
    </Row>
  )
}

/** ST-37, DS-03: the profile's colour; its windows recolour as soon as main saves it. */
function HueRow({ profile, onError, onOpenAppearance }: { profile: Profile; onError(message: string): void; onOpenAppearance(): void }): ReactElement {
  const t = useT()
  const [hue, setHue] = useState<ProfileHue>(profile.hue)
  useEffect(() => setHue(profile.hue), [profile.hue])
  const choose = (next: ProfileHue): void => {
    if (next === hue) return
    const before = hue
    setHue(next)
    call('profiles', 'setHue', profile.id, next).catch((err: unknown) => {
      setHue(before)
      onError(errorText(err))
    })
  }
  return (
    <Row
      title={t('profiles.current.colour')}
      description={
        <>
          {t('profiles.current.colourHint')}{' '}
          <button type="button" className="sp-link" onClick={onOpenAppearance}>
            {t('profiles.current.appearance')}
          </button>
        </>
      }
      anchor="profile-colour"
      stack
    >
      <HueSwatches label={t('profiles.current.colour')} value={hue} onChange={choose} />
    </Row>
  )
}

function OtherRow({ profile, block, onSwitch, onDelete }: { profile: Profile; block: ReturnType<typeof profileDeleteBlock>; onSwitch(): void; onDelete(el: HTMLElement): void }): ReactElement {
  const t = useT()
  const reasonId = useId()
  return (
    <li className="pf-row">
      <ProfileBadge name={profile.name} hue={profile.hue} />
      <div className="pf-row__text">
        <span className="pf-row__name">{profile.name}</span>
        {block && (
          <span id={reasonId} className="pf-row__meta">
            {t(deleteBlockMessage(block).key)}
          </span>
        )}
      </div>
      <div className="pf-row__actions">
        <Button variant="ghost" disabled={block !== null} aria-label={t('profiles.deleteLabel', { name: profile.name })} aria-describedby={block ? reasonId : undefined} onClick={(e) => onDelete(e.currentTarget)}>
          {t('profiles.delete')}
        </Button>
        <Button variant="secondary" aria-label={t('profiles.others.switchLabel', { name: profile.name })} onClick={onSwitch}>
          {t('profiles.others.switch')}
        </Button>
      </div>
    </li>
  )
}

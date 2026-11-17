/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Companions: every companion (hidden ones too), each opening its
// profile card, plus create, import, and the Dock icon on macOS. A look is
// changed on the card itself: the ring of bubbles around the figure.
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import { Ellipsis, Import, Plus, UsersRound } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { companionLookUrl, companionUrl } from '@shared/url'
import { call, errorText } from '../../api'
import { usePresets } from '../../components/companionData'
import { Badge, Button, EmptyState, ErrorState, IconButton, SkeletonRows, Switch, isMac, menuSeparator, showContextMenu, showMenu, useConfirm, useToast, type MenuItemSpec } from '../../ui'
import { CompanionSheets, openCompanionImport, openNewCompanion } from '../../companion-card/sheets'
import { CompanionAvatar } from '../companions/CompanionAvatar'
import { useCompanions } from '../data'
import { Card, ListFrame, Notice, PageHeader, Section } from '../kit'
import { useT } from '../../i18n/useT'
import { shareAsPack } from '../../packs/share'

interface CompanionsPageProps {
  /** 'look' (the old apex://settings/companion) opens the active companion's card with its look editor. */
  view: string | null
  onOpenSection(section: string): void
}

function openCard(id: string): void {
  void call('pages', 'open', companionUrl(id))
}

function openLook(id: string): void {
  void call('pages', 'open', companionLookUrl(id))
}

export function CompanionsPage({ view, onOpenSection }: CompanionsPageProps): ReactElement {
  const { activeId } = useCompanions()
  const look = view === 'look'
  useEffect(() => {
    if (!look || !activeId) return
    openLook(activeId)
    onOpenSection('companions')
  }, [look, activeId])
  return <CompanionList onOpenSection={onOpenSection} />
}

function CompanionList({ onOpenSection }: { onOpenSection(section: string): void }): ReactElement {
  const t = useT()
  const { items, activeId, error, reload } = useCompanions()
  const presets = usePresets()
  const confirm = useConfirm()
  const toast = useToast()
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const visible = items?.filter((c) => !c.hidden) ?? []
  const active = items?.find((c) => c.id === activeId) ?? null

  const added = (c: Companion): void => {
    toast.show({ tone: 'success', message: t('settings.companions.wasAdded', { name: c.name }), action: { label: t('settings.companions.openProfile'), onAction: () => openCard(c.id) } })
  }
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setNotice(null)
    try {
      await work()
    } catch (err) {
      setNotice(errorText(err))
    }
  }
  // The create and import sheets are shared with the card and the new tab page.
  const create = (): void => openNewCompanion({ onCreated: added })
  const pickImport = async (): Promise<void> => {
    setImporting(true)
    await openCompanionImport({ onCreated: added })
    setImporting(false)
  }
  /** Apex keeps one companion visible; explain instead of failing. */
  const explainLastVisible = async (c: Companion, verb: 'hide' | 'delete'): Promise<void> => {
    const action = verb === 'hide' ? t('settings.companions.verbHide') : t('settings.companions.verbDelete')
    const ok = await confirm({
      title: t('settings.companions.isYourOnlyVisible', { name: c.name }),
      message: t('settings.companions.apexAlwaysKeepsOne', { action, name: c.name }),
      confirmLabel: t('settings.companions.newCompanion'),
      cancelLabel: t('settings.companions.notNow'),
    })
    if (ok) create()
  }
  const remove = async (c: Companion): Promise<void> => {
    if (!c.hidden && visible.length <= 1) return explainLastVisible(c, 'delete')
    const ok = await confirm({
      title: t('settings.companions.delete', { name: c.name }),
      message: `${t('settings.companions.removedNotes', { name: c.name })}${c.id === activeId ? t('settings.companions.anotherBecomesActive') : ''}`,
      confirmLabel: t('settings.companions.deleteCompanion'),
      destructive: true,
    })
    if (!ok) return
    await run(async () => {
      await call('companions', 'remove', c.id)
      toast.show({ message: t('settings.companions.wasDeleted', { name: c.name }) })
    })
  }
  const menuFor = (c: Companion): MenuItemSpec[] => [
    { id: 'open', label: t('settings.companions.openProfile') },
    { id: 'look', label: t('settings.companions.customizeLook') },
    ...(c.id === activeId ? [] : [{ id: 'activate', label: t('settings.companions.makeActive'), enabled: !c.hidden }]),
    menuSeparator(),
    { id: 'duplicate', label: t('settings.companions.duplicate') },
    { id: c.hidden ? 'unhide' : 'hide', label: c.hidden ? t('settings.companions.showAgain') : t('settings.companions.hide') },
    { id: 'export', label: t('settings.companions.export') },
    { id: 'share-pack', label: t('packs.share.action') },
    menuSeparator(),
    { id: 'delete', label: t('settings.companions.delete2'), danger: true },
  ]
  const act = async (c: Companion, id: string | null): Promise<void> => {
    switch (id) {
      case 'open':
        return openCard(c.id)
      case 'look':
        return openLook(c.id)
      case 'activate':
        return run(() => call('companions', 'setActive', c.id))
      case 'duplicate':
        return run(async () => {
          const copy = await call('companions', 'duplicate', c.id)
          toast.show({ tone: 'success', message: t('settings.companions.wasAddedAsA', { name: copy.name, name2: c.name }), action: { label: t('settings.companions.openProfile'), onAction: () => openCard(copy.id) } })
        })
      case 'hide':
        if (visible.length <= 1) return explainLastVisible(c, 'hide')
        return run(async () => {
          await call('companions', 'hide', c.id)
          toast.show({ message: t('settings.companions.isHiddenFromThe', { name: c.name }), undo: () => void call('companions', 'unhide', c.id) })
        })
      case 'unhide':
        return run(() => call('companions', 'unhide', c.id))
      case 'export':
        return run(async () => {
          const path = await call('companions', 'export', c.id, { includeSkills: true, includeRoutines: true })
          if (path) toast.show({ tone: 'success', message: t('settings.companions.exportedWithItsSkills', { name: c.name }) })
        })
      case 'share-pack':
        return shareAsPack('companion', c.id)
      case 'delete':
        return remove(c)
      default:
        return undefined
    }
  }
  const openMenu = (c: Companion, e: MouseEvent<HTMLElement>): void => {
    void showMenu(menuFor(c), e.currentTarget).then((id) => act(c, id))
  }
  const tagline = (c: Companion): string => presets.find((p) => p.id === c.persona)?.tagline ?? (c.instructions ? t('settings.companions.yourOwnPersonalityAnd') : t('settings.companions.yourOwnPersonality'))

  return (
    <>
      <PageHeader
        title={t('settings.companions.companions')}
        description={t('settings.companions.eachCompanionHasIts')}
        actions={
          <>
            <Button icon={<Import />} loading={importing} onClick={() => void pickImport()}>
              {t('settings.companions.import')}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={create}>
              {t('settings.companions.newCompanion')}
            </Button>
          </>
        }
      />
      {notice && (
        <Notice tone="error" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      <Section title={t('settings.companions.yourCompanions')} note={t('settings.companions.hiddenCompanionsKeepTheir')}>
        <ListFrame>
          {items === null ? (
            error ? <ErrorState title={t('settings.companions.couldnTLoadYour')} message={error} onRetry={reload} /> : <SkeletonRows rows={3} avatar label={t('settings.companions.loadingCompanions')} />
          ) : items.length === 0 ? (
            <EmptyState icon={<UsersRound />} title={t('settings.companions.noCompanionsYet')} action={<Button variant="primary" onClick={create}>{t('settings.companions.newCompanion')}</Button>} />
          ) : (
            items.map((c) => (
              <div key={c.id} className={c.hidden ? 'sp-item sp-item--muted' : 'sp-item'} onContextMenu={(e) => void showContextMenu(e, menuFor(c)).then((id) => act(c, id))}>
                <CompanionAvatar look={c.look} name={c.name} dimmed={c.hidden} />
                <button type="button" className="sp-item__main" onClick={() => openCard(c.id)} aria-label={t('settings.companions.openSProfile', { name: c.name })}>
                  <span className="sp-item__title">
                    <span className="sp-item__title-text">{c.name}</span>
                    {c.id === activeId && <Badge tone="accent">{t('settings.companions.active')}</Badge>}
                    {c.hidden && <Badge>{t('settings.companions.hidden')}</Badge>}
                  </span>
                  <span className="sp-item__sub">{tagline(c)}</span>
                </button>
                <div className="sp-item__actions">
                  {c.id !== activeId && !c.hidden && (
                    <Button size="sm" variant="ghost" onClick={() => void act(c, 'activate')}>
                      {t('settings.companions.makeActive')}
                    </Button>
                  )}
                  {c.hidden && (
                    <Button size="sm" variant="ghost" onClick={() => void act(c, 'unhide')}>
                      {t('settings.companions.show')}
                    </Button>
                  )}
                  <IconButton size="sm" label={t('settings.companions.moreFor', { name: c.name })} icon={<Ellipsis />} aria-haspopup="menu" aria-expanded={false} onClick={(e) => openMenu(c, e)} />
                </div>
              </div>
            ))
          )}
        </ListFrame>
      </Section>
      {isMac && active && (
        <Section title={t('settings.companions.dockIcon')}>
          <Card>
            <Switch
              label={t('settings.companions.showInTheDock', { name: active.name })}
              description={t('settings.companions.dockIconHint', { name: active.name })}
              checked={active.dockIcon}
              onChange={(dockIcon) => void run(() => call('companions', 'update', active.id, { dockIcon }))}
            />
          </Card>
        </Section>
      )}
      <CompanionSheets />
    </>
  )
}

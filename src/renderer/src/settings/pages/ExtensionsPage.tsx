/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Extensions (ST-40): open the Web Store, search, and one
// row per extension with its icon, name and version, an enable switch, an
// expandable permissions panel (what it can do, what it may ask for, site
// access, its shortcuts and any clash with Apex's own keys), revoke one or
// every optional permission, and Remove, which confirms first and clears
// what the extension saved. Empty and no-results states; the list follows
// main's `extensions` event live.
import { useId, useMemo, useState, type ReactElement } from 'react'
import { ArrowUpRight, ChevronDown, Puzzle, TriangleAlert } from 'lucide-react'
import { SHORTCUTS } from '@shared/shortcuts'
import type { ExtensionInfo } from '@shared/extensions'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Badge, Button, EmptyState, Kbd, Switch, cx, formatShortcut, isMac, useToast } from '../../ui'
import { ExtensionIcon } from '../../extensions/ExtensionIcon'
import { removeExtension } from '../../extensions/ExtensionsToolbar'
import { filterExtensions, grantedOptional, hasClash, hostsSummary } from '@shared/extensions'
import { useExtensions } from '../../extensions/useExtensions'
import { Card, ListFrame, PageError, PageHeader, PageSkeleton, SearchField, Section } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { RecommendedShelf } from '../../extensions/RecommendedShelf' // ST-40 R
import '../../extensions/extensions.css'
import { packsPageUrl, type PacksState } from '@shared/packs'
import { Package } from 'lucide-react'
import { useEvent, useResource } from '../data'
import { Row } from '../kit'

export function ExtensionsPage(_props: SettingsPageProps): ReactElement {
  const t = useT()
  const { items, loading, error, reload } = useExtensions()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const shown = useMemo(() => filterExtensions(items, query), [items, query])

  const openStore = (): void => void call('extensions', 'openStore')

  return (
    <>
      <PageHeader
        title={t('extensions.settings.title')}
        description={t('extensions.settings.description')}
        actions={
          <Button variant="secondary" onClick={openStore} iconEnd={<ArrowUpRight aria-hidden />}>
            {t('extensions.settings.openStore')}
          </Button>
        }
      />
      <PacksSection />
      <Section
        title={t('extensions.settings.installed')}
        actions={items.length > 0 ? <SearchField value={query} onChange={setQuery} placeholder={t('extensions.settings.search')} label={t('extensions.settings.search')} /> : undefined}
        note={items.length > 0 ? t('extensions.settings.agentNote') : undefined}
      >
        {loading ? (
          <PageSkeleton label={t('extensions.settings.title')} rows={3} />
        ) : error ? (
          <PageError title={t('extensions.settings.loadError')} message={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Puzzle size={20} aria-hidden />}
              title={t('extensions.settings.emptyTitle')}
              description={t('extensions.settings.emptyBody')}
              action={
                <Button variant="primary" onClick={openStore}>
                  {t('extensions.settings.openStore')}
                </Button>
              }
            />
          </Card>
        ) : shown.length === 0 ? (
          <Card>
            <EmptyState
              compact
              title={t('extensions.settings.noResults', { query: query.trim() })}
              action={
                <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                  {t('extensions.settings.clearSearch')}
                </Button>
              }
            />
          </Card>
        ) : (
          <ListFrame label={t('extensions.settings.installed')}>
            {shown.map((ext) => (
              <ExtensionRow key={ext.id} ext={ext} expanded={open === ext.id} onToggle={() => setOpen(open === ext.id ? null : ext.id)} />
            ))}
          </ListFrame>
        )}
      </Section>
      {/* ST-40 R: the Recommended shelf. */}
      <Section title={t('extImport.rec.title')} note={t('extImport.rec.note')}>
        <RecommendedShelf />
      </Section>
    </>
  )
}

function ExtensionRow({ ext, expanded, onToggle }: { ext: ExtensionInfo; expanded: boolean; onToggle(): void }): ReactElement {
  const t = useT()
  const toast = useToast()
  const panelId = useId()
  const off = !ext.enabled || !ext.supported

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast.show({ tone: 'error', message: t('extensions.settings.actionFailed', { reason: errorText(err) }) })
    }
  }

  const note = !ext.supported ? t('extensions.settings.unsupportedNote') : !ext.enabled ? t('extensions.settings.offNote') : hasClash(ext) ? t('extensions.settings.clashShort') : null

  return (
    <div className={cx('ext-set', expanded && 'ext-set--open', off && 'ext-set--off')}>
      <div className="ext-set__row">
        <span className="ext-set__icon">
          <ExtensionIcon ext={ext} size={24} dimmed={off} />
        </span>
        <div className="ext-set__text">
          <span className="ext-set__name">
            {ext.name}
            {ext.source === 'unpacked' && <Badge tone="neutral">{t('extensions.settings.unpacked')}</Badge>}
          </span>
          <span className="ext-set__meta">
            {t('extensions.settings.version', { version: ext.version })}
            {note && (
              <span className={cx('ext-set__note', !ext.supported || hasClash(ext) ? 'ext-set__note--warn' : null)}>
                {(!ext.supported || (ext.enabled && hasClash(ext))) && <TriangleAlert aria-hidden />}
                {note}
              </span>
            )}
          </span>
        </div>
        <div className="ext-set__controls">
          <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle} iconEnd={<ChevronDown aria-hidden className="ext-set__chevron" />}>
            {expanded ? t('extensions.settings.hidePermissions') : t('extensions.settings.showPermissions')}
          </Button>
          <Button variant="ghost" size="sm" aria-label={t('extensions.settings.removeLabel', { name: ext.name })} onClick={() => void removeExtension(ext)}>
            {t('extensions.settings.remove')}
          </Button>
          <Switch
            size="sm"
            checked={ext.enabled && ext.supported}
            disabled={!ext.supported}
            aria-label={t('extensions.settings.toggle', { name: ext.name })}
            onChange={(on) => void run(() => call('extensions', 'setEnabled', ext.id, on))}
          />
        </div>
      </div>
      {expanded && (
        <div id={panelId} className="ext-set__panel" role="region" aria-label={t('extensions.settings.permissionsFor', { name: ext.name })}>
          {!ext.supported && ext.unsupportedReason && (
            <p className="ext-set__unsupported">
              <TriangleAlert aria-hidden />
              {ext.unsupportedReason}
            </p>
          )}
          {ext.description && <p className="ext-set__description">{ext.description}</p>}
          <PermissionsPanel ext={ext} onRevoke={(perm) => void run(() => call('extensions', 'revoke', ext.id, perm))} />
          {ext.commands.length > 0 && <ShortcutsPanel ext={ext} />}
          {ext.storeUrl && (
            <div className="ext-set__links">
              <Button variant="ghost" size="sm" onClick={() => void run(() => call('extensions', 'report', ext.id))} iconEnd={<ArrowUpRight aria-hidden />}>
                {t('extensions.settings.reportProblem')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PermissionsPanel({ ext, onRevoke }: { ext: ExtensionInfo; onRevoke(permission: string): void }): ReactElement {
  const t = useT()
  const granted = grantedOptional(ext)
  const { hosts, more } = hostsSummary(ext.hosts)
  // Only file patterns left: name them as written rather than saying nothing.
  const hostList = hosts.length === 0 ? ext.hosts.join(', ') : more > 0 ? t('extensions.settings.siteAccess.more', { hosts: hosts.join(', '), count: more }) : hosts.join(', ')
  const access =
    ext.siteAccess === 'all'
      ? t('extensions.settings.siteAccess.all')
      : ext.siteAccess === 'some'
        ? t('extensions.settings.siteAccess.some', { hosts: hostList })
        : ext.siteAccess === 'on-click'
          ? t('extensions.settings.siteAccess.onClick')
          : t('extensions.settings.siteAccess.none')

  return (
    <div className="ext-set__groups">
      <section className="ext-set__group">
        <h4 className="ext-set__heading">{t('extensions.settings.required')}</h4>
        {ext.permissions.length > 0 ? (
          <ul className="ext-set__list">
            {ext.permissions.map((p) => (
              <li key={p.id}>{p.label}</li>
            ))}
          </ul>
        ) : (
          <p className="ext-set__quiet">{t('extensions.settings.nothingExtra')}</p>
        )}
      </section>
      <section className="ext-set__group">
        <h4 className="ext-set__heading">{t('extensions.settings.siteAccess')}</h4>
        <p className="ext-set__value">{access}</p>
      </section>
      {ext.optional.length > 0 && (
        <section className="ext-set__group">
          <div className="ext-set__heading-row">
            <h4 className="ext-set__heading">{t('extensions.settings.optional')}</h4>
            {granted.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => onRevoke('all')}>
                {t('extensions.settings.revokeAll')}
              </Button>
            )}
          </div>
          <ul className="ext-set__list ext-set__list--optional">
            {ext.optional.map((p) => (
              <li key={p.id} className="ext-set__optional">
                <span className="ext-set__optional-label">{p.label}</span>
                <span className={cx('ext-set__state', p.granted && 'ext-set__state--on')}>{p.granted ? t('extensions.settings.allowed') : t('extensions.settings.notAllowed')}</span>
                {p.granted && (
                  <Button variant="ghost" size="sm" aria-label={t('extensions.settings.revokeOne', { permission: p.label })} onClick={() => onRevoke(p.id)}>
                    {t('extensions.settings.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {granted.length > 0 && <p className="ext-set__quiet">{t('extensions.settings.revokeNote')}</p>}
        </section>
      )}
    </div>
  )
}

/** The Apex shortcut's own name for a clash, or its id when it has none. */
function clashName(id: string, t: ReturnType<typeof useT>): string {
  const def = SHORTCUTS.find((s) => s.id === id)
  return def ? t(def.label) : id
}

function ShortcutsPanel({ ext }: { ext: ExtensionInfo }): ReactElement {
  const t = useT()
  return (
    <section className="ext-set__group">
      <h4 className="ext-set__heading">{t('extensions.settings.shortcuts')}</h4>
      <ul className="ext-set__list ext-set__list--commands">
        {ext.commands.map((c) => (
          <li key={c.name} className="ext-set__command">
            <span className="ext-set__command-name">{c.name}</span>
            {c.shortcut && !c.clash ? <Kbd shortcut={c.shortcut} /> : !c.shortcut ? <span className="ext-set__quiet">{t('extensions.settings.noShortcut')}</span> : null}
            {c.clash && c.shortcut && (
              <span className="ext-set__clash" role="note">
                <TriangleAlert aria-hidden />
                {t('extensions.settings.clash', { keys: formatShortcut(c.shortcut, isMac), action: clashName(c.clash, t) })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Packs (docs/packs.md): Apex's own add-ons, next to the Web Store ones. */
function PacksSection(): ReactElement {
  const t = useT()
  const state = useResource<PacksState>(() => call('packs', 'state'))
  useEvent('packs', (event) => state.set(event.state))
  const packs = state.data?.packs ?? []
  const on = packs.filter((p) => p.enabled).length
  return (
    <Section title={t('packs.settings.title')} note={t('packs.settings.note')}>
      <Card>
        <Row icon={<Package aria-hidden />} title={t('packs.settings.summary', { count: packs.length, on })} description={t('packs.settings.description')}>
          <Button variant="secondary" onClick={() => void call('pages', 'open', packsPageUrl())}>
            {t('packs.settings.open')}
          </Button>
        </Row>
      </Card>
    </Section>
  )
}

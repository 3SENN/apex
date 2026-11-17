/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy › Site settings (SH-37; the apex://settings/sites
// alias): the sites with their own settings (permissions, granted devices and
// switches, each editable, with Reset), a searchable cookies and site data
// list with Clear, and the cookie exceptions (always allow or always block).
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { Cookie, Globe } from 'lucide-react'
import { decisionOptions } from '@shared/permissions'
import { SITE_PERMISSIONS, type SiteDataEntry, type SiteSettingsEntry, type SiteSettingsPatch } from '@shared/sites'
import { apex, call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Badge, Button, EmptyState, Select, Switch, confirm, useToast } from '../../ui'
import { cookieExceptions, filterData, filterSites, hostOf, parseSiteInput, switchPatch, switchStates, type SwitchKey } from '../../overlay/surfaces/sites/logic'
import { PermIcon } from '../../overlay/surfaces/sites/parts'
import { useResource } from '../data'
import { Card, ListFrame, Notice, PageHeader, PageSkeleton, Row, SearchField, Section, TextInput } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { SiteContentRules } from '../sections/privacy/SiteContentRules'
import './siteSettings.css'

const SWITCHES: { key: SwitchKey; label: 'sites.info.adblock' | 'sites.info.sound' | 'sites.info.popups' }[] = [
  { key: 'adblock', label: 'sites.info.adblock' },
  { key: 'sound', label: 'sites.info.sound' },
  { key: 'popups', label: 'sites.info.popups' },
]

export function SiteSettingsPage({ settings }: SettingsPageProps): ReactElement {
  const t = useT()
  const sites = useResource(() => call('sites', 'list'))
  const data = useResource(() => call('sites', 'dataList'))

  // Site info, another window or a prompt changed a site: the list follows.
  useEffect(() => apex.onAppEvent((event) => void (event.type === 'site-settings' && sites.reload())), [sites.reload])

  const globals = { adblock: settings.adblock, popupBlocking: settings.popupBlocking !== false }
  return (
    <>
      <PageHeader title={t('sites.settings.title')} description={t('sites.settings.description')} />
      <ChangedSites entries={sites.data} error={sites.error} reload={sites.reload} globals={globals} />
      <SiteData entries={data.data} error={data.error} reload={data.reload} />
      <CookieExceptions entries={sites.data ?? []} reload={sites.reload} />
    </>
  )
}

interface ListProps<T> {
  entries: T[] | null
  error: string | null
  reload(): Promise<void>
}

function ChangedSites({ entries, error, reload, globals }: ListProps<SiteSettingsEntry> & { globals: { adblock: boolean; popupBlocking: boolean } }): ReactElement {
  const t = useT()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const shown = useMemo(() => filterSites(entries ?? [], query), [entries, query])

  const reset = async (origin: string): Promise<void> => {
    const host = hostOf(origin)
    if (!(await confirm({ title: t('sites.settings.resetTitle', { host }), message: t('sites.settings.resetBody'), confirmLabel: t('sites.settings.reset'), destructive: true }))) return
    try {
      await call('sites', 'forget', origin)
      setEditing(null)
      toast.show({ message: t('sites.settings.resetDone', { host }) })
      await reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) || t('sites.settings.failed') })
    }
  }

  return (
    <Section title={t('sites.settings.changed')} actions={entries && entries.length > 0 ? <SearchField value={query} onChange={setQuery} placeholder={t('sites.settings.searchSites')} /> : undefined}>
      {error && !entries ? (
        <LoadError message={error} onRetry={reload} />
      ) : !entries ? (
        <PageSkeleton label={t('sites.settings.changed')} rows={3} />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState compact icon={<Globe size={20} aria-hidden />} title={t('sites.settings.noSites')} description={t('sites.settings.noSitesHint')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState compact title={t('sites.settings.noSiteMatch', { query: query.trim() })} />
        </Card>
      ) : (
        <ListFrame label={t('sites.settings.changed')}>
          {shown.map((entry) => (
            <div key={entry.origin} className="ss-site">
              <Row title={<span className="ss-host">{hostOf(entry.origin)}</span>} description={t('sites.settings.overrides', { count: entry.overrides })} icon={<Globe size={16} aria-hidden />}>
                <Button size="sm" variant="ghost" aria-expanded={editing === entry.origin} onClick={() => setEditing(editing === entry.origin ? null : entry.origin)}>
                  {editing === entry.origin ? t('sites.settings.done') : t('sites.settings.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void reset(entry.origin)}>
                  {t('sites.settings.reset')}
                </Button>
              </Row>
              {editing === entry.origin && <SiteEditor entry={entry} globals={globals} onSaved={reload} />}
            </div>
          ))}
        </ListFrame>
      )}
    </Section>
  )
}

function SiteEditor({ entry, globals, onSaved }: { entry: SiteSettingsEntry; globals: { adblock: boolean; popupBlocking: boolean }; onSaved(): Promise<void> }): ReactElement {
  const t = useT()
  const [settings, setSettings] = useState(entry.settings)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => setSettings(entry.settings), [entry.settings])

  const save = async (patch: SiteSettingsPatch): Promise<void> => {
    setFailed(null)
    try {
      setSettings(await call('sites', 'set', entry.origin, patch))
      await onSaved()
    } catch (err) {
      setFailed(errorText(err) || t('sites.settings.failed'))
    }
  }
  const switches = switchStates({ settings, globals })

  return (
    <div className="ss-editor">
      {failed && <Notice tone="error">{failed}</Notice>}
      <h4 className="ss-editor__title">{t('sites.info.permissions')}</h4>
      <div className="ss-grid">
        {SITE_PERMISSIONS.map((perm) => {
          const label = t(`sites.perm.${perm}`)
          return (
            <div key={perm} className="ss-perm">
              <PermIcon perm={perm} size={15} />
              <span className="ss-perm__label">{label}</span>
              <Select
                size="sm"
                aria-label={label}
                value={settings.permissions[perm] ?? 'ask'}
                options={decisionOptions(perm).map((d) => ({ value: d, label: t(`sites.decision.${d}`) }))}
                onChange={(d) => void save({ permissions: { [perm]: d } })}
              />
            </div>
          )
        })}
      </div>
      {settings.devices.length > 0 && (
        <>
          <h4 className="ss-editor__title">{t('sites.info.devices')}</h4>
          {settings.devices.map((d) => (
            <div key={`${d.kind}:${d.id}`} className="ss-perm">
              <PermIcon perm={d.kind} size={15} />
              <span className="ss-perm__label">{d.name}</span>
              <Button size="sm" variant="ghost" aria-label={t('sites.info.revokeLabel', { name: d.name })} onClick={() => void save({ devices: settings.devices.filter((x) => !(x.kind === d.kind && x.id === d.id)) })}>
                {t('sites.info.revoke')}
              </Button>
            </div>
          ))}
        </>
      )}
      <h4 className="ss-editor__title">{t('sites.settings.switches')}</h4>
      {SWITCHES.map((s) => (
        <Switch key={s.key} size="sm" checked={switches[s.key]} onChange={(on) => void save(switchPatch(s.key, on, globals))} label={t(s.label)} />
      ))}
      <Switch size="sm" checked={settings.forceDark} onChange={(on) => void save({ forceDark: on })} label={t('sites.info.forceDark')} description={t('sites.info.forceDarkBody')} />
      {/* The per-site JavaScript, images, automatic downloads and insecure content rules. */}
      <h4 className="ss-editor__title">{t('safety.content.title')}</h4>
      <SiteContentRules bare settings={settings} onChange={(patch) => void save(patch)} />
    </div>
  )
}

function SiteData({ entries, error, reload }: ListProps<SiteDataEntry>): ReactElement {
  const t = useT()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const shown = useMemo(() => filterData(entries ?? [], query), [entries, query])

  const clear = async (domains: string[]): Promise<void> => {
    if (busy || domains.length === 0) return
    const title = domains.length === 1 ? t('sites.settings.clearTitle', { domain: domains[0]! }) : t('sites.settings.clearShownTitle', { count: domains.length })
    if (!(await confirm({ title, message: t('sites.settings.clearBody'), confirmLabel: t('sites.settings.clear'), destructive: true }))) return
    setBusy(true)
    try {
      for (const domain of domains) await call('sites', 'clearDomainData', domain)
      toast.show({ tone: 'success', message: domains.length === 1 ? t('sites.settings.cleared', { domain: domains[0]! }) : t('sites.settings.clearedMany', { count: domains.length }) })
      await reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) || t('sites.info.clearFailed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={t('sites.settings.data')}
      actions={
        entries && entries.length > 0 ? (
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('sites.settings.searchData')} />
            {query.trim() && shown.length > 0 && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void clear(shown.map((e) => e.domain))}>
                {t('sites.settings.clearShown')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {error && !entries ? (
        <LoadError message={error} onRetry={reload} />
      ) : !entries ? (
        <PageSkeleton label={t('sites.settings.data')} rows={4} />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState compact icon={<Cookie size={20} aria-hidden />} title={t('sites.settings.noData')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState compact title={t('sites.settings.noDataMatch', { query: query.trim() })} />
        </Card>
      ) : (
        <ListFrame label={t('sites.settings.data')}>
          {shown.map((entry) => (
            <Row key={entry.domain} title={<span className="ss-host">{entry.domain}</span>} description={t('sites.settings.cookies', { count: entry.cookies })} icon={<Cookie size={16} aria-hidden />}>
              <Button size="sm" variant="ghost" disabled={busy} aria-label={t('sites.settings.clearTitle', { domain: entry.domain })} onClick={() => void clear([entry.domain])}>
                {t('sites.settings.clear')}
              </Button>
            </Row>
          ))}
        </ListFrame>
      )}
    </Section>
  )
}

function CookieExceptions({ entries, reload }: { entries: SiteSettingsEntry[]; reload(): Promise<void> }): ReactElement {
  const t = useT()
  const inputId = useId()
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const exceptions = cookieExceptions(entries)

  const add = async (cookies: 'allow' | 'block', e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const origin = parseSiteInput(text)
    if (!origin) {
      setInvalid(true)
      return
    }
    setFailed(null)
    try {
      await call('sites', 'set', origin, { cookies })
      setText('')
      setInvalid(false)
      await reload()
    } catch (err) {
      setFailed(errorText(err) || t('sites.settings.failed'))
    }
  }
  const remove = async (origin: string): Promise<void> => {
    try {
      await call('sites', 'set', origin, { cookies: 'default' })
      await reload()
    } catch (err) {
      setFailed(errorText(err) || t('sites.settings.failed'))
    }
  }

  return (
    <Section title={t('sites.settings.exceptions')} note={t('sites.settings.exceptionsNote')}>
      {failed && <Notice tone="error">{failed}</Notice>}
      <Card>
        <form className="ss-add" onSubmit={(e) => void add('allow', e)}>
          <label htmlFor={inputId} className="ss-add__label">
            {t('sites.settings.exceptionSite')}
          </label>
          <TextInput
            id={inputId}
            value={text}
            invalid={invalid}
            placeholder="example.com"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${inputId}-error` : undefined}
            onChange={(e) => {
              setText(e.target.value)
              setInvalid(false)
            }}
          />
          <Button size="sm" variant="secondary" type="submit" disabled={!text.trim()}>
            {t('sites.settings.allow')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!text.trim()} onClick={() => void add('block')}>
            {t('sites.settings.block')}
          </Button>
          {invalid && (
            <p id={`${inputId}-error`} className="ss-add__error" role="alert">
              {t('sites.settings.exceptionInvalid')}
            </p>
          )}
        </form>
        {exceptions.length === 0 ? (
          <p className="ss-empty">{t('sites.settings.noExceptions')}</p>
        ) : (
          <ul className="ss-exceptions" aria-label={t('sites.settings.exceptions')}>
            {exceptions.map((x) => (
              <li key={x.origin} className="ss-exception">
                <span className="ss-host">{hostOf(x.origin)}</span>
                <Badge tone={x.cookies === 'allow' ? 'success' : 'danger'}>{x.cookies === 'allow' ? t('sites.settings.allowed') : t('sites.settings.blocked')}</Badge>
                <Button size="sm" variant="ghost" aria-label={`${t('sites.settings.remove')} ${hostOf(x.origin)}`} onClick={() => void remove(x.origin)}>
                  {t('sites.settings.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry(): Promise<void> }): ReactElement {
  const t = useT()
  return (
    <Notice
      tone="error"
      action={
        <Button size="sm" onClick={() => void onRetry()}>
          {t('sites.settings.retry')}
        </Button>
      }
    >
      {t('sites.settings.loadFailed')} {message}
    </Notice>
  )
}

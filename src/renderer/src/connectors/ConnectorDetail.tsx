/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, KeyRound, Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import { CONNECTOR_SWATCHES, connectorDetailUrl, policiesFor, type ConnectorHealth, type DirectoryEntry, type ToolPolicy } from '@shared/connectors'
import type { Connector } from '@shared/services'
import { atelier, call, errorText } from '../api'
import { useT, type T } from '../i18n/useT'
import { ownerList } from '../settings/destinations/common'
import type { ConnectorDialogs } from '../settings/destinations/ConnectorEditor'
import { useCompanions } from '../settings/data'
import { Field, Notice, TextInput } from '../settings/kit'
import { Badge, Button, IconButton, InlineRename, RelativeTime, SegmentedControl, Select, Spinner, StatusDot, Switch, cx, showMenu, useConfirm, useToast, type Status } from '../ui'
import { ConnectorLogo } from './ConnectorLogo'
import { localApprovalProps } from './LocalApprovalDialog'
import { accountsOf } from './logic/directory'
import { commandLine, fillUrlTemplate, inputFromConnector } from './logic/addForm'

// SK-14: one connector. Its health with Reconnect, rename and a
// label colour, the accounts of its service, its settings, every tool with
// a policy, and for a local server its exact command and recent output.

const HEALTH_KEYS: Record<ConnectorHealth, Parameters<T>[0]> = {
  unknown: 'connectors.health.unknown',
  checking: 'connectors.health.checking',
  ok: 'connectors.health.ok',
  'needs-reconnect': 'connectors.health.needsReconnect',
  'needs-approval': 'connectors.health.needsApproval',
  starting: 'connectors.health.starting',
  error: 'connectors.health.error',
  stopped: 'connectors.health.stopped',
}

const HEALTH_DOTS: Record<ConnectorHealth, Status> = {
  unknown: 'idle',
  checking: 'working',
  ok: 'success',
  'needs-reconnect': 'needs-input',
  'needs-approval': 'needs-input',
  starting: 'working',
  error: 'error',
  stopped: 'idle',
}

const POLICY_KEYS: Record<ToolPolicy, Parameters<T>[0]> = {
  ask: 'connectors.policy.ask',
  allow: 'connectors.policy.allow',
  off: 'connectors.policy.off',
}

/** The health line a tile or the detail shows. */
export function healthText(t: T, c: Pick<Connector, 'health' | 'enabled'>): string {
  return c.enabled ? t(HEALTH_KEYS[c.health]) : t('connectors.health.off')
}

export function healthDot(c: Pick<Connector, 'health' | 'enabled'>): Status {
  return c.enabled ? HEALTH_DOTS[c.health] : 'idle'
}

export interface ConnectorDetailProps {
  connector: Connector
  all: readonly Connector[]
  directory: readonly DirectoryEntry[]
  tabId: string
  dialogs: ConnectorDialogs
  onConnectAnother(entry: DirectoryEntry): void
}

export function ConnectorDetail({ connector: c, all, directory, tabId, dialogs, onConnectAnother }: ConnectorDetailProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const entry = c.directoryId ? directory.find((e) => e.id === c.directoryId) : undefined
  const local = c.transport.kind === 'local'
  const working = busy !== null || c.health === 'checking' || c.health === 'starting'

  const run = async (key: string, fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      if (done) toast.show({ tone: 'success', message: done })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const approve = async (el: HTMLElement | null): Promise<void> => {
    const data = localApprovalProps(c)
    if (!data) return
    const ok = await dialogs.openApproval(el, data)
    if (ok) toast.show({ tone: 'success', message: t('connectors.detail.approved', { name: c.displayName }) })
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({ title: t('connectors.detail.removeTitle', { name: c.displayName }), message: t('connectors.detail.removeBody'), confirmLabel: t('connectors.detail.removeConfirm'), destructive: true })
    if (!ok) return
    try {
      await call('connectors', 'remove', c.id)
      toast.show({ message: t('connectors.detail.removed', { name: c.displayName }) })
      void atelier.nav.go(tabId, 'atelier://connectors')
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const healthAction = (): ReactElement => {
    if (c.health === 'needs-approval')
      return (
        <Button variant="primary" size="sm" onClick={(e) => void approve(e.currentTarget)}>
          {t('connectors.detail.reviewStart')}
        </Button>
      )
    if (c.health === 'needs-reconnect')
      return (
        <Button variant="primary" size="sm" loading={busy === 'reconnect'} onClick={() => void run('reconnect', () => call('connectors', 'reconnect', c.id), t('connectors.detail.reconnected', { name: c.displayName }))}>
          {t('connectors.action.reconnect')}
        </Button>
      )
    return (
      <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={busy === 'check'} disabled={working || !c.enabled} onClick={() => void run('check', () => call('connectors', 'check', c.id))}>
        {t('connectors.detail.check')}
      </Button>
    )
  }

  return (
    <article className="cx-detail" aria-labelledby="cx-detail-title">
      <button type="button" className="cx-back" onClick={() => void atelier.nav.go(tabId, 'atelier://connectors')}>
        <ArrowLeft size={14} aria-hidden /> {t('connectors.page.back')}
      </button>

      <header className="cx-detail__head">
        <ConnectorLogo name={c.displayName} logo={c.logo} site={entry?.site ?? null} category={entry?.category ?? null} local={local} size="lg" />
        <div className="cx-detail__title">
          <h1 id="cx-detail-title" className="cx-detail__name">
            {c.labelColor && <span className="cx-label-dot" style={{ background: c.labelColor }} aria-hidden />}
            <InlineRename value={c.displayName} label={t('connectors.detail.rename')} maxLength={48} onCommit={(name) => call('connectors', 'rename', c.id, name)} />
          </h1>
          <p className="cx-detail__meta">
            <Badge>{c.source === 'directory' ? t('connectors.detail.directory') : t('connectors.detail.custom')}</Badge>
            {c.accountLabel && <Badge>{c.accountLabel}</Badge>}
            {c.isDefault && accountsOf(all, c).length > 1 && <Badge tone="accent">{t('connectors.tile.default')}</Badge>}
          </p>
          <p className="cx-muted">{entry?.description ?? c.url}</p>
        </div>
        <div className="cx-detail__actions">
          <Switch checked={c.enabled} label={t('connectors.detail.enabled')} onChange={(on) => void run('enabled', () => call('connectors', 'setEnabled', c.id, on))} />
        </div>
      </header>

      <section className="cx-card" aria-labelledby="cx-health">
        <h2 id="cx-health" className="cx-card__title">
          {t('connectors.detail.health')}
        </h2>
        <div className="cx-health" role="status">
          {working ? <Spinner size={14} /> : <StatusDot status={healthDot(c)} size={8} label="" pulse={false} />}
          <span className="cx-health__text">
            <strong>{healthText(t, c)}</strong>
            {c.healthDetail && <span className="cx-muted">{c.healthDetail}</span>}
          </span>
          {healthAction()}
        </div>
        <p className="cx-muted cx-where">
          <strong>{t('connectors.detail.where')}.</strong> {c.execution === 'server' ? t('connectors.detail.whereServer') : t('connectors.detail.whereLocal')}
        </p>
        {c.searchable && <p className="cx-muted">{t('connectors.detail.searchable')}</p>}
      </section>

      <section className="cx-card" aria-labelledby="cx-look">
        <h2 id="cx-look" className="cx-card__title">
          {t('connectors.detail.color')}
        </h2>
        <Swatches value={c.labelColor} onChange={(color) => void run('color', () => call('connectors', 'setLabelColor', c.id, color))} />
        <OwnerRow connector={c} onSave={(owner) => run('owner', () => call('connectors', 'save', inputFromConnector(c, { owner })))} />
      </section>

      {entry && <Accounts connector={c} all={all} entry={entry} tabId={tabId} onAdd={() => onConnectAnother(entry)} onDefault={(id) => void run('default', () => call('connectors', 'setDefault', id))} />}

      <SettingsFields connector={c} entry={entry} />

      <Tools connector={c} busy={working} onCheck={() => void run('check', () => call('connectors', 'check', c.id))} />

      <section className="cx-card" aria-labelledby="cx-server">
        <h2 id="cx-server" className="cx-card__title">
          {t('connectors.detail.server')}
          {c.source === 'custom' && (
            <Button variant="ghost" size="sm" icon={<Pencil />} onClick={(e) => void dialogs.openAdd(e.currentTarget, { connectorId: c.id }).then((r) => r && call('connectors', 'check', c.id).catch(() => undefined))}>
              {t('connectors.detail.edit')}
            </Button>
          )}
        </h2>
        {c.transport.kind === 'remote' ? (
          <dl className="cx-facts">
            <dt>{t('connectors.detail.url')}</dt>
            <dd className="sp-mono">{c.transport.url}</dd>
            {c.transport.headerName && (
              <>
                <dt>{t('connectors.detail.header')}</dt>
                <dd className="sp-mono">{c.transport.headerName}</dd>
              </>
            )}
            <dt>{t('connectors.detail.auth')}</dt>
            <dd>{t(`connectors.auth.${c.auth}`)}</dd>
          </dl>
        ) : (
          <>
            <dl className="cx-facts">
              <dt>{t('connectors.detail.command')}</dt>
              <dd>
                <pre className="cx-code">{commandLine(c.transport.command, c.transport.args)}</pre>
              </dd>
              <dt>{t('connectors.detail.cwd')}</dt>
              <dd className="sp-mono">{c.transport.cwd ?? t('connectors.detail.cwdDefault')}</dd>
              <dt>{t('connectors.detail.env')}</dt>
              <dd>
                {c.transport.env.length === 0 ? (
                  <span className="cx-muted">{t('connectors.local.envNone')}</span>
                ) : (
                  <ul className="cx-env-list">
                    {c.transport.env.map((e) => (
                      <li key={e.name}>
                        <code>{e.name}</code>
                        <span className="cx-muted">
                          {e.secret ? (
                            <>
                              <KeyRound size={12} aria-hidden /> {t('connectors.detail.envSecret')}
                            </>
                          ) : e.hasValue ? (
                            t('connectors.detail.envSet')
                          ) : (
                            t('connectors.detail.envEmpty')
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            <Logs connectorId={c.id} />
          </>
        )}
      </section>

      <footer className="cx-detail__foot">
        {entry && (
          <Button variant="ghost" iconEnd={<ArrowUpRight />} onClick={() => void atelier.tabs.create(entry.docsUrl)}>
            {t('connectors.detail.docs')}
          </Button>
        )}
        <Button variant="danger" icon={<Trash2 />} onClick={() => void remove()}>
          {t('connectors.detail.remove')}
        </Button>
      </footer>
    </article>
  )
}

/** Label colours as a radio group: arrows move, Space or Enter picks. */
function Swatches({ value, onChange }: { value: string | null; onChange(color: string | null): void }): ReactElement {
  const t = useT()
  const options: (string | null)[] = [null, ...CONNECTOR_SWATCHES]
  const current = options.indexOf(value?.toLowerCase() ?? null)
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (Math.max(current, 0) + step + options.length) % options.length
    onChange(options[next] ?? null)
    requestAnimationFrame(() => (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next] ?? null)?.focus())
  }
  return (
    <div className="cx-swatches" role="radiogroup" aria-label={t('connectors.detail.color')} onKeyDown={onKey}>
      {options.map((color, i) => {
        const on = i === Math.max(current, 0)
        return (
          <button
            key={color ?? 'none'}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx('cx-swatch', !color && 'cx-swatch--none', on && 'cx-swatch--on')}
            style={color ? { background: color } : undefined}
            aria-label={color ? `${t('connectors.detail.colorPick')} ${i}` : t('connectors.detail.colorNone')}
            title={color ?? t('connectors.detail.colorNone')}
            onClick={() => onChange(color)}
          >
            {on && <Check size={12} aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

/** Which companions get the connector. */
function OwnerRow({ connector, onSave }: { connector: Connector; onSave(owner: string): Promise<void> }): ReactElement {
  const t = useT()
  const id = useId()
  const companions = ownerList(useCompanions().items)
  const options = [{ value: SHARED_OWNER, label: t('connectors.detail.ownerShared') }, ...companions.map((c) => ({ value: c.id, label: c.name }))]
  return (
    <div className="cx-row cx-row--spread">
      <label htmlFor={id}>{t('connectors.detail.owner')}</label>
      <Select id={id} size="sm" value={connector.owner} options={options} onChange={(owner) => void onSave(owner)} />
    </div>
  )
}

function Accounts({ connector, all, entry, tabId, onAdd, onDefault }: { connector: Connector; all: readonly Connector[]; entry: DirectoryEntry; tabId: string; onAdd(): void; onDefault(id: string): void }): ReactElement {
  const t = useT()
  const accounts = accountsOf(all, connector)
  return (
    <section className="cx-card" aria-labelledby="cx-accounts">
      <h2 id="cx-accounts" className="cx-card__title">
        {t('connectors.detail.accounts')}
        <Button variant="ghost" size="sm" icon={<Plus />} onClick={onAdd}>
          {t('connectors.detail.addAccount')}
        </Button>
      </h2>
      <p className="cx-muted">{t('connectors.detail.accountsNote')}</p>
      <ul className="cx-accounts">
        {accounts.map((a) => (
          <li key={a.id} className={cx('cx-account', a.id === connector.id && 'cx-account--current')}>
            <ConnectorLogo name={a.displayName} logo={a.logo} site={entry.site} category={entry.category} size="sm" />
            {a.id === connector.id ? (
              <span className="cx-account__name" aria-current="page">
                {a.displayName}
                {a.accountLabel && <span className="cx-muted"> · {a.accountLabel}</span>}
              </span>
            ) : (
              <button type="button" className="cx-link cx-account__name" onClick={() => void atelier.nav.go(tabId, connectorDetailUrl(a.id))}>
                {a.displayName}
                {a.accountLabel && <span className="cx-muted"> · {a.accountLabel}</span>}
              </button>
            )}
            {a.isDefault ? (
              <Badge tone="accent">
                <Star size={11} aria-hidden /> {t('connectors.tile.default')}
              </Badge>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => onDefault(a.id)}>
                {t('connectors.detail.makeDefault')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Fields the service needs (host, workspace); saving fills the server URL from them. */
function SettingsFields({ connector, entry }: { connector: Connector; entry: DirectoryEntry | undefined }): ReactElement | null {
  const t = useT()
  const toast = useToast()
  const id = useId()
  const fields = (entry?.fields ?? []).filter((f) => f.key !== 'clientId' && f.key !== 'clientSecret')
  const keys = [...new Set([...fields.map((f) => f.key), ...Object.keys(connector.settings)])]
  const [values, setValues] = useState<Record<string, string>>(connector.settings)
  const [saving, setSaving] = useState(false)
  useEffect(() => setValues(connector.settings), [connector.id, JSON.stringify(connector.settings)])
  if (keys.length === 0) return null
  const dirty = JSON.stringify(values) !== JSON.stringify(connector.settings)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const url = entry && connector.transport.kind === 'remote' && /\{[a-zA-Z0-9_]+\}/.test(entry.url) ? fillUrlTemplate(entry.url, values) : undefined
      await call('connectors', 'save', inputFromConnector(connector, { settings: values, ...(url ? { url } : {}) }))
      toast.show({ tone: 'success', message: t('connectors.detail.settingsSaved') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="cx-card" aria-labelledby="cx-settings">
      <h2 id="cx-settings" className="cx-card__title">
        {t('connectors.detail.settings')}
      </h2>
      <form
        className="cx-settings"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {keys.map((key) => {
          const f = fields.find((x) => x.key === key)
          return (
            <Field key={key} label={f?.label ?? key} htmlFor={`${id}-${key}`}>
              <TextInput id={`${id}-${key}`} value={values[key] ?? ''} placeholder={f?.placeholder} spellCheck={false} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
            </Field>
          )
        })}
        <Button type="submit" size="sm" variant="secondary" disabled={!dirty} loading={saving}>
          {t('connectors.detail.saveSettings')}
        </Button>
      </form>
    </section>
  )
}

/** Every tool from tools/list with its policy; Ask only where Atelier runs the server. */
function Tools({ connector: c, busy, onCheck }: { connector: Connector; busy: boolean; onCheck(): void }): ReactElement {
  const t = useT()
  const toast = useToast()
  const allowed = policiesFor(c.execution)
  const set = (tool: string, policy: ToolPolicy): void => {
    call('connectors', 'setToolPolicy', c.id, tool, policy).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }
  const setAll = (policy: ToolPolicy): void => {
    call('connectors', 'setAllTools', c.id, policy).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }
  const allMenu = async (el: HTMLElement): Promise<void> => {
    const picked = await showMenu(
      [
        ...(allowed.includes('ask') ? [{ id: 'ask', label: t('connectors.detail.askAll') }] : []),
        { id: 'off', label: t('connectors.detail.offAll') },
      ],
      el,
    )
    if (picked === 'ask' || picked === 'off') setAll(picked)
  }
  return (
    <section className="cx-card" aria-labelledby="cx-tools">
      <h2 id="cx-tools" className="cx-card__title">
        {t('connectors.detail.tools')}
        {c.tools.length > 0 && (
          <span className="cx-card__actions">
            <Button variant="secondary" size="sm" onClick={() => setAll('allow')}>
              {t('connectors.detail.allowAll')}
            </Button>
            <IconButton size="sm" label={t('connectors.detail.moreAll')} icon={<ChevronDown />} aria-haspopup="menu" onClick={(e) => void allMenu(e.currentTarget)} />
          </span>
        )}
      </h2>
      {c.tools.length > 0 && c.toolsCheckedAt !== null && (
        <p className="cx-muted">
          {t('connectors.detail.toolsCount', { count: c.tools.length })} <RelativeTime value={c.toolsCheckedAt} />
        </p>
      )}
      {c.execution === 'server' && <Notice tone="info">{t('connectors.detail.toolsAskNote')}</Notice>}
      {c.tools.length === 0 ? (
        <div className="cx-empty-tools">
          <p className="cx-muted">{t('connectors.detail.toolsNone')}</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={busy} disabled={!c.enabled} onClick={onCheck}>
            {t('connectors.detail.check')}
          </Button>
        </div>
      ) : (
        <ul className="cx-tools">
          {c.tools.map((tool) => (
            <li key={tool.name} className={cx('cx-tool', tool.policy === 'off' && 'cx-tool--off')}>
              <div className="cx-tool__text">
                <span className="cx-tool__name">
                  {tool.title}
                  {tool.readOnly && <Badge>{t('connectors.detail.readOnly')}</Badge>}
                </span>
                <code className="cx-tool__id">{tool.name}</code>
                {tool.description && <span className="cx-tool__desc">{tool.description}</span>}
              </div>
              <SegmentedControl<ToolPolicy>
                size="sm"
                label={t('connectors.detail.policy', { tool: tool.title })}
                value={allowed.includes(tool.policy) ? tool.policy : 'allow'}
                options={allowed.map((p) => ({ value: p, label: t(POLICY_KEYS[p]) }))}
                onChange={(p) => set(tool.name, p)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A local server's recent stderr and stdout (secrets masked by main), refreshed while shown. */
function Logs({ connectorId }: { connectorId: string }): ReactElement {
  const t = useT()
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    let live = true
    const load = (): void => {
      if (document.hidden) return
      call('connectors', 'logs', connectorId).then(
        (next: string[]) => {
          if (live) setLines(next)
        },
        () => undefined,
      )
    }
    load()
    const timer = window.setInterval(load, 2500)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [connectorId])
  return (
    <div className="cx-logs">
      <p className="cx-label">{t('connectors.detail.logs')}</p>
      {lines.length === 0 ? (
        <p className="cx-muted">{t('connectors.detail.logsEmpty')}</p>
      ) : (
        <pre className="cx-code cx-code--logs" tabIndex={0} aria-label={t('connectors.detail.logs')}>
          {lines.slice(-200).join('\n')}
        </pre>
      )}
    </div>
  )
}

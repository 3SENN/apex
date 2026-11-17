/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The connectors step (ON-08): suggested connectors from the connectors directory,
// ranked by the sites in your imported history, each with connect,
// connecting, connected and retry; or a server address. Entries that need
// a token open the connector's own connect flow. Continuing with none connected gets a
// gentle nudge first (still under reduced motion), and Skip always works.
// The scene puts the suggested apps' own icons around the companion, lit
// once connected.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Check, Plug, RotateCw, ShieldCheck } from 'lucide-react'
import { connectorConnectUrl, type DirectoryEntry } from '@shared/connectors'
import { hostVisits, rankConnectorSuggestions } from '@shared/onboarding'
import { profileIsEmpty } from '@shared/userProfile'
import { call, errorText } from '../../api'
import { Button, Spinner } from '../../ui'
import { useMotion } from '../../ui/motion'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene, initial } from './StepFrame'
import { useT } from '../../i18n/useT'

type RowState = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'connected' } | { kind: 'failed'; message: string }

interface Suggestions {
  entries: DirectoryEntry[]
  connected: Set<string>
}

async function loadSuggestions(limit: number): Promise<Suggestions> {
  const [directory, existing, history, plan] = await Promise.all([
    call('connectors', 'directory'),
    call('connectors', 'list').catch(() => []),
    call('history', 'search', '', 2000).catch(() => []),
    call('onboarding', 'plan').catch(() => null),
  ])
  const connected = new Set(existing.flatMap((c) => {
    const id = (c as { directoryId?: string | null; enabled?: boolean }).directoryId
    return id && (c as { enabled?: boolean }).enabled !== false ? [id] : []
  }))
  // ON-18: the apps your profile named or needs come first; the ranking by your history fills in.
  const planned = (plan?.connectors ?? []).flatMap((id) => directory.filter((e) => e.id === id))
  return { entries: planned.length > 0 ? planned : rankConnectorSuggestions(directory, hostVisits(history), limit), connected }
}

// One lookup per site for the page's life: the rows and the scene share it.
const icons = new Map<string, Promise<string | null>>()
function siteIcon(site: string): Promise<string | null> {
  let icon = icons.get(site)
  if (!icon) {
    icon = call('connectors', 'favicon', site).catch(() => null)
    icons.set(site, icon)
  }
  return icon
}

/** Sites' own icons (null until known, or when Atelier has none). */
export function useSiteIcons(sites: readonly string[]): Record<string, string | null> {
  const [found, setFound] = useState<Record<string, string | null>>({})
  const key = sites.join('\n')
  useEffect(() => {
    let live = true
    for (const site of sites) {
      if (!site) continue
      void siteIcon(site).then((url) => {
        if (live) setFound((m) => (m[site] === url ? m : { ...m, [site]: url }))
      })
    }
    return () => {
      live = false
    }
  }, [key])
  return found
}

function useFavicon(site: string): string | null {
  return useSiteIcons([site])[site] ?? null
}

function ConnectorRow({ entry, state, onConnect }: { entry: DirectoryEntry; state: RowState; onConnect(): void }): ReactElement {
  const t = useT()
  const icon = useFavicon(entry.site)
  return (
    <li className="wlx__connector" data-state={state.kind}>
      <span className="wlx__connector-icon" aria-hidden="true">{icon ? <img src={icon} alt="" width={20} height={20} /> : <Plug />}</span>
      <span className="wlx__connector-text">
        <span className="wlx__connector-name">{entry.name}</span>
        <span className="wlx__connector-desc">{state.kind === 'failed' ? state.message : entry.description}</span>
      </span>
      <span className="wlx__connector-action" aria-live="polite">
        {state.kind === 'idle' && <Button size="sm" variant="secondary" onClick={onConnect} aria-label={t('firstRun.welcomeConnectors.connect', { name: entry.name })}>{t('firstRun.welcomeConnectors.connect2')}</Button>}
        {state.kind === 'connecting' && (
          <span className="wlx__connector-status">
            <Spinner size={14} /> {t('firstRun.welcomeConnectors.connecting')}
          </span>
        )}
        {state.kind === 'connected' && (
          <span className="wlx__connector-status wlx__connector-status--ok">
            <Check aria-hidden /> {t('firstRun.welcomeConnectors.connected')}
          </span>
        )}
        {state.kind === 'failed' && <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={onConnect} aria-label={t('firstRun.welcomeConnectors.retryConnecting', { name: entry.name })}>{t('firstRun.welcomeConnectors.retry')}</Button>}
      </span>
    </li>
  )
}

/** One suggestion as the scene draws it. */
export interface ConnectorMark {
  id: string
  name: string
  site: string
  connected: boolean
}

/** The suggestions list with inline connect; also used by setup's connector question card. */
export function InlineConnectors({ limit = 6, onChange, onLoaded, onMarks }: { limit?: number; onChange?(connected: number): void; onLoaded?(): void; onMarks?(marks: ConnectorMark[]): void }): ReactElement {
  const t = useT()
  const [data, setData] = useState<Suggestions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const load = (): void => {
    setError(null)
    loadSuggestions(limit).then(
      (d) => {
        setData(d)
        setRows(Object.fromEntries([...d.connected].map((id) => [id, { kind: 'connected' } as RowState])))
        onLoaded?.()
      },
      (err: unknown) => {
        setError(errorText(err))
        onLoaded?.()
      },
    )
  }
  useEffect(load, [])
  useEffect(() => onChange?.(Object.values(rows).filter((r) => r.kind === 'connected').length), [rows])
  useEffect(() => {
    if (data) onMarks?.(data.entries.map((e) => ({ id: e.id, name: e.name, site: e.site, connected: rows[e.id]?.kind === 'connected' })))
  }, [data, rows])

  const connect = async (entry: DirectoryEntry): Promise<void> => {
    // Tokens and extra fields are asked for on the connector's own page.
    if (entry.auth === 'token' || (entry.fields?.length ?? 0) > 0 || entry.setup === 'google') {
      await call('pages', 'open', connectorConnectUrl(entry.id))
      return
    }
    setRows((r) => ({ ...r, [entry.id]: { kind: 'connecting' } }))
    try {
      await call('connectors', 'connectDirectory', entry.id)
      setRows((r) => ({ ...r, [entry.id]: { kind: 'connected' } }))
    } catch (err) {
      setRows((r) => ({ ...r, [entry.id]: { kind: 'failed', message: errorText(err) } }))
    }
  }

  if (error) {
    return (
      <div className="wlx__slow" role="alert">
        <p>{t('firstRun.welcomeConnectors.connectorsCouldnTLoad', { error })}</p>
        <Button variant="secondary" onClick={load}>{t('firstRun.welcomeConnectors.tryAgain')}</Button>
      </div>
    )
  }
  if (!data) {
    return (
      <p className="wlx__connector-status" role="status">
        <Spinner size={14} /> {t('firstRun.welcomeConnectors.findingApps')}
      </p>
    )
  }
  return (
    <ul className="wlx__connectors" aria-label={t('firstRun.welcomeConnectors.suggestedConnectors')}>
      {data.entries.map((entry) => <ConnectorRow key={entry.id} entry={entry} state={rows[entry.id] ?? { kind: 'idle' }} onConnect={() => void connect(entry)} />)}
    </ul>
  )
}

function UrlEntry({ onConnected }: { onConnected(): void }): ReactElement {
  const t = useT()
  const id = useId()
  const [url, setUrl] = useState('')
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const add = async (): Promise<void> => {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('bad')
    } catch {
      setState({ kind: 'failed', message: t('firstRun.welcomeConnectors.enterTheServerS') })
      return
    }
    setState({ kind: 'connecting' })
    try {
      const saved = await call('connectors', 'save', { name: parsed.hostname.replace(/^www\./, ''), transport: { kind: 'remote', url: parsed.toString() }, auth: 'oauth', enabled: true })
      await call('connectors', 'check', saved.id).catch(() => undefined)
      setState({ kind: 'connected' })
      setUrl('')
      onConnected()
    } catch (err) {
      setState({ kind: 'failed', message: errorText(err) })
    }
  }
  return (
    <div className="co-field wlx__url">
      <label className="co-field__label" htmlFor={id}>{t('firstRun.welcomeConnectors.orConnectAServer')}</label>
      <div className="co-field__row">
        <input id={id} className="co-input" type="url" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void add()} />
        <Button variant="secondary" loading={state.kind === 'connecting'} disabled={!url.trim()} onClick={() => void add()}>{t('firstRun.welcomeConnectors.connect2')}</Button>
      </div>
      {state.kind === 'failed' && <p className="co-field__error" role="alert">{state.message}</p>}
      {state.kind === 'connected' && <p className="co-hint" role="status">{t('firstRun.welcomeConnectors.addedItShowsIn')}</p>}
    </div>
  )
}

export function ConnectorsStep({ next, back, ready }: StepProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  // ON-18: when your profile said what you do and named no app Atelier can connect (and needs none), there's nothing to offer here.
  useEffect(() => {
    let live = true
    void Promise.all([call('onboarding', 'profile').catch(() => null), call('onboarding', 'plan').catch(() => null)]).then(([profile, plan]) => {
      if (live && profile && plan && !profileIsEmpty(profile) && plan.connectors.length === 0) next()
    })
    return () => {
      live = false
    }
  }, [])
  const [connected, setConnected] = useState(0)
  const [extra, setExtra] = useState(0)
  const [nudged, setNudged] = useState(false)
  const [marks, setMarks] = useState<ConnectorMark[]>([])
  const icons = useSiteIcons(marks.slice(0, 6).map((m) => m.site))
  const total = connected + extra
  const proceed = (): void => {
    if (total === 0 && !nudged) {
      setNudged(true)
      return
    }
    next({ answers: { 'connectors-connected': String(total) } })
  }
  return (
    <StepFrame
      title={t('firstRun.welcomeConnectors.connectYourApps')}
      subtitle={t('firstRun.welcomeConnectors.connectorsLetYourCompanion')}
      back={<BackButton onBack={back} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => next()}>{t('firstRun.welcomeConnectors.skip')}</Button>
          <Button variant="primary" onClick={proceed}>{nudged && total === 0 ? t('firstRun.welcomeConnectors.continueWithoutApps') : t('firstRun.welcomeConnectors.continue')}</Button>
        </>
      }
    >
      <StepScene
        tiles={marks.slice(0, 6).map((m) => ({ id: m.id, image: icons[m.site] ?? null, mark: initial(m.name), on: m.connected, badge: m.connected ? 'check' : undefined }))}
      />
      <p className="wlx__assure">
        <ShieldCheck aria-hidden /> {t('firstRun.welcomeConnectors.yourCompanionAlwaysAsks')}
      </p>
      <InlineConnectors onChange={setConnected} onLoaded={ready} onMarks={setMarks} />
      <UrlEntry onConnected={() => setExtra((n) => n + 1)} />
      {nudged && total === 0 && (
        <p className="wlx__nudge" data-reduced={reduced || undefined} role="status">
          {t('firstRun.welcomeConnectors.nothingConnectedYetThat')}
        </p>
      )}
    </StepFrame>
  )
}

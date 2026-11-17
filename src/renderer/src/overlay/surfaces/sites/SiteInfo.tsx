/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Cookie, Database, Lock, Settings, ShieldAlert, TriangleAlert } from 'lucide-react'
import { decisionOptions } from '@shared/permissions'
import type { PermissionDecision, SecurityState, SiteInfo, SitePermission, SiteSettingsPatch } from '@shared/sites'
import { apex, call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, ErrorState, Select, SkeletonRows, Switch } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { capturingKinds, formatFingerprint, mediaNoun, sizeLabel, splitHost, splitPermissions, switchPatch, switchStates, type SwitchKey } from './logic'
import { PermIcon } from './parts'
import { SiteContentRules } from '../../../settings/sections/privacy/SiteContentRules'
import { SiteTweakSection } from '../../../tweaks/SiteTweakSection' // TWK-04
import { SitePrivacySummary } from './SitePrivacySummary' // privacy pack

// Site info (SH-37): opened from the pill's site button. The
// connection and certificate, the site's permissions (unset ones folded
// away), what it may use this time only (one-time permissions and devices
// allowed without "remember", each with Revoke), granted devices, the
// ad-block, sound and pop-up switches, dark mode for the site, and its
// cookies, data and cache with Clear. Everything acts on the window's own
// profile or private session. Esc or a click outside closes it (the host's
// menu policy).

type Clearing = 'data' | 'cache'

const SECURITY: Record<SecurityState, { title: Parameters<ReturnType<typeof useT>>[0]; body: Parameters<ReturnType<typeof useT>>[0] | null; tone: 'secure' | 'warn' | 'danger' | 'none' }> = {
  secure: { title: 'sites.info.secure', body: 'sites.info.secureBody', tone: 'secure' },
  insecure: { title: 'sites.info.insecure', body: 'sites.info.insecureBody', tone: 'warn' },
  'cert-bypassed': { title: 'sites.info.bypassed', body: 'sites.info.bypassedBody', tone: 'danger' },
  dangerous: { title: 'sites.info.dangerous', body: 'sites.info.dangerousBody', tone: 'danger' },
  internal: { title: 'sites.info.none', body: null, tone: 'none' },
  none: { title: 'sites.info.none', body: null, tone: 'none' },
}

export function SiteInfoPopover({ props, close }: SurfaceComponentProps<{ tabId: string }>): ReactElement {
  const t = useT()
  const titleId = useId()
  const [info, setInfo] = useState<SiteInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [certOpen, setCertOpen] = useState(false)
  const [clearing, setClearing] = useState<Clearing | null>(null)
  const [cleared, setCleared] = useState<Clearing | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setInfo(await call('sites', 'info', props.tabId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [props.tabId])

  useEffect(() => {
    void load()
  }, [load])

  // Another surface (or the Settings page) changed this site, or its capture moved.
  useEffect(
    () =>
      apex.onAppEvent((event) => {
        // A changed answer also ends the site's one-time ones (main forgets them), so those are read again too.
        if (event.type === 'site-settings' && info && event.origin === info.origin)
          void call('sites', 'info', props.tabId).then(({ settings, oneTime, sessionDevices }) => setInfo((i) => (i ? { ...i, settings, oneTime, sessionDevices } : i)))
        if (event.type === 'capture' && event.tabId === props.tabId) setInfo((i) => (i ? { ...i, capture: event.capture } : i))
      }),
    [info?.origin, props.tabId],
  )

  const update = async (patch: SiteSettingsPatch): Promise<void> => {
    if (!info) return
    setFailed(null)
    try {
      const settings = await call('sites', 'set', info.origin, patch)
      setInfo({ ...info, settings })
    } catch (err) {
      setFailed(errorText(err) || t('sites.settings.failed'))
    }
  }

  const clear = async (what: Clearing): Promise<void> => {
    if (!info || clearing) return
    setClearing(what)
    setFailed(null)
    try {
      if (what === 'data') await call('sites', 'clearSiteData', info.origin)
      else await call('sites', 'clearCache', info.origin)
      setCleared(what)
      setInfo((i) => (i ? (what === 'data' ? { ...i, cookieCount: 0, dataBytes: 0 } : { ...i, cacheBytes: 0 }) : i))
    } catch {
      setFailed(t('sites.info.clearFailed'))
    } finally {
      setClearing(null)
    }
  }

  if (error) {
    return (
      <div className="st-card st-info" role="dialog" aria-label={t('sites.info.error')}>
        <ErrorState compact title={t('sites.info.error')} message={error} retryLabel={t('sites.info.retry')} onRetry={load} />
      </div>
    )
  }
  if (!info) {
    return (
      <div className="st-card st-info" role="dialog" aria-busy="true" aria-label={t('sites.info.label', { host: '' })}>
        <SkeletonRows rows={5} label={t('sites.info.label', { host: '' })} />
      </div>
    )
  }

  const security = SECURITY[info.security]
  const host = splitHost(info.host, info.registrable)
  const oneTime = info.oneTime ?? []
  const sessionDevices = info.sessionDevices ?? []
  const split = splitPermissions(info.settings, info.capture)
  // A one-time grant shows once, as "Allowed this time", not again among the unset ones.
  const perms = { set: split.set.filter(({ perm }) => !oneTime.includes(perm)), unset: split.unset.filter((perm) => !oneTime.includes(perm)) }
  const switches = switchStates(info)
  const live = capturingKinds(info.capture)
  const liveNoun = mediaNoun(info.capture.camera, info.capture.microphone) ?? (info.capture.screen ? 'sites.noun.screen' : null)
  const cert = info.certificate

  const setSwitch = (key: SwitchKey, on: boolean): void => void update(switchPatch(key, on, info.globals))
  const setPermission = (perm: SitePermission, decision: PermissionDecision): void => void update({ permissions: { [perm]: decision } })
  const revoke = (kind: string, id: string): void => void update({ devices: info.settings.devices.filter((d) => !(d.kind === kind && d.id === id)) })
  /** Revokes a one-time permission or a session device, then reads site info again. */
  const revokeOnce = async (run: () => Promise<void>): Promise<void> => {
    setFailed(null)
    try {
      await run()
      await load()
    } catch (err) {
      setFailed(errorText(err) || t('sites.settings.failed'))
    }
  }

  return (
    <div className="st-card st-info" role="dialog" aria-labelledby={titleId}>
      <header className="st-info__head">
        <h2 id={titleId} className="st-info__host st-host" aria-label={t('sites.info.label', { host: info.host })}>
          <span className="st-host__sub">{host.before}</span>
          <span className="st-host__reg">{host.registrable}</span>
        </h2>
        {info.punycodeWarning && (
          <p className="st-note st-note--warn" role="note">
            <TriangleAlert size={13} aria-hidden />
            {t('sites.info.punycode')}
          </p>
        )}
      </header>

      <section className={`st-section st-conn st-conn--${security.tone}`} aria-label={t(security.title)}>
        <div className="st-row">
          <span className="st-row__glyph" aria-hidden>
            {security.tone === 'secure' ? <Lock size={15} /> : security.tone === 'none' ? <Lock size={15} /> : <ShieldAlert size={15} />}
          </span>
          <div className="st-row__text">
            <span className="st-row__title">{t(security.title)}</span>
            {security.body && <span className="st-row__desc">{t(security.body)}</span>}
          </div>
        </div>
        {/^https:/i.test(info.url) && (
          <>
            <button type="button" className="st-disclosure" aria-expanded={certOpen} onClick={() => setCertOpen((o) => !o)}>
              {certOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {t('sites.info.certificate')}
            </button>
            {certOpen &&
              (cert ? (
                <dl className="st-cert">
                  <dt>{t('sites.info.certSubject')}</dt>
                  <dd>{cert.subject}</dd>
                  <dt>{t('sites.info.certIssuer')}</dt>
                  <dd>{cert.issuer}</dd>
                  <dt>{t('sites.info.certFrom')}</dt>
                  <dd>{new Date(cert.validFrom).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
                  <dt>{t('sites.info.certTo')}</dt>
                  <dd>{new Date(cert.validTo).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
                  <dt>{t('sites.info.certProtocol')}</dt>
                  <dd>{cert.protocol}</dd>
                  <dt>{t('sites.info.certFingerprint')}</dt>
                  <dd className="st-mono">{formatFingerprint(cert.sha256)}</dd>
                </dl>
              ) : (
                <p className="st-muted">{t('sites.info.certMissing')}</p>
              ))}
          </>
        )}
      </section>

      {/* Privacy pack: HTTPS, trackers blocked and the cookie banner on this page. */}
      <SitePrivacySummary tabId={props.tabId} />

      {live.length > 0 && liveNoun && (
        <p className="st-live" role="status">
          <span className="st-live__dot" aria-hidden />
          {t('sites.info.capturing', { what: t(liveNoun) })}
        </p>
      )}

      <section className="st-section" aria-labelledby={`${titleId}-perms`}>
        <h3 id={`${titleId}-perms`} className="st-section__title">
          {t('sites.info.permissions')}
        </h3>
        {perms.set.length === 0 && oneTime.length === 0 && <p className="st-muted">{t('sites.info.noPermissions')}</p>}
        {oneTime.map((perm) => (
          <OnceRow
            key={`once:${perm}`}
            perm={perm}
            name={t(`sites.perm.${perm}`)}
            detail={t('sites.info.allowedOnce')}
            onRevoke={() => void revokeOnce(() => call('sites', 'revokeOneTime', props.tabId, perm))}
          />
        ))}
        {perms.set.map(({ perm, decision }) => (
          <PermissionRow key={perm} perm={perm} decision={decision} onChange={setPermission} />
        ))}
        {perms.unset.length > 0 && (
          <>
            <button type="button" className="st-disclosure" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              {moreOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {t('sites.info.morePermissions', { count: perms.unset.length })}
            </button>
            {moreOpen && perms.unset.map((perm) => <PermissionRow key={perm} perm={perm} decision="ask" onChange={setPermission} />)}
          </>
        )}
      </section>

      {(info.settings.devices.length > 0 || sessionDevices.length > 0) && (
        <section className="st-section" aria-labelledby={`${titleId}-devices`}>
          <h3 id={`${titleId}-devices`} className="st-section__title">
            {t('sites.info.devices')}
          </h3>
          {info.settings.devices.map((d) => (
            <div key={`${d.kind}:${d.id}`} className="st-row">
              <span className="st-row__glyph" aria-hidden>
                <PermIcon perm={d.kind} size={15} />
              </span>
              <span className="st-row__title st-row__grow">{d.name}</span>
              <Button size="sm" variant="ghost" aria-label={t('sites.info.revokeLabel', { name: d.name })} onClick={() => revoke(d.kind, d.id)}>
                {t('sites.info.revoke')}
              </Button>
            </div>
          ))}
          {sessionDevices.map((d) => (
            <OnceRow
              key={`once:${d.kind}:${d.id}`}
              perm={d.kind}
              name={d.name}
              detail={t('sites.info.deviceOnce')}
              onRevoke={() => void revokeOnce(() => call('sites', 'revokeDevice', props.tabId, { kind: d.kind, id: d.id }))}
            />
          ))}
        </section>
      )}

      <section className="st-section st-switches">
        <Switch size="sm" label={t('sites.info.adblock')} checked={switches.adblock} onChange={(on) => setSwitch('adblock', on)} />
        <Switch size="sm" label={t('sites.info.sound')} checked={switches.sound} onChange={(on) => setSwitch('sound', on)} />
        <Switch size="sm" label={t('sites.info.popups')} checked={switches.popups} onChange={(on) => setSwitch('popups', on)} />
        <Switch size="sm" label={t('sites.info.forceDark')} description={t('sites.info.forceDarkBody')} checked={info.settings.forceDark} onChange={(forceDark) => void update({ forceDark })} />
      </section>

      {/* TWK-04: the site's tweak (hide elements, focus, customize); nothing on Apex's own pages. */}
      <SiteTweakSection tabId={props.tabId} close={close} />

      {/* The site's own JavaScript, images, automatic downloads and insecure content rules. */}
      <section className="st-section" aria-labelledby={`${titleId}-content`}>
        <h3 id={`${titleId}-content`} className="st-section__title">
          {t('safety.content.title')}
        </h3>
        <SiteContentRules bare settings={info.settings} onChange={(patch) => void update(patch)} />
      </section>

      <section className="st-section" aria-label={t('sites.info.data')}>
        <div className="st-row">
          <span className="st-row__glyph" aria-hidden>
            <Cookie size={15} />
          </span>
          <div className="st-row__text st-row__grow">
            <span className="st-row__title">{t('sites.info.data')}</span>
            <span className="st-row__desc">{t('sites.info.dataSummary', { count: info.cookieCount, size: sizeLabel(info.dataBytes) })}</span>
          </div>
          <Button size="sm" variant="secondary" loading={clearing === 'data'} disabled={clearing !== null} onClick={() => void clear('data')}>
            {cleared === 'data' ? t('sites.info.cleared') : t('sites.info.clear')}
          </Button>
        </div>
        <div className="st-row">
          <span className="st-row__glyph" aria-hidden>
            <Database size={15} />
          </span>
          <div className="st-row__text st-row__grow">
            <span className="st-row__title">{t('sites.info.cache')}</span>
            <span className="st-row__desc">{sizeLabel(info.cacheBytes)}</span>
          </div>
          <Button size="sm" variant="secondary" loading={clearing === 'cache'} disabled={clearing !== null} onClick={() => void clear('cache')}>
            {cleared === 'cache' ? t('sites.info.cleared') : t('sites.info.clear')}
          </Button>
        </div>
        <p className="st-muted st-small">{t('sites.info.clearNote')}</p>
        {failed && (
          <p className="st-note st-note--danger" role="alert">
            {failed}
          </p>
        )}
      </section>

      {info.privateSession && <p className="st-muted st-small st-private">{t('sites.info.private')}</p>}

      <footer className="st-info__foot">
        <button
          type="button"
          className="st-link"
          onClick={() => {
            void call('pages', 'open', 'apex://settings/sites')
            close()
          }}
        >
          <Settings size={14} aria-hidden />
          {t('sites.info.settings')}
        </button>
      </footer>
    </div>
  )
}

/** Something the site may use this time only: "Allowed this time" and Revoke. */
function OnceRow({ perm, name, detail, onRevoke }: { perm: SitePermission; name: string; detail: string; onRevoke(): void }): ReactElement {
  const t = useT()
  return (
    <div className="st-row">
      <span className="st-row__glyph" aria-hidden>
        <PermIcon perm={perm} size={15} />
      </span>
      <div className="st-row__text st-row__grow">
        <span className="st-row__title">{name}</span>
        <span className="st-row__desc">{detail}</span>
      </div>
      <Button size="sm" variant="ghost" aria-label={t('sites.info.revokeOnceLabel', { name })} onClick={onRevoke}>
        {t('sites.info.revoke')}
      </Button>
    </div>
  )
}

function PermissionRow({ perm, decision, onChange }: { perm: SitePermission; decision: PermissionDecision; onChange(perm: SitePermission, d: PermissionDecision): void }): ReactElement {
  const t = useT()
  const label = t(`sites.perm.${perm}`)
  return (
    <div className="st-row">
      <span className="st-row__glyph" aria-hidden>
        <PermIcon perm={perm} size={15} />
      </span>
      <span className="st-row__title st-row__grow">{label}</span>
      <Select
        size="sm"
        aria-label={label}
        value={decision}
        options={decisionOptions(perm).map((d) => ({ value: d, label: t(`sites.decision.${d}`) }))}
        onChange={(d) => onChange(perm, d)}
      />
    </div>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One installed pack, in its sheet on apex://packs (docs/packs.md): Open and
// on or off first, then what needs you (an update, a problem, a service it
// waits for), what's inside (with Open, Add routine, Add companion, Add
// connector and Use accent), its keys and sign-ins, and what it can do. Where
// it came from, who signed it, its services, commands, files and log are
// under About this pack. Share or Export, Remix, Check for updates and Remove
// close it.
import { useState, type ReactElement } from 'react'
import { Columns2, Download, Palette, Plus, Share2, Trash2, Wand2, ExternalLink, RefreshCw } from 'lucide-react'
import { packAccentChoice } from '@shared/theme'
import type { PackDetail as PackDetailData, PackReview, PackSummary } from '@shared/packs'
import { packAppRef, packPanelRef, showOf, type SidebarAppShow } from '@shared/sidebarApps'
import { apex, call, errorText } from '../api'
import { setAppShow } from '../apps/library'
import { useSettingsView } from '../companion-card/useLoaded'
import { useT } from '../i18n/useT'
import { Notice } from '../settings/kit'
import { useEvent, useResource } from '../settings/data'
import { Button, RelativeTime, Select, SkeletonRows, Switch, cx, useConfirm, useToast } from '../ui'
import { KindIcon } from './KindIcon'
import { cardOpens, formatBytes, packKind, sourceKey } from './logic'
import { PackKeys } from './PackKeys'
import { PackSignIns } from './PackSignIns'
import { PackConnectorsUsed } from './PackConnectorsUsed'
import { PermissionList } from './PermissionList'
import { ShareAppDialog } from './ShareAppDialog'

export function PackDetail({ pack, onReview, focusKey, audited = false }: { pack: PackSummary; onReview(review: PackReview): void; focusKey?: string | null; audited?: boolean }): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const detail = useResource<PackDetailData>(() => call('packs', 'get', pack.id), pack.id, { keep: true })
  const [busy, setBusy] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  useEvent('packs', () => void detail.reload())
  const firstParty = pack.source.kind === 'first-party'
  // Open works on a pack that is off (it turns on); only one that can't run says no.
  const openable = pack.problems.length === 0 && !(pack.enabled && pack.waiting.length > 0)
  const opens = cardOpens(pack)
  // AP-01: how each of its apps and panels shows in the sidebar (the person's choice, else the pack's).
  const pins = useSettingsView()?.sidebar.apps ?? []
  const sidebarChoice = (ref: string, packDefault: boolean): ReactElement => (
    <Select<SidebarAppShow>
      size="sm"
      aria-label={t('packs.thing.inSidebar')}
      value={showOf({ ref, defaultShow: packDefault ? 'row' : 'hidden' }, pins)}
      onChange={(show) => setAppShow(pins, ref, show)}
      options={[
        { value: 'row', label: t('packs.thing.sidebarRow') },
        { value: 'icon', label: t('packs.thing.sidebarIcon') },
        { value: 'hidden', label: t('packs.thing.sidebarHidden') },
      ]}
    />
  )

  const run = async (what: string, action: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(what)
    try {
      await action()
      if (done) toast.show({ message: done })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({ title: t('packs.remove.title', { name: pack.name }), message: t('packs.remove.message'), confirmLabel: t('packs.remove.confirm'), destructive: true })
    if (ok) await run('remove', () => call('packs', 'remove', pack.id), t('packs.remove.done', { name: pack.name }))
  }

  const useAccent = (themeId: string): Promise<void> => run(`theme:${themeId}`, () => apex.settings.set({ accent: packAccentChoice(pack.id, themeId) }), t('packs.theme.used'))

  const inside = pack.worlds.length + pack.apps.length + pack.panels.length + pack.routines.length + pack.companions.length + pack.connectors.length + pack.themes.length + pack.cards.length > 0

  return (
    <div className="pk-detail">
      <div className="pk-hero">
        <KindIcon kind={packKind(pack)} size="lg" />
        <p className="pk-hero__desc">{pack.description}</p>
        <div className="pk-hero__actions">
          {opens && (
            <Button
              variant="primary"
              icon={<ExternalLink />}
              disabled={!openable}
              loading={busy === 'open'}
              onClick={() => void run('open', () => ('app' in opens ? call('packs', 'openApp', pack.id, opens.app) : call('packs', 'openWorld', opens.world)))}
            >
              {t('packs.thing.open')}
            </Button>
          )}
          <label className="pk-hero__switch">
            <Switch
              size="sm"
              aria-label={t('packs.row.toggle', { name: pack.name })}
              checked={pack.enabled}
              disabled={(pack.problems.length > 0 && !pack.enabled) || (pack.managed && pack.enabled)}
              onChange={(enabled) => void run('toggle', () => call('packs', 'setEnabled', pack.id, enabled))}
            />
            <span>{pack.enabled ? t('packs.detail.on') : t('packs.badge.off')}</span>
          </label>
        </div>
      </div>

      {pack.problems.length > 0 && (
        <Notice tone="error">
          <strong>{t('packs.detail.problems')}</strong>
          <ul>
            {pack.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
      {pack.managed && <Notice tone="info">{t('packs.policy.forced')}</Notice>}
      {pack.withdrawn && <Notice tone="warning">{pack.withdrawn.reason ? t('packs.detail.withdrawnReason', { index: pack.withdrawn.index, reason: pack.withdrawn.reason }) : t('packs.detail.withdrawn', { index: pack.withdrawn.index })}</Notice>}
      {pack.enabled && pack.problems.length === 0 && pack.waiting.length > 0 && (
        <Notice
          tone="warning"
          action={
            pack.waitingFor.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => void run('find', () => call('packs', 'findInBrowse', pack.waitingFor[0] as string))}>
                {t('packs.detail.findMissing')}
              </Button>
            ) : undefined
          }
        >
          <strong>{t('packs.detail.waiting')}</strong>
          <ul>
            {pack.waiting.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {pack.update && (
        <Notice
          tone="info"
          action={
            <Button size="sm" variant="primary" loading={busy === 'update'} onClick={() => void run('update', async () => onReview(await call('packs', 'reviewUpdate', pack.id)))}>
              {t('packs.detail.reviewUpdate')}
            </Button>
          }
        >
          {pack.update.added.length > 0 ? t('packs.detail.updateApproval', { version: pack.update.version }) : t('packs.detail.updateReady', { version: pack.update.version })}
        </Notice>
      )}

      {inside && (
        <section className="pk-block" aria-label={t('packs.detail.inside')}>
          <h4 className="pk-block__title">{t('packs.detail.inside')}</h4>
          <ul className="pk-things">
            {pack.worlds.map((w) => (
              <li key={`world:${w.ref}`} className="pk-thing">
                <span className="pk-thing__text">
                  {w.name}
                  <span className="pk-thing__kind">{t('packs.thing.world')}</span>
                </span>
                <span className="pk-actions">
                  <Button size="sm" variant="secondary" icon={<ExternalLink />} disabled={!openable} loading={busy === `world:${w.ref}`} onClick={() => void run(`world:${w.ref}`, () => call('packs', 'openWorld', w.ref))}>
                    {t('packs.thing.open')}
                  </Button>
                </span>
              </li>
            ))}
            {pack.apps.map((a) => (
              <li key={`app:${a.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  {a.name}
                  <span className="pk-thing__kind">{t(a.kind === 'game' ? 'packs.thing.game' : 'packs.thing.app')}</span>
                </span>
                <span className="pk-actions">
                  {pack.enabled && sidebarChoice(packAppRef(pack.id, a.id), a.sidebar)}
                  <Button size="sm" variant="secondary" icon={<ExternalLink />} disabled={!openable} onClick={() => void run(`app:${a.id}`, () => call('packs', 'openApp', pack.id, a.id))}>
                    {t('packs.thing.open')}
                  </Button>
                </span>
              </li>
            ))}
            {pack.panels.map((p) => (
              <li key={`panel:${p.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  {p.title}
                  <span className="pk-thing__kind">{t('packs.thing.panel')}</span>
                </span>
                <span className="pk-actions">
                  {pack.enabled && sidebarChoice(packPanelRef(pack.id, p.id), p.sidebar)}
                  <Button size="sm" variant="ghost" icon={<Columns2 />} disabled={!openable} onClick={() => void run(`panel:${p.id}`, () => call('packs', 'openPanel', pack.id, p.id, true))}>
                    {t('packs.thing.openBeside')}
                  </Button>
                  <Button size="sm" variant="secondary" icon={<ExternalLink />} disabled={!openable} onClick={() => void run(`panel:${p.id}`, () => call('packs', 'openPanel', pack.id, p.id))}>
                    {t('packs.thing.open')}
                  </Button>
                </span>
              </li>
            ))}
            {pack.cards.map((c) => (
              <li key={`card:${c.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  {c.title}
                  <span className="pk-thing__kind">{t('packs.thing.card')}</span>
                </span>
                <span />
              </li>
            ))}
            {pack.routines.map((r) => (
              <li key={`routine:${r.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  {r.name}
                  <span className="pk-thing__kind">{t('packs.thing.routine')}</span>
                </span>
                <Button size="sm" variant="ghost" icon={<Plus />} loading={busy === `routine:${r.id}`} onClick={() => void run(`routine:${r.id}`, () => call('packs', 'addRoutine', pack.id, r.id), t('packs.thing.routineAdded', { name: r.name }))}>
                  {t('packs.thing.addRoutine')}
                </Button>
              </li>
            ))}
            {pack.companions.map((c) => (
              <li key={`companion:${c.path}`} className="pk-thing">
                <span className="pk-thing__text">
                  {c.name}
                  <span className="pk-thing__kind">{t('packs.thing.companion')}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus />}
                  loading={busy === `companion:${c.path}`}
                  onClick={() => void run(`companion:${c.path}`, async () => toast.show({ message: t('packs.thing.companionAdded', { name: await call('packs', 'addCompanion', pack.id, c.path) }) }))}
                >
                  {t('packs.thing.addCompanion')}
                </Button>
              </li>
            ))}
            {pack.connectors.map((c) => (
              <li key={`connector:${c.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  {c.name}
                  <span className="pk-thing__kind">{c.local ? t('packs.thing.localConnector') : t('packs.thing.connector')}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus />}
                  loading={busy === `connector:${c.id}`}
                  onClick={() =>
                    void run(
                      `connector:${c.id}`,
                      async () => {
                        // Its page opens next, for a token or a sign-in when the server needs one.
                        const connectorId = await call('packs', 'addConnector', pack.id, c.id)
                        await call('pages', 'open', `apex://connectors/${connectorId}`)
                      },
                      t('packs.thing.connectorAdded', { name: c.name }),
                    )
                  }
                >
                  {t('packs.thing.addConnector')}
                </Button>
              </li>
            ))}
            {pack.themes.map((th) => (
              <li key={`theme:${th.id}`} className="pk-thing">
                <span className="pk-thing__text">
                  <span className="pk-swatch" style={{ background: th.accent }} aria-hidden="true" />
                  {th.name}
                  <span className="pk-thing__kind">{t('packs.thing.theme')}</span>
                </span>
                <Button size="sm" variant="ghost" icon={<Palette />} disabled={!pack.enabled} loading={busy === `theme:${th.id}`} onClick={() => void useAccent(th.id)}>
                  {t('packs.thing.useAccent')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pack.assetSlots.length > 0 && (
        <section className="pk-block" aria-label={t('packs.detail.assets')}>
          <h4 className="pk-block__title">{t('packs.detail.assets')}</h4>
          <ul className="pk-things">
            {pack.assetSlots.map((s) => (
              <li key={`slot:${s.slot}`} className="pk-thing">
                <span className="pk-thing__text">
                  {pack.apps.length > 1 ? `${s.appName}: ${s.name}` : s.name}
                  <span className="pk-thing__kind">{s.options.length > 0 ? s.description : t('packs.detail.assetsNone')}</span>
                </span>
                <span className="pk-actions">
                  <Select<string>
                    size="sm"
                    aria-label={s.name}
                    value={s.chosen ?? ''}
                    disabled={!pack.enabled || s.options.length === 0}
                    options={[{ value: '', label: t('packs.detail.assetsDefault') }, ...s.options]}
                    onChange={(value) => void run(`assets:${s.slot}`, () => call('packs', 'chooseAssets', pack.id, s.appId, s.slot, value || null))}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PackKeys pack={pack} focusKey={focusKey} />
      <PackSignIns pack={pack} />
      <PackConnectorsUsed pack={pack} />

      <section className="pk-block" aria-label={t('packs.detail.permissions')}>
        <h4 className="pk-block__title">{t('packs.detail.permissions')}</h4>
        <PermissionList lines={pack.permissions} label={t('packs.detail.permissions')} />
      </section>

      {(pack.granted.length > 0 || pack.optional.length > 0 || pack.folder || pack.ownBytes > 0) && (
        <section className="pk-block" aria-label={t('packs.detail.granted')}>
          {pack.ownBytes > 0 && <p className="pk-muted pk-small">{t('packs.detail.ownFiles', { size: formatBytes(pack.ownBytes) })}</p>}
          {(pack.granted.length > 0 || pack.folder) && (
            <>
              <h4 className="pk-block__title">{t('packs.detail.granted')}</h4>
              {pack.granted.length > 0 && <PermissionList lines={pack.granted} label={t('packs.detail.granted')} />}
              {pack.folder && <p className="pk-small">{t('packs.detail.folder', { path: pack.folder })}</p>}
              <Button size="sm" variant="ghost" loading={busy === 'revoke'} onClick={() => void run('revoke', () => call('packs', 'revokeGranted', pack.id))}>
                {t('packs.detail.revokeGranted')}
              </Button>
            </>
          )}
          {pack.optional.length > 0 && (
            <>
              <h4 className="pk-block__title">{t('packs.detail.mayAsk')}</h4>
              <PermissionList lines={pack.optional} label={t('packs.detail.mayAsk')} />
            </>
          )}
        </section>
      )}

      <details className="pk-more">
        <summary>{t('packs.detail.about')}</summary>
        <div className="pk-more__body">
          <dl className="pk-meta">
            <dt>{t('packs.meta.version')}</dt>
            <dd>{pack.version}</dd>
            {pack.author && (
              <>
                <dt>{t('packs.meta.author')}</dt>
                <dd>{pack.author}</dd>
              </>
            )}
            {pack.builtBy && (
              <>
                <dt>{t('packs.meta.builtBy')}</dt>
                <dd>{pack.builtBy}</dd>
              </>
            )}
            <dt>{t('packs.meta.source')}</dt>
            <dd>
              {t(sourceKey(pack.source))}
              {pack.source.url ? ` · ${pack.source.url}` : ''}
            </dd>
            {!firstParty && (
              <>
                <dt>{t('packs.meta.signature')}</dt>
                <dd>{pack.signature === 'signed' ? t('packs.signature.signed', { key: pack.keyId ?? '' }) : t('packs.signature.unsigned')}</dd>
                <dt>{t('packs.meta.installed')}</dt>
                <dd>
                  <RelativeTime value={pack.updatedAt} />
                </dd>
              </>
            )}
            {pack.forkedFrom && (
              <>
                <dt>{t('packs.meta.forkedFrom')}</dt>
                <dd>
                  {pack.forkedFrom.id} {pack.forkedFrom.version}
                </dd>
              </>
            )}
            {pack.homepage && (
              <>
                <dt>{t('packs.meta.homepage')}</dt>
                <dd>
                  <a href={pack.homepage} target="_blank" rel="noreferrer">
                    {pack.homepage}
                  </a>
                </dd>
              </>
            )}
          </dl>

          {(pack.provides.length > 0 || pack.uses.length > 0) && (
            <section className="pk-block" aria-label={t('packs.detail.services')}>
              <h4 className="pk-block__title">{t('packs.detail.services')}</h4>
              <ul className="pk-things">
                {pack.provides.map((s) => (
                  <li key={`provides:${s.service}`} className="pk-thing">
                    <span className="pk-thing__text">
                      {t('packs.detail.provides', { service: s.service })}
                      <span className="pk-thing__kind">{s.usedBy.length > 0 ? t('packs.detail.usedBy', { names: s.usedBy.join(', ') }) : t('packs.detail.notUsed')}</span>
                    </span>
                  </li>
                ))}
                {pack.uses.map((u) => (
                  <li key={`uses:${u.service}`} className="pk-thing">
                    <span className="pk-thing__text">
                      {t('packs.detail.uses', { service: u.service })}
                      <span className="pk-thing__kind">{u.from ? t('packs.detail.from', { name: u.from }) : t('packs.detail.noProvider')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.data ? (
            <>
              {(detail.data.manifest.contributes.commands?.length ?? 0) + (detail.data.manifest.contributes.menus?.length ?? 0) + (detail.data.manifest.contributes.tools?.length ?? 0) > 0 && (
                <section className="pk-block" aria-label={t('packs.detail.commands')}>
                  <h4 className="pk-block__title">{t('packs.detail.commands')}</h4>
                  <ul className="pk-things">
                    {(detail.data.manifest.contributes.commands ?? []).map((c) => (
                      <li key={`cmd:${c.id}`} className="pk-thing">
                        <span className="pk-thing__text">
                          {c.title}
                          <span className="pk-thing__kind">{t('packs.thing.command')}</span>
                        </span>
                        <span />
                      </li>
                    ))}
                    {(detail.data.manifest.contributes.menus ?? []).map((m) => (
                      <li key={`menu:${m.id}`} className="pk-thing">
                        <span className="pk-thing__text">
                          {m.title}
                          <span className="pk-thing__kind">{t(`packs.thing.menu.${m.context}`)}</span>
                        </span>
                        <span />
                      </li>
                    ))}
                    {(detail.data.manifest.contributes.tools ?? []).map((tool) => (
                      <li key={`tool:${tool.name}`} className="pk-thing">
                        <span className="pk-thing__text">
                          <span className="pk-mono">{tool.name}</span>
                          <span className="pk-thing__kind">{tool.description}</span>
                        </span>
                        <span />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <details className="pk-code">
                <summary>{t('packs.review.files', { count: detail.data.files.length })}</summary>
                <ul className="pk-log">
                  {detail.data.files.map((f) => (
                    <li key={f.path}>
                      <span>{formatBytes(f.size)}</span>
                      <span />
                      <span>{f.path}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <details className="pk-code">
                <summary>{t('packs.detail.log', { count: detail.data.log.length })}</summary>
                {detail.data.log.length === 0 ? (
                  <p className="pk-muted pk-small">{t('packs.detail.logEmpty')}</p>
                ) : (
                  <>
                    <ul className="pk-log" aria-label={t('packs.detail.logLabel')}>
                      {detail.data.log
                        .slice(-200)
                        .reverse()
                        .map((l, i) => (
                          <li key={`${l.at}-${i}`} className={cx(`pk-log--${l.level}`)}>
                            <span>{new Date(l.at).toLocaleTimeString()}</span>
                            <span>{l.source}</span>
                            <span>{l.message}</span>
                          </li>
                        ))}
                    </ul>
                    <div className="pk-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === 'saveLog'}
                        onClick={() =>
                          void run('saveLog', async () => {
                            const path = await call('packs', 'saveLog', pack.id)
                            if (path) toast.show({ message: t('packs.detail.logSaved') })
                          })
                        }
                      >
                        {t('packs.detail.saveLog')}
                      </Button>
                      {!audited && (
                        <Button size="sm" variant="ghost" onClick={() => void run('log', () => call('packs', 'clearLog', pack.id))}>
                          {t('packs.detail.clearLog')}
                        </Button>
                      )}
                    </div>
                    {audited && <p className="pk-muted pk-small">{t('packs.policy.auditLog')}</p>}
                  </>
                )}
              </details>
            </>
          ) : detail.error ? (
            <p className="pk-error">{detail.error}</p>
          ) : (
            <SkeletonRows rows={2} label={t('packs.page.loading')} />
          )}
        </div>
      </details>

      <div className="pk-detail__foot">
        <div className="pk-actions">
          {!firstParty && pack.apps.length > 0 && (
            <Button size="sm" variant="secondary" icon={<Share2 />} disabled={!pack.enabled || pack.problems.length > 0} onClick={() => setSharing(true)}>
              {t('packs.detail.share')}
            </Button>
          )}
          {!firstParty && pack.apps.length === 0 && (
            <Button size="sm" variant="ghost" icon={<Download />} loading={busy === 'export'} onClick={() => void run('export', async () => (await call('packs', 'exportPack', pack.id, 'installed')) && toast.show({ message: t('packs.exported') }))}>
              {t('packs.detail.export')}
            </Button>
          )}
          {pack.id !== 'apex-builtin-skills' && (
            <Button size="sm" variant="ghost" icon={<Wand2 />} loading={busy === 'remix'} disabled={pack.problems.length > 0} onClick={() => void run('remix', () => call('packs', 'remix', pack.id))}>
              {t('packs.detail.remix')}
            </Button>
          )}
          {pack.source.kind === 'dev' && (
            <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy === 'reload'} onClick={() => void run('reload', () => call('packs', 'reloadFolder', pack.id), t('packs.detail.reloaded'))}>
              {t('packs.detail.reloadFolder')}
            </Button>
          )}
          {pack.update === null && !firstParty && detail.data?.manifest.updateUrl && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw />}
              loading={busy === 'check'}
              onClick={() =>
                void run('check', async () => {
                  const after = (await call('packs', 'checkUpdates')).find((p) => p.id === pack.id)
                  toast.show({ message: after?.update ? t('packs.detail.updateFound', { version: after.update.version }) : t('packs.detail.upToDate') })
                })
              }
            >
              {t('packs.detail.checkUpdate')}
            </Button>
          )}
        </div>
        {!firstParty && !pack.managed && (
          <Button size="sm" variant="ghost" icon={<Trash2 />} loading={busy === 'remove'} onClick={() => void remove()}>
            {t('packs.detail.remove')}
          </Button>
        )}
      </div>
      {pack.apps.length > 0 && <ShareAppDialog pack={pack} open={sharing} onClose={() => setSharing(false)} />}
    </div>
  )
}

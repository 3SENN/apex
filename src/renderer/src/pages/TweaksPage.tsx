/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier://tweaks (TWK-05): every site's tweak, one opened for editing at a
// time (atelier://tweaks?site=<host> opens that one), a site to add, Allow
// custom scripts with its warning, and export and import as JSON.
import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Sparkles, Upload, Download } from 'lucide-react'
import { normalizeTweakHost, type Tweak, type TweaksState } from '@shared/tweaks'
import { internalQuery } from '@shared/url'
import { call, errorText } from '../api'
import { TweakEditor } from '../tweaks/TweakEditor'
import { tweakSummary, sortTweaks } from '../tweaks/logic'
import { t } from '../i18n/useT'
import { Notice, PageHeader, TextInput } from '../settings/kit'
import { useEvent, useResource } from '../settings/data'
import { Badge, Button, EmptyState, ErrorState, SkeletonRows, Switch, cx, useConfirm, useToast } from '../ui'
import '../tweaks/tweaks.css'

export interface TweaksPageProps {
  tabId: string
  url: string
}

export function TweaksPage({ url }: TweaksPageProps): ReactElement {
  const id = useId()
  const state = useResource<TweaksState>(() => call('tweaks', 'state'))
  const toast = useToast()
  const confirm = useConfirm()
  const site = normalizeTweakHost(internalQuery(url, 'site') ?? '')
  const [open, setOpen] = useState<string | null>(site)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEvent('tweaks', (event) => state.set(event.state))
  useEffect(() => setOpen(site), [site])

  const tweaks = sortTweaks(state.data?.tweaks ?? [])
  const scriptsAllowed = state.data?.scriptsAllowed ?? false
  const missing = site && state.data && !tweaks.some((b) => b.host === site) ? site : null

  const run = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    try {
      await action()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const add = async (host: string): Promise<void> => {
    setAddError(null)
    try {
      const tweak = await call('tweaks', 'create', host)
      setOpen(tweak.host)
      setDraft('')
    } catch (err) {
      setAddError(errorText(err))
    }
  }
  const onAdd = (e: FormEvent): void => {
    e.preventDefault()
    if (draft.trim()) void add(draft)
  }

  const setScripts = async (on: boolean): Promise<void> => {
    if (on) {
      const ok = await confirm({ title: t('tweaks.scripts.confirmTitle'), message: t('tweaks.scripts.warning'), confirmLabel: t('tweaks.scripts.confirm') })
      if (!ok) return
    }
    await run('scripts', async () => state.set(await call('tweaks', 'setScriptsAllowed', on)))
  }

  const onDeleted = (tweak: Tweak): void => {
    if (open === tweak.host) setOpen(null)
    toast.show({ message: t('tweaks.removed', { host: tweak.host }), undo: () => void call('tweaks', 'restore', tweak).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) })) })
  }

  const importFile = (): Promise<void> =>
    run('import', async () => {
      const result = await call('tweaks', 'importFile')
      if (!result) return
      const count = result.added + result.replaced
      toast.show({ tone: count > 0 ? undefined : 'error', message: result.scripts > 0 ? `${t('tweaks.imported', { count })} ${t('tweaks.importedScripts')}` : t('tweaks.imported', { count }) })
    })
  const exportAll = (): Promise<void> =>
    run('export', async () => {
      if (await call('tweaks', 'exportFile')) toast.show({ message: t('tweaks.exported') })
    })

  return (
    <div className="page">
      <div className="twk-scroll">
        <main className="twk-page" aria-labelledby={`${id}-title`}>
          <PageHeader
            title={<span id={`${id}-title`}>{t('tweaks.page.title')}</span>}
            description={t('tweaks.page.description')}
            actions={
              <div className="twk-actions">
                <Button variant="ghost" icon={<Upload />} loading={busy === 'import'} onClick={() => void importFile()}>
                  {t('tweaks.page.import')}
                </Button>
                <Button variant="secondary" icon={<Download />} loading={busy === 'export'} disabled={tweaks.length === 0} onClick={() => void exportAll()}>
                  {t('tweaks.page.exportAll')}
                </Button>
              </div>
            }
          />

          <form className="twk-card twk-add" onSubmit={onAdd}>
            <label className="twk-field__label" htmlFor={`${id}-add`}>
              {t('tweaks.add.label')}
            </label>
            <div className="twk-add__row">
              <TextInput
                id={`${id}-add`}
                className="twk-add__input"
                value={draft}
                placeholder={t('tweaks.add.placeholder')}
                autoComplete="off"
                spellCheck={false}
                invalid={Boolean(addError)}
                aria-describedby={`${id}-add-hint`}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setAddError(null)
                }}
              />
              <Button type="submit" variant="primary" disabled={!draft.trim()}>
                {t('tweaks.add.button')}
              </Button>
            </div>
            <p className={cx('twk-small', addError ? 'twk-error' : 'twk-muted')} id={`${id}-add-hint`} role={addError ? 'alert' : undefined}>
              {addError ?? t('tweaks.add.hint')}
            </p>
          </form>

          <div className="twk-card">
            <Switch label={t('tweaks.scripts.title')} description={t('tweaks.scripts.body')} checked={scriptsAllowed} disabled={!state.data || busy === 'scripts'} onChange={(on) => void setScripts(on)} />
            {scriptsAllowed && <Notice tone="warning">{t('tweaks.scripts.warning')}</Notice>}
          </div>

          {missing && (
            <Notice
              tone="info"
              action={
                <Button size="sm" variant="primary" onClick={() => void add(missing)}>
                  {t('tweaks.editor.create')}
                </Button>
              }
            >
              {t('tweaks.editor.notFound', { host: missing })}
            </Notice>
          )}

          {state.error && !state.data ? (
            <ErrorState title={t('tweaks.page.loadError')} message={state.error} onRetry={state.reload} />
          ) : !state.data ? (
            <SkeletonRows rows={4} label={t('tweaks.page.loading')} />
          ) : tweaks.length === 0 ? (
            <div className="twk-card">
              <EmptyState icon={<Sparkles />} title={t('tweaks.page.empty.title')} description={t('tweaks.page.empty.body')} />
            </div>
          ) : (
            <ul className="twk-list" aria-label={t('tweaks.page.list')}>
              {tweaks.map((b) => {
                const expanded = open === b.host
                const panel = `${id}-panel-${b.id}`
                return (
                  <li key={b.id} className={cx('twk-item', expanded && 'twk-item--open', !b.enabled && 'twk-item--off')}>
                    <div className="twk-item__row">
                      <button type="button" className="twk-item__toggle" aria-expanded={expanded} aria-controls={panel} onClick={() => setOpen(expanded ? null : b.host)}>
                        {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                        <span className="twk-item__text">
                          <span className="twk-item__host">
                            {b.host}
                            {b.subdomains && <Badge>{t('tweaks.row.subdomains')}</Badge>}
                            {!b.enabled && <Badge tone="warning">{t('tweaks.row.off')}</Badge>}
                          </span>
                          <span className="twk-item__summary">{tweakSummary(b)}</span>
                        </span>
                      </button>
                      <Switch size="sm" aria-label={t('tweaks.row.toggle', { host: b.host })} checked={b.enabled} onChange={(enabled) => void run(`toggle:${b.id}`, () => call('tweaks', 'update', b.id, { enabled }))} />
                    </div>
                    {expanded && (
                      <div id={panel}>
                        <TweakEditor tweak={b} scriptsAllowed={scriptsAllowed} onDeleted={onDeleted} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </main>
      </div>
    </div>
  )
}

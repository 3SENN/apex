/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The experiments page (ST-57): atelier://flags, reachable
// by its address only. Every experiment, newest first, with its date, what
// it does and a choice. A child is off and locked while its parent is off;
// changes that need a restart raise a banner with Relaunch.
import { useMemo, useState, type ReactElement } from 'react'
import { FlaskConical, RotateCw } from 'lucide-react'
import type { FlagState } from '@shared/flags'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Notice, PageHeader } from '../settings/kit'
import { useEvent, useResource } from '../settings/data'
import { Badge, Button, ErrorState, Select, SkeletonRows, cx, useConfirm, useToast } from '../ui'
import '../apps/platform.css'

export interface FlagsPageProps {
  tabId: string
}

/** A flag's title in the interface language when it has one (titleKey), else as the catalogue writes it. */
export function flagTitle(flag: Pick<FlagState, 'title' | 'titleKey'>): string {
  return flag.titleKey ? t(flag.titleKey) : flag.title
}

/** A flag's description in the interface language when it has one (descriptionKey). */
export function flagDescription(flag: Pick<FlagState, 'description' | 'descriptionKey'>): string {
  return flag.descriptionKey ? t(flag.descriptionKey) : flag.description
}

/** "off" → "Off", "on" → "On", anything else as written with a capital. */
export function valueLabel(value: string): string {
  if (value === 'off') return t('platform.flags.off')
  if (value === 'on') return t('platform.flags.on')
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ')
}

/** Children sit right under their parent, the rest stay newest first. */
export function orderFlags(flags: readonly FlagState[]): FlagState[] {
  const children = new Map<string, FlagState[]>()
  for (const f of flags) if (f.parent && flags.some((p) => p.id === f.parent)) children.set(f.parent, [...(children.get(f.parent) ?? []), f])
  const out: FlagState[] = []
  const add = (f: FlagState): void => {
    out.push(f)
    for (const c of children.get(f.id) ?? []) add(c)
  }
  for (const f of flags) if (!f.parent || !flags.some((p) => p.id === f.parent)) add(f)
  return out
}

export default function FlagsPage(_props: FlagsPageProps): ReactElement {
  const flags = useResource<FlagState[]>(() => call('flags', 'list'))
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useToast()
  const confirm = useConfirm()
  useEvent('flags', () => void flags.reload())

  const ordered = useMemo(() => orderFlags(flags.data ?? []), [flags.data])
  const pending = ordered.filter((f) => f.pendingRestart)
  const changed = ordered.filter((f) => !f.locked && f.value !== f.default)
  const titleOf = (id: string): string => {
    const f = ordered.find((x) => x.id === id)
    return f ? flagTitle(f) : id
  }

  const set = async (flag: FlagState, value: string): Promise<void> => {
    setBusy(flag.id)
    try {
      flags.set(await call('flags', 'set', flag.id, value))
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  const resetAll = async (): Promise<void> => {
    const ok = await confirm({ title: t('platform.flags.reset.title'), message: t('platform.flags.reset.message', { count: changed.length }), confirmLabel: t('platform.flags.reset.confirm') })
    if (!ok) return
    // Parents first, so a child is never refused while its parent is still changing.
    for (const f of [...changed].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)))) {
      try {
        flags.set(await call('flags', 'set', f.id, f.default))
      } catch {
        // A child locked by its parent's reset keeps its own stored value; nothing to do.
      }
    }
  }
  const relaunch = async (): Promise<void> => {
    try {
      await call('flags', 'relaunch')
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  return (
    <div className="page">
      {/* .page clips; this layer scrolls so a long flag list stays reachable. */}
      <div className="pl-flags-scroll">
        <main className="pl-flags-page" aria-labelledby="pl-flags-title">
          <PageHeader
            title={<span id="pl-flags-title">{t('platform.flags.title')}</span>}
            description={t('platform.flags.description')}
            actions={
              changed.length > 0 && (
                <Button variant="ghost" onClick={() => void resetAll()}>
                  {t('platform.flags.reset.button')}
                </Button>
              )
            }
          />
          <Notice tone="warning">{t('platform.flags.warning')}</Notice>
          {pending.length > 0 && (
            <div role="status">
              <Notice
                tone="info"
                action={
                  <Button variant="primary" size="sm" icon={<RotateCw />} onClick={() => void relaunch()}>
                    {t('platform.flags.relaunch')}
                  </Button>
                }
              >
                {t('platform.flags.restartBanner', { count: pending.length })}
              </Notice>
            </div>
          )}
          {flags.error && !flags.data ? (
            <ErrorState title={t('platform.flags.loadError')} message={flags.error} onRetry={flags.reload} />
          ) : !flags.data ? (
            <SkeletonRows rows={5} label={t('platform.flags.loading')} />
          ) : (
            <ul className="pl-flags" aria-label={t('platform.flags.title')}>
              {ordered.map((flag) => {
                const id = `pl-flag-${flag.id}`
                return (
                  <li key={flag.id} className={cx('pl-flag', flag.locked && 'pl-flag--locked', flag.parent && 'pl-flag--child')} aria-describedby={`${id}-desc`}>
                    <div className="pl-flag__text">
                      <h2 className="pl-flag__title" id={`${id}-title`}>
                        {flag.parent && <FlaskConical size={13} aria-hidden className="pl-faint" />}
                        {flagTitle(flag)}
                        {flag.value !== flag.default && !flag.locked && <Badge tone="accent">{t('platform.flags.changed')}</Badge>}
                        {flag.pendingRestart && <Badge tone="warning">{t('platform.flags.needsRestart')}</Badge>}
                      </h2>
                      <p className="pl-flag__desc" id={`${id}-desc`}>
                        {flagDescription(flag)}
                      </p>
                      <p className="pl-flag__meta">
                        <span>{t('platform.flags.added', { date: new Date(`${flag.addedAt}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) })}</span>
                        <code>#{flag.id}</code>
                        {flag.requiresRestart && <span>{t('platform.flags.restartNote')}</span>}
                        {flag.parent && <span>{flag.locked ? t('platform.flags.lockedBy', { parent: titleOf(flag.parent) }) : t('platform.flags.dependsOn', { parent: titleOf(flag.parent) })}</span>}
                      </p>
                    </div>
                    <div className="pl-flag__control">
                      <Select
                        size="sm"
                        fullWidth
                        value={flag.value}
                        disabled={flag.locked || busy === flag.id}
                        options={flag.values.map((v) => ({ value: v, label: v === flag.default ? t('platform.flags.defaultValue', { value: valueLabel(v) }) : valueLabel(v) }))}
                        onChange={(v) => void set(flag, v)}
                        aria-label={t('platform.flags.choose', { title: flagTitle(flag) })}
                      />
                    </div>
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

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Recommended shelf (ST-40 R) on Settings › Extensions and, compact, in
// the welcome flow's import step (ON-03 R): a few widely trusted Chrome Web
// Store extensions with one line each. Add fetches the
// package, shows the store's own install prompt (what it can do) and
// installs it; the row turns to Installed as the extensions list updates.
// Apple's password extension on macOS opens Settings › Passwords, where
// Apex's built-in switch sets it up.
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Check, CloudOff, KeyRound, Languages, Moon, PenLine, ShieldCheck } from 'lucide-react'
import { PASSWORDS_SETTINGS_URL, RECOMMENDED_CATEGORY_LABELS, recommendedFor, recommendedState, type RecommendedCategory, type RecommendedExtension } from '@shared/recommendedExtensions'
import type { ExtensionImportReport } from '@shared/browserImport'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button } from '../ui'
import { useExtensions } from './useExtensions'
import './extImport.css'

const CATEGORY_ICONS: Record<RecommendedCategory, ReactNode> = {
  passwords: <KeyRound aria-hidden />,
  writing: <PenLine aria-hidden />,
  language: <Languages aria-hidden />,
  reading: <Moon aria-hidden />,
  privacy: <ShieldCheck aria-hidden />,
  offline: <CloudOff aria-hidden />,
}

export function RecommendedShelf({ compact = false }: { compact?: boolean }): ReactElement {
  const t = useT()
  const { items } = useExtensions()
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<string | null>(null)
  const installed = useMemo(() => new Set(items.map((e) => e.id)), [items])
  const shelf = useMemo(() => recommendedFor(apex.platform), [])

  const describe = (rec: RecommendedExtension, report: ExtensionImportReport): string | null => {
    if (report.cancelled) return null
    if (report.added.length > 0) return t('extImport.rec.added', { name: rec.name })
    const skip = report.skipped[0]
    if (!skip || skip.reason === 'installed') return null
    if (skip.reason === 'notOnStore') return t('extImport.rec.notOnStore', { name: rec.name })
    if (skip.reason === 'unsupported') return t('extImport.rec.unsupported', { name: rec.name })
    return t('extImport.rec.failed', { name: rec.name, message: skip.message ?? '' })
  }

  const add = async (rec: RecommendedExtension): Promise<void> => {
    setAdding((cur) => new Set(cur).add(rec.id))
    setStatus(null)
    try {
      setStatus(describe(rec, await call('browserImport', 'addRecommended', rec.id)))
    } catch (err) {
      setStatus(t('extImport.rec.failed', { name: rec.name, message: errorText(err) }))
    } finally {
      setAdding((cur) => {
        const next = new Set(cur)
        next.delete(rec.id)
        return next
      })
    }
  }

  return (
    <div className={compact ? 'exr exr--compact' : 'exr'}>
      <ul className="exr__grid" aria-label={t('extImport.rec.listLabel')}>
        {shelf.map((rec) => {
          const state = recommendedState(rec, installed, adding)
          return (
            <li key={rec.id} className="exr__item">
              <span className="exr__icon">{CATEGORY_ICONS[rec.category]}</span>
              <span className="exr__text">
                <span className="exr__name">{rec.name}</span>
                <span className="exr__category">{t(RECOMMENDED_CATEGORY_LABELS[rec.category])}</span>
                <span className="exr__reason">{t(rec.reason)}</span>
              </span>
              <span className="exr__action">
                {state === 'installed' ? (
                  <span className="exr__installed">
                    <Check aria-hidden />
                    {t('extImport.rec.installed')}
                  </span>
                ) : state === 'setup' ? (
                  <Button size="sm" variant="secondary" aria-label={t('extImport.rec.setupLabel', { name: rec.name })} onClick={() => void call('pages', 'open', PASSWORDS_SETTINGS_URL)}>
                    {t('extImport.rec.setup')}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" loading={state === 'adding'} disabled={adding.size > 0} aria-label={t('extImport.rec.addLabel', { name: rec.name })} onClick={() => void add(rec)}>
                    {state === 'adding' ? t('extImport.rec.adding') : t('extImport.rec.add')}
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="exr__status sp-field__hint" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Copy, ExternalLink, FileCode, RotateCw } from 'lucide-react'
import { VIEW_SOURCE_MAX_BYTES, type ViewSourceResult } from '@shared/dialogs'
import { SOURCE_LINES_STEP, isMarkupSource, sourceLines, tokenizeLine, viewSourceTarget } from '@shared/viewSource'
import { apex, call, errorText, formatBytes } from '../api'
import { useT } from '../i18n/useT'
import { Button, EmptyState, ErrorState, Spinner, Switch, toast } from '../ui'

// apex://view-source?url=…: the page's source as the server sent it,
// fetched again through the tab's session, with line numbers, optional
// pretty-printing for markup, line wrap, Copy, Reload and a way back to the
// page. Long documents draw in steps so the page stays responsive.

interface ViewSourcePageProps {
  url: string
  tabId: string
}

type Load = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; source: ViewSourceResult }

const SourceLine = memo(function SourceLine({ n, text, markup }: { n: number; text: string; markup: boolean }): ReactElement {
  return (
    <div className="vs__line">
      <span className="vs__gutter" aria-hidden>
        {n}
      </span>
      <span className="vs__code">
        {markup
          ? tokenizeLine(text).map((tok, i) =>
              tok.kind === 'text' ? (
                tok.text
              ) : (
                <span key={i} className={`vs__tok vs__tok--${tok.kind}`}>
                  {tok.text}
                </span>
              ),
            )
          : text}
        {text === '' && '​'}
      </span>
    </div>
  )
})

export function ViewSourcePage({ url, tabId }: ViewSourcePageProps): ReactElement {
  const t = useT()
  const target = viewSourceTarget(url)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [pretty, setPretty] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [limit, setLimit] = useState(SOURCE_LINES_STEP)

  const fetchSource = useCallback(async (): Promise<void> => {
    if (!target) return
    setLoad({ state: 'loading' })
    setLimit(SOURCE_LINES_STEP)
    try {
      setLoad({ state: 'ready', source: await call('viewSource', 'load', target) })
    } catch (err) {
      setLoad({ state: 'failed', message: errorText(err) })
    }
  }, [target])

  useEffect(() => {
    void fetchSource()
  }, [fetchSource])

  const source = load.state === 'ready' ? load.source : null
  const markup = source ? isMarkupSource(source.contentType, source.text) : false
  const lines = useMemo(() => (source ? sourceLines(source.text, pretty, markup) : []), [source, pretty, markup])

  if (!target) {
    return (
      <div className="page page--center">
        <EmptyState icon={<FileCode />} title={t('menus.viewSource.invalid')} />
      </div>
    )
  }

  const copy = async (): Promise<void> => {
    if (!source) return
    try {
      await navigator.clipboard.writeText(pretty && markup ? lines.join('\n') : source.text)
      toast.show({ message: t('menus.viewSource.copied'), tone: 'success' })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const hidden = Math.max(0, lines.length - limit)
  return (
    <div className="page vs" data-wrap={wrap ? 'on' : 'off'}>
      <header className="vs__bar">
        <div className="vs__heading">
          <h1 className="vs__title" title={target}>
            {t('menus.viewSource.title', { url: target })}
          </h1>
          {source && (
            <span className="vs__meta">
              {t('menus.viewSource.lines', { count: lines.length })}
              {source.contentType && ` · ${source.contentType.split(';')[0]}`}
              {source.status && source.status !== 200 ? ` · ${source.status}` : ''}
            </span>
          )}
        </div>
        <div className="vs__tools">
          <Switch size="sm" label={t('menus.viewSource.pretty')} checked={pretty && markup} disabled={!markup} onChange={setPretty} />
          <Switch size="sm" label={t('menus.viewSource.wrap')} checked={wrap} onChange={setWrap} />
          <Button size="sm" variant="ghost" icon={<Copy />} disabled={!source} onClick={() => void copy()}>
            {t('menus.viewSource.copy')}
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={() => void fetchSource()}>
            {t('menus.viewSource.reload')}
          </Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => void apex.nav.go(tabId, target)}>
            {t('menus.viewSource.open')}
          </Button>
        </div>
      </header>
      {source?.truncated && (
        <p className="vs__notice" role="status">
          {t('menus.viewSource.truncated', { size: formatBytes(VIEW_SOURCE_MAX_BYTES) })}
        </p>
      )}
      {load.state === 'loading' && (
        <div className="vs__state" role="status">
          <Spinner />
          <span>{t('menus.viewSource.loading')}</span>
        </div>
      )}
      {load.state === 'failed' && (
        <div className="vs__state">
          <ErrorState title={t('menus.viewSource.failed')} message={load.message} onRetry={fetchSource} />
        </div>
      )}
      {source && source.text.length === 0 && (
        <div className="vs__state">
          <EmptyState icon={<FileCode />} title={t('menus.viewSource.empty')} />
        </div>
      )}
      {source && source.text.length > 0 && (
        <div className="vs__scroll" tabIndex={0} role="region" aria-label={t('menus.viewSource.title', { url: target })}>
          <pre className="vs__source" style={{ ['--vs-gutter-ch' as string]: String(String(lines.length).length + 1) }}>
            {lines.slice(0, limit).map((line, i) => (
              <SourceLine key={i} n={i + 1} text={line} markup={markup} />
            ))}
          </pre>
          {hidden > 0 && (
            <div className="vs__more">
              <Button size="sm" variant="secondary" onClick={() => setLimit((l) => l + SOURCE_LINES_STEP)}>
                {t('menus.viewSource.more', { count: Math.min(hidden, SOURCE_LINES_STEP) })}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { t } from '@shared/i18n/core'
import { call, errorText } from '../../api'
import { Button, ErrorState, SkeletonText } from '../../ui'

// PDFs (OV-32) with pdf.js and its bundled worker. The bytes come from the
// viewer over IPC (the chrome can't fetch atelier-file:), pages are drawn a few
// at a time onto canvases sized to the column, and pdf.js never evaluates code
// or loads fonts.

const PAGES_STEP = 5
const WIDTH_MAX = 880

type PdfDocument = Awaited<ReturnType<typeof import('pdfjs-dist')['getDocument']>['promise']>

function PdfPage({ pdf, index, count, width }: { pdf: PdfDocument; index: number; count: number; width: number }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let task: { cancel(): void; promise: Promise<void> } | null = null
    void pdf.getPage(index + 1).then(
      (page) => {
        const el = canvas.current
        if (cancelled || !el) return
        const base = page.getViewport({ scale: 1 })
        const ratio = window.devicePixelRatio || 1
        const scale = (width / base.width) * ratio
        const viewport = page.getViewport({ scale })
        el.width = Math.max(1, Math.floor(viewport.width))
        el.height = Math.max(1, Math.floor(viewport.height))
        el.style.width = `${Math.floor(viewport.width / ratio)}px`
        // Paper is white in both themes: this is the page itself, not Atelier's UI.
        task = page.render({ canvas: el, viewport, background: '#ffffff' })
        task.promise.catch(() => {
          if (!cancelled) setFailed(true)
        })
      },
      () => !cancelled && setFailed(true),
    )
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, index, width])
  const label = t('files.viewer.pdf.page', { n: index + 1, count })
  return (
    <figure className="fv-pdf__page">
      {failed ? <p className="fv-placeholder__meta">{t('files.viewer.pdf.failed')}</p> : <canvas ref={canvas} role="img" aria-label={label} />}
      <figcaption>{label}</figcaption>
    </figure>
  )
}

export function PdfView({ token, name }: { token: string; name: string }): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGES_STEP)
  const [width, setWidth] = useState(WIDTH_MAX)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let destroy: (() => Promise<void>) | null = null
    setPdf(null)
    setError(null)
    void (async () => {
      try {
        const bytes = await call('viewer', 'bytes', token)
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, useWasm: false, verbosity: 0 })
        destroy = () => task.destroy()
        const doc = await task.promise
        if (!cancelled) setPdf(doc)
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
      void destroy?.()
    }
  }, [token, attempt])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setWidth(Math.min(WIDTH_MAX, Math.max(240, el.clientWidth - 32)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={box} className="fv-pdf" role="document" aria-label={name} aria-busy={!pdf && !error}>
      {error ? (
        <ErrorState compact title={t('files.viewer.pdf.failed')} message={error} onRetry={() => setAttempt((n) => n + 1)} retryLabel={t('files.action.retry')} />
      ) : !pdf ? (
        <div style={{ width: '100%' }} aria-label={t('files.viewer.pdf.loading')}>
          <SkeletonText lines={6} />
        </div>
      ) : (
        <>
          {Array.from({ length: Math.min(shown, pdf.numPages) }, (_, i) => (
            <PdfPage key={i} pdf={pdf} index={i} count={pdf.numPages} width={width} />
          ))}
          {pdf.numPages > shown && (
            <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + PAGES_STEP)}>
              {t('files.viewer.pdf.more')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { AArrowDown, AArrowUp, BookOpen, Headphones, MessageCircle, Pause, Play, Square, Type, X } from 'lucide-react'
import type { TabInfo } from '@shared/ipc'
import { currentLocale } from '@shared/i18n/core'
import { articleForChat, type ReaderArticle } from '@shared/reader'
import { READER_FONTS, READER_RATES, READER_THEMES, READER_WIDTHS, nextTextSize, type ReaderFont, type ReaderTheme, type ReaderWidth } from '@shared/readerPrefs'
import { apex, call, errorText } from '../api'
import { pushQuote } from '../chat/quoteInbox'
import { useSettingsView } from '../chat/hooks'
import { useCompanions, useShell } from '../components/shellContext'
import { useT } from '../i18n/useT'
import { IconButton, SegmentedControl, Select, Spinner, cx, toast, useReducedMotion, useResolvedTheme } from '../ui'
import { ReaderBody, READER_ID_PREFIX } from './ReaderBody'
import { ReadAloud, speechAvailable } from './readAloud'
import { nearestRate, readerLook, ScrollMemory, sizeBounds } from './logic/view'
import { sortVoices, speechQueue, type QueueState } from './logic/speech'
import './reader.css'

// The reader view (RD-02, RD-05, RD-06): drawn by the chrome over the tab's
// pane while main keeps the page hidden underneath. A calm column of text in
// Apex's tokens, with a small floating bar for the text and page settings,
// read aloud, asking the companion and leaving.

const scrolls = new ScrollMemory()

type Load = { kind: 'loading' } | { kind: 'ready'; article: ReaderArticle } | { kind: 'failed'; message: string }

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechAvailable() ? window.speechSynthesis.getVoices() : []))
  useEffect(() => {
    if (!speechAvailable()) return
    const update = (): void => setVoices(window.speechSynthesis.getVoices())
    window.speechSynthesis.addEventListener('voiceschanged', update)
    update()
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

function publishedDate(raw: string | null): { label: string; iso: string } | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  try {
    return { label: new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'long' }).format(ms), iso: new Date(ms).toISOString() }
  } catch {
    return null
  }
}

export function ReaderView({ tab }: { tab: TabInfo }): ReactElement {
  const t = useT()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    setLoad({ kind: 'loading' })
    call('reader', 'article', tab.id).then(
      (article) => {
        if (live) setLoad(article ? { kind: 'ready', article } : { kind: 'failed', message: t('reader.view.failed') })
      },
      (err: unknown) => {
        if (live) setLoad({ kind: 'failed', message: errorText(err) })
      },
    )
    return () => {
      live = false
    }
    // t is left out: a language change must not refetch the article.
  }, [tab.id, tab.url])

  if (load.kind === 'ready') return <ReaderPage tab={tab} article={load.article} />
  return (
    <div className="reader reader--state" data-surface="auto">
      {load.kind === 'loading' ? (
        <p className="reader__status" role="status">
          <Spinner size={14} /> {t('reader.view.loading')}
        </p>
      ) : (
        <div className="reader__status" role="alert">
          <p>{load.message}</p>
          <button type="button" className="reader__plain" onClick={() => void call('reader', 'close', tab.id)}>
            {t('reader.view.original')}
          </button>
        </div>
      )}
    </div>
  )
}

function ReaderPage({ tab, article }: { tab: TabInfo; article: ReaderArticle }): ReactElement {
  const t = useT()
  const settings = useSettingsView()
  const appTheme = useResolvedTheme()
  const reduced = useReducedMotion()
  const shell = useShell()
  const companions = useCompanions()
  const companion = companions.list.find((c) => c.id === companions.activeId) ?? companions.list[0] ?? null
  const companionName = companion?.name ?? BRAND_NAME
  const scroller = useRef<HTMLDivElement>(null)
  const articleEl = useRef<HTMLElement>(null)
  const typeButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [speech, setSpeech] = useState<QueueState>(speechQueue.initial())
  const voices = useVoices()
  const reader = useRef<ReadAloud | null>(null)
  const memoryKey = ScrollMemory.key(tab.id, article.url)

  const look = readerLook({ font: settings.readerFont, size: settings.readerTextSize, width: settings.readerWidth, theme: settings.readerTheme }, appTheme)
  const save = (patch: Parameters<typeof apex.settings.set>[0]): void => {
    void apex.settings.set(patch).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }

  // Focus goes to the article so Space and the arrows scroll it; the place is kept per tab.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = scrolls.recall(memoryKey)
    el.focus({ preventScroll: true })
    const onScroll = (): void => scrolls.remember(memoryKey, el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [memoryKey])

  // One read-aloud controller per article; it stops when the reader closes or the tab changes.
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  useEffect(() => {
    if (!articleEl.current || !scroller.current) return
    const r = new ReadAloud({ root: articleEl.current, scroller: scroller.current, lang: article.lang, onChange: setSpeech, reducedMotion: () => reducedRef.current })
    reader.current = r
    return () => {
      r.dispose()
      reader.current = null
    }
  }, [article])
  useEffect(() => reader.current?.setRate(settings.readerRate), [settings.readerRate, article])
  useEffect(() => reader.current?.setVoice(settings.readerVoice), [settings.readerVoice, article])

  // The text and page panel closes on Escape and on a click outside it.
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panel.current?.contains(target) || typeButton.current?.contains(target)) return
      setPanelOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [panelOpen])
  useEffect(() => {
    if (panelOpen) panel.current?.querySelector<HTMLElement>('button, select')?.focus()
  }, [panelOpen])
  const onPanelKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    setPanelOpen(false)
    typeButton.current?.focus()
  }

  const onLink = useCallback(
    (href: string, e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      const background = e.metaKey || e.ctrlKey || e.button === 1
      if (background) void apex.tabs.create(href, { background: !e.shiftKey, afterId: tab.id })
      else void apex.nav.go(tab.id, href)
    },
    [tab.id],
  )
  const onAnchor = useCallback(
    (id: string) => {
      const target = document.getElementById(READER_ID_PREFIX + id)
      const box = scroller.current
      if (!target || !box) return
      const top = box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - 72
      box.scrollTo({ top: Math.max(0, top), behavior: reducedRef.current ? 'auto' : 'smooth' })
    },
    [],
  )

  const leave = (): void => {
    reader.current?.stop()
    void call('reader', 'close', tab.id)
  }
  const web = /^https?:/i.test(article.url)
  const ask = (): void => {
    // The panel opens on a new chat with the article as its quoted source, ready for a question.
    shell.openPanel(null)
    pushQuote({ text: articleForChat(article), url: article.url, links: [] })
  }
  const listen = (): void => {
    const r = reader.current
    if (!r) return
    if (speech.status === 'playing') r.pause()
    else r.play()
  }

  const date = publishedDate(article.publishedTime)
  const bounds = sizeBounds(look.size)
  const sortedVoices = useMemo(() => sortVoices(voices, article.lang), [voices, article.lang])
  const canSpeak = speechAvailable()
  const style = { '--reader-size': `${look.size}px`, '--reader-measure': `${look.measure}em`, '--reader-leading': String(look.leading) } as CSSProperties
  const fontLabel: Record<ReaderFont, string> = { serif: t('reader.font.serif'), sans: t('reader.font.sans') }
  const widthLabel: Record<ReaderWidth, string> = { narrow: t('reader.width.narrow'), medium: t('reader.width.medium'), wide: t('reader.width.wide') }
  const themeLabel: Record<ReaderTheme, string> = { auto: t('reader.theme.auto'), light: t('reader.theme.light'), sepia: t('reader.theme.sepia'), dark: t('reader.theme.dark') }
  const speaking = speech.status !== 'idle'

  return (
    <div className="reader" data-surface={look.surface} data-font={look.font} style={style}>
      <div ref={scroller} className="reader__scroll" tabIndex={-1} role="region" aria-label={t('reader.view.label', { title: article.title || tab.title })}>
        <div className="reader__controls" data-reader-silent>
          <div className="reader__bar" role="toolbar" aria-label={t('reader.view.toolbar')}>
            <IconButton
              ref={typeButton}
              label={t('reader.view.appearance')}
              icon={<Type size={16} aria-hidden />}
              pressed={panelOpen}
              aria-expanded={panelOpen}
              aria-controls="reader-appearance"
              onClick={() => setPanelOpen((open) => !open)}
            />
            {canSpeak && (
              <IconButton
                label={speech.status === 'playing' ? t('reader.view.pause') : speech.status === 'paused' ? t('reader.view.resume') : t('reader.view.listen')}
                icon={speech.status === 'playing' ? <Pause size={16} aria-hidden /> : speaking ? <Play size={16} aria-hidden /> : <Headphones size={16} aria-hidden />}
                pressed={speaking}
                onClick={listen}
              />
            )}
            {web && <IconButton label={t('reader.view.ask', { name: companionName })} icon={<MessageCircle size={16} aria-hidden />} onClick={ask} />}
            <span className="reader__bar-sep" aria-hidden />
            <IconButton label={t('reader.view.close')} icon={<X size={16} aria-hidden />} shortcut="Alt+CmdOrCtrl+R" onClick={leave} />
          </div>
          {panelOpen && (
            <div ref={panel} id="reader-appearance" className="reader__panel" role="group" aria-label={t('reader.view.appearance')} onKeyDown={onPanelKey}>
              <div className="reader__panel-row">
                <span className="reader__panel-label" id="reader-font-label">
                  {t('reader.font.label')}
                </span>
                <SegmentedControl label={t('reader.font.label')} size="sm" options={READER_FONTS.map((f) => ({ value: f, label: fontLabel[f] }))} value={look.font} onChange={(readerFont) => save({ readerFont })} />
              </div>
              <div className="reader__panel-row">
                <span className="reader__panel-label">{t('reader.size.label')}</span>
                <span className="reader__sizes">
                  <IconButton label={t('reader.size.smaller')} icon={<AArrowDown size={16} aria-hidden />} size="sm" disabled={!bounds.smaller} onClick={() => save({ readerTextSize: nextTextSize(look.size, -1) })} />
                  <span className="reader__size-value" aria-live="polite">
                    {t('reader.size.value', { size: look.size })}
                  </span>
                  <IconButton label={t('reader.size.larger')} icon={<AArrowUp size={16} aria-hidden />} size="sm" disabled={!bounds.larger} onClick={() => save({ readerTextSize: nextTextSize(look.size, 1) })} />
                </span>
              </div>
              <div className="reader__panel-row">
                <span className="reader__panel-label">{t('reader.width.label')}</span>
                <SegmentedControl label={t('reader.width.label')} size="sm" options={READER_WIDTHS.map((w) => ({ value: w, label: widthLabel[w] }))} value={settings.readerWidth} onChange={(readerWidth) => save({ readerWidth })} />
              </div>
              <div className="reader__panel-row reader__panel-row--themes">
                <span className="reader__panel-label">{t('reader.theme.label')}</span>
                <div className="reader__themes" role="radiogroup" aria-label={t('reader.theme.label')}>
                  {READER_THEMES.map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      role="radio"
                      aria-checked={settings.readerTheme === theme}
                      className={cx('reader__theme', `reader__theme--${theme}`)}
                      onClick={() => save({ readerTheme: theme })}
                      onKeyDown={(e) => {
                        const i = READER_THEMES.indexOf(theme)
                        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                        if (!step) return
                        e.preventDefault()
                        const next = READER_THEMES[(i + step + READER_THEMES.length) % READER_THEMES.length]!
                        save({ readerTheme: next })
                        ;(e.currentTarget.parentElement?.children[READER_THEMES.indexOf(next)] as HTMLElement | undefined)?.focus()
                      }}
                      tabIndex={settings.readerTheme === theme ? 0 : -1}
                    >
                      <span className="reader__theme-swatch" aria-hidden>
                        <Type size={14} />
                      </span>
                      <span className="reader__theme-name">{themeLabel[theme]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <article ref={articleEl} className="reader__article" lang={article.lang ?? undefined} dir={article.dir ?? undefined}>
          <header className="reader__header">
            {article.siteName && <p className="reader__site">{article.siteName}</p>}
            <h1 className="reader__title">{article.title || tab.title}</h1>
            {article.byline && <p className="reader__byline">{article.byline}</p>}
            <p className="reader__meta" data-reader-silent>
              <BookOpen size={13} aria-hidden />
              <span title={t('reader.view.words', { count: article.words })}>{t('reader.view.minutes', { count: article.minutes })}</span>
              {date && (
                <>
                  <span aria-hidden>·</span>
                  <time dateTime={date.iso}>{date.label}</time>
                </>
              )}
            </p>
          </header>
          <div className="reader__body">
            <ReaderBody nodes={article.body} onLink={onLink} onAnchor={onAnchor} />
          </div>
          <footer className="reader__footer" data-reader-silent>
            <button type="button" className="reader__plain" onClick={leave}>
              {t('reader.view.original')}
            </button>
          </footer>
        </article>

        {speaking && (
          <div className="reader__listen" role="region" aria-label={t('reader.view.listen')} data-reader-silent>
            <IconButton
              label={speech.status === 'playing' ? t('reader.view.pause') : t('reader.view.resume')}
              icon={speech.status === 'playing' ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
              onClick={listen}
            />
            <IconButton label={t('reader.view.stop')} icon={<Square size={14} aria-hidden />} onClick={() => reader.current?.stop()} />
            <span className="reader__listen-status" role="status">
              {speech.status === 'playing' ? t('reader.view.reading') : t('reader.view.paused')}
            </span>
            <Select
              aria-label={t('reader.view.speed')}
              size="sm"
              value={String(nearestRate(settings.readerRate))}
              options={READER_RATES.map((r) => ({ value: String(r), label: t('reader.view.speedValue', { rate: r }) }))}
              onChange={(r) => save({ readerRate: Number(r) })}
            />
            {sortedVoices.length > 0 ? (
              <Select
                aria-label={t('reader.view.voice')}
                size="sm"
                className="reader__voice"
                value={settings.readerVoice ?? ''}
                options={[{ value: '', label: t('reader.view.voiceAuto') }, ...sortedVoices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
                onChange={(uri) => save({ readerVoice: uri || null })}
              />
            ) : (
              <span className="reader__listen-status">{t('reader.view.noVoices')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

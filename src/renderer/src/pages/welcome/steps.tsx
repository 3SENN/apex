/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The setup flow's smaller steps: name (ON-05), look, engine and key,
// layout (ON-07), browser import (with passwords), favourite
// sites as pinned tabs, and launch (ON-11). Each lays out through the step
// template (StepFrame) and draws its scene around the companion (StepScene):
// its name tag, its colours, the key (and any other engine), the two layouts, what
// comes over from your browser, your sites, and what's next.
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Bookmark, Check, Command, Globe, History, KeyRound, MessageSquarePlus, MousePointerClick, PanelLeft, PanelTop, Palette, Pin, Plus, Search, Shuffle, Sparkles, Tag, Terminal } from 'lucide-react'
import { COMPANION_NAME_MAX, DEFAULT_PROFILE, type CompanionPreset } from '@shared/companion'
import { sameLook } from '@shared/companionLogic'
import { favoriteSuggestions, suggestNames } from '@shared/onboarding'
import { atelier, call, errorText } from '../../api'
import { useActiveCompanion, useCompanionAssets, useCompanions, usePresets } from '../../components/companionData'
import { cleanName } from '../../companion-card/logic/names'
import { LayoutPreview } from '../../illustrations'
import { WelcomePasswords } from '../../passwords/WelcomePasswords'
import { ENGINE_UI } from '@engines/renderer'
import { engineHasOwnAccount } from '@shared/engine'
import { Badge, Button, IconButton } from '../../ui'
import { useMotion } from '../../ui/motion'
import { PresetGallery, shuffledLook, useDraftLook } from '../CompanionEditor'
import { ImportSection } from '../Settings'
import { RecommendedShelf } from '../../extensions/RecommendedShelf' // ON-03 R
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene, initial, type SceneTile } from './StepFrame'
import { useSiteIcons } from './Connectors'
import { useT, t } from '../../i18n/useT'
// ── NT-01 setup search engine ──
import { BUILT_IN_SEARCH_ENGINES, resolveEngine } from '@shared/searchEngines'
import { EngineChoiceList } from '../../components/newtab/StartSearch'
import { engineChoices } from '../../components/newtab/searchLogic'

/** Steps with nothing to load are ready at once. */
function useReadyNow(ready: () => void): void {
  useEffect(() => ready(), [])
}

// ── Name (ON-05) ──

export function NameStep({ setup, settings, companion, next, back, ready, preview }: StepProps): ReactElement {
  const t = useT()
  const active = useActiveCompanion()
  const { items } = useCompanions()
  const fromAnswer = typeof setup.answers['companion-name'] === 'string' ? (setup.answers['companion-name'] as string) : null
  const [name, setName] = useState(fromAnswer ?? companion?.name ?? active?.name ?? '')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  useReadyNow(ready)
  const clean = cleanName(name)
  const suggestions = suggestNames(seed, 4, clean ? [clean] : [])

  useEffect(() => {
    const base = companion ?? active
    if (base) preview({ name: clean || base.name, persona: 'custom', look: base.look, dockIcon: false })
  }, [clean, companion?.id, active?.id])
  useEffect(() => () => preview(null), [])

  const save = async (): Promise<void> => {
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      let id = companion?.id ?? null
      // A first run names the companion Atelier starts with; later runs add a new one, never overwriting yours.
      const firstRun = !settings.onboarded && items.length <= 1
      if (!id && firstRun && active) id = active.id
      if (id) {
        const target = items.find((c) => c.id === id)
        if (!target || target.name !== clean) await call('companions', 'update', id, { name: clean })
      } else {
        id = (await call('companions', 'create', { name: clean, activate: true })).id
      }
      next({ companionId: id, answers: { 'companion-name': clean } })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const tagName = clean || companion?.name || active?.name || ''
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.giveYourCompanionA')}
      subtitle={t('firstRun.welcomeSteps.pickOneOfThese')}
      back={<BackButton onBack={back} />}
      actions={<Button variant="primary" loading={busy} disabled={!clean} onClick={() => void save()}>{t('firstRun.welcomeSteps.continue')}</Button>}
    >
      <StepScene tiles={[{ id: 'tag', icon: <Tag /> }, { id: 'name', text: tagName, on: Boolean(clean) }]} />
      <div className="co-field">
        <label className="co-field__label" htmlFor={nameId}>{t('firstRun.welcomeSteps.name')}</label>
        <input id={nameId} className="co-input" value={name} maxLength={COMPANION_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        {!clean && <p className="co-field__error">{t('firstRun.welcomeSteps.giveYourCompanionA2')}</p>}
      </div>
      <div className="wlx__chips" role="group" aria-label={t('firstRun.welcomeSteps.nameSuggestions')}>
        {suggestions.map((s) => (
          <button key={s} type="button" className="wlx__chip" aria-pressed={clean === s} onClick={() => setName(s)}>
            {s}
          </button>
        ))}
        <IconButton label={t('firstRun.welcomeSteps.moreNames')} icon={<Shuffle />} variant="subtle" onClick={() => setSeed((n) => n + 1)} />
      </div>
      {error && <p className="co-field__error" role="alert">{error}</p>}
    </StepFrame>
  )
}

// ── Look ──

export function LookStep({ companion, next, back, ready, preview }: StepProps): ReactElement {
  const t = useT()
  const active = useActiveCompanion()
  const [loaded] = useCompanionAssets()
  const assets = loaded instanceof Error ? null : loaded
  const presets = usePresets()
  const base = companion ?? active
  const draft = useDraftLook(base?.look ?? DEFAULT_PROFILE.look, assets)
  const [presetId, setPresetId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shuffled = useRef(false)
  const name = base?.name ?? 'your companion'

  // The parts load first; an untouched default look becomes a shuffled one.
  useEffect(() => {
    if (!assets && !(loaded instanceof Error)) return
    ready()
    if (!assets || shuffled.current) return
    shuffled.current = true
    if (base && sameLook(base.look, DEFAULT_PROFILE.look)) draft.replace(shuffledLook(assets))
  }, [assets, loaded])
  const lookKey = JSON.stringify(draft.look)
  useEffect(() => {
    preview({ name, persona: presetId ?? 'custom', look: draft.look, dockIcon: false })
  }, [lookKey, name])
  useEffect(() => () => preview(null), [])

  const pickPreset = (preset: CompanionPreset): void => {
    setPresetId(preset.id)
    draft.replace(preset.look)
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const id = companion?.id ?? active?.id
      if (!id) throw new Error('Your companion isn’t ready yet. Try again in a moment.')
      const patch = presetId ? { persona: presetId, look: draft.look } : { look: draft.look }
      if (!base || !sameLook(base.look, draft.look) || presetId) await call('companions', 'update', id, patch)
      next({ companionId: id, ...(presetId ? { answers: { preset: presetId } } : {}) })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const colors = draft.look.colors
  const tiles: SceneTile[] = [
    { id: 'palette', icon: <Palette /> },
    { id: 'skin', swatch: colors.skin },
    { id: 'hair', swatch: colors.hair },
    { id: 'shuffle', icon: <Shuffle /> },
    { id: 'outfit', swatch: colors.outfit },
    { id: 'accent', swatch: colors.accent },
  ]
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.makeYours', { name })}
      subtitle={t('firstRun.welcomeSteps.hereSALook')}
      back={<BackButton onBack={back} />}
      actions={<Button variant="primary" loading={busy} onClick={() => void save()}>{t('firstRun.welcomeSteps.continue')}</Button>}
    >
      <StepScene tiles={tiles} lines={false} />
      <div className="co-quick__controls">
        <Button
          variant="secondary"
          icon={<Shuffle />}
          disabled={!assets}
          onClick={() => {
            if (!assets) return
            setPresetId(null)
            draft.set(shuffledLook(assets))
          }}
        >
          {t('firstRun.welcomeSteps.shuffleTheLook')}
        </Button>
        {presets.length > 0 && (
          <div className="co-field">
            <span className="co-field__label">{t('firstRun.welcomeSteps.orStartFromA')}</span>
            <PresetGallery presets={presets} selectedId={presetId} onPick={pickPreset} compact label={t('firstRun.welcomeSteps.presetCompanions')} />
          </div>
        )}
        <p className="co-hint">{t('firstRun.welcomeSteps.everyPartColourAnd', { name })}</p>
      </div>
      {error && <p className="co-field__error" role="alert">{error}</p>}
    </StepFrame>
  )
}


export function EngineStep({ settings, onSettings, companion, next, back, ready }: StepProps): ReactElement {
  const t = useT()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  useReadyNow(ready)
  const saveKey = (): void => {
    setError(null)
    atelier.settings.setApiKey(key).then(
      (view) => {
        onSettings(view)
        setKey('')
        next()
      },
      (err: unknown) => setError(errorText(err)),
    )
  }
  // Another engine the build offers signs in on its own (its step is below the key).
  const OtherEngine = ENGINE_UI.Welcome
  const viaCode = OtherEngine !== null && engineHasOwnAccount(settings.engine)
  const viaKey = settings.hasApiKey && !viaCode
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.connectClaude')}
      subtitle={t('firstRun.welcomeSteps.runsOnClaude', { name: companion?.name ?? t('firstRun.welcomeSteps.yourCompanion') })}
      back={<BackButton onBack={back} />}
      actions={<Button variant={settings.hasApiKey || viaCode ? 'primary' : 'ghost'} onClick={() => next()}>{settings.hasApiKey || viaCode ? t('firstRun.welcomeSteps.continue') : t('firstRun.welcomeSteps.skipForNow')}</Button>}
    >
      <StepScene
        tiles={[
          { id: 'key', icon: <KeyRound />, on: viaKey, badge: viaKey ? 'check' : undefined },
          ...(OtherEngine ? [{ id: 'code', icon: <Terminal />, on: viaCode, badge: viaCode ? ('check' as const) : undefined }] : []),
        ]}
      />
      {settings.hasApiKey ? (
        <p className="co-flush">{t('firstRun.welcomeSteps.keyAlreadySet', { source: settings.apiKeySource === 'environment' ? t('firstRun.welcomeSteps.fromAnthropicApiKey') : t('firstRun.welcomeSteps.keySaved') })}</p>
      ) : (
        <div className="co-field__row">
          <input className="co-input" type="password" value={key} placeholder="sk-ant-…" autoComplete="off" aria-label={t('firstRun.welcomeSteps.anthropicApiKey')} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey()} />
          <Button variant="primary" disabled={!key.trim()} onClick={saveKey}>{t('firstRun.welcomeSteps.save')}</Button>
        </div>
      )}
      {error && <p className="co-field__error" role="alert">{error}</p>}
      {OtherEngine && <OtherEngine settings={settings} onSettings={onSettings} />}
      {/* Anthropic's Commercial Terms (D.3): people are told that AI answers can be wrong. */}
      <p className="co-hint">{t('firstRun.welcomeSteps.canBeWrong', { name: companion?.name ?? t('firstRun.welcomeSteps.yourCompanion') })}</p>
    </StepFrame>
  )
}

// ── Layout (ON-07) ──

const LAYOUTS = [
  { id: 'sidebar', get title() { return t('firstRun.welcomeSteps.sidebar') }, get description() { return t('firstRun.welcomeSteps.tabsAndChatsDown') }, recommended: true },
  { id: 'horizontal', get title() { return t('firstRun.welcomeSteps.topTabs') }, get description() { return t('firstRun.welcomeSteps.tabsAcrossTheTop') }, recommended: false },
] as const

export function LayoutStep({ setup, settings, onSettings, next, back, ready, look }: StepProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const saved = setup.answers.layout
  const [choice, setChoice] = useState<'sidebar' | 'horizontal'>(saved === 'horizontal' ? 'horizontal' : 'sidebar')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // NT-01: the search engine is offered here once, while none has been chosen (skipping keeps the current one).
  const [offerEngine] = useState(() => settings.searchEngineChosen !== true)
  const current = resolveEngine(settings.searchEngine, settings.customSearchEngines)
  const [engine, setEngine] = useState(() => (typeof setup.answers['search-engine'] === 'string' && BUILT_IN_SEARCH_ENGINES.some((e) => e.id === setup.answers['search-engine']) ? (setup.answers['search-engine'] as string) : current.id))
  useReadyNow(ready)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const patch = { ...((settings as { layout?: string }).layout !== choice ? { layout: choice } : {}), ...(offerEngine ? { searchEngine: engine } : {}) }
      if (Object.keys(patch).length > 0) onSettings(await atelier.settings.set(patch))
      next({ answers: offerEngine ? { layout: choice, 'search-engine': engine } : { layout: choice } })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  const group = useRef<HTMLDivElement>(null)
  // Two choices: any arrow moves to the other one, and focus follows.
  const move = (): void => {
    setChoice((c) => (c === 'sidebar' ? 'horizontal' : 'sidebar'))
    requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.chooseYourLayout')}
      subtitle={t('firstRun.welcomeSteps.youCanSwitchAny')}
      card="bare"
      back={<BackButton onBack={back} />}
      actions={<Button variant="primary" loading={busy} onClick={() => void save()}>{t('firstRun.welcomeSteps.continue')}</Button>}
    >
      <StepScene
        tiles={[
          { id: 'sidebar', icon: <PanelLeft />, on: choice === 'sidebar', current: choice === 'sidebar' },
          { id: 'tabs', icon: <PanelTop />, on: choice === 'horizontal', current: choice === 'horizontal' },
        ]}
      />
      <div
        ref={group}
        className="wlx__layouts"
        role="radiogroup"
        aria-label={t('firstRun.welcomeSteps.layout')}
        onKeyDown={(e) => {
          if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return
          e.preventDefault()
          move()
        }}
      >
        {LAYOUTS.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={choice === l.id} tabIndex={choice === l.id ? 0 : -1} className="wlx__layout" onClick={() => setChoice(l.id)}>
            <LayoutPreview kind={l.id === 'sidebar' ? 'sidebar' : 'tabs'} animate={!reduced} look={look} />
            <span className="wlx__layout-title">
              {l.title}
              {l.recommended && <Badge tone="accent">{t('firstRun.welcomeSteps.recommended')}</Badge>}
              {choice === l.id && <Check aria-hidden className="wlx__layout-check" />}
            </span>
            <span className="wlx__layout-desc">{l.description}</span>
          </button>
        ))}
      </div>
      {offerEngine && (
        <div className="wlx__search">
          <span className="wlx__search-label">{t('newTabSearch.choose.title')}</span>
          <EngineChoiceList engines={engineChoices(current)} value={engine} onChoose={setEngine} label={t('newTabSearch.choose.label')} pickOnArrow />
        </div>
      )}
      {error && <p className="co-field__error" role="alert">{error}</p>}
    </StepFrame>
  )
}


/** What comes over from the browser you use today, flowing to the companion. */
const BROWSER_TILES: SceneTile[] = [
  { id: 'bookmarks', icon: <Bookmark /> },
  { id: 'history', icon: <History /> },
  { id: 'passwords', icon: <KeyRound /> },
  { id: 'browser', icon: <Globe /> },
]

export function BrowserImportStep({ next, back, ready }: StepProps): ReactElement {
  const t = useT()
  useReadyNow(ready)
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.bringYourBookmarks')}
      subtitle={t('firstRun.welcomeSteps.importBookmarksAndHistory')}
      back={<BackButton onBack={back} />}
      actions={<Button variant="primary" onClick={() => next()}>{t('firstRun.welcomeSteps.continue')}</Button>}
    >
      <StepScene tiles={BROWSER_TILES} lines="in" />
      <ImportSection compact />
      <hr className="wlt__divider" />
      <WelcomePasswords />
      {/* ON-03 R: a few recommended extensions. */}
      <hr className="wlt__divider" />
      <h3 className="exr__heading">{t('extImport.rec.welcomeTitle')}</h3>
      <RecommendedShelf compact />
    </StepFrame>
  )
}

// ── Favourite sites as pinned tabs (optional) ──

function normalSite(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.')) return null
    return url.origin + '/'
  } catch {
    return null
  }
}

export function FavoritesStep({ next, back, ready }: StepProps): ReactElement {
  const t = useT()
  const [sites, setSites] = useState<Array<{ host: string; url: string }>>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldId = useId()

  useEffect(() => {
    call('history', 'search', '', 2000).then(
      (items) => {
        setSites(favoriteSuggestions(items, 8))
        ready()
      },
      () => ready(),
    )
  }, [])

  const toggle = (url: string): void =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(url)) n.delete(url)
      else n.add(url)
      return n
    })
  const add = (): void => {
    const url = normalSite(draft)
    if (!url) {
      setError(t('firstRun.welcomeSteps.thatDoesnTLook'))
      return
    }
    setError(null)
    setDraft('')
    const host = new URL(url).hostname.replace(/^www\./, '')
    setSites((s) => (s.some((x) => x.url === url) ? s : [...s, { host, url }]))
    setPicked((p) => new Set(p).add(url))
  }
  const pin = async (): Promise<void> => {
    const urls = [...picked]
    if (urls.length === 0) return next()
    setBusy(true)
    setError(null)
    try {
      // Open each in the background, then pin the new tabs as they appear.
      const pending = new Set(urls.map((u) => new URL(u).hostname))
      const off = atelier.tabs.onChanged((snapshot) => {
        for (const tab of snapshot.tabs) {
          let host = ''
          try {
            host = new URL(tab.url).hostname
          } catch {
            continue
          }
          if (!tab.pinned && pending.has(host)) {
            pending.delete(host)
            void call('tabs', 'setPinned', tab.id, true)
          }
        }
      })
      for (const url of urls) await atelier.tabs.create(url, { background: true })
      setTimeout(off, 5_000)
      next({ answers: { favorites: urls } })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  // Around the companion: every picked site and the most visited of the rest, six at most, in their own order
  // (so picking one doesn't shuffle the tiles), each with its own icon when Atelier has it.
  const others = new Set(sites.filter((s) => !picked.has(s.url)).slice(0, Math.max(0, 6 - picked.size)).map((s) => s.url))
  const around = sites.filter((s) => picked.has(s.url) || others.has(s.url)).slice(0, 6)
  const icons = useSiteIcons(around.map((s) => s.host))
  const tiles: SceneTile[] = around.length > 0
    ? around.map((s) => ({ id: s.url, image: icons[s.host] ?? null, mark: initial(s.host), on: picked.has(s.url), badge: picked.has(s.url) ? 'pin' : undefined }))
    : [{ id: 'pin', icon: <Pin /> }, { id: 'more', icon: <Sparkles /> }]
  return (
    <StepFrame
      title={t('firstRun.welcomeSteps.pinYourFavouriteSites')}
      subtitle={t('firstRun.welcomeSteps.pinnedTabsStayAt')}
      back={<BackButton onBack={back} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => next()}>{t('firstRun.welcomeSteps.skip')}</Button>
          <Button variant="primary" icon={<Pin />} loading={busy} disabled={picked.size === 0} onClick={() => void pin()}>
            {picked.size > 0 ? t('firstRun.welcomeSteps.pin2', { size: picked.size }) : t('firstRun.welcomeSteps.pin')}
          </Button>
        </>
      }
    >
      <StepScene tiles={tiles} />
      {sites.length > 0 ? (
        <ul className="wlx__sites" aria-label={t('firstRun.welcomeSteps.sitesYouVisitMost')}>
          {sites.map((s) => (
            <li key={s.url}>
              <label className="wlx__site">
                <input type="checkbox" checked={picked.has(s.url)} onChange={() => toggle(s.url)} />
                <span>{s.host}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="co-hint">{t('firstRun.welcomeSteps.addTheSitesYou')}</p>
      )}
      <div className="co-field__row">
        <label className="ui-sr-only" htmlFor={fieldId}>{t('firstRun.welcomeSteps.addASite')}</label>
        <input id={fieldId} className="co-input" value={draft} placeholder="example.com" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button variant="secondary" icon={<Plus />} disabled={!draft.trim()} onClick={add}>{t('firstRun.welcomeSteps.add')}</Button>
      </div>
      {error && <p className="co-field__error" role="alert">{error}</p>}
    </StepFrame>
  )
}

// ── Launch (ON-11) ──

/** What's next: the first chat, ⌘J to talk, ⌘L to search, a right-click to peek. */
const LAUNCH_TILES: SceneTile[] = [
  { id: 'chat', icon: <MessageSquarePlus />, on: true, current: true },
  { id: 'talk', icon: <Command /> },
  { id: 'search', icon: <Search /> },
  { id: 'peek', icon: <MousePointerClick /> },
]

export function LaunchStep({ setup, isMac, tabId, companion, back, ready }: StepProps): ReactElement {
  const t = useT()
  const [state, setState] = useState<'idle' | 'starting' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  useReadyNow(ready)
  const mod = isMac ? '⌘' : 'Ctrl+'
  const name = companion?.name ?? 'your companion'

  const finish = async (): Promise<void> => {
    // complete() marks setup done and opens the getting-started page once.
    await call('onboarding', 'complete')
  }
  const launch = async (): Promise<void> => {
    setState('starting')
    setError(null)
    try {
      if (!setup.finishedAt) await finish()
      const result = await call('onboarding', 'launch')
      if (!result.ok) throw new Error(result.error ?? 'The first chat couldn’t start.')
      void atelier.tabs.close(tabId)
    } catch (err) {
      setError(errorText(err))
      setState('failed')
    }
  }
  const justBrowse = async (): Promise<void> => {
    try {
      if (!setup.finishedAt) await finish()
    } finally {
      void atelier.tabs.close(tabId)
    }
  }

  const card = isMac || state === 'failed'
  return (
    <>
    <StepScene tiles={LAUNCH_TILES} />
    <StepFrame
      title={t('firstRun.welcomeSteps.youReAllSet')}
      subtitle={t('firstRun.welcomeSteps.yourFirstChatWith', { name, mod, mod2: mod })}
      back={<BackButton onBack={back} />}
      actions={<Button variant="brand" loading={state === 'starting'} onClick={() => void launch()}>{t('firstRun.welcomeSteps.startMyFirstChat')}</Button>}
    >
      {card && (
        <>
          {isMac && <p className="co-hint co-flush">{t('firstRun.welcomeSteps.toKeepAtelierIn')}</p>}
          {state === 'failed' && (
            <div className="wlx__slow" role="alert">
              <p>{error}</p>
              <div className="wlx__row">
                <Button variant="secondary" onClick={() => void launch()}>{t('firstRun.welcomeSteps.tryAgain')}</Button>
                <Button variant="ghost" onClick={() => void justBrowse()}>{t('firstRun.welcomeSteps.justOpenTheBrowser')}</Button>
              </div>
            </div>
          )}
        </>
      )}
    </StepFrame>
    </>
  )
}

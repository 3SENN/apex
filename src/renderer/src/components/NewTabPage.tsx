/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Coffee, Pencil, Sofa, UserPlus } from 'lucide-react'
import type { Companion as CompanionRecord } from '@shared/companion'
import type { ChromeCommand, TabInfo } from '@shared/ipc'
import { atelier, errorText } from '../api'
import { Bubble, Companion, CompanionStill, companionImage, signalPresence, useCaretGaze } from '../companion'
import { heroTint } from '../companion-card/logic/cardColors'
import { pickerSlots, slotIndexOf, stepSlot } from '../companion-card/logic/cycle'
import { CompanionSheets, openNewCompanion } from '../companion-card/sheets'
import { IconButton, Skeleton, toast } from '../ui'
import { motionReduced } from '../ui/motion'
import { chooseCompanion, useCompanions } from './companionData'
import { Floor, type FloorHandle } from './newtab/Floor'
import { noteAskOrigin } from './newtab/handoff'
import { flightPath } from './newtab/newtabLogic'
import { useCompanionFloor } from './newtab/useCompanionFloor' // DS-75b
import { StartComposer } from './newtab/StartComposer'
import { ChipTray } from './newtab/ChipTray'
import { IdeasCard } from './newtab/IdeasCard'
import { InboxButton } from './newtab/Inbox'
import { useSettingsView } from '../companion-card/useLoaded'
import { Nudges } from './newtab/Nudges'
import { SwitcherPill } from './newtab/SwitcherPill'
import { StartCorners } from './StartSurface' // DS-107
import { ArrowUp, Mic } from 'lucide-react'
import { Spinner } from '../ui'
import { t as tStatic, useT } from '../i18n/useT'
import { DictationBar } from '../chat/dictation/DictationBar'
import { insertDictation } from '../chat/dictation/logic'
import { useDictation } from '../chat/dictation/useDictation'
import { useShell } from './shellContext'
import { FOCUS_ASK_EVENT } from './AddressPill'
import { useStartIntake } from '../chat/composer/DropZone'
import '../companion-card/card.css'
import './newtab/newtab.css'
import { NewTabPrivateToggle, startPrivateChat } from '../chat/ChatBanners' // CH-30
import { ArrowRight, Search } from 'lucide-react'
import { EngineChooser, ModeSwitch, StartSuggestions, enterLabel } from './newtab/StartSearch'
import { engineChoices } from './newtab/searchLogic'
import { useStartSearch } from './newtab/useStartSearch'
import { NewTabPackCards } from '../packs/NewTabPackCards'

interface NewTabPageProps {
  tabId: string
  /** Starts a chat with `companionId` (the one shown when you asked). */
  onAsk(text: string, companionId: string): void
}

/** The live figure's canvas, inside a square button a little larger (DS-74). */
const FIGURE_PX = 112
/** If the tab has not turned into the chat by then, the opening status gives way. */
const OPENING_MS = 4000

/** Favicons of the sites in your tabs, for the floor's topic bubbles. */
function useFavicons(): string[] {
  const pick = (tabs: readonly TabInfo[]): string[] => [...new Set(tabs.filter((t) => t.favicon && /^https?:/.test(t.url)).map((t) => t.favicon as string))].slice(0, 6)
  const [favicons, setFavicons] = useState<string[]>(() => pick(atelier.initial.tabs.tabs))
  useEffect(() => atelier.tabs.onChanged((snapshot) => setFavicons(pick(snapshot.tabs))), [])
  return favicons
}

/**
 * The new tab, laid out as the start surface: the switcher pill at the top
 * centre, the floor toggle at the top right, and the live companion who
 * takes your next chat standing above the composer (DS-74). By default the
 * page is the Lounge (DS-75): every other companion stands on a floor
 * around the composer. Choosing another (a click, ←/→ in the empty
 * composer, the switcher, or dragging one onto the composer) arcs it up and
 * bumps the previous one back down (DS-77). With "Companions on New Tab"
 * off, the switcher lists everyone and the companion offers help in a
 * bubble. The choice is the active companion, so it is remembered.
 */
export function NewTabPage({ tabId, onAsk }: NewTabPageProps) {
  const { items, activeId, status } = useCompanions()
  const tr = useT()
  const shell = useShell()
  const { on: floorOn, toggle: toggleFloor } = useCompanionFloor() // DS-75b: the profile setting, followed by every open start surface
  const [text, setText] = useState('')
  // The add entry is a place in the ←/→ cycle, not a companion, so it lives here.
  const [onAdd, setOnAdd] = useState(false)
  const [opening, setOpening] = useState(false)
  const [drop, setDrop] = useState<{ tint: string; over: boolean } | null>(null)
  const [flight, setFlight] = useState<{ companion: CompanionRecord; from: DOMRect; key: number } | null>(null)
  const [arrival, setArrival] = useState(0)
  const favicons = useFavicons()
  // DS-112: keep-awake is the app setting the power-save service (ST-22) reads.
  const settingsView = useSettingsView()
  const keepAwake = settingsView?.keepAwake === true
  const caret = useCaretGaze()
  const composer = useRef<HTMLFormElement>(null)
  // MV-07: the ask field's mic works like the composer's; words land at the caret
  const dictation = useDictation((words) => void insertWords(words))
  const insertWords = (words: string): string => {
    const field = composer.current?.querySelector('textarea')
    const current = field?.value ?? text
    const next = insertDictation(current, field?.selectionStart ?? current.length, field?.selectionEnd ?? current.length, words)
    setText(next.text)
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(next.caret, next.caret)
    })
    return next.text
  }
  // SH-36, DS-110: Tab in the empty tab's command bar hands its text to this field
  useEffect(() => {
    const focusAsk = (text: string | null): void => {
      const field = composer.current?.querySelector('textarea')
      if (text !== null) setText(text)
      requestAnimationFrame(() => {
        field?.focus()
        const end = field?.value.length ?? 0
        field?.setSelectionRange(end, end)
      })
    }
    const onEvent = (e: Event): void => {
      const detail = (e as CustomEvent<{ tabId: string; text: string }>).detail
      if (detail && detail.tabId === tabId) focusAsk(detail.text)
    }
    window.addEventListener(FOCUS_ASK_EVENT, onEvent)
    const off = atelier.onCommand((command) => {
      if ((command as ChromeCommand) === 'focus-ask') focusAsk(null)
    })
    return () => {
      window.removeEventListener(FOCUS_ASK_EVENT, onEvent)
      off()
    }
  }, [tabId])
  const perch = useRef<HTMLDivElement>(null)
  const below = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const floor = useRef<FloorHandle>(null)
  const flightEl = useRef<HTMLDivElement>(null)
  const avoid = useMemo(() => [composer, perch, below], [])
  const flights = useRef(0)
  const userName = atelier.initial.settings.userName?.trim() ?? ''

  const slots = pickerSlots(items)
  const visible = items.filter((c) => !c.hidden)
  const companion = items.find((c) => c.id === activeId && !c.hidden) ?? visible[0] ?? null
  // CH-23, CH-24: files dropped or pasted on the ask field open a chat that carries them.
  const filesOver = useStartIntake({ tabId, companionId: companion?.id ?? null, text, target: composer, onHandoff: () => setText('') })
  const onFloor = visible.filter((c) => c.id !== companion?.id)
  const index = onAdd ? slots.length - 1 : companion ? slotIndexOf(slots, companion.id) : 0

  useEffect(() => setOnAdd(false), [activeId])
  // DS-73: a full-body still of the figure, ready for its flight into the first reply's face.
  const figureStill = useRef<string | null>(null)
  useEffect(() => {
    figureStill.current = null
    if (!companion) return
    let live = true
    companionImage(companion.look, FIGURE_PX * 2, undefined, { framing: 'full' }).then(
      (url) => {
        if (live) figureStill.current = url
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [companion?.id, companion?.look])
  useEffect(() => {
    if (!opening) return
    const timer = setTimeout(() => setOpening(false), OPENING_MS)
    return () => clearTimeout(timer)
  }, [opening])

  // ---- choosing who takes the next chat ----
  const choose = (id: string): void => {
    const next = items.find((c) => c.id === id)
    setOnAdd(false)
    if (!next || next.id === companion?.id) return
    const perchBox = perch.current?.getBoundingClientRect() ?? null
    const from = floorOn ? floor.current?.rectOf(id) ?? null : null
    if (floorOn && perchBox) {
      floor.current?.take(id)
      if (companion) {
        // Knocked back down, away from the side the newcomer flies in from.
        const fromLeft = from ? from.left + from.width / 2 < perchBox.left + perchBox.width / 2 : true
        floor.current?.bump(companion.id, { x: perchBox.left + perchBox.width / 2, y: perchBox.bottom + 24 }, fromLeft ? 1 : -1)
      }
      floor.current?.glance({ x: perchBox.left + perchBox.width / 2, y: perchBox.bottom })
    }
    if (from && perchBox && !motionReduced()) setFlight({ companion: next, from, key: ++flights.current })
    else setArrival((n) => n + 1)
    chooseCompanion(id).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }
  const step = (direction: 1 | -1): void => {
    const next = slots[stepSlot(slots, index, direction)]
    if (!next) return
    if (next.kind === 'add') {
      setOnAdd(true)
      return
    }
    choose(next.id)
  }
  const add = (): void => openNewCompanion({ onCreated: () => setOnAdd(false) })

  // The flight: along an arc from the floor to the figure's place, then the arrival ring.
  useLayoutEffect(() => {
    const el = flightEl.current
    const target = perch.current?.getBoundingClientRect()
    const box = stage.current?.getBoundingClientRect()
    if (!flight || !el || !target || !box) return
    const path = flightPath(flight.from, target, box)
    const animation = el.animate(path.keyframes, { duration: path.duration, easing: 'linear', fill: 'both' })
    animation.onfinish = () => {
      setFlight((f) => (f?.key === flight.key ? null : f))
      setArrival((n) => n + 1)
    }
    return () => {
      animation.onfinish = null
      animation.cancel()
    }
  }, [flight?.key])

  // ---- asking ----
  const [privateChat, setPrivateChat] = useState(false) // CH-30
  const ask = (override?: string /* The field with dictated words */): void => {
    const value = (override ?? text).trim()
    // On the add entry, sending with nothing typed adds a companion.
    if (onAdd && !value) return add()
    if (!value || !companion) return
    signalPresence('sent', companion.id)
    const standing = perch.current ? { rect: perch.current.getBoundingClientRect(), image: figureStill.current } : null
    if (composer.current) noteAskOrigin(tabId, composer.current.querySelector('[data-pond-anchor]')?.getBoundingClientRect() ?? composer.current.getBoundingClientRect(), privateChat ? null : standing)
    setOpening(true)
    // CH-30: a private chat starts here, never saved and with memory off.
    if (privateChat) startPrivateChat(tabId, value, companion.id)
    else onAsk(value, companion.id)
    setText('')
    caret.clear()
  }
  // ── NT-01 new tab search ── (ask the companion or search the web; local suggestions while typing)
  const search = useStartSearch({
    tabId,
    text,
    settings: settingsView,
    bypass: onAdd || dictation.state === 'starting' || dictation.state === 'listening' || dictation.state === 'transcribing',
    busy: opening,
    private: privateChat, // DC-04
    onAsk: (value) => ask(value),
    onClear: () => {
      setText('')
      caret.clear()
    },
    focusField: () => composer.current?.querySelector('textarea')?.focus(),
  })
  const webMode = search.mode === 'web' && !onAdd
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Arrows choose a companion only while the composer is empty, so they still move the caret in text.
    if (text !== '' || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      step(e.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  if (!companion) {
    return (
      <div className="nt" aria-busy={status === 'loading'}>
        <div className="nt__loading">
          <Skeleton circle width={FIGURE_PX} height={FIGURE_PX} />
          <Skeleton width={640} height={114} radius={24} />
        </div>
        <CompanionSheets />
      </div>
    )
  }

  const name = companion.name
  const tint = companion.look.colors.accent
  return (
    <div className="nt" data-mode={floorOn ? 'floor' : 'picker'} style={{ '--hero-tint': tint } as CSSProperties}>
      <div ref={stage} className="nt__stage">
        <Floor
          ref={floor}
          companions={onFloor}
          shown={floorOn}
          stageRef={stage}
          avoid={avoid}
          figureRef={perch}
          tint={heroTint(companion.look)}
          pulse={arrival}
          dropRef={composer}
          favicons={favicons}
          youInitial={userName ? userName.charAt(0).toUpperCase() : null}
          onChoose={choose}
          onDrag={(state) => setDrop(state ? { tint: state.tint, over: state.over } : null)}
        />

        <div className="nt__top">
          <SwitcherPill selected={companion} companions={visible} listAll={!floorOn} onChoose={choose} onAdd={add} onOpenCard={(id) => shell.openCompanionCard(id)} />
        </div>
        {/* DS-107: the corners are the shared start surface's (StartSurface.tsx). */}
        <StartCorners floorOn={floorOn} onToggleFloor={toggleFloor} inboxClassName="nt__arrive-last" />

        <div className="nt__figure">
          {onAdd ? (
            <button type="button" className="nt__add-entry" onClick={add}>
              <UserPlus aria-hidden />
              <span>{tr('tabs.newTab.addCompanion')}</span>
            </button>
          ) : (
            <button type="button" className="nt__figure-button" data-flying={flight ? 'true' : undefined} aria-label={tr('tabs.newTab.openCard', { name })} onClick={() => shell.openCompanionCard(companion.id)}>
              <div ref={perch} className="nt__perch" style={{ width: FIGURE_PX, height: FIGURE_PX }}>
                <Companion key={companion.id} profile={companion} size={FIGURE_PX} framing="full" floor lookAt={caret.lookAt} greet priority={1} title={tr('tabs.newTab.takesNext', { name })} />
                {arrival > 0 && <ArrivalRing key={arrival} tint={tint} />}
              </div>
              <span className="nt__badge" aria-hidden="true">
                <Pencil />
              </span>
              <span className="nt__tip" aria-hidden="true">{tr('tabs.newTab.openCard', { name })}</span>
            </button>
          )}
          {!onAdd && !floorOn && (
            <span className="nt__help">
              <Bubble text={tr('tabs.newTab.help')} side="left" tint={tint} revealKey={companion.id} announce />
            </span>
          )}
        </div>

        <StartComposer
          ref={composer}
          companion={companion}
          value={text}
          placeholder={onAdd ? tr('tabs.newTab.placeholderAdd') : webMode ? tr('newTabSearch.placeholder', { engine: search.engine.name }) : tr('tabs.newTab.placeholder', { name })}
          label={onAdd ? tr('tabs.newTab.labelAdd') : webMode ? tr('newTabSearch.label', { engine: search.engine.name }) : tr('tabs.newTab.label', { name })}
          opening={opening ? tr('tabs.newTab.opening', { name }) : null}
          drop={drop ?? (filesOver && companion ? { tint: companion.look.colors.accent, over: true } : null)}
          action={
            onAdd && !text.trim()
              ? { label: tr('tabs.newTab.addCompanion'), icon: <UserPlus aria-hidden />, enabled: true }
              : /* DS-59: the mic while empty, send-what-you-said while listening, a spinner while transcribing */
                dictation.state === 'listening'
                ? { label: tStatic('meetings.dictation.sendSpoken'), icon: <ArrowUp aria-hidden />, enabled: true }
                : dictation.state === 'starting' || dictation.state === 'transcribing'
                  ? { label: tStatic('meetings.dictation.transcribing'), icon: <Spinner size={14} />, enabled: false }
                  : /* NT-01: in web mode the button searches (or goes to a typed site) */
                    webMode && !text.trim()
                    ? { label: tr('newTabSearch.action.search', { engine: search.engine.name }), icon: <Search aria-hidden />, enabled: false }
                    : !text.trim()
                      ? { label: tStatic('meetings.dictation.talkTo', { name }), icon: <Mic aria-hidden />, enabled: dictation.available }
                      : search.plan.enter && search.plan.enter.kind !== 'ask'
                        ? { label: enterLabel(search.plan.enter, name, tr) ?? '', icon: search.plan.enter.kind === 'go' ? <ArrowRight aria-hidden /> : <Search aria-hidden />, enabled: !opening }
                        : undefined
          }
          lead={!onAdd && <ModeSwitch mode={search.mode} companionName={name} engine={search.engine} onChange={search.setMode} />}
          popup={
            search.choosing ? (
              <EngineChooser engines={engineChoices(search.engine)} current={search.engine} onChoose={search.chooseEngine} onKeep={search.keepEngine} />
            ) : (
              <StartSuggestions search={search} companionName={name} />
            )
          }
          onKeyFirst={search.keyFirst}
          onFocus={() => search.setFocused(true)}
          combobox={{ expanded: search.open, controls: search.listId, active: search.open && search.selected >= 0 ? search.optionId(search.selected) : undefined }}
          onChange={(value, field) => {
            setText(value)
            caret.track(field)
            // NT-01: typing means the field is in use, even when its focus event never fired (a window that is not in front).
            search.setFocused(true)
            // Listening holds while there is text (DS-69).
            signalPresence(value ? 'typing' : 'idle', companion.id)
            // Typing on the add entry means asking the companion after all.
            if (onAdd && value.trim()) setOnAdd(false)
          }}
          onCaret={(field) => text && caret.track(field)}
          onBlur={() => {
            signalPresence('idle', companion.id)
            caret.clear()
            search.setFocused(false) // NT-01
          }}
          onSubmit={() => {
            // Listening: stop and send; empty: the mic (Enter in the empty field does nothing).
            if (dictation.state === 'listening') return void dictation.stop().then((words) => ask(words ? insertWords(words) : undefined))
            if (!onAdd && !text.trim()) {
              if (webMode || document.activeElement instanceof HTMLTextAreaElement) return
              return void dictation.start()
            }
            // NT-01: the send button runs what Enter would (go to a typed site, search, or ask).
            if (!onAdd) return search.runEnter()
            ask()
          }}
          onKeyDown={onKeyDown}
        >
          {/* Dictation's status line under the ask field */}
          <DictationBar dictation={dictation} className="nt-dictation" onStop={() => void dictation.stop().then((words) => words && insertWords(words))} />
          {/* The start tray (DS-108) and the ideas card (DS-109); the floor keeps clear of this slot. */}
          <div ref={below} className="nt__below">
            <ChipTray />
            <IdeasCard
              companionName={name}
              onPrefill={(prompt) => {
                setText(prompt)
                // The caret lands at the end, ready for the details the idea asks for.
                requestAnimationFrame(() => {
                  const field = composer.current?.querySelector('textarea')
                  field?.focus()
                  field?.setSelectionRange(prompt.length, prompt.length)
                })
              }}
              onSend={(prompt) => ask(prompt)}
            />
            {/* docs/packs.md: cards from the packs that are on; nothing without one. */}
            <NewTabPackCards />
          </div>
          {/* CH-30 */}
          <NewTabPrivateToggle on={privateChat} onChange={setPrivateChat} />
          <Nudges />
        </StartComposer>
        {slots.length > 1 && <p className="ui-sr-only">{tr('tabs.newTab.switchHint')}</p>}

        {flight && (
          <div ref={flightEl} className="nt-flight" style={{ width: FIGURE_PX, height: FIGURE_PX, '--flight-tint': flight.companion.look.colors.accent } as CSSProperties} aria-hidden="true">
            <CompanionStill look={flight.companion.look} mood="happy" size={FIGURE_PX} />
          </div>
        )}
      </div>
      <CompanionSheets />
    </div>
  )
}

/** Atelier's arrival cue: a light ring spreads under the feet and a short column of sparkles rises. */
function ArrivalRing({ tint }: { tint: string }) {
  if (motionReduced()) return null
  return (
    <span className="nt-arrival" style={{ '--arrival-tint': tint } as CSSProperties} aria-hidden="true">
      <span className="nt-arrival__ring" />
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} className="nt-arrival__spark" viewBox="-1 -1 2 2" style={{ '--i': i } as CSSProperties}>
          <path d="M0 -1 L0.22 -0.22 L1 0 L0.22 0.22 L0 1 L-0.22 0.22 L-1 0 L-0.22 -0.22 Z" />
        </svg>
      ))}
    </span>
  )
}

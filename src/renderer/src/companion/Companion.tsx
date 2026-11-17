/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { MessageCircleQuestionMark, Moon } from 'lucide-react'
import type { CompanionEngine, CompanionMood, CompanionProfile } from '@shared/companion'
import { t } from '@shared/i18n/core'
import { lookWithProp, useEngineAvailable, useHeldProp } from './activity'
import { resolveFraming, type CompanionFraming } from './layout'
import { LiveBudget, LIVE_MIN_PX, PatDetector } from './liveBudget'
import { useChatPresence, useChatTyping, useCompanionPresence, wakePresence } from './presence'
import { cheerIsFresh, figureMood } from './presenceCore'
import { initCompanionStats } from './stats'
import { CompanionStill } from './Still'
import { CompanionView, type LookTarget } from './view'
import './companion.css'

// The companion, assembled at runtime from modular parts (rig, head,
// accessories) with a 2D face layer; see docs/companion-system.md. The view
// is imperative, so mood, speech and pointer changes never re-render React.
// Every figure shows a still first and swaps into the live figure when its
// first frame is drawn (DS-71); over the live budget or off-screen it stays
// a breathing still.

initCompanionStats()

const budget = new LiveBudget()
/** Off-screen this long gives the live slot back. */
const OFFSCREEN_GRACE_MS = 2000
const MOOD_WORDS: Record<CompanionMood, string> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  talking: 'talking',
  approval: 'needs you',
  happy: 'happy',
  sad: 'sad',
  sleeping: 'napping',
}

export interface CompanionProps {
  profile: CompanionProfile & { id?: string }
  /** A fixed mood. Leave it out to follow the companion's presence (its chats, every composer, idle time), or the chat's with `chatId`. */
  mood?: CompanionMood
  /** Follow this chat's mood instead of the companion's. */
  chatId?: string | null
  /** Increment on each streamed text chunk to animate speech; presence supplies it when the mood is followed. */
  talkPulse?: number
  /** CSS pixels, or 'fill' to fill the parent and re-frame whenever it resizes (CO-19). */
  size?: number | 'fill'
  /** 'auto' frames the face below 80 px and the full body above. */
  framing?: CompanionFraming
  /** A viewport point the eyes go to (the caret while you type); a small mouse movement hands the gaze back. */
  lookAt?: LookTarget | null
  /** An oval floor glow in the companion's colour under its feet. */
  floor?: boolean
  /** The 3D stage's own ground shadow; off where the surface draws its own floor (the card hero). */
  shadow?: boolean
  /** Wave hello once ready (and again whenever it turns true). */
  greet?: boolean
  /** Increment to play the celebration (a wave and a ring of sparkles). */
  celebrate?: number
  /** 'still' never creates a WebGL view (galleries, decoration). */
  render?: 'auto' | 'still'
  /** Live-slot priority when more figures want one than the budget allows. */
  priority?: number
  className?: string
  onClick?: () => void
  title?: string
}

/** Whether the head is under the pointer, roughly: the top of a full-body frame, most of a bust. */
function overHead(event: ReactPointerEvent<HTMLElement>, box: HTMLElement | null, framing: Exclude<CompanionFraming, 'auto'>): boolean {
  if (!box) return false
  const rect = box.getBoundingClientRect()
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  const x = (event.clientX - rect.left) / Math.max(1, rect.width)
  return x > 0.18 && x < 0.82 && y < (framing === 'full' ? 0.5 : 0.75)
}

export function Companion({
  profile,
  mood: fixedMood,
  chatId,
  talkPulse: fixedTalk,
  size = 'fill',
  framing = 'auto',
  lookAt = null,
  floor = false,
  shadow = true,
  greet = false,
  celebrate = 0,
  render = 'auto',
  priority = 0,
  className,
  onClick,
  title,
}: CompanionProps) {
  const outerRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CompanionView | null>(null)
  const pats = useRef(new PatDetector())
  const [measured, setMeasured] = useState(0)
  const px = typeof size === 'number' ? size : measured
  const resolved = resolveFraming(framing, px)

  // ---- mood ----
  const own = useCompanionPresence(profile.id)
  const chat = useChatPresence(chatId)
  const typingHere = useChatTyping(chatId)
  // In a chat, the chat's state leads; at rest the figure listens to its composer and naps with the companion's other views.
  const followed: CompanionMood = chatId ? figureMood(chat.mood, typingHere, own.mood) : own.mood
  const mood = fixedMood ?? followed
  const talkPulse = fixedTalk ?? (chatId ? chat.talkPulse : own.talkPulse)
  // The live figure holds the step's prop; a fixed mood (galleries, previews) never does.
  const heldProp = useHeldProp(fixedMood ? null : chatId, fixedMood ? undefined : profile.id)
  const liveLook = lookWithProp(profile.look, heldProp)
  const available = useEngineAvailable((profile as { engine?: CompanionEngine | null }).engine)

  // ---- size: fill the parent and re-frame as it changes ----
  useLayoutEffect(() => {
    if (typeof size === 'number') return
    const outer = outerRef.current
    if (!outer || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const rect = outer.getBoundingClientRect()
      setMeasured(Math.max(0, Math.floor(Math.min(rect.width, rect.height))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    return () => observer.disconnect()
  }, [size === 'fill'])

  // ---- the live budget ----
  const [granted, setGranted] = useState(false)
  const [ready, setReady] = useState(false)
  const slot = useRef<ReturnType<LiveBudget['register']> | null>(null)
  const wantsLive = render === 'auto' && px >= LIVE_MIN_PX
  useEffect(() => {
    if (!wantsLive) return
    const handle = budget.register({ size: px, visible: true, priority }, setGranted)
    slot.current = handle
    return () => {
      handle.release()
      slot.current = null
      setGranted(false)
    }
  }, [wantsLive])
  useEffect(() => slot.current?.update({ size: px, priority }), [px, priority])
  // Off-screen for a while gives the slot back; coming back asks again.
  useEffect(() => {
    const box = boxRef.current
    if (!wantsLive || !box || typeof IntersectionObserver === 'undefined') return
    let grace: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting ?? true
      if (grace) clearTimeout(grace)
      grace = null
      if (visible) slot.current?.update({ visible: true })
      else grace = setTimeout(() => slot.current?.update({ visible: false }), OFFSCREEN_GRACE_MS)
    })
    observer.observe(box)
    return () => {
      if (grace) clearTimeout(grace)
      observer.disconnect()
    }
  }, [wantsLive])
  const live = wantsLive && granted

  // ---- the live view ----
  const initial = useRef({ look: liveLook, mood, size: px, framing, shadow })
  initial.current = { look: liveLook, mood, size: px, framing, shadow }
  useEffect(() => {
    const host = hostRef.current
    if (!live || !host) return
    const view = new CompanionView(host, { ...initial.current, onReady: () => setReady(true) })
    viewRef.current = view
    view.setIdle(own.idle)
    view.setLookTarget(lookAt)
    if (greet) view.greet()
    if (pendingCheer.current) {
      pendingCheer.current = false
      view.celebrate()
    }
    return () => {
      // The still is already back underneath (ready flips in the same commit), so there is no flash.
      view.dispose()
      viewRef.current = null
      setReady(false)
    }
  }, [live])

  const lookKey = JSON.stringify(liveLook ?? null)
  useEffect(() => {
    // lookKey covers every field of the look.
    void viewRef.current?.setLook(liveLook)
  }, [lookKey])
  useEffect(() => viewRef.current?.setMood(mood), [mood])
  useEffect(() => viewRef.current?.setSize(px), [px])
  useEffect(() => viewRef.current?.setFraming(framing), [framing])
  useEffect(() => viewRef.current?.setLookTarget(lookAt), [lookAt])
  useEffect(() => viewRef.current?.setIdle(own.idle), [own.idle])
  useEffect(() => {
    if (talkPulse > 0) viewRef.current?.talk()
  }, [talkPulse])
  useEffect(() => {
    if (greet) viewRef.current?.greet()
  }, [greet])
  // A celebration plays once per bump, from the prop or from presence (a companion was just added).
  // DS-79: a figure mounting a moment after the cheer (the new tab re-mounts it for the new companion) still plays it.
  const cheers = useRef({ prop: celebrate, presence: cheerIsFresh(own.cheerAt, Date.now()) ? own.cheer - 1 : own.cheer })
  /** A cheer that came before the live view was there; the view plays it as it starts. */
  const pendingCheer = useRef(false)
  // Stills react with a short CSS hop or wiggle instead.
  const [react, setReact] = useState<'poke' | 'pat' | 'cheer' | null>(null)
  useEffect(() => {
    const seen = cheers.current
    if (celebrate === seen.prop && own.cheer === seen.presence) return
    cheers.current = { prop: celebrate, presence: own.cheer }
    if (viewRef.current) viewRef.current.celebrate()
    else if (wantsLive) pendingCheer.current = true
    else setReact('cheer')
  }, [celebrate, own.cheer])

  // ---- interaction: poke and pat ----
  useEffect(() => {
    if (!react) return
    const timer = setTimeout(() => setReact(null), react === 'cheer' ? 900 : 600)
    return () => clearTimeout(timer)
  }, [react])
  const handleClick = (): void => {
    wakePresence()
    if (viewRef.current) viewRef.current.poke()
    else setReact('poke')
    onClick?.()
  }
  const handleMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') return
    if (!overHead(event, boxRef.current, resolved)) {
      pats.current.reset()
      return
    }
    if (!pats.current.move(event.clientX, event.timeStamp)) return
    wakePresence()
    if (viewRef.current) viewRef.current.pat()
    else setReact('pat')
  }

  const name = profile.name
  const shownStill = !(live && ready)
  // Behind a live figure the still keeps its last mood, so moods during a chat cost no off-screen renders.
  const stillMood = useRef(mood)
  if (shownStill) stillMood.current = mood
  const style: CSSProperties = typeof size === 'number' ? { width: size, height: size } : {}
  return (
    <div
      ref={outerRef}
      className={[
        'companion',
        `companion--${mood}`,
        typeof size === 'number' ? null : 'companion--fill',
        onClick && 'companion--clickable',
        floor && 'companion--floor',
        react && `companion--${react}`,
        !available && 'companion--unavailable',
        className,
      ].filter(Boolean).join(' ')}
      style={{ ...style, ['--companion-glow' as string]: profile.look.colors.accent, ['--companion-skin' as string]: profile.look.colors.skin }}
      onClick={handleClick}
      onPointerMove={handleMove}
      onPointerLeave={() => pats.current.reset()}
      title={title}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      } : undefined}
      aria-label={title ?? (available ? `${name}, ${MOOD_WORDS[mood]}` : t('atWork.companion.unavailable', { name }))}
    >
      <div ref={boxRef} className="companion__box" style={{ width: px, height: px }}>
        {floor && <span className="companion__floor" aria-hidden="true" />}
        {px > 0 && (
          <CompanionStill
            look={profile.look}
            mood={stillMood.current}
            size={px}
            // A live view never crops to the bare face, so its still matches it.
            framing={wantsLive && resolved === 'face' ? 'bust' : resolved}
            alive
            hidden={!shownStill}
          />
        )}
        {live && <div ref={hostRef} className="companion__live" data-ready={ready || undefined} style={{ width: px, height: px }} />}
      </div>
      {mood === 'approval' && (
        <span className="companion__ask" aria-hidden="true">
          <MessageCircleQuestionMark />
        </span>
      )}
      {mood === 'sleeping' && (
        <span className="companion__moon" aria-hidden="true">
          <Moon />
        </span>
      )}
    </div>
  )
}

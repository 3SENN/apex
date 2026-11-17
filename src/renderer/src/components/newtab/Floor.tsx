/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import { CircleQuestionMark, Heart, Moon, Music, Siren, Sparkles, Sun, ZapIcon } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { Bubble, CompanionStill, FaceAvatar, useCompanionPresence, useCompanionWalk } from '../../companion'
import { ShapeField } from '../../companion-card/ShapeField'
import type { AmbientFieldHandle } from '../../ui'
import type { FieldClearing } from '../../ui/logic/ambient'
import { motionReduced, useMotion } from '../../ui/motion'
import {
  bumpToFloor,
  createFloor,
  drainEvents,
  dragActor,
  floorGround,
  floorOf,
  glanceAll,
  grabActor,
  groundPoint,
  keepOutOf,
  keepOutRect,
  pokeActor,
  pondLayout,
  removeActor,
  restagger,
  screenOf,
  setKeepOut,
  stepFloor,
  syncActors,
  throwActor,
  type FloorActor,
  type FloorBubble,
  type FloorGround,
  type FloorLayout,
  type FloorTopic,
  type FloorWorld,
  type ReactionGlyph,
} from './floorSim'
import { useT } from '../../i18n/useT'

// The Lounge (DS-75, DS-76): every companion not on the ask field stands on
// a pond seen at an angle as a breathing still. The pond's ground is the
// companion surfaces' field of glyphs (ShapeField, density floor) in the
// colour of the companion on the ask field: swells roll out from that
// figure's feet, landings and newcomers send a ripple, and it fades out to
// nothing at its edge, so there is no disc. The simulation is floorSim.ts;
// this draws it, writing positions straight to the DOM each frame so React
// only re-renders when a bubble changes.

/** Floor companions at the front, in CSS px; the back row is smaller. */
const ACTOR_PX = 96
/** Where the feet are in a full-body still, from the top. */
const FEET = 0.94
const DRAG_START_PX = 5
/** Only landings this hard ripple the ground (footsteps are 0.25). */
const RIPPLE_STRENGTH = 0.35

const GLYPHS: Record<ReactionGlyph, ReactNode> = {
  heart: <Heart />,
  sparkle: <Sparkles />,
  question: <CircleQuestionMark />,
  alarm: <Siren />,
  music: <Music />,
  sun: <Sun />,
  bolt: <ZapIcon />,
  moon: <Moon />,
}

export interface FloorHandle {
  /** Where a floor companion is on screen (for the flight to the ask field), or null. */
  rectOf(id: string): DOMRect | null
  /** The companion that was on the ask field lands back on the floor near `from` (viewport px). */
  bump(id: string, from: { x: number; y: number }, direction: -1 | 1): void
  /** Everyone glances at a viewport point. */
  glance(at: { x: number; y: number }): void
  /** Takes a companion off the floor. */
  take(id: string): void
}

export interface FloorProps {
  /** The companions on the floor (visible ones, not the one on the ask field). */
  companions: readonly Companion[]
  shown: boolean
  /** The stage the floor fills; its size drives the layout. */
  stageRef: RefObject<HTMLElement | null>
  /** Elements the companions keep out of: the ask field and the perch above it. The ground dims behind all but the figure. */
  avoid: ReadonlyArray<RefObject<HTMLElement | null>>
  /** The figure above the ask field: the ground's swells roll out from its feet. */
  figureRef?: RefObject<HTMLElement | null>
  /** The colour of the companion on the ask field, which the ground is washed in. */
  tint: string
  /** Change it to send a swell out from the figure's feet (a companion arrived on the ask field). */
  pulse?: string | number
  /** Dropping a companion here chooses it. */
  dropRef: RefObject<HTMLElement | null>
  favicons: readonly string[]
  youInitial: string | null
  /** A click (after its hop) or a drop on the ask field. */
  onChoose(id: string): void
  /** While a companion is dragged: its colour and whether it is over the field. */
  onDrag(state: { id: string; tint: string; over: boolean } | null): void
}

interface Ground extends FloorGround {
  /** The reading UI over it, in the ground's own pixels. */
  clear: FieldClearing[]
}

const NO_GROUND: Ground = { left: 0, top: 0, width: 0, height: 0, origin: { x: 0.5, y: 0.5 }, clear: [] }

function floorLayout(stage: HTMLElement, avoid: ReadonlyArray<RefObject<HTMLElement | null>>, figure: HTMLElement | null): { layout: FloorLayout; keep: DOMRect | null; ground: Ground } {
  const box = stage.getBoundingClientRect()
  const rects = avoid.map((r) => r.current?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.width > 0)
  // DS-75: the pond centres on the ask card itself, not the whole form (whose tray and ideas hang below it).
  const first = avoid[0]?.current
  const card = first?.querySelector<HTMLElement>('[data-pond-anchor]')?.getBoundingClientRect() ?? rects[0]
  const field = card && card.width > 0 ? { left: card.left - box.left, top: card.top - box.top, right: card.right - box.left, bottom: card.bottom - box.top } : null
  const layout = pondLayout(box, field)
  const local = rects.map((r) => ({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top }))
  // A figure is drawn up from its feet at most this tall (the front of the floor is scale 1).
  const keep = keepOutRect(local, ACTOR_PX * FEET)
  // The ground: swells from the figure's feet; dimmed behind the composer and the ideas, not behind the figure.
  const body = figure?.getBoundingClientRect()
  const feet = body && body.width > 0 ? { x: body.left + body.width / 2 - box.left, y: body.top + body.height * FEET - box.top } : null
  const ground = floorGround(layout, feet)
  const clear = avoid
    .filter((r) => r.current && r.current !== figure)
    .map((r) => (r.current as HTMLElement).getBoundingClientRect())
    .filter((r) => r.width > 0)
    .map((r) => ({ left: r.left - box.left - ground.left, top: r.top - box.top - ground.top, right: r.right - box.left - ground.left, bottom: r.bottom - box.top - ground.top }))
  return { layout, keep: keep ? new DOMRect(keep.left, keep.top, keep.right - keep.left, keep.bottom - keep.top) : null, ground: { ...ground, clear } }
}

/** The same ground (to the pixel), so a re-measure that changed nothing doesn't redraw it. */
function sameGround(a: Ground, b: Ground): boolean {
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 0.5
  const box = (p: FieldClearing, q: FieldClearing): boolean => near(p.left, q.left) && near(p.top, q.top) && near(p.right, q.right) && near(p.bottom, q.bottom)
  return (
    near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height) &&
    Math.abs(a.origin.x - b.origin.x) < 0.001 && Math.abs(a.origin.y - b.origin.y) < 0.001 &&
    a.clear.length === b.clear.length && a.clear.every((c, i) => box(c, b.clear[i] as FieldClearing))
  )
}

export const Floor = forwardRef<FloorHandle, FloorProps>(function Floor({ companions, shown, stageRef, avoid, figureRef, tint, pulse, dropRef, favicons, youInitial, onChoose, onDrag }, handle) {
  const { reduced } = useMotion()
  const ids = companions.map((c) => c.id)
  const idsKey = ids.join(',')
  const world = useRef<FloorWorld | null>(null)
  world.current ??= createFloor(ids, { seed: 11, reduced, topics: { favicons: favicons.length, you: !!youInitial } })
  const layout = useRef<FloorLayout>({ cx: 0, cy: 0, rx: 1, ry: 1 })
  const elements = useRef(new Map<string, HTMLElement>())
  const [bubbles, setBubbles] = useState<Record<string, FloorBubble>>({})
  const [ground, setGround] = useState<Ground>(NO_GROUND)
  const groundBox = useRef<Ground>(NO_GROUND)
  const field = useRef<AmbientFieldHandle>(null)
  // Who has popped in already: anyone else who pops in walked in (a visitor), and ripples the ground.
  const arrived = useRef(new Set(ids))
  const latest = useRef({ onChoose, onDrag })
  latest.current = { onChoose, onDrag }

  // The floor reveals from its centre on the first frame and whenever it is turned back on.
  const [revealed, setRevealed] = useState(false)
  const wasShown = useRef(shown)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    if (shown && !wasShown.current && world.current) restagger(world.current)
    wasShown.current = shown
  }, [shown])

  // Keep the cast in step with the companions.
  useEffect(() => {
    if (world.current) syncActors(world.current, ids)
  }, [idsKey])
  useEffect(() => {
    if (world.current) world.current.reduced = reduced
  }, [reduced])
  useEffect(() => {
    if (world.current) world.current.topics = { favicons: favicons.length, you: !!youInitial }
  }, [favicons.length, youInitial])

  // Layout: the stage's size and the field's place.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => {
      const { layout: next, keep, ground: nextGround } = floorLayout(stage, avoid, figureRef?.current ?? null)
      layout.current = next
      if (!sameGround(groundBox.current, nextGround)) {
        groundBox.current = nextGround
        setGround(nextGround)
      }
      if (world.current) setKeepOut(world.current, keep ? keepOutOf({ left: keep.left, top: keep.top, right: keep.right, bottom: keep.bottom }, next) : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    for (const ref of avoid) if (ref.current) observer.observe(ref.current)
    if (figureRef?.current) observer.observe(figureRef.current)
    return () => observer.disconnect()
  }, [stageRef, avoid, figureRef])

  // A companion arriving on the ask field sends a swell out from the figure's feet.
  const lastPulse = useRef(pulse)
  useEffect(() => {
    if (lastPulse.current === pulse) return
    lastPulse.current = pulse
    if (shown) field.current?.ripple()
  }, [pulse, shown])

  // The loop: step the sim, place every companion, raise bubbles and ripples.
  useEffect(() => {
    if (!shown) return
    let frame = 0
    let last = performance.now()
    let bubbleKey = ''
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      const w = world.current
      if (!w || document.hidden) {
        last = now
        return
      }
      stepFloor(w, (now - last) / 1000)
      last = now
      for (const actor of w.actors) place(actor, w)
      const key = w.actors.map((a) => (a.bubble ? `${a.id}:${a.bubble.at}` : '')).join('|')
      if (key !== bubbleKey) {
        bubbleKey = key
        setBubbles(Object.fromEntries(w.actors.filter((a) => a.bubble).map((a) => [a.id, a.bubble as FloorBubble])))
      }
      // Landings ripple the ground from where they land (AmbientField skips ripples under Reduce Motion).
      for (const e of drainEvents(w)) if (e.type === 'ripple' && e.strength >= RIPPLE_STRENGTH) rippleAt(e.x, e.d)
    }
    const rippleAt = (x: number, d: number): void => {
      const foot = screenOf({ x, d, z: 0 }, layout.current)
      field.current?.ripple(groundPoint(groundBox.current, foot.left, foot.top))
    }
    const place = (actor: FloorActor, w: FloorWorld): void => {
      const el = elements.current.get(actor.id)
      if (!el) return
      const foot = screenOf({ x: actor.x, d: actor.d, z: 0 }, layout.current)
      const lift = actor.z * layout.current.rx * 0.9
      const squash = actor.squash
      el.style.transform = `translate3d(${foot.left - ACTOR_PX / 2}px, ${foot.top - ACTOR_PX * FEET}px, 0) scale(${foot.scale})`
      el.style.zIndex = String(foot.order + (actor.mode === 'held' ? 2000 : 0))
      const entered = w.time >= actor.enteredAt ? 'true' : 'false'
      if (el.dataset.in !== entered) el.dataset.in = entered
      if (entered === 'true' && !arrived.current.has(actor.id)) {
        arrived.current.add(actor.id)
        rippleAt(actor.x, actor.d)
      }
      if (el.dataset.mode !== actor.mode) el.dataset.mode = actor.mode
      // A stroll steps slower than a walk; the strip's cycle follows the actor's speed.
      if (actor.mode === 'walk') {
        const cycle = walkCycle(actor.speed)
        if (el.dataset.cycle !== cycle) {
          el.dataset.cycle = cycle
          el.style.setProperty('--walk-cycle', cycle)
        }
      }
      const body = el.firstElementChild?.nextElementSibling as HTMLElement | null
      if (body) body.style.transform = `translateY(${-lift / foot.scale}px) rotate(${actor.spin}rad) scale(${(1 + squash * 0.18) * actor.facing}, ${1 - squash * 0.2})`
      const shadow = el.firstElementChild as HTMLElement | null
      if (shadow) {
        // The shadow stays on the floor, shrinking and fading as the companion rises.
        const k = Math.max(0.45, 1 - actor.z * 2.2)
        shadow.style.transform = `scale(${k})`
        shadow.style.setProperty('--lift', String(k))
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [shown])

  useImperativeHandle(handle, () => ({
    rectOf(id) {
      const el = elements.current.get(id)
      const body = el?.firstElementChild?.nextElementSibling
      return body ? body.getBoundingClientRect() : null
    },
    bump(id, from, direction) {
      const stage = stageRef.current
      const w = world.current
      if (!stage || !w) return
      const box = stage.getBoundingClientRect()
      const point = floorOf(from.x - box.left, from.y - box.top, layout.current)
      // It lands with a ripple of its own; it didn't walk in.
      arrived.current.add(id)
      bumpToFloor(w, id, point, direction)
    },
    glance(at) {
      const stage = stageRef.current
      const w = world.current
      if (!stage || !w) return
      const box = stage.getBoundingClientRect()
      glanceAll(w, floorOf(at.x - box.left, at.y - box.top, layout.current))
    },
    take(id) {
      if (world.current) removeActor(world.current, id)
    },
  }), [stageRef])

  // ---- dragging ----
  const drag = useRef<{ id: string; pointer: number; startX: number; startY: number; dragging: boolean; samples: Array<{ x: number; y: number; t: number }> } | null>(null)
  const overDrop = (x: number, y: number): boolean => {
    const rect = dropRef.current?.getBoundingClientRect()
    return !!rect && x >= rect.left - 12 && x <= rect.right + 12 && y >= rect.top - 24 && y <= rect.bottom + 12
  }
  const toFloor = (x: number, y: number): { x: number; d: number } => {
    const box = stageRef.current?.getBoundingClientRect()
    return floorOf(x - (box?.left ?? 0), y - (box?.top ?? 0), layout.current)
  }
  const onPointerDown = (companion: Companion) => (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: companion.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }] }
  }
  const onPointerMove = (companion: Companion) => (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = drag.current
    const w = world.current
    if (!state || state.pointer !== event.pointerId || state.id !== companion.id || !w) return
    if (!state.dragging && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_START_PX) return
    if (!state.dragging) {
      state.dragging = true
      grabActor(w, companion.id)
    }
    state.samples = [...state.samples.filter((s) => event.timeStamp - s.t < 120), { x: event.clientX, y: event.clientY, t: event.timeStamp }]
    // The pointer holds it by the middle: its feet hang just below, its shadow farther down on the floor.
    const lift = (ACTOR_PX * 0.33) / Math.max(1, layout.current.rx * 0.9)
    const point = toFloor(event.clientX, event.clientY + ACTOR_PX * 0.78)
    dragActor(w, companion.id, point.x, point.d, lift)
    latest.current.onDrag({ id: companion.id, tint: companion.look.colors.accent, over: overDrop(event.clientX, event.clientY) })
  }
  const finish = (companion: Companion, event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const state = drag.current
    const w = world.current
    drag.current = null
    if (!state || state.id !== companion.id || !w) return
    if (!state.dragging) {
      if (cancelled) return
      // A click: a hop and a bubble, then it heads for the ask field.
      pokeActor(w, companion.id)
      setTimeout(() => latest.current.onChoose(companion.id), motionReduced() ? 0 : 320)
      return
    }
    latest.current.onDrag(null)
    if (!cancelled && overDrop(event.clientX, event.clientY)) {
      latest.current.onChoose(companion.id)
      return
    }
    const first = state.samples[0]
    const lastSample = state.samples[state.samples.length - 1]
    const seconds = first && lastSample ? Math.max(0.016, (lastSample.t - first.t) / 1000) : 1
    const vx = first && lastSample ? (lastSample.x - first.x) / seconds / layout.current.rx : 0
    const vd = first && lastSample ? (lastSample.y - first.y) / seconds / layout.current.ry : 0
    throwActor(w, companion.id, cancelled ? 0 : vx, cancelled ? 0 : vd * 0.5)
  }

  const youTopic = youInitial ? <span className="nt-topic-you">{youInitial}</span> : null
  const topicIcon = (topic: FloorTopic): ReactNode => {
    switch (topic.type) {
      case 'favicon':
        return favicons[topic.index] ? <img src={favicons[topic.index]} alt="" /> : GLYPHS.sparkle
      case 'companion': {
        const other = companions.find((c) => c.id === topic.id)
        return other ? <FaceAvatar look={other.look} name={other.name} size={16} label="" /> : GLYPHS.heart
      }
      case 'you':
        return youTopic ?? GLYPHS.heart
      case 'glyph':
        return GLYPHS[topic.glyph]
    }
  }

  return (
    // Hidden, it keeps its companions for the staggered exit but takes no focus or clicks.
    <div className="nt-floor" data-state={shown && revealed ? 'in' : 'out'} aria-hidden={shown ? undefined : true} inert={!shown}>
      {ground.width > 0 && (
        <div className="nt-floor__ground" style={{ left: ground.left, top: ground.top, width: ground.width, height: ground.height }} aria-hidden="true">
          <ShapeField ref={field} tint={tint} density="floor" origin={ground.origin} clear={ground.clear} paused={!shown} />
        </div>
      )}
      {companions.map((companion, i) => (
        <FloorCompanion
          key={companion.id}
          ref={(el) => {
            if (el) elements.current.set(companion.id, el)
            else elements.current.delete(companion.id)
          }}
          companion={companion}
          order={i}
          napping={world.current?.actors.find((a) => a.id === companion.id)?.mode === 'nap'}
          bubble={bubbles[companion.id] ?? null}
          bubbleIcon={bubbles[companion.id] ? topicIcon((bubbles[companion.id] as FloorBubble).topic) : null}
          side={((world.current?.actors.find((a) => a.id === companion.id)?.x ?? 0) > 0 ? 'right' : 'left')}
          onPointerDown={onPointerDown(companion)}
          onPointerMove={onPointerMove(companion)}
          onPointerUp={(e) => finish(companion, e, false)}
          onPointerCancel={(e) => finish(companion, e, true)}
          onKeyChoose={() => latest.current.onChoose(companion.id)}
        />
      ))}
    </div>
  )
})

interface FloorCompanionProps {
  companion: Companion
  order: number
  napping: boolean
  bubble: FloorBubble | null
  bubbleIcon: ReactNode
  side: 'left' | 'right'
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLButtonElement>): void
  onKeyChoose(): void
}

/** Seconds per walk cycle at a floor speed: 0.62 s at a walk, slower on a stroll. */
function walkCycle(speed: number): string {
  return `${(Math.min(1.4, Math.max(0.45, (0.16 * 0.62) / Math.max(0.01, speed)))).toFixed(2)}s`
}

/** One companion on the floor: its contact shadow, a breathing still (a walk strip while it walks), a name tag and its bubble. */
const FloorCompanion = forwardRef<HTMLButtonElement, FloorCompanionProps>(function FloorCompanion({ companion, order, napping, bubble, bubbleIcon, side, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyChoose }, ref): ReactElement {
  // A companion busy in a chat looks busy on the floor too.
  const t = useT()
  const { mood: presence } = useCompanionPresence(companion.id)
  const mood = napping ? 'sleeping' : presence === 'sleeping' ? 'sleeping' : presence === 'idle' ? 'idle' : presence
  // Nobody walks under Reduce Motion (floorSim), so the strip isn't drawn then.
  const { reduced } = useMotion()
  const walk = useCompanionWalk(companion.look, ACTOR_PX, !reduced)
  return (
    <button
      ref={ref}
      type="button"
      className="nt-actor"
      data-active={bubble ? 'true' : undefined}
      style={{ ['--actor-tint' as string]: companion.look.colors.accent, ['--actor-order' as string]: order } as CSSProperties}
      aria-label={t('tabs.newTabFloor.chooseForYourNext', { name: companion.name })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onKeyChoose()
        }
      }}
    >
      <span className="nt-actor__shadow" aria-hidden="true" />
      <span className="nt-actor__body">
        <span className="nt-actor__pop" data-walk={walk ? '' : undefined}>
          <CompanionStill look={companion.look} mood={mood} size={ACTOR_PX} alive />
          {walk && (
            <span className="nt-actor__walk" aria-hidden="true">
              <img src={walk} alt="" draggable={false} />
            </span>
          )}
        </span>
      </span>
      <span className="nt-actor__name" aria-hidden="true">{companion.name}</span>
      {bubble && (
        <span className={`nt-actor__bubble nt-actor__bubble--${side}`}>
          <Bubble icons={[bubbleIcon]} side={side} tint={companion.look.colors.accent} revealKey={bubble.at} />
        </span>
      )}
    </button>
  )
})

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The agent at work (OV-21, OV-22, DS-26): the per-tab
// control state, its transitions, the plain words the notice shows and the
// rules for human-verification pages. Pure, so main's agentControl.ts, the
// overlay surfaces and the tests share one copy.
import type { AgentEvent, ToolKind } from './ipc'
import type { AgentControlState } from './services/chat'

/**
 * Where the notice was dragged to on its tab, in the tab's CSS px: the
 * notice's horizontal centre and its top edge (less the 12 px gap). The
 * overlay host keeps it inside the window when the tab shrinks.
 */
export interface NoticePosition {
  x: number
  y: number
}

/** The notice's gap below its anchor (the default spot is 12 px under the tab's top edge). */
export const NOTICE_GAP = 12
/** Arrow keys move the notice by this much (Shift moves further). */
export const NOTICE_STEP = 16
const POSITION_MAX = 20_000

export interface AgentControlView {
  tabId: string
  chatId: string
  companionId: string
  state: AgentControlState
  /** What the agent is doing, in plain words (null before its first step). */
  activity: string | null
  /** The notice's remembered spot on this tab; null for the default (top centre). */
  position: NoticePosition | null
  /** Set for a moment after a challenge was solved, for the brief confirmation. */
  solvedAt: number | null
  /** The shield was clicked: the notice offers take over prominently. Bumps on each click. */
  nudge: number
}

export type ControlAction =
  | { type: 'claim'; tabId: string; chatId: string; companionId: string }
  | { type: 'release'; tabId: string }
  | { type: 'take-over'; tabId: string }
  | { type: 'hand-back'; tabId: string }
  | { type: 'pause'; chatId: string }
  | { type: 'resume'; chatId: string }
  | { type: 'challenge'; tabId: string }
  | { type: 'challenge-done'; tabId: string; at: number }
  | { type: 'activity'; chatId: string; activity: string | null; started: boolean }
  | { type: 'settle'; tabId: string }
  | { type: 'move'; tabId: string; position: NoticePosition | null }
  | { type: 'nudge'; tabId: string }

export type ControlMap = ReadonlyMap<string, AgentControlView>

/** How long "Solved, carrying on" stays before the notice goes back to the activity. */
export const SOLVED_CONFIRM_MS = 2200
/** Resuming settles into driving after this even if the agent takes its time to act. */
export const RESUME_SETTLE_MS = 1500

function update(map: ControlMap, tabId: string, patch: (v: AgentControlView) => AgentControlView | null): ControlMap {
  const current = map.get(tabId)
  if (!current) return map
  const next = patch(current)
  if (next === current) return map
  const out = new Map(map)
  if (next) out.set(tabId, next)
  else out.delete(tabId)
  return out
}

function forChat(map: ControlMap, chatId: string, patch: (v: AgentControlView) => AgentControlView): ControlMap {
  let out: Map<string, AgentControlView> | null = null
  for (const [tabId, view] of map) {
    if (view.chatId !== chatId) continue
    const next = patch(view)
    if (next === view) continue
    out ??= new Map(map)
    out.set(tabId, next)
  }
  return out ?? map
}

const is = (view: AgentControlView, ...states: AgentControlState[]): boolean => states.includes(view.state)

/**
 * One step of the control state. Taking over a tab pauses the whole chat, so
 * its other tabs show paused; handing back resumes them all.
 */
export function reduceControl(map: ControlMap, action: ControlAction): ControlMap {
  switch (action.type) {
    case 'claim': {
      const current = map.get(action.tabId)
      if (current && current.chatId === action.chatId) return map
      const out = new Map(map)
      out.set(action.tabId, {
        tabId: action.tabId,
        chatId: action.chatId,
        companionId: action.companionId,
        state: 'driving',
        activity: null,
        // A new chat on the same tab keeps where you put the notice.
        position: current?.position ?? null,
        solvedAt: null,
        nudge: 0,
      })
      return out
    }
    case 'release':
      return update(map, action.tabId, () => null)
    case 'take-over': {
      const target = map.get(action.tabId)
      if (!target || is(target, 'taken-over')) return map
      const paused = forChat(map, target.chatId, (v) => (v.tabId !== action.tabId && is(v, 'driving', 'resuming') ? { ...v, state: 'paused' } : v))
      return update(paused, action.tabId, (v) => ({ ...v, state: 'taken-over', solvedAt: null }))
    }
    case 'hand-back': {
      const target = map.get(action.tabId)
      if (!target || !is(target, 'taken-over', 'paused')) return map
      return forChat(map, target.chatId, (v) => (is(v, 'taken-over', 'paused') ? { ...v, state: 'resuming' } : v))
    }
    case 'pause':
      return forChat(map, action.chatId, (v) => (is(v, 'driving', 'resuming') ? { ...v, state: 'paused' } : v))
    case 'resume':
      // A person still holding a tab keeps it; only paused tabs carry on.
      return forChat(map, action.chatId, (v) => (is(v, 'paused') ? { ...v, state: 'resuming' } : v))
    case 'challenge':
      return update(map, action.tabId, (v) => (is(v, 'driving', 'resuming') ? { ...v, state: 'challenge', solvedAt: null } : v))
    case 'challenge-done':
      return update(map, action.tabId, (v) => (is(v, 'challenge') ? { ...v, state: 'resuming', solvedAt: action.at } : v))
    case 'activity': {
      return forChat(map, action.chatId, (v) => {
        const state = action.started && is(v, 'resuming') ? 'driving' : v.state
        if (state === v.state && v.activity === action.activity) return v
        return { ...v, state, activity: action.activity ?? v.activity }
      })
    }
    case 'settle':
      return update(map, action.tabId, (v) => (is(v, 'resuming') ? { ...v, state: 'driving', solvedAt: null } : v.solvedAt !== null ? { ...v, solvedAt: null } : v))
    case 'move':
      return update(map, action.tabId, (v) => ({ ...v, position: action.position ? clampPosition(action.position) : null }))
    case 'nudge':
      return update(map, action.tabId, (v) => (is(v, 'driving', 'resuming') ? { ...v, nudge: v.nudge + 1 } : v))
  }
}

/** The shield blocks the page only while the agent is in control (OV-22). */
export function shieldShown(state: AgentControlState): boolean {
  return state === 'driving' || state === 'resuming'
}

/** The notice shows for every state but idle. */
export function noticeShown(state: AgentControlState): boolean {
  return state !== 'idle'
}

export function clampPosition(p: NoticePosition): NoticePosition {
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.round(Math.min(POSITION_MAX, Math.max(0, n))) : 0)
  return { x: clamp(p.x), y: clamp(p.y) }
}

/** The notice's anchor on its tab: the whole tab (default, top centre) or the dragged-to point. */
export function noticeAnchorRect(position: NoticePosition | null): { x: number; y: number; width: number; height: number } | null {
  return position ? { x: position.x, y: position.y, width: 0, height: 0 } : null
}

/**
 * A drag or arrow-key move: from where the notice is now (its frame in tab
 * px) by a delta, kept inside the tab.
 */
export function movedPosition(frame: { x: number; y: number; width: number; height: number }, delta: { x: number; y: number }, tab: { width: number; height: number }): NoticePosition {
  const left = Math.min(Math.max(0, frame.x + delta.x), Math.max(0, tab.width - frame.width))
  const top = Math.min(Math.max(0, frame.y + delta.y), Math.max(0, tab.height - frame.height))
  return clampPosition({ x: left + frame.width / 2, y: top - NOTICE_GAP })
}

// ---- plain words ----

/** The i18n key for what a tool kind is doing (CH-20 shares these words). */
export function activityKey(kind: ToolKind | undefined): 'atWork.activity.reading' | 'atWork.activity.looking' | 'atWork.activity.clicking' | 'atWork.activity.typing' | 'atWork.activity.opening' | 'atWork.activity.tabs' | 'atWork.activity.searching' | 'atWork.activity.fetching' | 'atWork.activity.memory' | 'atWork.activity.connector' | 'atWork.activity.working' {
  switch (kind) {
    case 'read-page':
    case 'find':
      return 'atWork.activity.reading'
    case 'screenshot':
      return 'atWork.activity.looking'
    case 'click':
      return 'atWork.activity.clicking'
    case 'type':
      return 'atWork.activity.typing'
    case 'navigate':
      return 'atWork.activity.opening'
    case 'tabs':
      return 'atWork.activity.tabs'
    case 'web-search':
      return 'atWork.activity.searching'
    case 'web-fetch':
      return 'atWork.activity.fetching'
    case 'memory':
      return 'atWork.activity.memory'
    case 'connector':
      return 'atWork.activity.connector'
    default:
      return 'atWork.activity.working'
  }
}

/** Which of the companion's generated props it holds for a step, if any. */
export type ActivityProp = 'reading' | 'searching' | 'typing'

export function activityProp(kind: ToolKind | undefined): ActivityProp | null {
  switch (kind) {
    case 'read-page':
    case 'find':
    case 'web-fetch':
    case 'screenshot':
      return 'reading'
    case 'web-search':
      return 'searching'
    case 'type':
      return 'typing'
    default:
      return null
  }
}

/** What the companion holds now: a prop, kept a moment after its step so quick steps don't flicker. */
export interface HeldProp {
  prop: ActivityProp | null
  /** The prop goes away at this time; Infinity while its step is still running. */
  until: number
}

export const NO_PROP: HeldProp = { prop: null, until: 0 }
/** How long a prop stays after its step ends, or while a step without one runs. */
export const PROP_HOLD_MS = 1600

/** One chat event's effect on the held prop. */
export function heldPropAfter(current: HeldProp, event: AgentEvent, now: number): HeldProp {
  switch (event.type) {
    case 'tool': {
      if (event.state !== 'running') return current.prop && current.until === Infinity ? { prop: current.prop, until: now + PROP_HOLD_MS } : current
      const prop = activityProp(event.kind ?? kindFromLabel(event.label))
      if (prop) return { prop, until: Infinity }
      // A click between two reads keeps the book up for a moment.
      return current.prop && heldPropShown(current, now) ? { prop: current.prop, until: Math.min(current.until, now + PROP_HOLD_MS) } : NO_PROP
    }
    case 'status':
      return event.status === 'running' ? current : NO_PROP
    case 'approval':
    case 'connector-approval':
    case 'stopped':
    case 'error':
    case 'step-limit':
    case 'reset':
      return NO_PROP
    default:
      return current
  }
}

export function heldPropShown(held: HeldProp, now: number): ActivityProp | null {
  return held.prop && now < held.until ? held.prop : null
}

/** The tool kind from a browser member name, for emitters that only know the member. */
export function toolKindOf(name: string): ToolKind {
  switch (name) {
    case 'read_page':
    case 'get_page_text':
      return 'read-page'
    case 'find':
      return 'find'
    case 'screenshot':
    case 'zoom':
      return 'screenshot'
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'middle_click':
    case 'left_click_drag':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'mouse_move':
    case 'hover':
    case 'scroll':
    case 'scroll_to':
      return 'click'
    case 'type':
    case 'key':
    case 'hold_key':
    case 'form_input':
      return 'type'
    case 'navigate':
      return 'navigate'
    case 'new_tab':
    case 'switch_tab':
    case 'close_tab':
    case 'list_tabs':
      return 'tabs'
    case 'web_search':
      return 'web-search'
    case 'web_fetch':
      return 'web-fetch'
    case 'memory':
      return 'memory'
    default:
      return 'other'
  }
}

/**
 * A best guess from a tool row's label, for events from before every emitter
 * filled `kind` (it stays optional). Labels come from
 * describeToolCall.
 */
export function kindFromLabel(label: string): ToolKind {
  const l = label.trim().toLowerCase()
  if (l.startsWith('search the web')) return 'web-search'
  if (l.startsWith('read http') || l.startsWith('read www')) return 'web-fetch'
  if (l.startsWith('read') || l.startsWith('find')) return 'read-page'
  if (l.startsWith('take a screenshot') || l.startsWith('zoom')) return 'screenshot'
  if (/^(click|right-click|middle-click|double-click|triple-click|hover|scroll|drag|move the pointer|press the mouse|release the mouse)/.test(l)) return 'click'
  if (/^(type|press|hold|fill)/.test(l)) return 'type'
  if (/^(open a new tab|list tabs|switch to|close)/.test(l)) return 'tabs'
  if (/^(open |go back|go forward|reload)/.test(l)) return 'navigate'
  if (l.includes('memory')) return 'memory'
  return 'other'
}

// ---- human verification (the challenge flow) ----

// Frames and pages that only ever host a human check. Hosts are matched on
// their registrable end, paths on their start, so look-alikes don't count.
const CHALLENGE_FRAMES: ReadonlyArray<{ host: string; path?: string }> = [
  { host: 'google.com', path: '/recaptcha/' },
  { host: 'recaptcha.net', path: '/recaptcha/' },
  { host: 'hcaptcha.com' },
  { host: 'challenges.cloudflare.com' },
  { host: 'arkoselabs.com' },
  { host: 'funcaptcha.com' },
  { host: 'geo.captcha-delivery.com' },
]
const CHALLENGE_PATHS = ['/cdn-cgi/challenge-platform/', '/sorry/index']
const CHALLENGE_TITLES = [/^just a moment\.{0,3}$/i, /^attention required!?/i, /\bare you a robot\b/i, /^verify you are human/i, /^human verification/i, /^security check/i]

function hostMatches(host: string, want: string): boolean {
  return host === want || host.endsWith(`.${want}`)
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Whether a frame URL is a human-verification widget. */
export function isChallengeFrame(url: string): boolean {
  const u = parse(url)
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false
  const host = u.hostname.toLowerCase()
  // Score-only widgets sit invisibly on ordinary pages; they ask nobody anything.
  if (u.searchParams.get('size') === 'invisible') return false
  return CHALLENGE_FRAMES.some((f) => hostMatches(host, f.host) && (!f.path || u.pathname.startsWith(f.path)))
}

/**
 * Whether the page asks a person to prove they are human: an interstitial by
 * its path or title, or a page whose frames include a visible check widget.
 */
export function isChallengePage(page: { url: string; title: string; frames: readonly string[] }): boolean {
  const u = parse(page.url)
  if (u && CHALLENGE_PATHS.some((p) => u.pathname.startsWith(p))) return true
  const title = page.title.trim()
  if (title && CHALLENGE_TITLES.some((re) => re.test(title))) return true
  return page.frames.some(isChallengeFrame)
}

// ---- the status pill ----

export interface PillChat {
  id: string
  companionId: string
  status: 'idle' | 'running' | 'needs-approval' | 'error' | 'finished'
  title: string
}

export interface PillState {
  chatId: string
  companionId: string
  mode: 'working' | 'approval'
  /** Other chats in the same state, for "and 2 more". */
  others: number
}

/**
 * What the pill shows while the panel is closed: a chat that needs you comes
 * first (most recent), then one that works. Null hides the pill. The panel's
 * own chat counts too, since the panel is closed.
 */
export function pillState(chats: readonly PillChat[], panelOpen: boolean): PillState | null {
  if (panelOpen) return null
  const asking = chats.filter((c) => c.status === 'needs-approval')
  const working = chats.filter((c) => c.status === 'running')
  const pick = asking[0] ?? working[0]
  if (!pick) return null
  const mode = pick.status === 'needs-approval' ? 'approval' : 'working'
  return { chatId: pick.id, companionId: pick.companionId, mode, others: asking.length + working.length - 1 }
}

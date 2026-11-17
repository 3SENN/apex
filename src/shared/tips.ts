/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for tips while a chat works (CH-29's catalogue), while setup
// waits, and on the new tab, plus dismissible nudges. Tips never show over a
// request card.
import { BRAND_NAME } from './branding'
import type { ConversationsService, DockIconService, OnboardingEvent } from './onboarding'
import type { GuidesService } from './guides'
import type { HelpService } from './help'
import type { FirstWeekItem, FirstWeekView } from './firstWeek'

export type TipContext = 'chat-working' | 'setup-wait' | 'new-tab'

export interface Tip {
  id: string
  context: TipContext
  text: string
  /** A feature flag the tip needs on (a key of `features`), if any. */
  needs?: string
  /** An atelier:// address the tip's link opens, if any. */
  link?: { label: string; url: string }
}

/**
 * The catalogue (CH-29). Every tip is about something
 * Atelier ships. A tip about something a chat or a flag can switch off (browser
 * control, memory, web tools, an experiment) names it in `needs` and shows
 * only while it is on.
 */
export const TIPS: readonly Tip[] = [
  // While a chat works.
  { id: 'work-watch', context: 'chat-working', needs: 'browser', text: 'You can keep browsing while your companion works. Its tabs carry a small mark so you can tell them apart.' },
  { id: 'work-stop', context: 'chat-working', text: 'Changed your mind? Press Esc or the stop button to end the run. Nothing already done is undone.' },
  { id: 'work-queue', context: 'chat-working', text: 'Type your next message now. It waits in line and goes out when this run ends.' },
  { id: 'work-split', context: 'chat-working', needs: 'browser', text: 'Put the chat beside a page with split view, so you can watch both at once.' },
  { id: 'work-skill', context: 'chat-working', text: 'Doing this often? Save the chat as a skill and run it again with /name.', link: { label: 'Skills', url: 'atelier://skills' } },
  { id: 'work-routine', context: 'chat-working', text: 'A routine can run a prompt like this on a schedule, while you do something else.', link: { label: 'Routines', url: 'atelier://routines' } },
  { id: 'work-memory', context: 'chat-working', needs: 'memory', text: 'Ask your companion to remember something and it saves a note you can read and edit in Memory.' },
  { id: 'work-connectors', context: 'chat-working', text: 'Connectors let your companion reach your apps. It asks before it uses one.', link: { label: 'Connectors', url: 'atelier://connectors' } },
  { id: 'work-voice', context: 'chat-working', text: 'Hold the mic key to dictate instead of typing.' },
  { id: 'work-export', context: 'chat-working', text: 'Any chat can be exported as text, Markdown, HTML or PDF from its menu.' },
  { id: 'work-meetings', context: 'chat-working', text: `${BRAND_NAME} can take notes in a meeting and turn the transcript into a summary.`, link: { label: 'Meetings', url: 'atelier://meetings' } },
  { id: 'work-workspace', context: 'chat-working', text: 'Files, apps and tables your companion makes are kept together in Workspace.', link: { label: 'Workspace', url: 'atelier://workspace' } },
  // While setup waits.
  { id: 'setup-shortcut', context: 'setup-wait', text: 'Press ⌘J any time to talk to your companion.' },
  { id: 'setup-card', context: 'setup-wait', text: 'Click your companion’s picture to open its card. Change its look and name there whenever you like.' },
  { id: 'setup-peek', context: 'setup-wait', text: 'Right-click a link to peek at it without leaving the page.' },
  { id: 'setup-control', context: 'setup-wait', text: 'Your companion asks before anything that matters, like buying, sending or deleting.' },
  { id: 'setup-many', context: 'setup-wait', text: 'You can add more companions later, each with its own look, skills and memory.' },
  { id: 'setup-guides', context: 'setup-wait', text: `Guides walk you through the main things ${BRAND_NAME} can do, in a few minutes each.` },
  // On the new tab.
  { id: 'tab-ask', context: 'new-tab', text: 'Type a question here to start a chat, or a web address to go straight there.' },
  { id: 'tab-switch', context: 'new-tab', text: 'Use the left and right arrow keys in the empty composer to choose another companion.' },
  { id: 'tab-guides', context: 'new-tab', text: `New to ${BRAND_NAME}? Guides show what it can do.`, link: { label: 'Open Guides', url: 'atelier://guides' } },
  { id: 'tab-routines', context: 'new-tab', text: 'Routines can bring you a morning digest of the sites you read.', link: { label: 'Routines', url: 'atelier://routines' } },
]

/** Tips that fit the context and the features in use, minus dismissed ones. */
export function tipsFor(context: TipContext, features: Record<string, boolean>, dismissed: readonly string[] = []): Tip[] {
  const gone = new Set(dismissed)
  return TIPS.filter((tip) => tip.context === context && !gone.has(tip.id) && (tip.needs === undefined || features[tip.needs] === true))
}

/** The tip to show `elapsedMs` into a wait, rotating every `everyMs` (about ten seconds). */
export function rotatingTip(tips: readonly Tip[], elapsedMs: number, everyMs = 10_000): Tip | null {
  if (tips.length === 0) return null
  const i = Math.floor(Math.max(0, elapsedMs) / everyMs) % tips.length
  return tips[i] ?? null
}

export interface GuidanceState {
  dismissedTips: string[]
  dismissedNudges: string[]
}

export interface GuidanceService {
  state(): GuidanceState
  dismissTip(id: string): void
  dismissNudge(id: string): void
}

/** Every namespace the first-run feature adds. */
export interface FirstRunServices {
  conversations: ConversationsService
  guides: GuidesService
  help: HelpService
  guidance: GuidanceService
  dockIcon: DockIconService
}

/** The first-run feature's AppEvent additions. */
export type FirstRunEvent = OnboardingEvent | { type: 'guidance'; state: GuidanceState }

// One small suggestion at a time under the composer, picked from the
// getting-started checklist's unfinished automatic items. Dismissed nudges
// never return; a snoozed or hidden checklist means no nudges at all.

export interface Nudge {
  /** The checklist item it stands for (also its dismissal id). */
  id: string
  text: string
  action: { label: string; url: string } | { label: string; kind: 'default-browser' | 'companion' }
}

export const NUDGES: readonly Nudge[] = [
  { id: 'import-data', text: 'Bring your bookmarks and history over from your old browser.', action: { label: 'Import', url: 'atelier://settings/import' } },
  { id: 'connect-app', text: 'Let your companion reach one of your apps. It asks before using it.', action: { label: 'Connect an app', url: 'atelier://connectors' } },
  { id: 'set-up-routine', text: 'A routine can do a job for you every morning.', action: { label: 'Set one up', url: 'atelier://routines/new' } },
  { id: 'customise-companion', text: 'Make your companion yours: change its look, name or instructions.', action: { label: 'Open its card', kind: 'companion' } },
  { id: 'default-browser', text: `Open links from other apps in ${BRAND_NAME}.`, action: { label: `Make ${BRAND_NAME} the default`, kind: 'default-browser' } },
  { id: 'try-dictation', text: 'Talk instead of typing: hold the mic key and speak.', action: { label: 'Show me', url: 'atelier://guides/meet-your-companion' } },
]

type NudgeView = Pick<FirstWeekView, 'status' | 'snoozedUntil'> & { items: ReadonlyArray<Pick<FirstWeekItem, 'id' | 'done'>> }

/** The one nudge to show now, or null. */
export function pickNudge(view: NudgeView | null, dismissed: readonly string[], now: number): Nudge | null {
  if (!view || view.status !== 'ready') return null
  if (view.snoozedUntil !== null && view.snoozedUntil > now) return null
  const gone = new Set(dismissed)
  for (const item of view.items) {
    if (item.done || gone.has(item.id)) continue
    const nudge = NUDGES.find((n) => n.id === item.id)
    if (nudge) return nudge
  }
  return null
}

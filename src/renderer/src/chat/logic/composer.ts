/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Effort } from '@shared/ipc'
import type { Owner, Skill } from '@shared/services'
import { SHARED_OWNER } from '@shared/chats'
import { t } from '@shared/i18n/core'

// Pure rules behind the composer: which hint it shows, which skills the /
// menu lists, and the model and effort choices offered before a first message.

export type ComposerState = 'no-key' | 'new' | 'new-panel' | 'follow-up' | 'running' | 'editing-queued' | 'meeting'

export interface ComposerInput {
  hasApiKey: boolean
  /** The chat has no messages yet. */
  empty: boolean
  /** The side panel's empty chat is about the page beside it. */
  surface?: 'page' | 'panel'
  running: boolean
  editingQueued: boolean
  /** A meeting is attached. */
  meeting?: boolean
}

export function composerState(input: ComposerInput): ComposerState {
  if (!input.hasApiKey) return 'no-key'
  if (input.editingQueued) return 'editing-queued'
  if (input.running) return 'running'
  if (input.meeting) return 'meeting'
  if (!input.empty) return 'follow-up'
  return input.surface === 'panel' ? 'new-panel' : 'new'
}

export function composerHint(state: ComposerState, name: string): string {
  switch (state) {
    case 'no-key':
      return t('chat.composer.addYourApiKey', { name })
    case 'editing-queued':
      return t('chat.composer.editingAQueuedMessage')
    case 'running':
      return t('chat.composer.isBusyWhatYou', { name })
    case 'meeting':
      return t('chat.composer.askAboutThisMeeting', { name })
    case 'new':
      return t('chat.composer.whatShouldDoType', { name })
    case 'new-panel':
      return t('chat.composer.askAboutThisPage', { name })
    case 'follow-up':
      return t('chat.composer.replyTo', { name })
  }
}

export interface SkillMatches {
  own: Skill[]
  shared: Skill[]
  /** own then shared, the order arrow keys move through. */
  all: Skill[]
}

const SKILL_LIMIT = 8

/** The / query in the composer, or null when the text isn't a skill prefix. */
export function skillQuery(text: string): string | null {
  return /^\/([a-z0-9-]*)$/.exec(text)?.[1] ?? null
}

/** Skills for the / menu: the companion's own first, then shared ones; other companions' skills never show. */
export function matchSkills(skills: readonly Skill[], query: string, companionId: Owner): SkillMatches {
  const byName = (a: Skill, b: Skill): number => a.name.localeCompare(b.name)
  const hits = skills.filter((s) => s.name.startsWith(query))
  const own = hits.filter((s) => s.owner === companionId).sort(byName)
  // A companion's own skill wins over a shared one with the same name.
  const ownNames = new Set(own.map((s) => s.name))
  const shared = hits.filter((s) => s.owner === SHARED_OWNER && !ownNames.has(s.name)).sort(byName)
  const all = [...own, ...shared].slice(0, SKILL_LIMIT)
  return { own: all.filter((s) => s.owner !== SHARED_OWNER), shared: all.filter((s) => s.owner === SHARED_OWNER), all }
}

/** Must match MODELS in src/main/settings.ts; main validates the id. */
export const CHAT_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
]

export const EFFORTS: ReadonlyArray<{ id: Effort; label: string }> = [
  { id: 'low', get label() { return t('chat.composer.low') } },
  { id: 'medium', get label() { return t('chat.composer.medium') } },
  { id: 'high', get label() { return t('chat.composer.high') } },
  { id: 'xhigh', get label() { return t('chat.composer.extraHigh') } },
  { id: 'max', get label() { return t('chat.composer.max') } },
]

/** Models without an effort setting (the chip menu shows a short note instead of presets). */
const NO_EFFORT_MODELS: ReadonlySet<string> = new Set(['claude-haiku-5-5'])

export function hasEffortControl(model: string): boolean {
  return !NO_EFFORT_MODELS.has(model)
}

export function modelLabel(id: string): string {
  if (!id) return t('chat.composer.unknownModel')
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id
}

export function effortLabel(id: Effort): string {
  return EFFORTS.find((e) => e.id === id)?.label ?? id
}

/** Grows a textarea with its text up to `max` px, then it scrolls. */
export function composerHeight(scrollHeight: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scrollHeight))
}

/**
 * What the round primary button does. The mic sits in its own slot: it takes
 * the main slot while the composer is empty and idle, and moves to the small
 * secondary slot once there is something to send.
 */
export type PrimaryAction = 'voice' | 'send' | 'sending' | 'stop' | 'queue' | 'save' | 'send-transcript' | 'busy'

export interface PrimaryInput {
  hasText: boolean
  /** An API key (or another engine) is ready. */
  canSend: boolean
  running: boolean
  /** A send is on its way to main. */
  sending: boolean
  editingQueued: boolean
  /** The chat itself is still being created (first send from the new tab). */
  creating?: boolean
  /** Voice input. Until it ships ('off'), the empty state shows the voice button disabled, so the slot keeps its geometry (DS-59). */
  voice?: 'off' | 'idle' | 'recording' | 'transcribing'
  /** A send is held until an attached meeting's transcript is ready (MV-14). */
  waiting?: boolean
  /** CH-22: false while a chip is preparing or failed, so Send (and Queue) wait for it. */
  attachmentsReady?: boolean
}

export interface PrimaryState {
  action: PrimaryAction
  disabled: boolean
  /** Where the mic shows. */
  mic: 'main' | 'secondary' | 'hidden'
}

export function primaryButton(input: PrimaryInput): PrimaryState {
  const voice = input.voice ?? 'off'
  if (input.creating || input.waiting || voice === 'transcribing') return { action: 'busy', disabled: true, mic: 'hidden' }
  if (voice === 'recording') return { action: 'send-transcript', disabled: false, mic: 'secondary' }
  if (input.editingQueued) return { action: 'save', disabled: !input.hasText, mic: 'secondary' }
  if (input.sending) return { action: 'sending', disabled: true, mic: 'secondary' }
  const ready = input.attachmentsReady ?? true
  if (input.running) return input.hasText ? { action: 'queue', disabled: !ready, mic: 'secondary' } : { action: 'stop', disabled: false, mic: 'secondary' }
  if (input.hasText) return { action: 'send', disabled: !input.canSend || !ready, mic: 'secondary' }
  return { action: 'voice', disabled: voice !== 'idle' || !input.canSend, mic: 'main' }
}

/** The accessible name (and tooltip) for each primary action. */
export function primaryLabel(action: PrimaryAction, name: string): string {
  switch (action) {
    case 'voice':
      return t('chat.composer.talkTo', { name })
    case 'send':
      return t('chat.composer.send')
    case 'sending':
      return t('chat.composer.sending')
    case 'stop':
      return t('chat.composer.stop', { name })
    case 'queue':
      return t('chat.composer.sendNextAfterThis')
    case 'save':
      return t('chat.composer.saveQueuedMessage')
    case 'send-transcript':
      return t('chat.composer.sendWhatYouSaid')
    case 'busy':
      return t('chat.composer.gettingReady')
  }
}

/** Why the voice button is disabled, for its tooltip; null when it works. */
export function voiceUnavailable(voice: PrimaryInput['voice'], canSend: boolean): string | null {
  if ((voice ?? 'off') === 'off') return t('chat.composer.talkingToYourCompanion')
  return canSend ? null : t('chat.composer.addYourAnthropicKey')
}

/** Does the draft fit on one line? Then a docked request lets the composer shrink to a single row. */
export function fitsOneLine(text: string, maxChars: number): boolean {
  return !text.includes('\n') && text.length <= maxChars
}

/** Adds or removes a suggested next step in the draft, one step per paragraph. */
export function toggleStep(draft: string, step: string): string {
  const parts = draft.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const at = parts.indexOf(step.trim())
  if (at === -1) parts.push(step.trim())
  else parts.splice(at, 1)
  return parts.join('\n\n')
}

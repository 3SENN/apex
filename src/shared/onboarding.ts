/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onboarding contract: the setup flow (ON-01 to ON-17), importing
// conversations from other assistants (CH-31's parsers), the Dock icon
// designer and companion preset extras (CO-17). Setup state lives in userData/setup.json, the
// Dock design in userData/dock-icon.json.
import { BRAND_NAME } from './branding'
import type { Companion } from './companion'
import type { RoutineDraft } from './routines'
import type { SkillDraft } from './skills'
import type { InterviewLine, InterviewTurn, UserProfile, WorkspaceChoice, WorkspacePlan } from './userProfile'

export type SetupStepId =
  | 'intro' | 'name' | 'look' | 'engine' | 'layout' | 'questions' | 'workspace' | 'connectors'
  | 'import-browser' | 'import-ai' | 'showcase' | 'favorites' | 'launch'
/** ON-18: 'workspace' reviews what your profile (the conversation, or the cards) asks for before any of it is set. */
export const SETUP_STEPS = [
  'intro', 'name', 'look', 'engine', 'layout', 'questions', 'workspace', 'connectors',
  'import-browser', 'import-ai', 'showcase', 'favorites', 'launch',
] as const satisfies readonly SetupStepId[]

export interface SetupState {
  version: 1
  step: SetupStepId
  visited: SetupStepId[]
  answers: Record<string, string | string[] | null>
  companionId: string | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  skipped: boolean
  /** A notice to show once (for example, a reset setup file). */
  notice: string | null
}

export type SetupPatch = Partial<Pick<SetupState, 'answers' | 'companionId'>> & { step?: SetupStepId }

/** Methods added to the `onboarding` namespace (the original `complete` is kept). */
export interface OnboardingMethods {
  state(): SetupState
  save(patch: SetupPatch): SetupState
  goTo(step: SetupStepId): SetupState
  skipRest(): void
  restart(options: { newCompanion: boolean }): SetupState
  launch(): Promise<{ ok: boolean; chatId: string | null; error?: string }>
  stepTimeout(step: SetupStepId): void
  // ── ON-18: the setup conversation and your profile (shared/userProfile.ts) ──
  /** The companion's next line; null when no engine can run it (the question cards instead). */
  interviewTurn(lines: InterviewLine[]): Promise<InterviewTurn | null>
  /** Ends the conversation: the profile it adds up to (or the cards' answers' one), saved, with its workspace plan. */
  finishInterview(lines: InterviewLine[] | null): Promise<{ profile: UserProfile; plan: WorkspacePlan }>
  /** Your saved profile, or null. */
  profile(): UserProfile | null
  /** Saves an edited profile (Settings › You); the About me note follows. */
  saveProfile(profile: UserProfile): UserProfile
  clearProfile(): void
  /** The workspace your profile asks for, or null without one. */
  plan(): WorkspacePlan | null
  /** Applies what the review step kept: the sidebar rows and the routines. */
  applyPlan(choice: WorkspaceChoice): { routines: number }
}

// ── Importing conversations ──

export type ConversationSource = 'chatgpt' | 'claude' | 'apex'
export const CONVERSATION_SOURCES = ['chatgpt', 'claude', 'apex'] as const satisfies readonly ConversationSource[]

export interface ConversationPick {
  token: string
  files: string[]
  conversations: number
  sources: ConversationSource[]
}

export interface ImportJob {
  id: string
  state: 'running' | 'done' | 'failed'
  done: number
  total: number
  imported: number
  skipped: number
  error?: string
}

export interface ConversationsService {
  pick(): Promise<ConversationPick | null>
  start(token: string, options: { companionId: string; buildMemory: boolean }): ImportJob
  job(id: string): ImportJob
  /** Continue an imported chat in a new one, with a summary or the transcript as context; returns the new chat id. */
  continueFrom(chatId: string, mode: 'summary' | 'transcript'): Promise<string>
}

// ── The Dock icon designer ──

export interface DockIconDesign {
  companionId: string | null
  background: { kind: 'match' } | { kind: 'swatch'; id: string } | { kind: 'custom'; hex: string }
  /** Clamped to -0.5..0.5. */
  offset: { x: number; y: number }
  /** -180..180 degrees. */
  rotate: number
  /** -60..60 degrees. */
  turn: number
  /** 0.5..1.6. */
  scale: number
  /** -1..1. */
  gaze: { x: number; y: number }
  smile: boolean
}

export const DOCK_DESIGN_LIMITS = {
  offset: 0.5,
  rotate: 180,
  turn: 60,
  scale: { min: 0.5, max: 1.6 },
  gaze: 1,
} as const

export interface DockIconService {
  design(): DockIconDesign
  save(design: DockIconDesign): DockIconDesign
  reset(): DockIconDesign
  apply(pngDataUrl: string): boolean
}

// ── Companion preset extras ──

/** What the preset detail sheet shows before you add a preset. */
export interface PresetDetail {
  presetId: string
  name: string
  tagline: string | null
  summary: string | null
  starterSkills: SkillDraft[]
  starterRoutines: RoutineDraft[]
  version: string | null
}

/** Methods the setup flow adds to the `companions` namespace. */
export interface CompanionsSetupMethods {
  presetDetail(presetId: string): PresetDetail
  /** Fields where your companion differs from its preset's newer version; null when there is no update. */
  presetDiff(companionId: string): PresetDiffRow[] | null
  /** Takes the listed fields from the preset's newer version; `PRESET_UPDATE_ACKNOWLEDGE` alone keeps everything of yours. */
  applyPresetUpdate(companionId: string, fields: string[]): Companion
}

/** One field a preset update changed. `edited`: you changed it yourself since you added the companion (never pre-selected). */
export interface PresetDiffRow {
  field: string
  yours: string
  preset: string
  edited?: boolean
}

/** The field name applyPresetUpdate takes to mark an update reviewed without taking anything from it. */
export const PRESET_UPDATE_ACKNOWLEDGE = 'acknowledge'

/** The preset fields an update can change, in review order. */
export const PRESET_DIFF_FIELDS = ['name', 'colors', 'parts', 'face'] as const
export type PresetDiffField = (typeof PRESET_DIFF_FIELDS)[number]

/** AppEvent additions of the setup flow. */
export type OnboardingEvent =
  | { type: 'onboarding'; state: SetupState }
  | { type: 'import-job'; job: ImportJob }


/** userData/setup.json's version; a newer file is reset with a notice. */
export const SETUP_FILE_VERSION = 1
/** A step that hasn't loaded after this long logs a warning and offers to continue. */
export const STEP_WATCHDOG_MS = 45_000

export function setupStepIndex(step: SetupStepId): number {
  return SETUP_STEPS.indexOf(step)
}

export function nextSetupStep(step: SetupStepId): SetupStepId | null {
  return SETUP_STEPS[setupStepIndex(step) + 1] ?? null
}

export function previousSetupStep(step: SetupStepId): SetupStepId | null {
  const i = setupStepIndex(step)
  return i > 0 ? (SETUP_STEPS[i - 1] ?? null) : null
}

export function freshSetupState(now: number, companionId: string | null = null, notice: string | null = null): SetupState {
  return { version: 1, step: 'intro', visited: ['intro'], answers: {}, companionId, startedAt: now, updatedAt: now, finishedAt: null, skipped: false, notice }
}

/** Answers merge key by key (null clears one); a step change marks the step visited. The one-time notice clears on any change. */
export function applySetupPatch(state: SetupState, patch: SetupPatch, now: number): SetupState {
  const answers = patch.answers ? { ...state.answers, ...patch.answers } : state.answers
  const step = patch.step ?? state.step
  const visited = state.visited.includes(step) ? state.visited : [...state.visited, step]
  return {
    ...state,
    answers,
    companionId: patch.companionId === undefined ? state.companionId : patch.companionId,
    step,
    visited,
    updatedAt: now,
    notice: null,
  }
}

// ── Name suggestions (ON-05): Apex's own short names, never one of its six characters' (TRADEMARKS.md) ──

export const SETUP_NAMES = [
  'Pico', 'Nova', 'Juno', 'Wren', 'Milo', 'Tavi', 'Fern', 'Lumo', 'Bix', 'Skye',
  'Rory', 'Indi', 'Poppy', 'Zuri', 'Taro', 'Quill', 'Moss', 'Kiko', 'Bean', 'Coco',
  'Dash', 'Ember', 'Fig', 'Hazel', 'Iggy', 'Jasper', 'Kai', 'Lark', 'Mabel', 'Nico',
  'Olive', 'Pebble', 'Rumi', 'Sunny', 'Tilly', 'Umi', 'Vesper', 'Yuki', 'Ziggy', 'Biscuit',
] as const

/** A small seeded random source, so a reshuffle is repeatable in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` distinct names for a seed, never one in `exclude` (case-insensitive). */
export function suggestNames(seed: number, count = 4, exclude: readonly string[] = []): string[] {
  const skip = new Set(exclude.map((n) => n.trim().toLowerCase()))
  const pool: string[] = SETUP_NAMES.filter((n) => !skip.has(n.toLowerCase()))
  const random = seededRandom(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = pool[i] as string
    pool[i] = pool[j] as string
    pool[j] = swap
  }
  return pool.slice(0, Math.max(0, count))
}

// ── Setup questions (ON-06): one card at a time ──

export type SetupQuestionKind = 'text' | 'single' | 'multi' | 'confirm' | 'info' | 'tools' | 'connector'

export interface SetupQuestion {
  /** The answer's key in SetupState.answers. */
  id: string
  kind: SetupQuestionKind
  /** What the companion asks, in its bubble. */
  prompt: string
  hint?: string
  options?: ReadonlyArray<{ id: string; label: string }>
  /** Offers an Other choice with its own text. */
  other?: boolean
  placeholder?: string
  /** Text cards can be dictated through the mic. */
  dictation?: boolean
}

/** The prompt each tool chip starts the first chat with. */
export const SETUP_TOOL_PROMPTS: Readonly<Record<string, string>> = {
  'summarize-page': 'Show me how you summarize a page I have open.',
  'compare-options': 'Help me compare a few options side by side.',
  'plan-trip': 'Help me plan a short trip.',
  'research-brief': 'Research a topic for me and write a short brief.',
  'weekly-review': 'Set up a weekly review routine with me.',
}

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  { id: 'welcome-note', kind: 'info', prompt: 'A few quick questions so I can help from day one.', hint: 'Skip any of them. Nothing is looked up about you, and you can edit the answers later in Memory.' },
  { id: 'call-you', kind: 'text', prompt: 'What should I call you?', placeholder: 'Your first name', dictation: true },
  { id: 'time-zone', kind: 'confirm', prompt: 'It looks like you’re in this time zone. Is that right?', hint: 'Routines and reminders use it.' },
  {
    id: 'use-cases',
    kind: 'multi',
    prompt: 'What would you like a hand with?',
    other: true,
    options: [
      { id: 'research', label: 'Research' },
      { id: 'shopping', label: 'Shopping and comparing' },
      { id: 'writing', label: 'Writing and documents' },
      { id: 'meetings', label: 'Meetings and notes' },
      { id: 'routines', label: 'Daily routines' },
      { id: 'travel', label: 'Travel plans' },
      { id: 'coding', label: 'Coding and building' },
      { id: 'data', label: 'Data' },
      { id: 'design', label: 'Design' },
      { id: 'projects', label: 'Projects and teamwork' },
    ],
  },
  {
    id: 'hands-on',
    kind: 'single',
    prompt: 'How hands-on do you want to be?',
    hint: 'I’ll set up your sidebar to match. You can change it any time.',
    options: [
      { id: 'simple', label: 'Keep it simple' },
      { id: 'mixed', label: 'A good mix' },
      { id: 'technical', label: 'I’m technical, keep it out of my way' },
    ],
  },
  {
    id: 'reply-style',
    kind: 'single',
    prompt: 'How do you like your answers?',
    other: true,
    options: [
      { id: 'short', label: 'Short and to the point' },
      { id: 'balanced', label: 'A bit of detail' },
      { id: 'thorough', label: 'Thorough, with reasons' },
    ],
  },
  { id: 'work', kind: 'text', prompt: 'What do you work on, in a few words?', placeholder: 'For example: teaching, design, running a shop', dictation: true },
  { id: 'apps', kind: 'connector', prompt: 'Want me to reach one of your apps?', hint: 'I always ask before I use an app for you.' },
  {
    id: 'first-tool',
    kind: 'tools',
    prompt: 'Pick something to try first.',
    options: [
      { id: 'summarize-page', label: 'Summarize a page' },
      { id: 'compare-options', label: 'Compare options' },
      { id: 'plan-trip', label: 'Plan a trip' },
      { id: 'research-brief', label: 'Research brief' },
      { id: 'weekly-review', label: 'Weekly review' },
    ],
  },
]

export interface QuestionsState {
  index: number
  answers: Record<string, string | string[] | null>
  /** Other's text, per question. */
  other: Record<string, string>
  skipped: string[]
  /** The companion is thinking about the last answer (a short pause, never research). */
  thinking: boolean
}

export type QuestionsAction =
  | { type: 'set'; id: string; value: string | string[] | null }
  | { type: 'toggle'; id: string; option: string }
  | { type: 'other'; id: string; text: string }
  | { type: 'next' }
  | { type: 'skip' }
  | { type: 'back' }
  | { type: 'thinking'; on: boolean }
  | { type: 'jump'; index: number }

export function initialQuestions(answers: Record<string, string | string[] | null> = {}, questions: readonly SetupQuestion[] = SETUP_QUESTIONS): QuestionsState {
  // Resume at the first card without an answer.
  const index = questions.findIndex((q) => answers[q.id] === undefined)
  return { index: index < 0 ? questions.length : Math.max(0, index), answers: { ...answers }, other: {}, skipped: [], thinking: false }
}

/** The card reducer: answers, Other text, skip, back and the thinking pause. */
export function questionsReducer(questions: readonly SetupQuestion[]): (state: QuestionsState, action: QuestionsAction) => QuestionsState {
  const clampIndex = (i: number): number => Math.max(0, Math.min(questions.length, i))
  return (state, action) => {
    switch (action.type) {
      case 'set':
        return { ...state, answers: { ...state.answers, [action.id]: action.value } }
      case 'toggle': {
        const current = state.answers[action.id]
        const list = Array.isArray(current) ? current : []
        const value = list.includes(action.option) ? list.filter((o) => o !== action.option) : [...list, action.option]
        return { ...state, answers: { ...state.answers, [action.id]: value } }
      }
      case 'other':
        return { ...state, other: { ...state.other, [action.id]: action.text } }
      case 'next': {
        const q = questions[state.index]
        if (!q) return state
        let answers = state.answers
        const otherText = state.other[q.id]?.trim()
        const current = answers[q.id]
        if (q.other && otherText) {
          if (q.kind === 'multi') answers = { ...answers, [q.id]: [...(Array.isArray(current) ? current.filter((v) => v !== 'other' && !v.startsWith('other:')) : []), `other:${otherText}`] }
          else if (current === 'other' || current === undefined || current === null) answers = { ...answers, [q.id]: `other:${otherText}` }
        } else if (Array.isArray(current) && current.includes('other')) {
          answers = { ...answers, [q.id]: current.filter((v) => v !== 'other') }
        }
        if (q.kind === 'info' && answers[q.id] === undefined) answers = { ...answers, [q.id]: 'seen' }
        return { ...state, answers, skipped: state.skipped.filter((id) => id !== q.id), index: clampIndex(state.index + 1), thinking: false }
      }
      case 'skip': {
        const q = questions[state.index]
        if (!q) return state
        return { ...state, answers: { ...state.answers, [q.id]: null }, skipped: state.skipped.includes(q.id) ? state.skipped : [...state.skipped, q.id], index: clampIndex(state.index + 1), thinking: false }
      }
      case 'back':
        return { ...state, index: clampIndex(state.index - 1), thinking: false }
      case 'jump':
        return { ...state, index: clampIndex(action.index), thinking: false }
      case 'thinking':
        return { ...state, thinking: action.on }
    }
  }
}

/** Whether the current card has something to continue with (skip is always there). */
export function questionAnswered(q: SetupQuestion, state: QuestionsState): boolean {
  const value = state.answers[q.id]
  if (q.kind === 'info' || q.kind === 'connector') return true
  if (q.other && state.other[q.id]?.trim()) return true
  if (Array.isArray(value)) return value.some((v) => v !== 'other')
  return typeof value === 'string' && value.trim().length > 0 && value !== 'other'
}

/** An answer as words: option labels, Other's text, or the text itself. */
export function answerText(q: SetupQuestion, value: string | string[] | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const one = (v: string): string => (v.startsWith('other:') ? v.slice(6) : (q.options?.find((o) => o.id === v)?.label ?? v))
  const text = Array.isArray(value) ? value.map(one).join(', ') : one(value)
  return text.trim() ? text.trim() : null
}

/** The editable shared memory note setup writes (ON-06): only what you typed or picked. */
export const SETUP_MEMORY_PATH = '/memories/about-me.md'

export function setupMemoryNote(answers: Record<string, string | string[] | null>, questions: readonly SetupQuestion[] = SETUP_QUESTIONS): string | null {
  const labels: Record<string, string> = { 'call-you': 'Name', 'time-zone': 'Time zone', 'use-cases': 'Wants help with', 'reply-style': 'Prefers answers that are', work: 'Works on' }
  const lines: string[] = []
  for (const q of questions) {
    const label = labels[q.id]
    const text = label ? answerText(q, answers[q.id]) : null
    if (label && text) lines.push(`- ${label}: ${text}`)
  }
  if (lines.length === 0) return null
  return ['# About me', '', `From ${BRAND_NAME} setup. Edit or delete anything here; companions read this note.`, '', ...lines, ''].join('\n')
}

/** The first chat's message and context, seeded from the answers (ON-11). */
export function firstChatSeed(answers: Record<string, string | string[] | null>, questions: readonly SetupQuestion[] = SETUP_QUESTIONS): { text: string; context: string | null } {
  const tool = answers['first-tool']
  const toolPrompt = typeof tool === 'string' ? SETUP_TOOL_PROMPTS[tool] : undefined
  const name = answerText(questions.find((q) => q.id === 'call-you') ?? { id: 'call-you', kind: 'text', prompt: '' }, answers['call-you'])
  const text = toolPrompt ?? (name ? `Hi, I’m ${name}. I just finished setting up ${BRAND_NAME}. What can you help me with first?` : `I just finished setting up ${BRAND_NAME}. What can you help me with first?`)
  const facts: string[] = []
  for (const q of questions) {
    if (q.kind === 'info' || q.kind === 'connector') continue
    const value = answerText(q, answers[q.id])
    if (value) facts.push(`${q.prompt} ${value}`)
  }
  const context = facts.length > 0 ? `<setup_answers>\nWhat the person told you during setup. Use it to tailor your first reply; don't repeat it back.\n${facts.map((f) => `- ${f}`).join('\n')}\n</setup_answers>` : null
  return { text, context }
}

// ── Connectors step (ON-08) ──

/** The host a connector's site sits on, without www. */
export function siteHost(site: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return site.toLowerCase()
  }
}

/** Directory entries, those whose site shows up in imported history first (by visits), then the given order. */
export function rankConnectorSuggestions<T extends { id: string; site: string }>(entries: readonly T[], visits: Readonly<Record<string, number>> = {}, limit = 6): T[] {
  const score = (e: T): number => {
    const host = siteHost(e.site)
    let best = 0
    for (const [h, n] of Object.entries(visits)) {
      const visited = h.replace(/^www\./, '').toLowerCase()
      if (visited === host || visited.endsWith(`.${host}`)) best = Math.max(best, n)
    }
    return best
  }
  return entries
    .map((e, i) => ({ e, i, s: score(e) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e)
}


export const DEFAULT_DOCK_DESIGN: DockIconDesign = {
  companionId: null,
  background: { kind: 'match' },
  offset: { x: 0, y: 0 },
  rotate: 0,
  turn: 0,
  scale: 1,
  gaze: { x: 0, y: 0 },
  smile: false,
}

/** Apex's own background swatches. */
export const DOCK_SWATCHES: ReadonlyArray<{ id: string; label: string; hex: string }> = [
  { id: 'dawn', label: 'Dawn', hex: '#f6b58e' },
  { id: 'meadow', label: 'Meadow', hex: '#9fd8a8' },
  { id: 'lagoon', label: 'Lagoon', hex: '#7cc7e8' },
  { id: 'iris', label: 'Iris', hex: '#a99cf2' },
  { id: 'blush', label: 'Blush', hex: '#f4a6c6' },
  { id: 'sand', label: 'Sand', hex: '#efe0bf' },
  { id: 'slate', label: 'Slate', hex: '#4a5468' },
  { id: 'night', label: 'Night', hex: '#1d2233' },
]

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(min, Math.min(max, n))
}
const round = (v: number, places = 3): number => Math.round(v * 10 ** places) / 10 ** places
const HEX6 = /^#[0-9a-f]{6}$/i

/** Any input, clamped into a valid design; unknown swatches and bad colours fall back to matching the companion. */
export function clampDockDesign(input: unknown): DockIconDesign {
  const d = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof DockIconDesign, unknown>>
  const L = DOCK_DESIGN_LIMITS
  const xy = (v: unknown, limit: number): { x: number; y: number } => {
    const o = (v && typeof v === 'object' ? v : {}) as { x?: unknown; y?: unknown }
    return { x: round(clamp(o.x, -limit, limit, 0)), y: round(clamp(o.y, -limit, limit, 0)) }
  }
  const bg = (d.background && typeof d.background === 'object' ? d.background : {}) as { kind?: unknown; id?: unknown; hex?: unknown }
  let background: DockIconDesign['background'] = { kind: 'match' }
  if (bg.kind === 'swatch' && typeof bg.id === 'string' && DOCK_SWATCHES.some((s) => s.id === bg.id)) background = { kind: 'swatch', id: bg.id }
  else if (bg.kind === 'custom' && typeof bg.hex === 'string' && HEX6.test(bg.hex)) background = { kind: 'custom', hex: bg.hex.toLowerCase() }
  return {
    companionId: typeof d.companionId === 'string' && /^[a-z0-9-]{1,64}$/i.test(d.companionId) ? d.companionId : null,
    background,
    offset: xy(d.offset, L.offset),
    rotate: round(clamp(d.rotate, -L.rotate, L.rotate, 0), 1),
    turn: round(clamp(d.turn, -L.turn, L.turn, 0), 1),
    scale: round(clamp(d.scale, L.scale.min, L.scale.max, 1)),
    gaze: xy(d.gaze, L.gaze),
    smile: d.smile === true,
  }
}

/** The background colour a design draws, given the companion's own accent for 'match'. */
export function dockBackgroundHex(design: DockIconDesign, companionAccent: string): string {
  if (design.background.kind === 'custom') return design.background.hex
  if (design.background.kind === 'swatch') {
    const id = design.background.id
    return DOCK_SWATCHES.find((s) => s.id === id)?.hex ?? companionAccent
  }
  return companionAccent
}

export type DockHandle = 'move' | 'rotate' | 'turn' | 'scale' | 'gaze'

/** Resets one handle to its default (double-click). */
export function resetDockHandle(design: DockIconDesign, handle: DockHandle): DockIconDesign {
  const D = DEFAULT_DOCK_DESIGN
  switch (handle) {
    case 'move':
      return { ...design, offset: { ...D.offset } }
    case 'rotate':
      return { ...design, rotate: D.rotate }
    case 'turn':
      return { ...design, turn: D.turn }
    case 'scale':
      return { ...design, scale: D.scale }
    case 'gaze':
      return { ...design, gaze: { ...D.gaze } }
  }
}

/**
 * The designer's keys: arrows move, [ ] rotate, , . turn, - = scale,
 * with ⇧ for bigger steps. Returns null for any other key.
 */
export function dockDesignKey(design: DockIconDesign, key: string, shift: boolean): DockIconDesign | null {
  const big = shift ? 5 : 1
  const move = 0.02 * big
  const next = (patch: Partial<DockIconDesign>): DockIconDesign => clampDockDesign({ ...design, ...patch })
  switch (key) {
    case 'ArrowLeft':
      return next({ offset: { x: design.offset.x - move, y: design.offset.y } })
    case 'ArrowRight':
      return next({ offset: { x: design.offset.x + move, y: design.offset.y } })
    case 'ArrowUp':
      return next({ offset: { x: design.offset.x, y: design.offset.y - move } })
    case 'ArrowDown':
      return next({ offset: { x: design.offset.x, y: design.offset.y + move } })
    case '[':
    case '{':
      return next({ rotate: design.rotate - 3 * big })
    case ']':
    case '}':
      return next({ rotate: design.rotate + 3 * big })
    case ',':
    case '<':
      return next({ turn: design.turn - 3 * big })
    case '.':
    case '>':
      return next({ turn: design.turn + 3 * big })
    case '-':
    case '_':
      return next({ scale: design.scale - 0.02 * big })
    case '=':
    case '+':
      return next({ scale: design.scale + 0.02 * big })
    default:
      return null
  }
}

/** A stable text form, for the debounced save's change check. */
export function serializeDockDesign(design: DockIconDesign): string {
  const d = clampDockDesign(design)
  return JSON.stringify([d.companionId, d.background, d.offset.x, d.offset.y, d.rotate, d.turn, d.scale, d.gaze.x, d.gaze.y, d.smile])
}

/** Saves wait this long after the last change. */
export const DOCK_SAVE_DELAY_MS = 400


export const SHOWCASE_SLIDES = ['tabs', 'meetings', 'documents', 'research', 'routines', 'memory'] as const
export type ShowcaseSlideId = (typeof SHOWCASE_SLIDES)[number]
/** Each slide shows this long before the carousel moves on by itself. */
export const SHOWCASE_SLIDE_MS = 6_000

export interface ShowcaseState {
  index: number
  /** Hover or focus pauses it; reduced motion keeps it paused (static slides). */
  paused: boolean
  /** Time spent on the current slide while playing. */
  elapsed: number
}

export type ShowcaseAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'go'; index: number }
  | { type: 'pause'; on: boolean }
  | { type: 'tick'; ms: number }

export function showcaseReducer(count: number = SHOWCASE_SLIDES.length): (state: ShowcaseState, action: ShowcaseAction) => ShowcaseState {
  const wrap = (i: number): number => ((i % count) + count) % count
  return (state, action) => {
    switch (action.type) {
      case 'next':
        return { ...state, index: wrap(state.index + 1), elapsed: 0 }
      case 'prev':
        return { ...state, index: wrap(state.index - 1), elapsed: 0 }
      case 'go':
        return { ...state, index: wrap(action.index), elapsed: 0 }
      case 'pause':
        return { ...state, paused: action.on }
      case 'tick': {
        if (state.paused) return state
        const elapsed = state.elapsed + Math.max(0, action.ms)
        return elapsed >= SHOWCASE_SLIDE_MS ? { ...state, index: wrap(state.index + 1), elapsed: 0 } : { ...state, elapsed }
      }
    }
  }
}

// ── CO-16 clips: short transparent frame sequences ──

export const SETUP_CLIPS = ['typing', 'wave', 'intro'] as const
export type SetupClipId = (typeof SETUP_CLIPS)[number]

/** One frame: a still the off-screen renderer draws, and how long it holds. */
export interface ClipFrame {
  mood: 'idle' | 'listening' | 'thinking' | 'working' | 'talking' | 'happy'
  blink?: boolean
  holdMs: number
}

/** Apex's own clip timings, built from the still renderer's moods and blink frame. */
export const CLIP_FRAMES: Readonly<Record<SetupClipId, readonly ClipFrame[]>> = {
  typing: [
    { mood: 'working', holdMs: 420 },
    { mood: 'thinking', holdMs: 360 },
    { mood: 'working', blink: true, holdMs: 120 },
    { mood: 'working', holdMs: 520 },
  ],
  wave: [
    { mood: 'happy', holdMs: 260 },
    { mood: 'talking', holdMs: 220 },
    { mood: 'happy', blink: true, holdMs: 120 },
    { mood: 'happy', holdMs: 480 },
  ],
  intro: [
    { mood: 'idle', blink: true, holdMs: 160 },
    { mood: 'idle', holdMs: 300 },
    { mood: 'happy', holdMs: 420 },
    { mood: 'talking', holdMs: 260 },
    { mood: 'happy', holdMs: 700 },
  ],
}

/** The cache key of a clip: the look's key, the clip, its pixel size and framing. */
export function clipCacheKey(lookKey: string, clip: SetupClipId, size: number, framing: 'full' | 'bust' | 'face' = 'full'): string {
  return `clip:${clip}:${Math.round(size)}:${framing}:${lookKey}`
}

export function clipDuration(frames: readonly { holdMs: number }[]): number {
  return frames.reduce((sum, f) => sum + f.holdMs, 0)
}

/** Which frame shows `elapsedMs` into a clip; one-shots hold the last frame, loops wrap. */
export function clipFrameAt(frames: readonly { holdMs: number }[], elapsedMs: number, loop = false): number {
  const total = clipDuration(frames)
  if (frames.length === 0 || total <= 0) return 0
  let t = Math.max(0, elapsedMs)
  if (loop) t %= total
  else if (t >= total) return frames.length - 1
  for (let i = 0; i < frames.length; i++) {
    t -= (frames[i] as { holdMs: number }).holdMs
    if (t < 0) return i
  }
  return frames.length - 1
}

// ── History-based suggestions (ON-08's ranking, the favourites step) ──

/** Visits per host (without www) over history items. */
export function hostVisits(items: ReadonlyArray<{ url: string; visits: number }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) {
    let host: string
    try {
      const url = new URL(item.url)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      host = url.hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    out[host] = (out[host] ?? 0) + Math.max(1, item.visits)
  }
  return out
}

/** The most visited sites, as https origins, for the optional pinned-tabs step. */
export function favoriteSuggestions(items: ReadonlyArray<{ url: string; visits: number }>, limit = 8): Array<{ host: string; url: string; visits: number }> {
  return Object.entries(hostVisits(items))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([host, visits]) => ({ host, url: `https://${host}/`, visits }))
}

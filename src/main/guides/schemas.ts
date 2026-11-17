/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The guides service schemas: the setup flow, importing
// conversations, guides, help, guidance, the Dock icon designer, and the
// preset extras on `companions`.
import { z } from 'zod'
import { DOCK_DESIGN_LIMITS, SETUP_STEPS, type CompanionsSetupMethods, type OnboardingMethods } from '@shared/onboarding'
import { HELP_TOPIC_IDS } from '@shared/help'
import { DESTINATIONS } from '@shared/url'
import { INTERVIEW_LIMITS, profileSchema } from '@shared/userProfile'
import type { FirstRunServices } from '@shared/tips'
import { chatIdSchema, companionIdSchema, idSchema, pngDataUrlSchema, textSchema } from '../serviceKit'
import type { AdditionSchemas, SchemaMap } from '../schemas/types'

const step = z.enum(SETUP_STEPS)
const answer = z.union([textSchema(2_000), z.array(textSchema(200)).max(50), z.null()])
const unit = (limit: number) => z.number().finite().min(-limit).max(limit)

const dockDesign = z.object({
  companionId: companionIdSchema.nullable(),
  background: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('match') }).strict(),
    z.object({ kind: z.literal('swatch'), id: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
    z.object({ kind: z.literal('custom'), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
  ]),
  offset: z.object({ x: unit(DOCK_DESIGN_LIMITS.offset), y: unit(DOCK_DESIGN_LIMITS.offset) }).strict(),
  rotate: unit(DOCK_DESIGN_LIMITS.rotate),
  turn: unit(DOCK_DESIGN_LIMITS.turn),
  scale: z.number().finite().min(DOCK_DESIGN_LIMITS.scale.min).max(DOCK_DESIGN_LIMITS.scale.max),
  gaze: z.object({ x: unit(DOCK_DESIGN_LIMITS.gaze), y: unit(DOCK_DESIGN_LIMITS.gaze) }).strict(),
  smile: z.boolean(),
}).strict()

/** Methods added to `onboarding` (the original `complete` keeps its schema). */
const interviewLines = z
  .array(z.object({ from: z.enum(['companion', 'you']), text: z.string().max(INTERVIEW_LIMITS.text) }).strict())
  .max(INTERVIEW_LIMITS.lines)

export const ONBOARDING_SCHEMAS: AdditionSchemas<OnboardingMethods> = {
  state: z.tuple([]),
  save: z.tuple([z.object({
    answers: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), answer).optional(),
    companionId: companionIdSchema.nullable().optional(),
    step: step.optional(),
  }).strict()]),
  goTo: z.tuple([step]),
  skipRest: z.tuple([]),
  restart: z.tuple([z.object({ newCompanion: z.boolean() }).strict()]),
  launch: z.tuple([]),
  stepTimeout: z.tuple([step]),
  // ON-18: the setup conversation and your profile.
  interviewTurn: z.tuple([interviewLines]),
  finishInterview: z.tuple([interviewLines.nullable()]),
  profile: z.tuple([]),
  saveProfile: z.tuple([profileSchema]),
  clearProfile: z.tuple([]),
  plan: z.tuple([]),
  applyPlan: z.tuple([z.object({ destinations: z.partialRecord(z.enum(DESTINATIONS), z.boolean()), routines: z.array(z.string().max(32)).max(10) }).strict()]),
}

/** Methods added to `companions`. */
export const COMPANIONS_SETUP_SCHEMAS: AdditionSchemas<CompanionsSetupMethods> = {
  presetDetail: z.tuple([z.string().regex(/^[a-z0-9-]{1,64}$/)]),
  presetDiff: z.tuple([companionIdSchema]),
  applyPresetUpdate: z.tuple([companionIdSchema, z.array(z.string().max(64)).min(1).max(50)]),
}

export const FIRST_RUN_SCHEMAS: SchemaMap<FirstRunServices> = {
  conversations: {
    pick: z.tuple([]),
    start: z.tuple([z.string().uuid(), z.object({ companionId: companionIdSchema, buildMemory: z.boolean() }).strict()]),
    job: z.tuple([idSchema]),
    continueFrom: z.tuple([chatIdSchema, z.enum(['summary', 'transcript'])]),
  },
  guides: {
    list: z.tuple([z.object({ category: z.string().max(64).optional(), query: textSchema(200).optional() }).strict().optional()]),
    get: z.tuple([idSchema]),
    tryIt: z.tuple([idSchema]),
    forUseCases: z.tuple([z.array(idSchema).max(50)]),
  },
  help: {
    topics: z.tuple([]),
    ask: z.tuple([z.enum(HELP_TOPIC_IDS)]),
  },
  guidance: {
    state: z.tuple([]),
    dismissTip: z.tuple([idSchema]),
    dismissNudge: z.tuple([idSchema]),
  },
  dockIcon: {
    design: z.tuple([]),
    save: z.tuple([dockDesign]),
    reset: z.tuple([]),
    apply: z.tuple([pngDataUrlSchema]),
  },
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { FrameReport } from '@shared/autofill'
import type { FieldKind } from '@shared/fields'
import { PASSWORD_MAX, USERNAME_MAX } from '@shared/passwords'

// Frame reports come from page renderers, which Apex doesn't trust: every one
// is parsed here before the controller sees it, and anything malformed is
// dropped without a reply.

const FIELD_KINDS = [
  'username', 'email', 'current-password', 'new-password', 'otp', 'cc-number', 'cc-name', 'cc-exp', 'cc-exp-month',
  'cc-exp-year', 'cc-csc', 'given-name', 'additional-name', 'family-name', 'name', 'organization', 'address-line1',
  'address-line2', 'address-line3', 'address-level2', 'address-level1', 'postal-code', 'country', 'tel',
] as const satisfies readonly FieldKind[]

const coord = z.number().finite().min(-1_000_000).max(1_000_000)
const size = z.number().finite().min(0).max(1_000_000)
const rect = z.object({ x: coord, y: coord, width: size, height: size }).strict()
const id = z.string().min(1).max(64)
const kind = z.enum(FIELD_KINDS)
const guard = z.enum(['password', 'card', 'cvc', 'otp'])
const VALUE_MAX = Math.max(PASSWORD_MAX, USERNAME_MAX)

const frameReportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('focus'),
    fieldId: id,
    kind,
    rect,
    formId: id,
    filled: z.object({ username: z.boolean(), password: z.boolean() }).strict(),
    typed: z.boolean(),
    trusted: z.literal(true),
    formRole: z.enum(['login', 'signup', 'card', 'address']),
    username: z.string().max(USERNAME_MAX).optional(),
  }).strict(),
  z.object({ type: z.literal('blur'), fieldId: id }).strict(),
  z.object({ type: z.literal('moved'), fieldId: id, rect }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['ArrowUp', 'ArrowDown', 'Enter', 'Escape']) }).strict(),
  z.object({ type: z.literal('scroll') }).strict(),
  z.object({
    type: z.literal('submit'),
    form: z.enum(['login', 'card', 'address']),
    // Keys are field kinds; the security code is never accepted, even if a page sends it.
    values: z.partialRecord(kind.exclude(['cc-csc']), z.string().max(VALUE_MAX)),
    trigger: z.enum(['submit', 'enter', 'click', 'removed', 'pagehide']).optional(),
  }).strict(),
  z.object({ type: z.literal('probe'), nonce: z.string().uuid(), childRect: rect }).strict(),
  z.object({ type: z.literal('guarded'), rects: z.array(rect).max(500), focused: guard.nullable().optional() }).strict(),
])

export function parseFrameReport(raw: unknown): FrameReport | null {
  const parsed = frameReportSchema.safeParse(raw)
  return parsed.success ? (parsed.data as FrameReport) : null
}

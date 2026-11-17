/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAILTO_BODY_MAX } from '@shared/diagnostics'
import { mainT } from '../i18n/mainT'

// Problem-report email drafts (OV-30). Apex has no server: a report is
// a file you attach yourself, so the draft says where it is. mailto can't
// attach files, and some mail apps cut long bodies, so the body stays under
// MAILTO_BODY_MAX characters. With no support address built in, the draft
// has no recipient.

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
const CRLF = '\r\n'
// The part of the description quoted in the draft; the whole text is in the bundle.
const EXCERPT_MAX = 600

/** The address as given when it looks like one; '' otherwise. */
export function cleanAddress(address: string): string {
  const trimmed = address.trim()
  return EMAIL.test(trimmed) ? trimmed : ''
}

export function mailtoUrl(to: string, subject: string, body: string): string {
  const address = cleanAddress(to)
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, CRLF))}`
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Joins paragraphs, shortening the flexible one (the excerpt) first so the body fits. */
function fit(fixed: { before: string[]; after: string[] }, flexible: string): string {
  const join = (middle: string): string => [...fixed.before, ...(middle ? [middle] : []), ...fixed.after].join('\n\n')
  const base = join('')
  const room = MAILTO_BODY_MAX - base.length - (flexible ? 2 : 0)
  const body = join(room > 20 ? cut(flexible, Math.min(room, EXCERPT_MAX)) : '')
  return cut(body, MAILTO_BODY_MAX)
}

export interface ReportMailInput {
  supportEmail: string
  version: string
  /** Where the bundle is, as the person sees it (~ for the home folder). */
  path: string
  /** The user's description, already stripped of secrets. */
  description: string
  systemLine: string
}

export function reportMail(input: ReportMailInput): { subject: string; body: string; url: string } {
  const subject = mainT('diagnostics.mail.reportSubject', { version: input.version })
  const body = fit(
    {
      before: [mainT('diagnostics.mail.reportIntro')],
      after: [mainT('diagnostics.mail.reportAttach', { path: cut(input.path, 400) }), mainT('diagnostics.mail.system', { system: cut(input.systemLine, 200) })],
    },
    input.description.trim(),
  )
  return { subject, body, url: mailtoUrl(input.supportEmail, subject, body) }
}

export function feedbackMail(input: { supportEmail: string; version: string; systemLine: string }): { subject: string; body: string; url: string } {
  const subject = mainT('diagnostics.mail.feedbackSubject', { version: input.version })
  const body = cut([mainT('diagnostics.mail.feedbackIntro'), '', mainT('diagnostics.mail.system', { system: cut(input.systemLine, 200) })].join('\n\n'), MAILTO_BODY_MAX)
  return { subject, body, url: mailtoUrl(input.supportEmail, subject, body) }
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// SK-04: a message that ran a skill shows a chip instead of the raw /command.
// Main expands the skill into a <skill> block in what it sends; the log keeps
// what you typed, so the chip hides the leading command and keeps the rest.

/** The text of your message without the leading /<skill name> (or an expanded <skill> block). */
export function stripSkillCommand(text: string, skillName: string): string {
  const expanded = text.replace(/^\s*<skill name="[^"]*">[\s\S]*?<\/skill>\s*/, '')
  if (expanded !== text) return expanded.trim()
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`^\\s*/${escaped}(?=\\s|$)\\s*`, 'i'), '').trim()
}

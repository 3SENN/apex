/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-105: who the Library's selector pill offers. Pure, so it is unit-tested.

/**
 * The companions to list, in the companion list's order: every visible one,
 * a hidden one only when it made files, and then any maker no longer in the
 * list (a removed companion's files stay findable by its id).
 */
export function libraryCompanionIds(companions: readonly { id: string; hidden?: boolean }[], files: readonly { companionId: string }[]): string[] {
  const owners = new Set(files.map((f) => f.companionId))
  const listed = companions.filter((c) => !c.hidden || owners.has(c.id)).map((c) => c.id)
  return [...new Set([...listed, ...owners])]
}

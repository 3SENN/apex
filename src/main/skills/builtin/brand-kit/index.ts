/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SHARED_OWNER } from '@shared/chats'
import type { Skill } from '@shared/services'

// The built-in brand-kit skill. It is
// shared by every companion, read-only, and invoked as /brand-kit (or
// attached from the + menu). It ships next to the other built-in skills
// in the SKILL.md folder format; BRAND_KIT_MARKDOWN is that file.

export const BRAND_KIT_ID = 'builtin-brand-kit'
export const BRAND_KIT_VERSION = '1'

const DESCRIPTION = 'Make documents, slides and sheets look like the person’s own brand: their colours, type and logo.'

const INSTRUCTIONS = `Use this when the user asks for a document, a slide deck, a spreadsheet, a report or a one-page artifact that should look like it comes from them or their organisation.

1. Find the brand first.
   - Look in this conversation and in your memory for brand notes: colour values (hex or RGB), font names, a tagline, tone of voice, and a logo.
   - A logo or brand guide the user attached is the best source. With Files and documents on, attached files are in the code workspace and can go straight into the file you make.
   - If something important is missing, ask one short question that covers all of it ("Which colours and font should I use, and do you have a logo to attach?"). If they would rather not say, use the neutral defaults below and say so in one line.

2. Keep a small, consistent palette.
   - One primary colour for headings, accents and key shapes; one secondary colour used sparingly; neutrals (near-black text, a light grey for rules and table stripes, white or off-white backgrounds).
   - Check contrast: body text on its background should be easy to read (at least 4.5:1). Never put long text on a saturated colour.
   - Neutral defaults when there is no brand: text #1F2328, muted #5B6470, rules #D9DDE3, background #FFFFFF, accent #2F6FEB.

3. Type.
   - Use the brand fonts when they are installed or embeddable; otherwise pick a widely available match (a clean sans serif for interfaces and slides, a readable serif or sans for long documents) and say which you used.
   - Two weights are usually enough. Keep headings short; set body text at a comfortable size (11–12 pt in documents, 18 pt or more on slides).

4. Logo.
   - Place it small and with clear space around it: a corner of the title slide or the document header, not on every element.
   - Never stretch, recolour, crop or add effects to a logo. If only a low-resolution or light-on-dark version exists, mention it rather than forcing it onto the wrong background.

5. Layout by format.
   - Slides: one idea per slide, a title that says the point, generous margins, at most about six short lines; charts in the brand palette with direct labels.
   - Documents: a clear title block, headings in the primary colour, consistent spacing, page numbers, and tables with a light header row.
   - Spreadsheets: a frozen header row in the primary colour with white text, number formats that fit the data, and column widths that show the values.
   - Web pages and SVG: the same palette as CSS variables, system or brand fonts, and no external requests.

6. Before you finish, check the result against the brand once: colours, fonts, logo placement and contrast. Tell the user in one or two sentences what you applied, and offer to save the brand notes to memory so the next file matches without asking again.`

export const BRAND_KIT_MARKDOWN = `---
name: brand-kit
description: ${DESCRIPTION}
---

${INSTRUCTIONS}
`

/** The skill as a Skill record, for the composer, /brand-kit and skill attachments. */
export const BRAND_KIT_SKILL: Skill = {
  id: BRAND_KIT_ID,
  name: 'brand-kit',
  description: DESCRIPTION,
  instructions: INSTRUCTIONS,
  updatedAt: 0,
  owner: SHARED_OWNER,
  lastUsedAt: null,
}

/** A built-in skill by its /name or id; user skills of the same name win, so this is the fallback. */
export function builtinSkill(nameOrId: string): Skill | undefined {
  return nameOrId === BRAND_KIT_SKILL.name || nameOrId === BRAND_KIT_ID ? BRAND_KIT_SKILL : undefined
}

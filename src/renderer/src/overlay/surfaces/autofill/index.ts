/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { FillPopupProps, ImportHintProps, SaveOfferProps } from '@shared/autofill'
import type { SurfacePolicy } from '@shared/overlay'
import type { SurfaceMap, SurfaceModule } from '../../types'
import { makeFillPopup } from './FillPopup'
import { ImportHint } from './ImportHint'
import { SaveOffer } from './SaveOffer'
import './autofill.css'

// Overlay domain `autofill`: the login, card and address fill
// popups (menu layer, focus stays in the page, closed on tab switch) and the
// save, update and import-hint cards (top right, focused, hidden until the
// tab returns). Main places every surface itself (src/main/autofill/placement.ts),
// so each draws exactly at its anchor: 'top-center' with no gap.

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()
const id = z.string().min(1).max(128)
const site = z.string().max(253)
const text = z.string().max(512)

const row = z
  .object({
    id,
    kind: z.enum(['login', 'card', 'address', 'generated', 'manage', 'passkey']),
    title: text,
    subtitle: text.optional(),
    icon: z.string().max(4096).optional(),
  })
  .strict()

const fillProps = z
  .object({
    popupId: id,
    rows: z.array(row).max(200),
    anchorRect: rect,
    siteLabel: site,
    embeddingSite: site.optional(),
    activeId: id.nullable().optional(),
  })
  .strict() as unknown as z.ZodType<FillPopupProps>

const offerProps = z
  .object({
    offerId: id,
    kind: z.enum(['login', 'card', 'address']),
    mode: z.enum(['save', 'update']),
    fields: z.array(z.object({ key: z.string().min(1).max(32), label: text, value: z.string().max(4096), masked: z.boolean().optional() }).strict()).max(12),
    anchorRect: rect,
    siteLabel: site,
    embeddingSite: site.optional(),
  })
  .strict() as unknown as z.ZodType<SaveOfferProps>

const hintProps = z.object({ offerId: id, anchorRect: rect, siteLabel: site }).strict() as unknown as z.ZodType<ImportHintProps>

/** Fill popups never take focus from the page; a click elsewhere or another tab closes them. */
const POPUP_POLICY: SurfacePolicy = { tier: 'interactive', size: 'fixed', outsideClick: 'close', blocksPage: false, onTabSwitch: 'close', layer: 'menu', focus: false, exitMs: 0 }
/** The cards stay put through clicks on the page and wait while another tab shows. */
const CARD_POLICY: SurfacePolicy = { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'menu', focus: true, exitMs: 120 }

function popup(kind: 'login' | 'card' | 'address'): SurfaceModule<FillPopupProps> {
  return { component: makeFillPopup(kind), props: fillProps, policy: POPUP_POLICY, placement: 'top-center', gap: 0 }
}

const saveOffer: SurfaceModule<SaveOfferProps> = { component: SaveOffer, props: offerProps, policy: CARD_POLICY, placement: 'top-center', gap: 0 }

const hint: SurfaceModule<ImportHintProps> = { component: ImportHint, props: hintProps, policy: CARD_POLICY, placement: 'top-center', gap: 0 }

const any = (m: SurfaceModule<FillPopupProps> | SurfaceModule<SaveOfferProps> | SurfaceModule<ImportHintProps>): SurfaceModule<never> => m as unknown as SurfaceModule<never>

export const AUTOFILL_SURFACE_MAP: SurfaceMap = {
  'autofill-login': any(popup('login')),
  'autofill-card': any(popup('card')),
  'autofill-address': any(popup('address')),
  'save-login': any(saveOffer),
  'save-card': any(saveOffer),
  'save-address': any(saveOffer),
  'password-import-hint': any(hint),
}

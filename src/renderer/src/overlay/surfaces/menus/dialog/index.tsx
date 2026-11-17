/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { z } from 'zod'
import type { DialogResult, DialogSurfaceProps } from '@shared/dialogs'
import { escapeButton, resultFor, initialValues } from '@shared/dialogLogic'
import { MODAL_POLICY, type SurfaceComponentProps, type SurfaceModule } from '../../../types'
import { DialogView } from './DialogView'

// The `dialog` surface (OV-07, OV-08): a backdrop over the window, or over
// only the tab's pane for a tab dialog, with the dialog centred in it. A tab
// dialog hides while its tab is away and comes back with it; the window and
// the other split pane stay usable meanwhile. A press on the backdrop is a
// cancel, like Esc and the close button.

function DialogSurface({ props, resolve, exiting }: SurfaceComponentProps<DialogSurfaceProps>): ReactElement {
  const { spec, scope, origin } = props
  const answer = (result: DialogResult): void => resolve(result)
  const cancel = (): void => {
    if (!exiting) answer(resultFor(spec, escapeButton(spec), initialValues(spec), spec.checkbox?.checked ?? false))
  }
  return (
    <div className="dlg-layer" data-scope={scope} data-state={exiting ? 'closing' : 'open'}>
      <div className="dlg-layer__scrim" aria-hidden onPointerDown={cancel} />
      <DialogView spec={spec} origin={origin ?? null} onAnswer={answer} exiting={exiting} />
    </div>
  )
}

const label = z.string().min(1).max(200)
const text = z.string().max(10_000)
const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()

const specSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: text.optional(),
    icon: z.enum(['info', 'warning', 'danger', 'lock']).optional(),
    callout: text.optional(),
    inputs: z.array(z.object({ id: z.string().min(1).max(64), label, type: z.enum(['text', 'password']), value: text.optional() }).strict()).max(8).optional(),
    checkbox: z.object({ label, checked: z.boolean() }).strict().optional(),
    buttons: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            label,
            style: z.enum(['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link']),
            align: z.enum(['start', 'end']).optional(),
            escape: z.boolean().optional(),
            enter: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    dedupeKey: z.string().max(256).optional(),
  })
  .strict()

export const dialogSurface: SurfaceModule<DialogSurfaceProps> = {
  component: DialogSurface,
  props: z.object({ spec: specSchema, scope: z.enum(['window', 'tab']), area: rect, origin: z.string().max(2048).optional() }).strict(),
  // fill-tab takes the anchor's area: the tab's pane for a tab dialog, the whole window otherwise.
  policy: { ...MODAL_POLICY, size: 'fill-tab', onTabSwitch: 'hide-until-return' },
}

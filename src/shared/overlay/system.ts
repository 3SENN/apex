/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The system overlay surfaces: the open-at-login approval dialog (OV-09).
export const SYSTEM_SURFACES = ['login-item-approval'] as const

export type SystemSurfaceId = (typeof SYSTEM_SURFACES)[number]

export interface SystemSurfaceProps {
  'login-item-approval': Record<string, never>
}

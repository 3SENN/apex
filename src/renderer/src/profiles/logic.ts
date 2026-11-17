/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Profiles page and dialogs' pure parts (ST-37 to ST-39). They live in
// @shared/profiles so the unit tests reach them; this is the renderer's
// import point.
export { deleteArmed, deleteBlockMessage, deletionRows, freshHue, hueSwatches, nameMessage, nameProblemMessage, nextHue, type Message } from '@shared/profiles'

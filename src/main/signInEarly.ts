/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { applySignInSwitches } from './signInCompat'

// Before ready (Chromium reads its feature list at start-up): FedCM off, so
// Google Identity Services takes its popup or redirect flow (signInCompat.ts).
applySignInSwitches()

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Imported first by src/main/index.ts, before the diagnostics and the
// language read the profile folder: Apex's name for the system and Chromium,
// and a dev run's Dock icon once the app is ready (branding.ts).
import { app } from 'electron'
import { applyAppName, applyDevDockIcon } from './branding'

applyAppName()
void app.whenReady().then(applyDevDockIcon)

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Imported by src/main/index.ts (line 2, after the app name), before anything else runs:
// the logger, the capture, the crash reporter (only when crashReports is on)
// and the unclean-exit sentinel start here (boot.ts). A smoke run swaps
// userData for a temp folder after the imports, so it boots from the
// diagnostics feature instead and never touches the real profile.
import { app } from 'electron'
import { bootDiagnostics } from './boot'

if (process.env.ATELIER_SMOKE !== '1') bootDiagnostics(app.getPath('userData'))

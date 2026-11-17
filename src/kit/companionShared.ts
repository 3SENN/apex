/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The kit's view of the companion contract (docs/apps.md › The kit): the same
// module as the chrome's, with the asset base pointing at the kit's copy of
// the companion art inside the app's own origin. scripts/kit/build.mjs aliases
// '@shared/companion' to this file; an explicit export wins over `export *`.
export * from '../shared/companion'
export const COMPANION_ASSET_BASE = '/__apex/kit/1/companion/'

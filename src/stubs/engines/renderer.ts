/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@internal/engines/renderer` in a build from public code: no engines
// besides the API key, so no engine choice, sections or error steps. A build
// with the private internal/ folder takes internal/engines/renderer.tsx.
import type { EngineUi } from '../../renderer/src/engines/seam'

export const ENGINE_UI: EngineUi = {
  choices: [],
  Sections: null,
  Welcome: null,
  useErrorStep: () => null,
}

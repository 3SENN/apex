/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// electron-builder's entry point (`electron-builder --config electron-builder.config.mjs`,
// and release.mjs). It is electron-builder.yml plus what the environment decides:
// the app id, the macOS signing mode and its entitlements, the identity,
// notarization and the publish target. See scripts/release/builderConfig.mjs
// and docs/release.md. The release commands (release.mjs) load the maintainer's
// private internal/release.env before they get here; a plain `npm run package`
// uses the real environment only, so it stays unsigned unless you ask.
import { builderConfig } from './scripts/release/builderConfig.mjs'

export default () => {
  return builderConfig(process.env, { log: (message) => console.log(`  • Atelier signing: ${message}`) })
}

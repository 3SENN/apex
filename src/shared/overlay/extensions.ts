/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `extensions`: the toolbar's extensions
// popover and the install and native-messaging prompts. Components and
// policies live in src/renderer/src/overlay/surfaces/extensions/index.ts.
import type { ExtensionInstallPrompt, ExtensionNativePrompt } from '../extensions'

export const EXTENSIONS_SURFACES = ['extensions-popover', 'extension-install-prompt', 'extension-native-prompt'] as const

export type ExtensionsSurfaceId = (typeof EXTENSIONS_SURFACES)[number]

export interface ExtensionsSurfaceProps {
  'extensions-popover': Record<string, never>
  'extension-install-prompt': { prompt: ExtensionInstallPrompt }
  'extension-native-prompt': { prompt: ExtensionNativePrompt }
}

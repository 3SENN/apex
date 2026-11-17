/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@internal/engines/shared` in a build from public code: no engines besides
// the API key (src/shared/engine.ts). A build with the private internal/
// folder takes internal/engines/shared.ts instead, which has the same exports
// and adds its engines, their status fields, error codes, settings and
// service methods (scripts/internal.mjs, docs/architecture.md › Engines).

/** Engines this build adds to the API key, by id. */
export const EXTRA_ENGINE_IDS = [] as const
export type ExtraEngineId = (typeof EXTRA_ENGINE_IDS)[number]

/** Each added engine's name, as Settings › Model and key lists it. */
export const EXTRA_ENGINE_LABELS: Record<ExtraEngineId, string> = {}

/** Fields the added engines put on EngineStatus. */
export interface ExtraEngineStatus {}

/** Service namespaces the added engines bring (src/shared/services.ts). */
export interface ExtraEngineServices {}

/** Chat error codes the added engines report (src/shared/chatErrors.ts). */
export const EXTRA_CHAT_ERROR_CODES = [] as const

/** App settings the added engines keep (src/shared/settingsRegistry.ts). */
export interface ExtraEngineSettings {}
export const EXTRA_ENGINE_SETTINGS = {} as const

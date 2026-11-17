/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, type NativeImage } from 'electron'
import { z } from 'zod'
import { BRANDING, offeredPresets } from '@shared/branding'
import { localizedPreset } from '@shared/brandingPreset'
import { FACE_IDS, LOOK_ADJUST_KEYS, LOOK_ADJUST_LIMIT, PART_IDS, RIGS, type CompanionLook, type CompanionPreset, type CompatibilityConfig } from '@shared/companion'
import { devRendererUrl } from './appProtocol'
import { standardAppIcon } from './branding'
import { appRoot } from './resources'

// Main's side of the companion: the look schema shared by the service
// validator and the preset loader, the generated presets and part rules,
// and the Dock icon.

export const HEX_COLOR = /^#[0-9a-f]{6}$/i
export const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

const hex = z.string().regex(HEX_COLOR)
const optionalPart = <T extends readonly [string, ...string[]]>(ids: T) => z.enum(ids).nullable()

export const lookSchema: z.ZodType<CompanionLook> = z.object({
  rig: z.enum(RIGS),
  parts: z.object({
    head: z.enum(PART_IDS.head),
    ears: optionalPart(PART_IDS.ears),
    hair: optionalPart(PART_IDS.hair),
    hat: optionalPart(PART_IDS.hat),
    eyeAccessory: optionalPart(PART_IDS.eyeAccessory),
    earAccessory: optionalPart(PART_IDS.earAccessory),
    prop: optionalPart(PART_IDS.prop),
  }),
  face: z.object({
    eyes: z.enum(FACE_IDS.eyes),
    brows: z.enum(FACE_IDS.brows),
    mouth: z.enum(FACE_IDS.mouth),
  }),
  colors: z.object({ skin: hex, hair: hex, accent: hex, outfit: hex }),
  // DS-120: optional, so older looks and files still pass; unknown keys are dropped.
  adjust: z.partialRecord(z.enum(LOOK_ADJUST_KEYS), z.number().finite().min(-LOOK_ADJUST_LIMIT).max(LOOK_ADJUST_LIMIT)).optional(),
})

export const presetSchema: z.ZodType<CompanionPreset> = z.object({
  id: z.string().regex(PERSONA_ID).refine((id) => id !== 'custom'),
  name: z.string().trim().min(1).max(24),
  tagline: z.string().max(200),
  personality: z.string().max(1000),
  look: lookSchema,
})

/** Keeps the valid, uniquely named presets from a parsed presets.json. */
export function parsePresets(raw: unknown): { presets: CompanionPreset[]; rejected: number } {
  if (!Array.isArray(raw)) return { presets: [], rejected: 1 }
  const presets: CompanionPreset[] = []
  let rejected = 0
  for (const item of raw) {
    const parsed = presetSchema.safeParse(item)
    if (parsed.success && !presets.some((p) => p.id === parsed.data.id)) presets.push(parsed.data)
    else rejected++
  }
  return { presets, rejected }
}

/** The generated config folder: the source folder in dev, the built renderer folder otherwise. */
function configDir(): string {
  return devRendererUrl() ? join(appRoot(), 'src/renderer/public/companion/config') : join(__dirname, '../renderer/companion/config')
}

export function presetsPath(): string {
  return join(configDir(), 'presets.json')
}

export function compatibilityPath(): string {
  return join(configDir(), 'head-part-compatibility.json')
}

const rule = z.union([z.literal('all'), z.array(z.string())])
const compatibilitySchema: z.ZodType<CompatibilityConfig> = z.record(
  z.string(),
  z.object({ ears: rule, hair: rule, hat: rule, eyeAccessory: rule, earAccessory: rule }),
)

/** The generated part rules, or none (everything allowed) when the file is missing or invalid. */
export function readCompatibility(path: string): CompatibilityConfig {
  try {
    const parsed = compatibilitySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
    console.warn(`Ignored invalid companion part rules in ${path}.`)
  } catch (err) {
    console.warn('Companion part rules are unavailable:', err instanceof Error ? err.message : err)
  }
  return {}
}

export class CompanionPresets {
  readonly #path: string
  #cache: CompanionPreset[] | null = null
  #warned = false

  constructor(path: string) {
    this.#path = path
  }

  /** The offered presets, the branding's own companion in the app language (src/shared/brandingPreset.ts). */
  list(): CompanionPreset[] {
    return this.#offered().map((p) => localizedPreset(p))
  }

  #offered(): CompanionPreset[] {
    if (this.#cache) return this.#cache
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch (err) {
      // Not cached, so presets appear once the assets are generated.
      if (!this.#warned) console.warn('Companion presets are unavailable:', err instanceof Error ? err.message : err)
      this.#warned = true
      return []
    }
    const { presets, rejected } = parsePresets(raw)
    if (rejected > 0) console.warn(`Ignored ${rejected} invalid companion preset(s) in ${this.#path}.`)
    // The presets the branding offers: its own companion first, if it has one that is a valid preset, and none it
    // leaves out (the unofficial branding offers its neutral companion and none of Apex's six; src/shared/branding.ts).
    const own = BRANDING.ownPreset
    const ownValid = own !== null && presetSchema.safeParse(own).success
    if (own && !ownValid) console.warn(`Ignored the branding's own companion "${own.id}": it is not a valid preset.`)
    this.#cache = offeredPresets(presets, ownValid ? BRANDING : { ...BRANDING, ownPreset: null })
    return this.#cache
  }

  ids(): string[] {
    return this.list().map((p) => p.id)
  }

  /** The personality for a persona; 'custom' and unknown ids have none. */
  personality(persona: string): string | undefined {
    if (persona === 'custom') return undefined
    return this.list().find((p) => p.id === persona)?.personality
  }
}

// ---- Dock icon (macOS) ----

export const DOCK_ICON_PREFIX = 'data:image/png;base64,'
export const DOCK_ICON_MAX = 3 * 1024 * 1024
/** The chrome renders the icon at 512 px. */
export const DOCK_ICON_MAX_SIDE = 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from a PNG data URL's header (signature, then the IHDR chunk), without decoding the image. */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  if (!dataUrl.startsWith(DOCK_ICON_PREFIX)) return null
  // 44 base64 characters hold the first 33 bytes: signature, IHDR length and type, width, height and more.
  const head = Buffer.from(dataUrl.slice(DOCK_ICON_PREFIX.length, DOCK_ICON_PREFIX.length + 44), 'base64')
  if (head.length < 24 || !PNG_SIGNATURE.every((byte, i) => head[i] === byte) || head.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

export function dockIconImage(dataUrl: string): NativeImage {
  if (!dataUrl.startsWith(DOCK_ICON_PREFIX) || dataUrl.length > DOCK_ICON_MAX) throw new Error('The Dock icon must be a PNG data URL under 3 MB.')
  // createFromDataURL decodes at once, and a few KB of PNG can declare a canvas of gigabytes.
  const size = pngSize(dataUrl)
  if (!size || size.width === 0 || size.height === 0 || size.width > DOCK_ICON_MAX_SIDE || size.height > DOCK_ICON_MAX_SIDE) {
    throw new Error(`The Dock icon must be a PNG of at most ${DOCK_ICON_MAX_SIDE}×${DOCK_ICON_MAX_SIDE} pixels.`)
  }
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) throw new Error('The Dock icon image could not be read.')
  return image
}

export function setDockIcon(image: NativeImage): boolean {
  if (process.platform !== 'darwin' || !app.dock) return false
  app.dock.setIcon(image)
  return true
}

export function resetDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  // A dev run's bundle is Electron's own, so its icon is set explicitly (branding.ts).
  const standard = app.isPackaged ? null : standardAppIcon()
  if (standard) {
    app.dock.setIcon(standard)
    return
  }
  // Electron passes null through to NSApp.applicationIconImage = nil, which
  // restores the bundle's icon; the typings only list images and paths.
  app.dock.setIcon(null as unknown as NativeImage)
}

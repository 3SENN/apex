/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// The page scripts/app-icons/render-pip.mjs loads in a hidden Electron
// window: the app's own still renderer (src/renderer/src/companion/render.ts)
// draws Pip (presets.json `pip`), smiling, with a transparent background. The
// main process calls window.__renderPip(size) and saves what comes back.
import { renderCompanionImage } from '../../../src/renderer/src/companion/render'

type Look = Parameters<typeof renderCompanionImage>[0]

/** A preset's look: the presets ship with the companion assets (config/presets.json), served from /companion/. */
async function presetLook(id: string): Promise<Look> {
  const presets = (await (await fetch('/companion/config/presets.json')).json()) as Array<{ id: string; look: Look }>
  const preset = presets.find((p) => p.id === id)
  if (!preset) throw new Error(`No preset called ${id}`)
  return preset.look
}

/** The group picture on .apexpack files (docs/packs.md): three presets together, each in its own mood. */
export const GROUP = [
  { id: 'mochi', mood: 'talking' },
  { id: 'pip', mood: 'happy' },
  { id: 'bolt', mood: 'approval' },
] as const

declare global {
  interface Window {
    __renderGroup?: (size: number) => Promise<{ members: Array<{ id: string; head: string; full: string }>; errors: string[] }>
    __renderPip?: (size: number) => Promise<{ head: string; full: string; errors: string[] }>
    __apexCompanionStats?: { ready: number; errors: string[] }
  }
}

window.__renderPip = async (size: number) => {
  // The frameless floating head the small avatars and the Dock use, then the whole companion.
  const pip = await presetLook('pip')
  const head = await renderCompanionImage(pip, size, 'happy', { framing: 'face' })
  const full = await renderCompanionImage(pip, size, 'happy', { framing: 'full' })
  return { head, full, errors: window.__apexCompanionStats?.errors ?? [] }
}

window.__renderGroup = async (size: number) => {
  const members: Array<{ id: string; head: string; full: string }> = []
  for (const m of GROUP) {
    const look = await presetLook(m.id)
    const full = await renderCompanionImage(look, size, m.mood, { framing: 'full' })
    const head = await renderCompanionImage(look, size, m.mood, { framing: 'face' })
    members.push({ id: m.id, head, full })
  }
  return { members, errors: window.__apexCompanionStats?.errors ?? [] }
}

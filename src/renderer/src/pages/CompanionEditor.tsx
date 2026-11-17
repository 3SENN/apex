/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What every look editor shares: the look bindings (a saved companion's look,
// or a local draft) with undo and redo, part and face labels, shuffling, the
// face swatches and the preset gallery. A look is edited on the companion's
// card, in the ring of bubbles around the figure (LookInPlace, LookRing);
// the create sheet and setup pick presets and shuffle.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Info } from 'lucide-react'
import type { Companion, CompanionLook, CompanionPreset, FaceLayer, RigId } from '@shared/companion'
import { lookKey, normalizeLook, sameLook } from '@shared/companionLogic'
import { call, errorText } from '../api'
import { assetUrl, randomLook, type CompanionAssets } from '../companion'
import { useCompanionImage } from '../components/companionData'
import { canRedo, canUndo, createHistory, pushHistory, redoHistory, sealHistory, undoHistory, type History } from '../companion-card/logic/history'
import { pickPalette, type ShuffleStyle } from '../companion-card/logic/shuffle'
import { IconButton, type SaveState } from '../ui'
import { ShapeField } from '../companion-card/ShapeField' // DS-86
import '../companion-card/card.css'
import { t as tx } from '@shared/i18n/core'
import { useT } from '../i18n/useT'

/** 'hair-sideswept' → 'Sideswept', for ids the manifest does not label. */
function fallbackLabel(id: string): string {
  const words = id.replace(/^(head|ears|hair|hat|prop|eyes|brows|mouth)-/, '').replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function partLabel(assets: CompanionAssets | null, id: string): string {
  return assets?.manifest.parts[id]?.label ?? fallbackLabel(id)
}

export function faceLabel(assets: CompanionAssets | null, layer: FaceLayer, id: string): string {
  return assets?.manifest.face[layer]?.[id]?.label ?? fallbackLabel(id)
}

export function rigLabel(assets: CompanionAssets | null, rig: RigId): string {
  return assets?.manifest.rigs[rig]?.label ?? tx('settings.look.rigFallback', { rig })
}

/** A random look leaning towards `style` (its palette is re-picked with the bias). */
export function shuffledLook(assets: CompanionAssets, style: ShuffleStyle = 'any', rng: () => number = Math.random): CompanionLook {
  const look = randomLook(assets, rng)
  if (style === 'any') return look
  const palette = pickPalette(assets.randomization.palettes, style, rng)
  return palette ? { ...look, colors: { ...palette.colors } } : look
}

// ---- look bindings: a saved companion, or a local draft ----

/** What the look editor drives: the current look, undo and redo, and (for a saved companion) its save state. */
export interface LookBinding {
  look: CompanionLook
  /** Changes with the same group (one colour drag) collapse into one undo step. */
  set(next: CompanionLook, group?: string): void
  /** Ends the open group, e.g. when a colour drag is released. */
  seal(): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  save?: { state: SaveState; retry(): void }
}

const COLOR_SAVE_MS = 250
const SAVED_FOR_MS = 1800

function useLookHistory(initial: CompanionLook, assets: CompanionAssets | null): [History<CompanionLook>, (update: (h: History<CompanionLook>) => History<CompanionLook>) => void, (next: CompanionLook) => CompanionLook] {
  const [history, setHistory] = useState(() => createHistory(initial))
  // Only picks are normalized: a saved look that breaks newer rules shows as
  // the runtime draws it until it is changed.
  const normalize = (value: CompanionLook): CompanionLook => (assets ? normalizeLook(value, assets.compatibility) : value)
  return [history, setHistory, normalize]
}

/** A local look with undo and redo, saved nowhere (the create sheet and the welcome flow). */
export function useDraftLook(initial: CompanionLook, assets: CompanionAssets | null): LookBinding & { replace(look: CompanionLook): void } {
  const [history, setHistory, normalize] = useLookHistory(initial, assets)
  return {
    look: history.present,
    set: (next, group) => setHistory((h) => pushHistory(h, normalize(next), { group, same: sameLook })),
    seal: () => setHistory(sealHistory),
    undo: () => setHistory(undoHistory),
    redo: () => setHistory(redoHistory),
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    // A preset or shuffle that starts over is still one undoable step.
    replace: (look) => setHistory((h) => pushHistory(h, look, { same: sameLook })),
  }
}

/**
 * Edits a saved companion's look with undo and redo. Every pick saves at
 * once and colour drags save once they settle. Echoes of our own saves are
 * ignored; a change made elsewhere (a reset, another window) becomes a new
 * step, so it can be undone too.
 */
export function useSavedLook(companion: Companion, assets: CompanionAssets | null): LookBinding {
  const [history, setHistory, normalize] = useLookHistory(companion.look, assets)
  const [state, setState] = useState<SaveState>('idle')
  const latest = useRef(history)
  latest.current = history
  // The last look sent and not yet echoed back, and the last one main has.
  const sent = useRef<string | null>(null)
  const saved = useRef(lookKey(companion.look))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = companion.id

  const save = (look: CompanionLook): void => {
    const key = lookKey(look)
    sent.current = key
    setState('saving')
    if (settle.current) clearTimeout(settle.current)
    call('companions', 'update', id, { look }).then(
      () => {
        if (sent.current !== key && sent.current !== null) return
        setState('saved')
        settle.current = setTimeout(() => setState('idle'), SAVED_FOR_MS)
      },
      (err: unknown) => {
        if (sent.current === key) sent.current = null
        console.warn('Could not save the companion look:', errorText(err))
        setState('error')
      },
    )
  }

  useEffect(() => {
    const key = lookKey(history.present)
    if (key === (sent.current ?? saved.current)) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const look = history.present
    if (history.group) {
      timer.current = setTimeout(() => {
        timer.current = null
        save(look)
      }, COLOR_SAVE_MS)
    } else save(look)
  }, [history.present])

  useEffect(() => {
    const key = lookKey(companion.look)
    saved.current = key
    if (sent.current === key) {
      sent.current = null
      return
    }
    // A newer change of ours is still on its way.
    if (timer.current || sent.current !== null) return
    if (key !== lookKey(latest.current.present)) setHistory((h) => pushHistory(h, companion.look, { same: sameLook }))
  }, [companion.look])

  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current)
    // A colour drag still settling is saved on the way out.
    if (timer.current) {
      clearTimeout(timer.current)
      void call('companions', 'update', id, { look: latest.current.present }).catch(() => undefined)
    }
  }, [])

  return {
    look: history.present,
    set: (next, group) => setHistory((h) => pushHistory(h, normalize(next), { group, same: sameLook })),
    seal: () => setHistory(sealHistory),
    undo: () => setHistory(undoHistory),
    redo: () => setHistory(redoHistory),
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    save: { state, retry: () => save(latest.current.present) },
  }
}

/**
 * The layer's resting variant drawn on the skin colour, so face chips show
 * what they are. The skin is toned down against dark surfaces in CSS, so
 * the swatches don't glare out of a dark chip.
 */
export function FaceSwatch({ assets, layer, id, skin }: { assets: CompanionAssets; layer: FaceLayer; id: string; skin: string }) {
  const def = assets.manifest.face[layer]?.[id]
  const variant = def?.variants.neutral
  if (!variant) return null
  const layers = [def.pupils, variant].filter((f): f is string => Boolean(f)).map((f) => `url("${assetUrl(f)}")`)
  const style = { '--swatch-skin': skin, backgroundImage: layers.join(', ') } as CSSProperties
  return <span className={`co-face-swatch co-face-swatch--${layer}`} style={style} aria-hidden="true" />
}

// ---- presets ----

interface PresetGalleryProps {
  presets: CompanionPreset[]
  /** The preset shown as chosen, if any. */
  selectedId?: string | null
  onPick(preset: CompanionPreset): void
  compact?: boolean
  label?: string
  /** CO-17: shows a details button on each card that opens the preset's detail sheet. */
  onDetails?(preset: CompanionPreset): void
}

/** Atelier’s preset companions with their look, name and tagline. Picking one never overwrites a companion; callers add a new one. */
export function PresetGallery({ presets, selectedId = null, onPick, compact = false, label = tx('settings.look.presets'), onDetails }: PresetGalleryProps) {
  const t = useT()
  return (
    <div className={`co-presets${compact ? ' co-presets--row' : ''}`} role="group" aria-label={label}>
      {presets.map((preset) =>
        // CO-17
        onDetails ? (
          <span key={preset.id} className="co-preset-wrap">
            <PresetCard preset={preset} selected={selectedId === preset.id} compact={compact} onPick={() => onPick(preset)} />
            <IconButton className="co-preset-info" label={t('core.companionEditor.about', { name: preset.name })} icon={<Info />} variant="subtle" size="sm" onClick={() => onDetails(preset)} />
          </span>
        ) : (
          <PresetCard key={preset.id} preset={preset} selected={selectedId === preset.id} compact={compact} onPick={() => onPick(preset)} />
        ),
      )}
    </div>
  )
}

function PresetCard({ preset, selected, compact, onPick }: { preset: CompanionPreset; selected: boolean; compact: boolean; onPick(): void }) {
  const image = useCompanionImage(preset.look, 192)
  return (
    <button type="button" className="co-preset" aria-pressed={selected} onClick={onPick} title={preset.personality}>
      <span className="co-preset__thumb" style={{ '--hero-tint': preset.look.colors.accent } as CSSProperties}>
        <ShapeField tint={preset.look.colors.accent} still className="co-preset__field" />
        {image ? <img src={image} alt="" width={88} height={88} /> : <span className="co-preset__placeholder" />}
      </span>
      <span className="co-preset__name">{preset.name}</span>
      {!compact && <span className="co-preset__tagline">{preset.tagline}</span>}
    </button>
  )
}

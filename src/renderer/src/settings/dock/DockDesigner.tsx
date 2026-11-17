/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Dock icon designer (ST-10; macOS): a live icon canvas, a
// companion picker and a background picker (match the companion, Atelier's
// swatches, or a custom colour from a pad with a hue slider and a hex
// field). Drag the head to move it, drag the eyes to aim the gaze, click the
// mouth to toggle a smile; the handles rotate, turn and scale it. Keys:
// arrows move, [ ] rotate, , . turn, - = scale, ⇧ for bigger steps.
// Double-click a handle to reset it. Every change previews at once and is
// saved and applied 400 ms after the last one.
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { DEFAULT_DOCK_DESIGN, DOCK_SAVE_DELAY_MS, DOCK_SWATCHES, clampDockDesign, dockDesignKey, resetDockHandle, serializeDockDesign, type DockHandle, type DockIconDesign } from '@shared/onboarding'
import { call, errorText } from '../../api'
import { dockGeometry, dockHead, drawDockIcon, renderDockIcon } from '../../companion/dockRender'
import { Button, Select } from '../../ui'
import { hexToHsv, hsvToHex, parseHex } from './color'
import './dock.css'
import { useT } from '../../i18n/useT'

const CANVAS = 256

type Drag = { kind: DockHandle; startX: number; startY: number; start: DockIconDesign; moved: boolean; onMouth: boolean }

export function DockDesigner({ companions, chosenId }: { companions: readonly Companion[]; chosenId: string | null }): ReactElement {
  const t = useT()
  const [design, setDesign] = useState<DockIconDesign | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [head, setHead] = useState<HTMLImageElement | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  const savedKey = useRef<string | null>(null)
  const pickerId = useId()
  const helpId = useId()

  useEffect(() => {
    call('dockIcon', 'design').then(
      (d) => {
        savedKey.current = serializeDockDesign(d)
        setDesign(d)
      },
      (err: unknown) => setError(errorText(err)),
    )
  }, [])

  const companion = companions.find((c) => c.id === (design?.companionId ?? chosenId)) ?? companions.find((c) => c.id === chosenId) ?? companions[0] ?? null
  const lookKey = companion ? JSON.stringify(companion.look) : ''

  // The head image for the companion and expression; redraws reuse it.
  useEffect(() => {
    if (!companion || !design) return
    let live = true
    dockHead(companion.look, design.smile).then((img) => live && setHead(img), () => live && setHead(null))
    return () => {
      live = false
    }
  }, [lookKey, design?.smile])

  // Instant preview.
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !design || !companion) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const px = CANVAS * dpr
    if (canvas.current && canvas.current.width !== px) {
      canvas.current.width = px
      canvas.current.height = px
    }
    drawDockIcon(ctx, px, design, head, companion.look.colors.accent)
  }, [design, head, lookKey])

  // Saved and applied 400 ms after the last change.
  useEffect(() => {
    if (!design || !companion) return
    const key = serializeDockDesign(design)
    if (key === savedKey.current) return
    const timer = setTimeout(async () => {
      setStatus('saving')
      try {
        const saved = await call('dockIcon', 'save', design)
        savedKey.current = serializeDockDesign(saved)
        await call('dockIcon', 'apply', await renderDockIcon(saved, companion.look))
        setStatus('saved')
      } catch (err) {
        setError(errorText(err))
        setStatus('failed')
      }
    }, DOCK_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [design && serializeDockDesign(design), lookKey])

  if (error && !design) return <p className="dk-error" role="alert">{error}</p>
  if (!design || !companion) return <div className="dk-designer dk-designer--loading" aria-busy="true" />

  const update = (next: DockIconDesign): void => {
    setError(null)
    setDesign(clampDockDesign(next))
  }
  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: ((e.clientX - rect.left) / rect.width) * CANVAS, y: ((e.clientY - rect.top) / rect.height) * CANVAS }
  }
  const hit = (x: number, y: number): { kind: DockHandle; onMouth: boolean } | null => {
    const g = dockGeometry(design, CANVAS)
    const near = (p: { x: number; y: number }, r: number): boolean => Math.hypot(x - p.x, y - p.y) <= r
    if (near(g.handles.rotate, 10)) return { kind: 'rotate', onMouth: false }
    if (near(g.handles.scale, 10)) return { kind: 'scale', onMouth: false }
    if (near(g.handles.turn, 10)) return { kind: 'turn', onMouth: false }
    if (near({ x: g.mouth.cx, y: g.mouth.cy }, g.mouth.r)) return { kind: 'move', onMouth: true }
    if (near({ x: g.eyes.cx, y: g.eyes.cy }, g.eyes.r) && y < g.head.cy) return { kind: 'gaze', onMouth: false }
    if (near({ x: g.head.cx, y: g.head.cy }, g.head.r)) return { kind: 'move', onMouth: false }
    return null
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    const p = point(e)
    const h = hit(p.x, p.y)
    if (!h) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind: h.kind, startX: p.x, startY: p.y, start: design, moved: false, onMouth: h.onMouth }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const p = point(e)
    const dx = p.x - d.startX
    const dy = p.y - d.startY
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    d.moved = true
    const tile = CANVAS * 0.8
    const g = dockGeometry(d.start, CANVAS)
    switch (d.kind) {
      case 'move':
        return update({ ...d.start, offset: { x: d.start.offset.x + dx / tile, y: d.start.offset.y + dy / tile } })
      case 'gaze':
        return update({ ...d.start, gaze: { x: d.start.gaze.x + dx / (g.head.r * 0.5), y: d.start.gaze.y + dy / (g.head.r * 0.5) } })
      case 'rotate': {
        const angle = (Math.atan2(p.y - g.head.cy, p.x - g.head.cx) * 180) / Math.PI + 90
        return update({ ...d.start, rotate: ((angle + 540) % 360) - 180 })
      }
      case 'turn':
        return update({ ...d.start, turn: d.start.turn + dx * 0.6 })
      case 'scale': {
        const from = Math.hypot(d.startX - g.head.cx, d.startY - g.head.cy)
        const to = Math.hypot(p.x - g.head.cx, p.y - g.head.cy)
        return update({ ...d.start, scale: d.start.scale * (from > 0 ? to / from : 1) })
      }
    }
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    // A click on the mouth (no drag) toggles the smile.
    if (d && !d.moved && d.onMouth) update({ ...design, smile: !design.smile })
  }
  const onDoubleClick = (e: { clientX: number; clientY: number }): void => {
    const p = point(e)
    const h = hit(p.x, p.y)
    if (h && !h.onMouth) update(resetDockHandle(design, h.kind))
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      update({ ...design, smile: !design.smile })
      return
    }
    const next = dockDesignKey(design, e.key, e.shiftKey)
    if (!next) return
    e.preventDefault()
    update(next)
  }

  const g = dockGeometry(design, CANVAS)
  const pct = (v: number): string => `${(v / CANVAS) * 100}%`
  const handle = (kind: 'rotate' | 'scale' | 'turn', label: string): ReactElement => (
    <span className={`dk-handle dk-handle--${kind}`} style={{ left: pct(g.handles[kind].x), top: pct(g.handles[kind].y) } as CSSProperties} title={t('settings.dockDesigner.doubleClickToReset', { label })} aria-hidden="true" />
  )

  return (
    <div className="dk-designer">
      <div className="dk-stage">
        <div className="dk-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (drag.current = null)} onDoubleClick={onDoubleClick}>
          <canvas
            ref={canvas}
            width={CANVAS}
            height={CANVAS}
            tabIndex={0}
            role="img"
            aria-label={t('settings.dockDesigner.previewLabel', { name: companion.name, rotate: Math.round(design.rotate), turn: Math.round(design.turn), scale: Math.round(design.scale * 100) }) + (design.smile ? t('settings.dockDesigner.previewSmiling') : '')}
            aria-describedby={helpId}
            onKeyDown={onKeyDown}
          />
          {handle('rotate', t('settings.dockDesigner.rotate'))}
          {handle('turn', t('settings.dockDesigner.turn'))}
          {handle('scale', t('settings.dockDesigner.scale'))}
        </div>
        <p id={helpId} className="dk-help">
          {t('settings.dockDesigner.dragToMoveDrag')}
        </p>
      </div>
      <div className="dk-controls">
        <div className="dk-field">
          <label className="dk-label" htmlFor={pickerId}>{t('settings.dockDesigner.companion')}</label>
          <Select id={pickerId} value={companion.id} options={companions.map((c) => ({ value: c.id, label: c.name }))} onChange={(id: string) => update({ ...design, companionId: id })} />
        </div>
        <Background design={design} accent={companion.look.colors.accent} onChange={update} />
        <div className="dk-actions">
          <Button variant="secondary" icon={<RotateCcw />} onClick={() => update({ ...DEFAULT_DOCK_DESIGN, companionId: design.companionId })}>{t('settings.dockDesigner.reset')}</Button>
          <span className="dk-status" role="status" aria-live="polite">
            {status === 'saving' ? t('settings.dockDesigner.saving') : status === 'saved' ? t('settings.dockDesigner.saved') : ''}
          </span>
        </div>
        {error && <p className="dk-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

function Background({ design, accent, onChange }: { design: DockIconDesign; accent: string; onChange(d: DockIconDesign): void }): ReactElement {
  const t = useT()
  const bg = design.background
  const custom = bg.kind === 'custom' ? bg.hex : accent
  const [hsv, setHsv] = useState(() => hexToHsv(custom))
  const [hexText, setHexText] = useState(custom)
  const pad = useRef<HTMLDivElement>(null)
  const hueId = useId()
  const hexId = useId()
  useEffect(() => {
    if (bg.kind === 'custom') setHexText(bg.hex)
  }, [bg.kind === 'custom' ? bg.hex : null])

  const setCustom = (hex: string): void => onChange({ ...design, background: { kind: 'custom', hex } })
  const fromHsv = (next: typeof hsv): void => {
    setHsv(next)
    const hex = hsvToHex(next)
    setHexText(hex)
    setCustom(hex)
  }
  const padAt = (e: { clientX: number; clientY: number }): void => {
    const r = pad.current?.getBoundingClientRect()
    if (!r) return
    fromHsv({ ...hsv, s: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) })
  }
  return (
    <fieldset className="dk-bg">
      <legend className="dk-label">{t('settings.dockDesigner.background')}</legend>
      <div className="dk-swatches" role="radiogroup" aria-label={t('settings.dockDesigner.background')}>
        <button type="button" role="radio" aria-checked={bg.kind === 'match'} className="dk-swatch dk-swatch--match" style={{ '--sw': accent } as CSSProperties} onClick={() => onChange({ ...design, background: { kind: 'match' } })}>
          <span className="ui-sr-only">{t('settings.dockDesigner.matchTheCompanion')}</span>
        </button>
        {DOCK_SWATCHES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={bg.kind === 'swatch' && bg.id === s.id} aria-label={s.label} title={s.label} className="dk-swatch" style={{ '--sw': s.hex } as CSSProperties} onClick={() => onChange({ ...design, background: { kind: 'swatch', id: s.id } })} />
        ))}
        <button type="button" role="radio" aria-checked={bg.kind === 'custom'} className="dk-swatch dk-swatch--custom" style={{ '--sw': custom } as CSSProperties} onClick={() => setCustom(custom)}>
          <span className="ui-sr-only">{t('settings.dockDesigner.customColour')}</span>
        </button>
      </div>
      {bg.kind === 'custom' && (
        <div className="dk-pad-wrap">
          <div
            ref={pad}
            className="dk-pad"
            style={{ '--hue': `hsl(${hsv.h} 100% 50%)` } as CSSProperties}
            role="slider"
            tabIndex={0}
            aria-label={t('settings.dockDesigner.saturationAndBrightness')}
            aria-valuetext={t('settings.dockDesigner.saturationValue', { saturation: Math.round(hsv.s * 100), brightness: Math.round(hsv.v * 100) })}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              padAt(e)
            }}
            onPointerMove={(e) => e.buttons === 1 && padAt(e)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.02
              const map: Record<string, Partial<typeof hsv>> = { ArrowLeft: { s: hsv.s - step }, ArrowRight: { s: hsv.s + step }, ArrowUp: { v: hsv.v + step }, ArrowDown: { v: hsv.v - step } }
              const patch = map[e.key]
              if (!patch) return
              e.preventDefault()
              fromHsv({ ...hsv, s: Math.max(0, Math.min(1, patch.s ?? hsv.s)), v: Math.max(0, Math.min(1, patch.v ?? hsv.v)) })
            }}
          >
            <span className="dk-pad__thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
          </div>
          <label className="ui-sr-only" htmlFor={hueId}>{t('settings.dockDesigner.hue')}</label>
          <input id={hueId} className="dk-hue" type="range" min={0} max={359} value={Math.round(hsv.h)} onChange={(e) => fromHsv({ ...hsv, h: Number(e.target.value) })} />
          <div className="dk-hex">
            <label htmlFor={hexId}>{t('settings.dockDesigner.hex')}</label>
            <input
              id={hexId}
              className="co-input"
              value={hexText}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => {
                setHexText(e.target.value)
                const hex = parseHex(e.target.value)
                if (hex) {
                  setHsv(hexToHsv(hex))
                  setCustom(hex)
                }
              }}
              aria-invalid={parseHex(hexText) === null || undefined}
            />
          </div>
        </div>
      )}
    </fieldset>
  )
}

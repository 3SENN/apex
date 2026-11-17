/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-kit/guide.js (docs/apps.md › The cast): the person's companion in a
// corner of the app's own page, with a speech bubble, the way the welcome
// flow has one beside each step. The app decides what it says; Apex's
// runtime draws who says it. The app needs a cast in its manifest.
import * as THREE from 'three'
import type { CompanionLook, CompanionMood } from '@shared/companion'
import { character, type KitCharacter } from './character'

interface ApexCast {
  cast: { members(): Promise<Array<{ ref: string; name: string; look: CompanionLook }>> }
}

export interface Guide {
  /** The companion's name. */
  name: string
  /** Shows the bubble with this text (and a mood) for `ms`, or until the next say. */
  say(text: string, options?: { mood?: CompanionMood; ms?: number }): void
  /** Hides the bubble; the companion stays. */
  quiet(): void
  /** Shows or hides the whole guide. */
  show(visible: boolean): void
  dispose(): void
}

/** Puts the companion in a corner of the page. Rejects when the app has no cast. */
export async function guide(options: { corner?: 'bottom-right' | 'bottom-left'; size?: number } = {}): Promise<Guide> {
  const apex = (globalThis as unknown as { apex?: ApexCast }).apex
  if (!apex) throw new Error('apex-kit/guide.js runs in an app page, where window.apex is available.')
  const [me] = await apex.cast.members()
  if (!me) throw new Error('No companion is in this app’s cast. Add "cast" to the app in its manifest.')
  const size = Math.max(96, Math.min(320, options.size ?? 168))
  const left = options.corner === 'bottom-left'

  const box = document.createElement('div')
  box.setAttribute('data-apex-guide', '')
  Object.assign(box.style, { position: 'fixed', bottom: '12px', [left ? 'left' : 'right']: '12px', width: `${size}px`, zIndex: '2147483000', pointerEvents: 'none', display: 'grid', justifyItems: left ? 'start' : 'end' })
  const bubble = document.createElement('div')
  bubble.setAttribute('role', 'status')
  bubble.setAttribute('aria-live', 'polite')
  Object.assign(bubble.style, {
    maxWidth: `${Math.max(size, 240)}px`,
    padding: '8px 12px',
    marginBottom: '6px',
    borderRadius: '14px',
    background: 'Canvas',
    color: 'CanvasText',
    boxShadow: '0 4px 18px rgba(0,0,0,.18)',
    font: '14px/1.4 system-ui, sans-serif',
    visibility: 'hidden',
  })
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  box.append(bubble, canvas)
  document.body.append(box)

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(size, size)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8877aa, 2.2))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(2, 4, 3)
  scene.add(key)
  const pip: KitCharacter = await character(me.look, { mood: 'idle' })
  scene.add(pip.object3d)
  // Frame the whole figure: its rest bounds, a little room around it.
  const [minX, minY, minZ] = pip.bounds.min
  const [maxX, maxY, maxZ] = pip.bounds.max
  const height = maxY - minY
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50)
  const centre = new THREE.Vector3((minX + maxX) / 2, minY + height * 0.5, (minZ + maxZ) / 2)
  camera.position.set(centre.x, centre.y + height * 0.08, centre.z + (height * 1.25) / Math.tan(THREE.MathUtils.degToRad(15)) / 2)
  camera.lookAt(centre)

  let running = true
  let last = performance.now()
  let blinkIn = 2.5
  let quietTimer: ReturnType<typeof setTimeout> | null = null
  const frame = (now: number): void => {
    if (!running) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if ((blinkIn -= dt) < 0) {
      pip.blink()
      blinkIn = 2.5 + Math.random() * 2.5
    }
    if (!document.hidden && box.style.display !== 'none') {
      pip.update(dt)
      renderer.render(scene, camera)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  const quiet = (): void => {
    if (quietTimer) clearTimeout(quietTimer)
    quietTimer = null
    bubble.style.visibility = 'hidden'
    bubble.textContent = ''
    pip.setMood('idle')
  }

  return {
    name: me.name,
    say(text, o = {}) {
      bubble.textContent = String(text).slice(0, 400)
      bubble.style.visibility = 'visible'
      pip.setMood(o.mood ?? 'talking')
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(quiet, o.ms ?? Math.max(2_500, Math.min(9_000, text.length * 70)))
    },
    quiet,
    show(visible) {
      box.style.display = visible ? 'grid' : 'none'
    },
    dispose() {
      running = false
      quiet()
      pip.dispose()
      renderer.dispose()
      box.remove()
    },
  }
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import type { Bounds, Framing } from './layout'
import { CAMERA_FOV } from './layout'

function blobTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0, 'rgba(20, 12, 40, 1)')
    gradient.addColorStop(0.55, 'rgba(20, 12, 40, 0.55)')
    gradient.addColorStop(1, 'rgba(20, 12, 40, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 64, 64)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Scene, camera, cel lighting and a soft ground shadow, shared by live views and off-screen renders. */
export class Stage {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.05, 100)
  private readonly shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>
  private shadowRadius = 0.5

  constructor() {
    // Ambient + key sum to about π, so the lit toon band shows the tint at full value.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.85)
    key.position.set(2.5, 4, 6)
    this.scene.add(key)
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = 0.002
    this.shadow.renderOrder = -1
    this.scene.add(this.shadow)
  }

  frame(framing: Framing): void {
    const { camera } = this
    camera.position.set(0, framing.targetY + framing.distance * 0.06, framing.distance)
    camera.near = Math.max(0.01, framing.distance * 0.05)
    camera.far = framing.distance * 6
    camera.lookAt(0, framing.targetY, 0)
    camera.updateProjectionMatrix()
  }

  /** Face-only stills leave the ground out. */
  showShadow(visible: boolean): void {
    this.shadow.visible = visible
  }

  fitShadow(bounds: Bounds): void {
    const halfWidth = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]))
    this.shadowRadius = Math.max(0.2, Math.min(halfWidth, (bounds.max[1] - bounds.min[1]) * 0.45) * 0.85)
    this.lift(0)
  }

  /** Shrinks and fades the shadow as the character leaves the ground. */
  lift(height: number): void {
    const k = 1 - Math.min(0.55, Math.max(0, height) * 1.4)
    this.shadow.scale.set(this.shadowRadius * k, this.shadowRadius * k * 0.55, 1)
    this.shadow.material.opacity = 0.2 * k
  }

  dispose(): void {
    this.shadow.geometry.dispose()
    this.shadow.material.map?.dispose()
    this.shadow.material.dispose()
    this.scene.clear()
  }
}

/** Little four-point stars that pop around the head on `sparkle` cues. */
export class Sparkles {
  readonly group = new THREE.Group()
  private readonly geometry: THREE.ShapeGeometry
  private readonly materials: THREE.MeshBasicMaterial[]
  private readonly items: Array<{ mesh: THREE.Mesh; life: number; from: THREE.Vector3; to: THREE.Vector3; spin: number }> = []
  private starSize = 0.05

  constructor(accent: string, count = 5) {
    const shape = new THREE.Shape()
    const points = 8
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2 + Math.PI / 2
      const r = i % 2 === 0 ? 1 : 0.32
      const x = Math.cos(angle) * r
      const y = Math.sin(angle) * r
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    this.geometry = new THREE.ShapeGeometry(shape)
    this.materials = [0xffffff, accent].map(
      (color) => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, toneMapped: false }),
    )
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.materials[i % 2])
      mesh.visible = false
      mesh.renderOrder = 2
      this.group.add(mesh)
      this.items.push({ mesh, life: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), spin: 0 })
    }
  }

  setAccent(accent: string): void {
    this.materials[1]?.color.set(accent)
  }

  /** A full ring of stars around the whole figure, for celebrations. */
  ring(center: THREE.Vector3, radius: number, rng: () => number = Math.random): void {
    this.starSize = radius * 0.13
    this.items.forEach((item, i) => {
      const angle = (i / this.items.length) * Math.PI * 2 + (rng() - 0.5) * 0.3
      item.from.set(center.x + Math.cos(angle) * radius * 0.35, center.y + Math.sin(angle) * radius * 0.35, center.z + radius * 0.2)
      item.to.set(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius * 0.9 + radius * 0.15, center.z + radius * 0.3)
      item.life = 1 + i * 0.05
      item.spin = (rng() - 0.5) * 5
    })
  }

  burst(center: THREE.Vector3, radius: number, rng: () => number = Math.random): void {
    this.starSize = radius * 0.2
    this.items.forEach((item, i) => {
      const angle = (i / this.items.length) * Math.PI * 1.6 - Math.PI * 0.3 + (rng() - 0.5) * 0.5
      const reach = radius * (0.75 + rng() * 0.45)
      item.from.copy(center)
      item.to.set(center.x + Math.cos(angle) * reach, center.y + Math.sin(angle) * reach * 0.8 + radius * 0.25, center.z + radius * 0.3)
      item.life = 1 + i * 0.08
      item.spin = (rng() - 0.5) * 6
    })
  }

  update(dt: number): void {
    for (const item of this.items) {
      if (item.life <= 0) {
        item.mesh.visible = false
        continue
      }
      item.life = Math.max(0, item.life - dt / 0.8)
      const p = 1 - Math.min(1, item.life)
      const ease = 1 - (1 - p) * (1 - p)
      item.mesh.visible = item.life < 1
      item.mesh.position.lerpVectors(item.from, item.to, ease)
      item.mesh.rotation.z += item.spin * dt
      item.mesh.scale.setScalar(Math.max(1e-4, this.starSize * Math.sin(Math.PI * p)))
    }
  }

  dispose(): void {
    this.group.removeFromParent()
    this.geometry.dispose()
    for (const material of this.materials) material.dispose()
  }
}

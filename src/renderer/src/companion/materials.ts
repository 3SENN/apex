/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { TINTS, type Tint } from '@shared/companion'

/** Three light bands, sampled without filtering for the cel look. */
export function createToonGradient(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([96, 176, 255]), 3, 1, THREE.RedFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

export function tintOf(material: THREE.Material): Tint | null {
  const name = material.name
  if (!name.startsWith('tint:')) return null
  const tint = name.slice(5)
  return (TINTS as readonly string[]).includes(tint) ? (tint as Tint) : null
}

export function isFaceMaterial(material: THREE.Material): boolean {
  return material.name === 'face'
}

interface ColoredMaterial extends THREE.Material {
  color?: THREE.Color
  emissive?: THREE.Color
  emissiveIntensity?: number
}

/** A toon copy of a glTF material: same colour (or the tint), opacity and sidedness. */
export function createToonMaterial(source: THREE.Material, gradient: THREE.Texture, color: string | null): THREE.MeshToonMaterial {
  const src = source as ColoredMaterial
  const material = new THREE.MeshToonMaterial({
    name: source.name,
    gradientMap: gradient,
    transparent: source.transparent,
    opacity: source.opacity,
    side: source.side,
    alphaTest: source.alphaTest,
  })
  if (color) material.color.set(color)
  else if (src.color) material.color.copy(src.color)
  if (src.emissive && (src.emissive.r > 0 || src.emissive.g > 0 || src.emissive.b > 0)) {
    material.emissive.copy(src.emissive)
    material.emissiveIntensity = src.emissiveIntensity ?? 1
  }
  return material
}

/** Whether a mesh with this material gets an inverted hull: open or see-through surfaces do not. */
export function wantsOutline(material: THREE.Material): boolean {
  return !material.transparent && material.opacity >= 1 && material.side === THREE.FrontSide && !isFaceMaterial(material)
}

// The hull is pushed out along world-space normals, so its width is in world
// units whatever the node scale (quantized meshes carry a large one).
const OUTLINE_VERTEX = /* glsl */ `
uniform float thickness;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  world.xyz += n * thickness;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const OUTLINE_FRAGMENT = /* glsl */ `
uniform vec3 color;
void main() {
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`

export function createOutlineMaterial(color: string, thickness: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'outline',
    uniforms: {
      color: { value: new THREE.Color(color) },
      thickness: { value: thickness },
    },
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    side: THREE.BackSide,
  })
}

export function setOutline(material: THREE.ShaderMaterial, color: string | null, thickness: number | null): void {
  if (color !== null) (material.uniforms.color?.value as THREE.Color | undefined)?.set(color)
  if (thickness !== null && material.uniforms.thickness) material.uniforms.thickness.value = thickness
}

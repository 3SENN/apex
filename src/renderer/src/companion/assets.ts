/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import {
  COMPANION_ASSET_BASE,
  type AnimationEventsConfig,
  type CompanionManifest,
  type CompanionPreset,
  type CompatibilityConfig,
  type HatConfig,
  type PupilConfig,
  type RandomizationConfig,
} from '@shared/companion'
import { offeredPresets } from '@shared/branding'
import { reportCompanionError } from './stats'

// Every file is fetched and parsed once per URL. Rejected loads leave the
// cache so a later mount can retry.

export interface CompanionAssets {
  manifest: CompanionManifest
  compatibility: CompatibilityConfig
  hats: HatConfig
  pupils: PupilConfig
  randomization: RandomizationConfig
  animationEvents: AnimationEventsConfig
  presets: CompanionPreset[]
}

export interface LoadedModel {
  /** Shared template: clone it, never add it to a scene. */
  scene: THREE.Group
  animations: THREE.AnimationClip[]
}

export function assetUrl(file: string): string {
  return new URL(COMPANION_ASSET_BASE + file, document.baseURI).href
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit) return hit
  const promise = load()
  cache.set(key, promise)
  promise.catch((error: unknown) => {
    if (cache.get(key) === promise) cache.delete(key)
    reportCompanionError(`${key}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return promise
}

const jsonCache = new Map<string, Promise<unknown>>()
const modelCache = new Map<string, Promise<LoadedModel>>()
const imageCache = new Map<string, Promise<HTMLImageElement>>()
let assetsPromise: Promise<CompanionAssets> | null = null
const loadedListeners = new Set<() => void>()

/**
 * Calls `listener` each time a fresh load of the manifest and configs
 * succeeds, so views that fell back after a failed load can try again.
 * Returns the unsubscribe function.
 */
export function onCompanionAssetsLoaded(listener: () => void): () => void {
  loadedListeners.add(listener)
  return () => loadedListeners.delete(listener)
}

function loadJson<T>(file: string): Promise<T> {
  const url = assetUrl(file)
  return cached(jsonCache, url, async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as unknown
  }) as Promise<T>
}

/** The manifest and every config file, fetched once. */
export function loadCompanionAssets(): Promise<CompanionAssets> {
  if (assetsPromise) return assetsPromise
  const promise = (async (): Promise<CompanionAssets> => {
    const manifest = await loadJson<CompanionManifest>('manifest.json')
    if (manifest?.version !== 1 || !manifest.rigs || !manifest.parts || !manifest.face || !manifest.config) {
      throw new Error('companion manifest.json: unsupported format')
    }
    const { config } = manifest
    const [compatibility, hats, pupils, randomization, animationEvents, presets] = await Promise.all([
      loadJson<CompatibilityConfig>(config.compatibility),
      loadJson<HatConfig>(config.hats),
      loadJson<PupilConfig>(config.pupils),
      loadJson<RandomizationConfig>(config.randomization),
      loadJson<AnimationEventsConfig>(config.animationEvents),
      loadJson<CompanionPreset[] | { presets: CompanionPreset[] }>(config.presets),
    ])
    return {
      manifest,
      compatibility,
      hats,
      pupils,
      randomization,
      animationEvents,
      // Only the presets the branding offers: the gallery and first run match main's list.
      presets: offeredPresets(Array.isArray(presets) ? presets : (presets?.presets ?? [])),
    }
  })()
  assetsPromise = promise
  promise.then(
    () => {
      for (const listener of [...loadedListeners]) listener()
    },
    () => {
      if (assetsPromise === promise) assetsPromise = null
    },
  )
  return promise
}

let loader: GLTFLoader | null = null

function gltfLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
  }
  return loader
}

/** A rig or part template. Geometry and clips are shared by every clone. */
export function loadModel(file: string): Promise<LoadedModel> {
  const url = assetUrl(file)
  return cached(modelCache, url, async () => {
    const gltf = await gltfLoader().loadAsync(url)
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && !mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
    })
    gltf.scene.updateMatrixWorld(true)
    return { scene: gltf.scene, animations: gltf.animations }
  })
}

/** A decoded face layer image, shared by every compositor. */
export function loadImage(file: string): Promise<HTMLImageElement> {
  const url = assetUrl(file)
  return cached(imageCache, url, async () => {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return image
  })
}

/** Loads several face layers; failures are reported and left out of the map. */
export async function preloadImages(files: readonly string[]): Promise<Map<string, HTMLImageElement>> {
  const results = await Promise.allSettled(files.map(async (file) => [file, await loadImage(file)] as const))
  const images = new Map<string, HTMLImageElement>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const [file, image] = result.value
    images.set(file, image)
  }
  return images
}

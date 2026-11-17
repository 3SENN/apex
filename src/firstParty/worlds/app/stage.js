/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The world on screen: the scene atelier-kit/world.js builds from a world file,
// you and the residents as companions (atelier-kit/character.js), walking with
// the keys or by clicking (running with Shift, or to a spot far away), the
// camera that follows you, and speech bubbles.
// The editor (editor.js) uses the same stage with the camera let loose.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { character } from 'atelier-kit/character.js'
import { createWorldView } from 'atelier-kit/world.js'

/** World units a second: walking, and running (Shift, or a click far away). */
const WALK_SPEED = 2.4
const RUN_SPEED = 3.8
/** A click this far off runs there. */
const RUN_FROM = 6
/** Reduce Motion: you glide, legs still. */
const stillLegs = matchMedia('(prefers-reduced-motion: reduce)')
const NEAR = 1.8
const FOLLOW = new THREE.Vector3(0, 6.2, 8.4)

// ---- the format's rules, as the app needs them (docs/apps.md › Worlds) ----

const inArea = (a, x, z) => x >= a[0] && x <= a[2] && z >= a[1] && z <= a[3]

/** The ground of a tile: the last paint that covers it, else the base. */
export function groundAt(world, x, z) {
  for (let i = world.ground.paint.length - 1; i >= 0; i--) if (inArea(world.ground.paint[i].area, x, z)) return world.ground.paint[i].type
  return world.ground.base
}

/** The place a point is in (the last listed wins), or null. */
export function placeAt(world, x, z) {
  for (let i = world.places.length - 1; i >= 0; i--) if (inArea(world.places[i].area, Math.floor(x), Math.floor(z))) return world.places[i]
  return null
}

/** Where a resident stands: their spot, else the middle of their home, else the middle of the world. */
export function residentSpot(world, r) {
  if (r.at) return r.at
  const home = r.home ? world.places.find((p) => p.id === r.home) : null
  if (home) return [(home.area[0] + home.area[2] + 1) / 2, (home.area[1] + home.area[3] + 1) / 2]
  return [world.size[0] / 2, world.size[1] / 2]
}

/** Who a resident is here: a guest's own name and look, or the companion filling their spot (null: an empty spot). */
export const residentLook = (r, filled) => (r.guest ? { name: r.guest.name, look: r.guest.look } : (filled[r.id] ?? null))

const turnTowards = (from, to, t) => {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return from + d * t
}

const castShadows = (object) => object.traverse((o) => {
  if (o.isMesh) o.castShadow = true
})

export function createStage(canvas, layer, events = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600)
  const controls = new OrbitControls(camera, canvas)
  controls.enabled = false
  controls.enableDamping = true
  controls.maxPolarAngle = Math.PI * 0.47
  controls.minDistance = 4
  controls.maxDistance = 140
  const overlay = new THREE.Group()
  scene.add(overlay)
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  let world = null
  let filled = {}
  let view = null
  let mode = 'visit'
  let me = null
  let people = []
  let walkTo = null
  let near = null
  let inside = null
  let generation = 0
  const keys = new Set()
  const bubbles = new Map()

  const resize = () => {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  function clearPeople() {
    for (const p of people) {
      scene.remove(p.object)
      p.char.dispose()
    }
    people = []
  }

  /** Builds the residents again (after an edit, or a new world). */
  async function setPeople(doc, who) {
    const mine = ++generation
    filled = who ?? filled
    const built = await Promise.all(
      doc.residents.map(async (r) => {
        const look = residentLook(r, filled)
        if (!look) return null
        try {
          return { resident: r, name: look.name, char: await character(look.look) }
        } catch {
          return null
        }
      }),
    )
    if (mine !== generation) {
      for (const b of built) b?.char.dispose()
      return
    }
    clearPeople()
    for (const b of built) {
      if (!b) continue
      const [x, z] = residentSpot(doc, b.resident)
      b.char.object3d.position.set(x, 0, z)
      b.char.object3d.rotation.y = Math.atan2((doc.spawn?.[0] ?? doc.size[0] / 2) - x, (doc.spawn?.[1] ?? doc.size[1] / 2) - z)
      castShadows(b.char.object3d)
      scene.add(b.char.object3d)
      people.push({ id: b.resident.id, name: b.name, resident: b.resident, char: b.char, object: b.char.object3d, x, z, blinkAt: Math.random() * 4 })
    }
  }

  /** Shows a world: its ground, props, places and sky, the residents, and you at the spawn point. */
  async function load(doc, who, myLook) {
    world = doc
    if (view) {
      scene.remove(view.root, view.lights)
      view.dispose()
    }
    view = createWorldView(doc, { labels: true })
    scene.add(view.root, view.lights)
    scene.background = view.sky
    scene.fog = new THREE.Fog(view.sky, view.fog.near, view.fog.far)
    if (me?.char) {
      scene.remove(me.object)
      me.char.dispose()
    }
    const [sx, sz] = doc.spawn ?? [doc.size[0] / 2, doc.size[1] / 2]
    me = { char: null, object: new THREE.Group(), x: sx, z: sz, facing: 0, gait: null }
    if (myLook) {
      try {
        const c = await character(myLook.look)
        castShadows(c.object3d)
        me = { char: c, object: c.object3d, name: myLook.name, x: sx, z: sz, facing: 0, gait: null }
      } catch {
        // Without the companion art you still walk, unseen.
      }
    }
    scene.add(me.object)
    await setPeople(doc, who)
    frame()
  }

  /** Points the camera: behind you while you visit; over the whole world while you edit. */
  function frame() {
    if (!world) return
    const [w, d] = world.size
    if (mode === 'edit') {
      const c = world.camera
      camera.position.set(...(c?.at ?? [w / 2, Math.max(w, d) * 0.8, d * 1.15]))
      controls.target.set(...(c?.lookAt ?? [w / 2, 0, d / 2]))
      controls.update()
    } else {
      camera.position.set(me.x + FOLLOW.x, FOLLOW.y, me.z + FOLLOW.z)
      camera.lookAt(me.x, 0.6, me.z)
    }
  }

  function setMode(next) {
    mode = next
    controls.enabled = next === 'edit'
    walkTo = null
    keys.clear()
    if (me?.gait) {
      me.gait = null
      me.char?.move(null)
    }
    if (me) me.object.visible = next !== 'edit'
    frame()
  }

  /** Rebuilds the scene from a changed world (the editor), keeping the camera where it is. */
  function rebuild(doc) {
    world = doc
    view.rebuild(doc)
    scene.background = view.sky
    scene.fog = new THREE.Fog(view.sky, view.fog.near, view.fog.far)
  }

  /** Says a line over someone's head for a few seconds; `id` is a resident's, or 'me'. */
  function say(id, name, text, seconds = 6) {
    const old = bubbles.get(id)
    old?.el.remove()
    const el = document.createElement('div')
    el.className = 'bubble'
    const who = document.createElement('span')
    who.className = 'bubble__name'
    who.textContent = name
    el.append(who, document.createTextNode(text))
    layer.append(el)
    bubbles.set(id, { el, until: performance.now() + seconds * 1000 })
    const person = people.find((p) => p.id === id)
    person?.char.setMood('talking')
    setTimeout(() => {
      if (bubbles.get(id)?.el === el) person?.char.setMood('idle')
    }, seconds * 1000)
  }

  const head = new THREE.Vector3()
  function placeBubbles(now) {
    for (const [id, b] of bubbles) {
      if (now > b.until) {
        b.el.remove()
        bubbles.delete(id)
        continue
      }
      const object = id === 'me' ? me?.object : people.find((p) => p.id === id)?.object
      if (!object) continue
      head.set(object.position.x, object.position.y + 1.45, object.position.z).project(camera)
      b.el.style.left = `${((head.x + 1) / 2) * canvas.clientWidth}px`
      b.el.style.top = `${((1 - head.y) / 2) * canvas.clientHeight}px`
      b.el.hidden = head.z > 1
    }
  }

  function walk(dt) {
    let dx = 0
    let dz = 0
    if (keys.has('w') || keys.has('arrowup')) dz -= 1
    if (keys.has('s') || keys.has('arrowdown')) dz += 1
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1
    if (keys.has('d') || keys.has('arrowright')) dx += 1
    if (dx || dz) walkTo = null
    else if (walkTo) {
      dx = walkTo.x - me.x
      dz = walkTo.z - me.z
      if (Math.hypot(dx, dz) < 0.12) {
        walkTo = null
        dx = 0
        dz = 0
      }
    }
    const running = keys.has('shift') || walkTo?.run === true
    const speed = running ? RUN_SPEED : WALK_SPEED
    let gait = null
    if (dx || dz) {
      const len = Math.hypot(dx, dz)
      dx /= len
      dz /= len
      const [w, d] = world.size
      const nx = Math.min(w - 0.3, Math.max(0.3, me.x + dx * speed * dt))
      const nz = Math.min(d - 0.3, Math.max(0.3, me.z + dz * speed * dt))
      // Water is for looking at.
      if (groundAt(world, Math.floor(nx), Math.floor(nz)) !== 'water') {
        me.x = nx
        me.z = nz
      } else walkTo = null
      me.facing = Math.atan2(dx, dz)
      gait = stillLegs.matches ? null : running ? 'run' : 'walk'
    }
    // Only a change of gait reaches the animator.
    if (gait !== me.gait) {
      me.gait = gait
      me.char?.move(gait, speed)
    }
    me.object.position.set(me.x, 0, me.z)
    me.object.rotation.y = turnTowards(me.object.rotation.y, me.facing, 0.25)

    let best = null
    for (const p of people) {
      const dist = Math.hypot(p.x - me.x, p.z - me.z)
      if (dist < NEAR && (!best || dist < best.dist)) best = { person: p, dist }
    }
    const place = placeAt(world, me.x, me.z)
    if (best?.person !== near || place !== inside) {
      near = best?.person ?? null
      inside = place
      events.onWhere?.({ near, place: inside })
    }
    // Residents turn to you when you come close.
    if (near) near.object.rotation.y = turnTowards(near.object.rotation.y, Math.atan2(me.x - near.x, me.z - near.z), 0.12)
  }

  let last = performance.now()
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (world && me) {
      if (mode === 'visit') {
        walk(dt)
        const at = new THREE.Vector3(me.x + FOLLOW.x, FOLLOW.y, me.z + FOLLOW.z)
        camera.position.lerp(at, 0.08)
        camera.lookAt(me.x, 0.6, me.z)
      } else controls.update()
      me.char?.update(dt)
      for (const p of people) {
        p.char.update(dt)
        p.blinkAt -= dt
        if (p.blinkAt < 0) {
          p.char.blink()
          p.blinkAt = 2.5 + Math.random() * 3
        }
      }
      renderer.render(scene, camera)
      placeBubbles(now)
      events.onFrame?.()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  /** The tile under a pointer event, or null off the ground. */
  function pick(event) {
    if (!view) return null
    const rect = canvas.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(view.ground, false)[0]
    return hit ? { x: hit.point.x, z: hit.point.z } : null
  }

  window.addEventListener('keydown', (e) => {
    if (mode !== 'visit' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
    const k = e.key.toLowerCase()
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keys.add(k)
      e.preventDefault()
    } else if (k === 'shift') keys.add(k)
    else if (k === 'e' && near) events.onTalk?.(near)
    else if (k === 'enter' && inside?.opens) events.onEnter?.(inside)
  })
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
  window.addEventListener('blur', () => keys.clear())
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'visit' || e.button !== 0) return
    const at = pick(e)
    if (!at) return
    // Clicking someone close by talks to them; anywhere else walks there.
    const person = people.find((p) => Math.hypot(p.x - at.x, p.z - at.z) < 0.6)
    if (person && Math.hypot(person.x - me.x, person.z - me.z) < NEAR + 0.4) events.onTalk?.(person)
    else walkTo = { ...at, run: Math.hypot(at.x - me.x, at.z - me.z) > RUN_FROM }
  })

  return {
    scene,
    camera,
    controls,
    overlay,
    get world() {
      return world
    },
    get people() {
      return people
    },
    get where() {
      return { near, place: inside, me: me ? [me.x, me.z] : null }
    },
    load,
    setPeople,
    setMode,
    rebuild,
    say,
    pick,
    frame,
    /** Puts you somewhere at once (tests, and coming back out of a place). */
    teleport(x, z) {
      me.x = x
      me.z = z
      walkTo = null
      frame()
    },
  }
}

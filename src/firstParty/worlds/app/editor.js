/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The world editor: paint the ground, place the kit's props, draw places and
// link them to apps, add residents, choose the palette and the sky. Every
// change can be undone. The world stays a plain world file the whole time:
// the ground is kept as a tile grid while you paint and written back as the
// fewest rectangles that cover it.
import * as THREE from 'three'
import { PROPS } from 'atelier-kit/props.js'
import { t } from './i18n.js'
import { groundAt, residentSpot } from './stage.js'

const GROUNDS = ['grass', 'path', 'sand', 'boards', 'stone', 'floor', 'water', 'snow']
const PALETTES = ['meadow', 'seaside', 'city', 'snow', 'dusk']
const SKIES = ['morning', 'midday', 'late-afternoon', 'dusk', 'night']
const MAX_PAINTS = 2000
const TOOLS = [
  ['select', 'Select'],
  ['ground', 'Ground'],
  ['prop', 'Props'],
  ['place', 'Places'],
  ['person', 'People'],
  ['look', 'Look around'],
]
/** A palette, sky or ground id as words, in English (t() translates them): late-afternoon, Late afternoon. */
const words = (id) => id[0].toUpperCase() + id.slice(1).replace('-', ' ')

/** Guests the editor offers: residents of the world itself, not anyone's companion. */
export const GUESTS = [
  { name: 'Tilly', look: { rig: 'B', parts: { head: 'head-oval', ears: null, hair: 'hair-bun', hat: null, eyeAccessory: 'glasses-round', earAccessory: null, prop: null }, face: { eyes: 'eyes-oval', brows: 'brows-thin', mouth: 'mouth-small' }, colors: { skin: '#ffd2a8', hair: '#c0583c', accent: '#fff3c4', outfit: '#e0705a' } } },
  { name: 'Rook', look: { rig: 'A', parts: { head: 'head-bean', ears: null, hair: 'hair-sideswept', hat: 'hat-beret', eyeAccessory: null, earAccessory: null, prop: null }, face: { eyes: 'eyes-cat', brows: 'brows-bold', mouth: 'mouth-smile' }, colors: { skin: '#9fd8c8', hair: '#24414f', accent: '#ffe08a', outfit: '#3a78b0' } } },
  { name: 'Fern', look: { rig: 'A', parts: { head: 'head-round', ears: null, hair: 'hair-tuft', hat: null, eyeAccessory: null, earAccessory: null, prop: null }, face: { eyes: 'eyes-round', brows: 'brows-soft', mouth: 'mouth-smile' }, colors: { skin: '#b9e68a', hair: '#4f7a2a', accent: '#ffd6e8', outfit: '#6fae4a' } } },
  { name: 'Juno', look: { rig: 'C', parts: { head: 'head-cloud', ears: 'ears-bunny', hair: null, hat: null, eyeAccessory: null, earAccessory: null, prop: null }, face: { eyes: 'eyes-sparkle', brows: 'brows-soft', mouth: 'mouth-cat' }, colors: { skin: '#cfe0ff', hair: '#6b7fd8', accent: '#ffc2e2', outfit: '#8a7cf0' } } },
]

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'on') for (const [event, fn] of Object.entries(v)) node.addEventListener(event, fn)
    else if (k in node) node[k] = v
    else node.setAttribute(k, v)
  }
  node.append(...children)
  return node
}

const freeId = (taken, base) => {
  let n = 1
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function createEditor(stage, panel, options = {}) {
  const canvas = stage.controls.domElement
  let active = false
  let world = null
  let grid = null
  let tool = 'select'
  let ground = 'path'
  let brush = 1
  let propKind = 'tree'
  let turn = 0
  let guest = 0
  let selected = null
  let drag = null
  let apps = []
  let warning = ''
  const undo = []
  const redo = []

  // What the editor draws over the world: the brush or prop under the pointer, the selection, a place being drawn.
  const accent = new THREE.MeshBasicMaterial({ color: '#6a4bff', transparent: true, opacity: 0.35, depthWrite: false })
  const cursor = new THREE.Mesh(new THREE.BoxGeometry(1, 0.08, 1), accent)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 28), new THREE.MeshBasicMaterial({ color: '#6a4bff', side: THREE.DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  const drawing = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1), accent)
  stage.overlay.add(cursor, ring, drawing)
  stage.overlay.visible = false

  // ---- the ground as a grid while you paint ----

  function readGrid() {
    const [w, d] = world.size
    grid = new Uint8Array(w * d)
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) grid[z * w + x] = GROUNDS.indexOf(groundAt(world, x, z))
  }

  /** The grid as the fewest rectangles: runs of one ground in a row, joined with the same run in the rows below. */
  function writeGrid() {
    const [w, d] = world.size
    const base = GROUNDS.indexOf(world.ground.base)
    const out = []
    let open = new Map()
    for (let z = 0; z < d; z++) {
      const next = new Map()
      for (let x = 0; x < w; ) {
        const t = grid[z * w + x]
        let x1 = x
        while (x1 + 1 < w && grid[z * w + x1 + 1] === t) x1++
        if (t !== base) {
          const key = `${x},${x1},${t}`
          const above = open.get(key)
          if (above) {
            above.area[3] = z
            next.set(key, above)
          } else {
            const paint = { type: GROUNDS[t], area: [x, z, x1, z] }
            out.push(paint)
            next.set(key, paint)
          }
        }
        x = x1 + 1
      }
      open = next
    }
    world.ground.paint = out
    warning = out.length > MAX_PAINTS ? t('The ground has {n} painted areas; a world keeps {max}. Paint bigger, plainer areas to save it.', { n: out.length, max: MAX_PAINTS }) : ''
  }

  // ---- changes ----

  function remember() {
    undo.push(JSON.stringify(world))
    if (undo.length > 100) undo.shift()
    redo.length = 0
  }

  function changed({ people = false } = {}) {
    stage.rebuild(world)
    if (people) void stage.setPeople(world)
    render()
    options.onChange?.()
  }

  function restore(from, to) {
    const text = from.pop()
    if (!text) return
    to.push(JSON.stringify(world))
    world = JSON.parse(text)
    selected = null
    readGrid()
    changed({ people: true })
  }

  /** Keeps the world inside its size after it shrinks: what falls outside goes. */
  function fit() {
    const [w, d] = world.size
    world.props = world.props.filter((p) => p.at[0] <= w && p.at[2] <= d)
    world.places = world.places
      .map((p) => ({ ...p, area: [p.area[0], p.area[1], Math.min(p.area[2], w - 1), Math.min(p.area[3], d - 1)] }))
      .filter((p) => p.area[0] <= p.area[2] && p.area[1] <= p.area[3])
    const places = new Set(world.places.map((p) => p.id))
    world.residents = world.residents.map((r) => (r.home && !places.has(r.home) ? { ...r, home: undefined } : r)).filter((r) => !r.at || (r.at[0] <= w && r.at[1] <= d))
    if (world.spawn && (world.spawn[0] > w || world.spawn[1] > d)) world.spawn = [w / 2, d / 2]
  }

  /** After a size change: what falls outside goes, and the ground is written again within the new size. */
  function resized() {
    fit()
    readGrid()
    writeGrid()
  }

  // ---- what is under the pointer ----

  function hit(at) {
    let best = null
    for (const [index, p] of world.props.entries()) {
      const dist = Math.hypot(p.at[0] - at.x, p.at[2] - at.z)
      if (dist < 0.9 && (!best || dist < best.dist)) best = { kind: 'prop', index, dist }
    }
    for (const [index, r] of world.residents.entries()) {
      const [x, z] = residentSpot(world, r)
      const dist = Math.hypot(x - at.x, z - at.z)
      if (dist < 0.7 && (!best || dist < best.dist)) best = { kind: 'resident', index, dist }
    }
    if (best) return best
    for (let index = world.places.length - 1; index >= 0; index--) {
      const a = world.places[index].area
      if (at.x >= a[0] && at.x < a[2] + 1 && at.z >= a[1] && at.z < a[3] + 1) return { kind: 'place', index }
    }
    return null
  }

  function paint(at) {
    const [w, d] = world.size
    const t = GROUNDS.indexOf(ground)
    const r = Math.floor(brush / 2)
    for (let z = Math.floor(at.z) - r; z <= Math.floor(at.z) + r; z++) for (let x = Math.floor(at.x) - r; x <= Math.floor(at.x) + r; x++) if (x >= 0 && z >= 0 && x < w && z < d) grid[z * w + x] = t
  }

  const tileArea = (a, b) => [Math.max(0, Math.floor(Math.min(a.x, b.x))), Math.max(0, Math.floor(Math.min(a.z, b.z))), Math.min(world.size[0] - 1, Math.floor(Math.max(a.x, b.x))), Math.min(world.size[1] - 1, Math.floor(Math.max(a.z, b.z)))]

  function showCursor(at) {
    cursor.visible = Boolean(at) && (tool === 'ground' || tool === 'prop' || tool === 'person')
    if (!at || !cursor.visible) return
    if (tool === 'prop') {
      const [fw, fd] = PROPS[propKind].footprint
      const sideways = Math.round(turn / 90) % 2 !== 0
      cursor.scale.set(sideways ? fd : fw, 1, sideways ? fw : fd)
      cursor.position.set(Math.floor(at.x) + 0.5, 0.05, Math.floor(at.z) + 0.5)
    } else if (tool === 'ground') {
      cursor.scale.set(brush, 1, brush)
      cursor.position.set(Math.floor(at.x) + 0.5, 0.05, Math.floor(at.z) + 0.5)
    } else {
      cursor.scale.set(0.8, 1, 0.8)
      cursor.position.set(at.x, 0.05, at.z)
    }
  }

  function showSelection() {
    ring.visible = false
    if (!selected) return
    if (selected.kind === 'prop') {
      const p = world.props[selected.index]
      ring.position.set(p.at[0], 0.06, p.at[2])
      ring.visible = true
    } else if (selected.kind === 'resident') {
      const [x, z] = residentSpot(world, world.residents[selected.index])
      ring.position.set(x, 0.06, z)
      ring.visible = true
    }
  }

  // ---- pointer and keys ----

  canvas.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0 || tool === 'look') return
    const at = stage.pick(e)
    if (!at) return
    canvas.setPointerCapture(e.pointerId)
    if (tool === 'ground') {
      remember()
      drag = { kind: 'paint' }
      paint(at)
      writeGrid()
      changed()
    } else if (tool === 'prop') {
      remember()
      world.props.push({ kit: propKind, at: [Math.floor(at.x) + 0.5, 0, Math.floor(at.z) + 0.5], ...(turn ? { turn } : {}) })
      selected = { kind: 'prop', index: world.props.length - 1 }
      changed()
    } else if (tool === 'place') {
      drag = { kind: 'place', from: at, to: at }
    } else if (tool === 'person') {
      remember()
      const id = freeId(world.residents.map((r) => r.id), 'resident')
      const resident = guest < GUESTS.length ? { id, guest: { name: GUESTS[guest].name, look: GUESTS[guest].look, personality: '' }, at: [at.x, at.z] } : { id, companion: 'local', at: [at.x, at.z] }
      world.residents.push(resident)
      selected = { kind: 'resident', index: world.residents.length - 1 }
      changed({ people: true })
    } else {
      selected = hit(at)
      if (selected && selected.kind !== 'place') {
        remember()
        drag = { kind: 'move', moved: false }
      }
      render()
    }
  })

  canvas.addEventListener('pointermove', (e) => {
    if (!active) return
    const at = stage.pick(e)
    showCursor(at)
    if (!drag || !at) return
    if (drag.kind === 'paint') {
      paint(at)
      writeGrid()
      stage.rebuild(world)
    } else if (drag.kind === 'place') {
      drag.to = at
      const a = tileArea(drag.from, drag.to)
      drawing.visible = true
      drawing.scale.set(a[2] - a[0] + 1, 1, a[3] - a[1] + 1)
      drawing.position.set((a[0] + a[2] + 1) / 2, 0.04, (a[1] + a[3] + 1) / 2)
    } else if (drag.kind === 'move' && selected) {
      drag.moved = true
      if (selected.kind === 'prop') world.props[selected.index].at = [Math.floor(at.x) + 0.5, 0, Math.floor(at.z) + 0.5]
      else world.residents[selected.index].at = [Math.round(at.x * 4) / 4, Math.round(at.z * 4) / 4]
      stage.rebuild(world)
      if (selected.kind === 'resident') void stage.setPeople(world)
      showSelection()
    }
  })

  canvas.addEventListener('pointerup', () => {
    if (!active || !drag) return
    const finished = drag
    drag = null
    drawing.visible = false
    if (finished.kind === 'place') {
      remember()
      const id = freeId(world.places.map((p) => p.id), 'place')
      world.places.push({ id, name: t('Place {n}', { n: world.places.length + 1 }), area: tileArea(finished.from, finished.to) })
      selected = { kind: 'place', index: world.places.length - 1 }
      changed()
    } else if (finished.kind === 'move') {
      if (!finished.moved) undo.pop()
      else changed({ people: selected?.kind === 'resident' })
    } else if (finished.kind === 'paint') render()
  })

  window.addEventListener('keydown', (e) => {
    if (!active || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) restore(redo, undo)
      else restore(undo, redo)
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      restore(redo, undo)
    } else if (e.key.toLowerCase() === 'r') {
      if (selected?.kind === 'prop') {
        remember()
        const p = world.props[selected.index]
        p.turn = ((p.turn ?? 0) + 90) % 360
        changed()
      } else turn = (turn + 90) % 360
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      removeSelected()
    }
  })

  function removeSelected() {
    if (!selected) return
    remember()
    if (selected.kind === 'prop') world.props.splice(selected.index, 1)
    else if (selected.kind === 'resident') world.residents.splice(selected.index, 1)
    else {
      const [gone] = world.places.splice(selected.index, 1)
      world.residents = world.residents.map((r) => (r.home === gone.id ? { ...r, home: undefined } : r))
    }
    const people = selected.kind !== 'prop'
    selected = null
    changed({ people })
  }

  function setTool(next) {
    tool = next
    // Look around: the left button orbits. Otherwise it is the tool's, and the right button orbits.
    stage.controls.mouseButtons = { LEFT: next === 'look' ? THREE.MOUSE.ROTATE : null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    cursor.visible = false
    render()
  }

  // ---- the panel ----

  /** A field that remembers one undo step when you start typing in it, and rebuilds when you leave it. */
  function field(label, value, apply, options = {}) {
    const input = el(options.area ? 'textarea' : 'input', { value: value ?? '', ...(options.area ? { rows: 3 } : { type: options.type ?? 'text' }), ...(options.max ? { maxLength: options.max } : {}) })
    let started = false
    input.addEventListener('input', () => {
      if (!started) {
        remember()
        started = true
      }
      apply(input.value)
      options.onChange?.()
    })
    input.addEventListener('change', () => {
      started = false
      changed({ people: options.people })
    })
    return el('label', {}, [t(label), input])
  }

  function select(label, value, choices, apply) {
    const s = el('select', { on: { change: () => {
      remember()
      apply(s.value)
      changed({ people: true })
    } } }, choices.map(([v, text]) => el('option', { value: v, textContent: text, selected: v === value })))
    return el('label', {}, [t(label), s])
  }

  function chips(list, current, pick) {
    return el('div', { className: 'chips' }, list.map(([value, label]) => el('button', { type: 'button', className: 'btn btn--small', textContent: t(label), 'aria-pressed': String(value === current), on: { click: () => pick(value) } })))
  }

  function selectionPanel() {
    if (!selected) return el('p', { className: 'note', textContent: tool === 'select' ? t('Click a prop, a resident or a place to change it. Drag props and residents to move them; R turns a prop, Delete removes.') : '' })
    const box = el('div', { className: 'selected' })
    const remove = el('button', { type: 'button', className: 'btn btn--small', textContent: t('Remove'), on: { click: removeSelected } })
    if (selected.kind === 'prop') {
      const p = world.props[selected.index]
      box.append(el('strong', { textContent: t(PROPS[p.kit].name) }))
      box.append(el('div', { className: 'row' }, [
        el('button', { type: 'button', className: 'btn btn--small', textContent: t('Turn'), on: { click: () => {
          remember()
          p.turn = ((p.turn ?? 0) + 90) % 360
          changed()
        } } }),
        el('label', {}, [t('Colour'), el('input', { type: 'color', value: p.tint?.accent ?? '#ff8a5c', on: { change: (e) => {
          remember()
          p.tint = { accent: e.target.value }
          changed()
        } } })]),
        remove,
      ]))
    } else if (selected.kind === 'place') {
      const p = world.places[selected.index]
      box.append(field('Name', p.name, (v) => (p.name = v.slice(0, 60) || t('Place')), { max: 60 }))
      const choices = [['', t('Opens nothing')], ...apps.map((a) => [`${a.pack}/${a.app}`, `${a.packName}: ${a.name}`])]
      if (p.opens && !apps.some((a) => a.pack === p.opens.pack && a.app === p.opens.app)) choices.push([`${p.opens.pack}/${p.opens.app}`, t('{name} (not installed)', { name: `${p.opens.pack}: ${p.opens.app}` })])
      box.append(select('Opens', p.opens ? `${p.opens.pack}/${p.opens.app}` : '', choices, (v) => {
        if (!v) delete p.opens
        else {
          const [pack, app] = v.split('/')
          p.opens = { pack, app }
        }
      }))
      box.append(remove)
    } else {
      const r = world.residents[selected.index]
      const places = [['', t('No home')], ...world.places.map((p) => [p.id, p.name])]
      if (r.guest) {
        box.append(el('strong', { textContent: t('A guest of this world') }))
        box.append(field('Name', r.guest.name, (v) => (r.guest.name = v.slice(0, 24) || t('Guest')), { max: 24, people: true }))
        box.append(field('Personality', r.guest.personality ?? '', (v) => (r.guest.personality = v.slice(0, 1000)), { area: true, max: 1000 }))
      } else box.append(el('strong', { textContent: t('An open spot: one of your companions lives here, and one of theirs for whoever adds the world.') }))
      box.append(field('What they do here', r.role ?? '', (v) => (r.role = v.slice(0, 120) || undefined), { max: 120 }))
      box.append(select('Home', r.home ?? '', places, (v) => (r.home = v || undefined)))
      box.append(remove)
    }
    return box
  }

  function render() {
    if (!active) return
    showSelection()
    panel.replaceChildren(
      el('div', {}, [
        el('h3', { textContent: t('World') }),
        field('Name', world.name, (v) => {
          world.name = v.slice(0, 80) || 'World'
          document.getElementById('world-name').textContent = world.name
        }, { max: 80 }),
        select('Palette', world.palette, PALETTES.map((p) => [p, t(words(p))]), (v) => (world.palette = v)),
        select('Sky', world.sky, SKIES.map((s) => [s, t(words(s))]), (v) => (world.sky = v)),
        el('div', { className: 'row' }, [
          field('Width', world.size[0], (v) => (world.size = [Math.min(128, Math.max(8, Number(v) || 8)), world.size[1]]), { type: 'number', onChange: resized }),
          field('Depth', world.size[1], (v) => (world.size = [world.size[0], Math.min(128, Math.max(8, Number(v) || 8))]), { type: 'number', onChange: resized }),
        ]),
      ]),
      el('div', {}, [el('h3', { textContent: t('Tools') }), chips(TOOLS, tool, setTool)]),
      tool === 'ground' ? el('div', {}, [
        el('h3', { textContent: t('Ground') }),
        chips(GROUNDS.map((g) => [g, words(g)]), ground, (g) => ((ground = g), render())),
        el('h3', { textContent: t('Brush') }),
        chips([[1, 'Small'], [3, 'Medium'], [5, 'Large']], brush, (b) => ((brush = b), render())),
      ]) : '',
      tool === 'prop' ? el('div', {}, [el('h3', { textContent: t('Props') }), chips(Object.entries(PROPS).map(([id, p]) => [id, p.name]), propKind, (id) => ((propKind = id), render())), el('p', { className: 'note', textContent: t('Click to place; R turns it.') })]) : '',
      tool === 'person' ? el('div', {}, [el('h3', { textContent: t('Who') }), chips([...GUESTS.map((g, i) => [i, g.name]), [GUESTS.length, 'Open spot']], guest, (g) => ((guest = g), render())), el('p', { className: 'note', textContent: t('Click to add them. Guests come with the world; an open spot is filled with a companion of whoever visits.') })]) : '',
      tool === 'place' ? el('p', { className: 'note', textContent: t('Drag over the ground to draw a place, then pick the app it opens.') }) : '',
      el('div', {}, [el('h3', { textContent: t('Selected') }), selectionPanel()]),
      el('div', { className: 'row' }, [
        el('button', { type: 'button', className: 'btn btn--small', textContent: t('Undo'), disabled: undo.length === 0, on: { click: () => restore(undo, redo) } }),
        el('button', { type: 'button', className: 'btn btn--small', textContent: t('Redo'), disabled: redo.length === 0, on: { click: () => restore(redo, undo) } }),
      ]),
      warning ? el('p', { className: 'note', textContent: warning }) : '',
    )
  }

  return {
    /** Starts editing a copy of a world. */
    async start(doc) {
      world = JSON.parse(JSON.stringify(doc))
      readGrid()
      undo.length = 0
      redo.length = 0
      selected = null
      warning = ''
      active = true
      panel.hidden = false
      stage.overlay.visible = true
      setTool('select')
      apps = await (options.apps?.() ?? [])
      render()
    },
    stop() {
      active = false
      panel.hidden = true
      stage.overlay.visible = false
      stage.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    },
    /** The world as edited now. */
    world: () => JSON.parse(JSON.stringify(world)),
  }
}

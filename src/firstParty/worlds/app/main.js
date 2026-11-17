/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Worlds (docs/apps.md › Worlds): Apex's world viewer and editor, a kit app
// like any other. Home lists your worlds and the ones packs bring. A world
// opens to walk around in as your companion: residents talk when you walk up
// to them, and stepping into a place opens its app with the residents there
// as its cast. Edit builds a world of your own; Share… saves it as an
// .apexworld that anyone can open, with their own companions in its open spots.
import { createEditor } from './editor.js'
import { t, translatePage } from './i18n.js'
import { createStage } from './stage.js'

translatePage()

const $ = (id) => document.getElementById(id)
const stage = createStage($('view'), $('bubbles'), { onWhere: hint, onTalk: talk, onEnter: enter, onFrame: report })
let unsaved = false
const editor = createEditor(stage, $('tools'), {
  apps: () => apex.worlds.apps().catch(() => []),
  onChange: () => {
    unsaved = true
    $('done').disabled = false
  },
})
let current = null
let screen = 'home'
/** Where opening a world got to, for the smoke test's report when it stops: 'world', 'companion', 'stage', 'shown'. */
let opening = null
let me = null
const talking = new Set()

const note = (id, text) => ($(id).textContent = text ?? '')
const errorText = (err) => (err && err.message ? err.message : String(err))

/** The person's companion: who you walk around as. */
async function myCompanion() {
  try {
    const [first] = await apex.cast.members()
    return first ? { name: first.name, look: first.look } : null
  } catch {
    return null
  }
}

function go(ref, mode = 'visit') {
  location.hash = `${mode === 'edit' ? 'edit' : 'world'}=${encodeURIComponent(ref)}`
}

/** Leaving the editor with changes it hasn't saved asks first. */
function mayLeave() {
  if (screen !== 'edit' || !unsaved) return true
  return window.confirm(t('Leave without saving your changes to this world?'))
}

let lastHash = location.hash
function route() {
  if (location.hash !== lastHash && !mayLeave()) {
    // Stay: put the address back without going anywhere.
    history.replaceState(null, '', lastHash || location.pathname)
    return
  }
  lastHash = location.hash
  unsaved = false
  const params = new URLSearchParams(location.hash.slice(1))
  const visit = params.get('world')
  const edit = params.get('edit')
  if (visit) void open(visit, 'visit')
  else if (edit) void open(edit, 'edit')
  else void showHome()
}

// ---- home ----

function button(label, onClick, kind = '') {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `btn btn--small ${kind}`
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

async function showHome() {
  screen = 'home'
  editor.stop()
  $('stage').hidden = true
  $('home').hidden = false
  note('home-note', '')
  const list = $('world-list')
  let worlds = []
  try {
    worlds = await apex.worlds.list()
  } catch (err) {
    note('home-note', errorText(err))
  }
  list.replaceChildren()
  if (worlds.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = t('No worlds yet. Start one with New world.')
    list.append(empty)
  }
  for (const w of worlds) {
    const card = document.createElement('li')
    card.className = 'card'
    const title = document.createElement('h2')
    title.textContent = w.name
    const meta = document.createElement('p')
    meta.textContent = `${w.from === 'own' ? t('Yours') : t('From {from}', { from: w.from })} · ${t(w.places === 1 ? '{n} place' : '{n} places', { n: w.places })} · ${t(w.residents === 1 ? '{n} resident' : '{n} residents', { n: w.residents })}`
    card.append(title, meta)
    if (w.description) {
      const about = document.createElement('p')
      about.textContent = w.description
      card.append(about)
    }
    const actions = document.createElement('div')
    actions.className = 'card__actions'
    actions.append(button(t('Visit'), () => go(w.ref), 'btn--primary'))
    if (w.editable) {
      actions.append(button(t('Edit'), () => go(w.ref, 'edit')))
      actions.append(button(t('Share…'), () => void share(w.ref, 'home-note')))
      const remove = button(t('Remove'), async () => {
        // A second click removes it, so one slip never does.
        if (remove.dataset.sure !== '1') {
          remove.dataset.sure = '1'
          remove.textContent = t('Click again to remove')
          return
        }
        await apex.worlds.remove(w.ref).catch((err) => note('home-note', errorText(err)))
        void showHome()
      })
      actions.append(remove)
    } else actions.append(button(t('Make a copy'), () => void copy(w.ref)))
    card.append(actions)
    list.append(card)
  }
}

async function copy(ref) {
  try {
    const { world } = await apex.worlds.get(ref)
    const saved = await apex.worlds.save({ ...world, name: t('{name} (my copy)', { name: world.name }).slice(0, 80) }, { copy: true })
    go(saved.ref, 'edit')
  } catch (err) {
    note(screen === 'home' ? 'home-note' : 'stage-note', errorText(err))
  }
}

async function share(ref, where) {
  try {
    const path = await apex.worlds.share(ref)
    if (path) note(where, t('Saved {path}. Anyone who opens it gets the world, with their own companions in its open spots.', { path }))
  } catch (err) {
    note(where, errorText(err))
  }
}

$('new-world').addEventListener('click', async () => {
  const world = {
    format: 'apex-world',
    version: 1,
    id: 'new-world',
    name: t('New world'),
    palette: 'meadow',
    sky: 'midday',
    size: [32, 24],
    ground: { base: 'grass', paint: [] },
    props: [],
    places: [],
    residents: [],
    spawn: [16, 12],
  }
  try {
    const saved = await apex.worlds.save(world, { copy: true })
    go(saved.ref, 'edit')
  } catch (err) {
    note('home-note', errorText(err))
  }
})

// ---- a world ----

async function open(ref, mode) {
  let data
  opening = 'world'
  try {
    data = await apex.worlds.get(ref)
  } catch (err) {
    note('home-note', errorText(err))
    location.hash = ''
    return
  }
  current = { ref, ...data }
  $('home').hidden = true
  $('stage').hidden = false
  $('world-name').textContent = data.world.name
  $('edit').textContent = data.editable ? t('Edit') : t('Make a copy')
  $('share').hidden = !data.editable
  note('stage-note', '')
  opening = 'companion'
  me ??= await myCompanion()
  opening = 'stage'
  await stage.load(data.world, data.residents, me)
  opening = 'shown'
  setMode(mode === 'edit' && data.editable ? 'edit' : 'visit')
}

function setMode(mode) {
  screen = mode
  stage.setMode(mode)
  const editing = mode === 'edit'
  $('edit').hidden = editing
  $('share').hidden = editing || !current.editable
  $('done').hidden = !editing
  $('done').disabled = true
  $('keys').hidden = editing
  $('hint').hidden = true
  if (editing) editor.start(current.world)
  else editor.stop()
}

$('back').addEventListener('click', () => {
  location.hash = ''
})
$('edit').addEventListener('click', () => {
  if (current.editable) go(current.ref, 'edit')
  else void copy(current.ref)
})
$('share').addEventListener('click', () => void share(current.ref, 'stage-note'))
$('done').addEventListener('click', async () => {
  try {
    const saved = await apex.worlds.save(editor.world(), {})
    current.world = editor.world()
    unsaved = false
    note('stage-note', '')
    go(saved.ref)
  } catch (err) {
    note('stage-note', errorText(err))
  }
})

function hint({ near, place }) {
  const el = $('hint')
  if (screen !== 'visit') return
  if (near) el.textContent = t('Talk to {name} · E', { name: near.name })
  else if (place?.opens) el.textContent = t('Step into {name} · Enter', { name: place.name })
  else if (place) el.textContent = place.name
  else {
    el.hidden = true
    return
  }
  el.hidden = false
}

async function talk(person) {
  if (talking.has(person.id)) return
  talking.add(person.id)
  stage.say(person.id, person.name, '…', 30)
  const place = stage.where.place
  const who = me?.name ?? t('Someone')
  const situation = place ? t('{who} walks up to say hello at {place}.', { who, place: place.name }) : t('{who} walks up to say hello.', { who })
  try {
    const line = await apex.worlds.speak(current.ref, person.id, { situation })
    stage.say(person.id, person.name, line)
  } catch (err) {
    stage.say(person.id, person.name, '…', 3)
    note('stage-note', errorText(err))
  } finally {
    talking.delete(person.id)
  }
}

async function enter(place) {
  try {
    const result = await apex.worlds.enter(current.ref, place.id)
    if (!result.opened) {
      // Browse opens at the app's pack, where the person can review and add it; then they step in again.
      note('stage-note', t('{name} opens an app you don’t have yet. Find it, add it, then step in again.', { name: place.name }))
      await apex.worlds.find(result.missing.pack)
    }
  } catch (err) {
    note('stage-note', errorText(err))
  }
}

/** What the world shows now, for tests (apex.test.ready) and for looking in from outside. */
function report() {
  const where = stage.where
  apex.test?.ready({ screen, world: current?.world.id ?? null, people: stage.people.length, place: where.place?.id ?? null, near: where.near?.id ?? null })
}

window.__worlds = {
  stage,
  editor,
  get current() {
    return current
  },
  get screen() {
    return screen
  },
  get opening() {
    return opening
  },
}
window.addEventListener('hashchange', route)
route()

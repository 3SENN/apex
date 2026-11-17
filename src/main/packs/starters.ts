/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Starters for apps a companion builds (docs/apps.md › Companions as
// builders): create_pack({ starter }) begins a draft from one of these, so
// the first version already follows the rules: readable modules on the kit,
// light and dark, keyboard use, and the test hook (atelier.test.ready) that
// test_pack's playtest reads. Each is small enough to read in one go. Pages
// link Atelier UI (the kit's ui.css, APP-UI) first, so they look like Atelier.
const KIT_UI = '/__atelier/kit/1/atelier-kit/ui.css'
import { BRAND_NAME } from '@shared/branding'
import type { PackApp, PackManifest } from '@shared/packs'
import { NO_PACK_PERMISSIONS } from '@shared/packs'
import { PHONE_APP, PHONE_APP_STYLE, PHONE_PAGE, PHONE_SCRIPT, PHONE_STYLE } from './starterPhone'

export const STARTERS = ['game-3d', 'game-2d', 'tool', 'story', 'phone-controller', 'sorter'] as const
export type Starter = (typeof STARTERS)[number]

const PAGE = (title: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${KIT_UI}">
<link rel="stylesheet" href="./style.css">
<script type="module" src="./main.js"></script>
</head>
<body>
<main id="app"></main>
</body>
</html>
`

const STYLE = `/* ${BRAND_NAME} UI (linked first) brings the tokens, Inter and the ax-* components; this file adds only what this app needs. */
html, body { height: 100%; }
.hud { position: fixed; top: var(--space-3); left: var(--space-3); padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill); background: var(--bg-raised); box-shadow: 0 0 0 var(--hairline) var(--border-card), var(--shadow-sm); font-size: var(--text-md); font-weight: 600; font-variant-numeric: tabular-nums; }
.answer, .log { white-space: pre-wrap; }
.log:empty { display: none; }
.sorted { margin: 0; padding-left: var(--space-5); line-height: 1.6; overflow-wrap: anywhere; }
.sorted:empty { display: none; }
`

const GAME_3D = `// A companion on a stage: the arrow keys (or WASD) move it, and it cheers
// when it reaches the star. three.js and atelier-kit come from the ${BRAND_NAME} kit.
import * as THREE from 'three'
import { character } from 'atelier-kit/character.js'

const app = document.getElementById('app')
const hud = Object.assign(document.createElement('div'), { className: 'hud', textContent: 'Find the star' })
document.body.append(hud)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
app.replaceWith(renderer.domElement)
const scene = new THREE.Scene()
// Colours from ${BRAND_NAME} UI's tokens: the page's own for the stage (it follows light and dark), the companion's accent for the stand-in.
const probe = document.body.appendChild(Object.assign(document.createElement('span'), { hidden: true }))
const token = (name) => ((probe.style.color = \`var(\${name})\`), getComputedStyle(probe).color)
const paintStage = () => (scene.background = new THREE.Color(getComputedStyle(document.body).backgroundColor))
paintStage()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintStage)
scene.add(new THREE.HemisphereLight(0xffffff, 0x8877aa, 2.2))
const sun = new THREE.DirectionalLight(0xffffff, 1.5)
sun.position.set(3, 6, 4)
scene.add(sun)
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshToonMaterial({ color: 0x9fd8a8 }))
ground.rotation.x = -Math.PI / 2
scene.add(ground)
const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.25), new THREE.MeshToonMaterial({ color: 0xffd34d }))
scene.add(star)
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
camera.position.set(0, 4, 7.5)
camera.lookAt(0, 0.5, 0)

// The person's companion plays (the manifest's cast); a plain block stands in if there is none.
const [me] = await atelier.cast.members()
const player = me ? await character(me.look, { mood: 'idle' }) : null
const body = player ? player.object3d : new THREE.Mesh(new THREE.BoxGeometry(0.6, 1, 0.6), new THREE.MeshToonMaterial({ color: new THREE.Color(token('--accent')) }))
scene.add(body)

let score = 0
const placeStar = () => star.position.set((Math.random() - 0.5) * 8, 0.4, (Math.random() - 0.5) * 8)
placeStar()

const keys = new Set()
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()))
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))

const resize = () => {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

let last = performance.now()
let blinkIn = 3
let moving = null
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const speed = 3 * dt
  const dx = (keys.has('arrowright') || keys.has('d') ? 1 : 0) - (keys.has('arrowleft') || keys.has('a') ? 1 : 0)
  const dz = (keys.has('arrowdown') || keys.has('s') ? 1 : 0) - (keys.has('arrowup') || keys.has('w') ? 1 : 0)
  body.position.x = THREE.MathUtils.clamp(body.position.x + dx * speed, -5, 5)
  body.position.z = THREE.MathUtils.clamp(body.position.z + dz * speed, -5, 5)
  if (dx || dz) body.rotation.y = Math.atan2(dx, dz)
  // Runs while it moves (3 units a second keeps the steps with the ground), and stands when it stops.
  const gait = dx || dz ? 'run' : null
  if (gait !== moving) {
    moving = gait
    player?.move(gait, 3)
  }
  star.rotation.y += dt * 2
  if (body.position.distanceTo(new THREE.Vector3(star.position.x, 0, star.position.z)) < 0.7) {
    score++
    hud.textContent = 'Stars: ' + score
    player?.setMood('happy')
    setTimeout(() => player?.setMood('idle'), 1200)
    void atelier.status.set({ text: score + ' stars', badge: score })
    placeStar()
  }
  if ((blinkIn -= dt) < 0) {
    player?.blink()
    blinkIn = 2.5 + Math.random() * 3
  }
  player?.update(dt)
  renderer.render(scene, camera)
  atelier.test?.ready({ score, x: body.position.x, z: body.position.z })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

const GAME_2D = `// A small arcade: move with the arrow keys (or WASD), catch the dots, and
// the score shows on the app's row in the sidebar.
const app = document.getElementById('app')
const canvas = document.createElement('canvas')
const hud = Object.assign(document.createElement('div'), { className: 'hud', textContent: 'Score: 0' })
app.replaceWith(canvas)
document.body.append(hud)
const ctx = canvas.getContext('2d')
// Colours from ${BRAND_NAME} UI's tokens (read again when the theme changes): the page, the companion's accent and a warm star.
const probe = document.body.appendChild(Object.assign(document.createElement('span'), { hidden: true }))
const token = (name) => ((probe.style.color = \`var(\${name})\`), getComputedStyle(probe).color)
let paint = {}
const repaint = () => (paint = { page: getComputedStyle(document.body).backgroundColor, player: token('--accent'), star: token('--status-needs-input') })
repaint()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint)

const player = { x: 100, y: 100, r: 16 }
const dot = { x: 300, y: 200, r: 8 }
let score = 0
const keys = new Set()
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()))
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))

const resize = () => {
  canvas.width = innerWidth * devicePixelRatio
  canvas.height = innerHeight * devicePixelRatio
  canvas.style.width = innerWidth + 'px'
  canvas.style.height = innerHeight + 'px'
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
}
addEventListener('resize', resize)
resize()

const moveDot = () => Object.assign(dot, { x: 40 + Math.random() * (innerWidth - 80), y: 60 + Math.random() * (innerHeight - 100) })

let last = performance.now()
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const speed = 260 * dt
  if (keys.has('arrowleft') || keys.has('a')) player.x -= speed
  if (keys.has('arrowright') || keys.has('d')) player.x += speed
  if (keys.has('arrowup') || keys.has('w')) player.y -= speed
  if (keys.has('arrowdown') || keys.has('s')) player.y += speed
  player.x = Math.max(player.r, Math.min(innerWidth - player.r, player.x))
  player.y = Math.max(player.r, Math.min(innerHeight - player.r, player.y))
  if (Math.hypot(player.x - dot.x, player.y - dot.y) < player.r + dot.r) {
    score++
    hud.textContent = 'Score: ' + score
    void atelier.status.set({ text: 'Score ' + score, badge: score })
    moveDot()
  }
  ctx.fillStyle = paint.page
  ctx.fillRect(0, 0, innerWidth, innerHeight)
  ctx.fillStyle = paint.star
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = paint.player
  ctx.beginPath()
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2)
  ctx.fill()
  atelier.test?.ready({ score, x: Math.round(player.x), y: Math.round(player.y) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

const TOOL = `// A tool on ${BRAND_NAME}'s AI: the person writes, the model answers as it writes.
const app = document.getElementById('app')
app.className = 'ax-app'
app.innerHTML = '<div class="ax-stack"><div class="ax-field"><label class="ax-label" for="in">What should I help with?</label><textarea class="ax-textarea" id="in"></textarea></div><div class="ax-cluster"><button class="ax-btn ax-btn--accent" id="go" type="button">Ask</button></div><div id="out" class="answer" aria-live="polite"></div></div>'
const input = document.getElementById('in')
const out = document.getElementById('out')
const go = document.getElementById('go')
go.addEventListener('click', async () => {
  const text = input.value.trim()
  if (!text) return input.focus()
  go.disabled = true
  out.textContent = ''
  try {
    await atelier.ai.stream(text, { tier: 'fast', onText: (piece) => (out.textContent += piece) })
  } catch (err) {
    out.textContent = err.message
  } finally {
    go.disabled = false
    atelier.test?.ready({ answered: out.textContent.length > 0 })
  }
})
atelier.test?.ready({ answered: false })
`

const SORTER = `// A sorter on ${BRAND_NAME}'s quick decisions (atelier.ai.decide): one line per message,
// each gets a topic and an urgency with how sure the model is. No text is
// written, so it runs in about a tenth of a second on the person's decision
// model, or on their Claude engine when they have none. Unsure answers are
// shown as unsure instead of guessed.
const TOPICS = { billing: 'Payments, invoices, refunds', bug: 'Something is broken or not working', question: 'A question about how something works', other: null }
const URGENCY = ['Can wait', 'Today', 'Right now']
const app = document.getElementById('app')
app.className = 'ax-app'
app.innerHTML = '<div class="ax-stack"><div class="ax-field"><label class="ax-label" for="in">Messages, one per line</label><textarea class="ax-textarea" id="in"></textarea></div><div class="ax-cluster"><button class="ax-btn ax-btn--accent" id="go" type="button">Sort</button></div><ul id="out" class="sorted" aria-live="polite"></ul></div>'
const input = document.getElementById('in')
const out = document.getElementById('out')
const go = document.getElementById('go')
const pct = (p) => Math.round(p * 100) + '%'
go.addEventListener('click', async () => {
  const lines = input.value.split('\\n').map((l) => l.trim()).filter(Boolean).slice(0, 20)
  if (!lines.length) return input.focus()
  go.disabled = true
  out.textContent = ''
  let sorted = 0
  for (const line of lines) {
    const row = document.createElement('li')
    row.textContent = line + ' …'
    out.append(row)
    try {
      const { answers, source } = await atelier.ai.decide(line, {
        topic: { type: 'choice', instructions: 'What is this message about?', criteria: TOPICS },
        urgency: { type: 'score', instructions: 'How soon does it need an answer?', criteria: URGENCY },
      })
      // Claude's own estimates are less calibrated than a decision model's: ask for more before trusting them.
      const sure = source === 'model' ? 0.75 : 0.85
      const topicP = answers.topic.probabilities[answers.topic.choice]
      const topic = topicP >= sure ? answers.topic.choice + ' (' + pct(topicP) + ')' : 'unsure'
      const level = Math.round(answers.urgency.score)
      row.textContent = line + ' → ' + topic + ', ' + (answers.urgency.confidence >= 0.5 ? URGENCY[level] : 'urgency unsure')
      sorted++
    } catch (err) {
      row.textContent = line + ' → ' + err.message
    }
  }
  go.disabled = false
  atelier.test?.ready({ sorted })
})
atelier.test?.ready({ sorted: 0 })
`

const STORY = `// A story told with the person's companion: the model can roll dice through
// the app's own tool, and the companion comments in character.
const app = document.getElementById('app')
app.className = 'ax-app'
app.innerHTML = '<div class="ax-stack"><div id="log" class="log" aria-live="polite"></div><div class="ax-field"><label class="ax-label" for="in">What do you do?</label><textarea class="ax-textarea" id="in"></textarea></div><div class="ax-cluster"><button class="ax-btn ax-btn--accent" id="go" type="button">Go</button></div></div>'
const log = document.getElementById('log')
const input = document.getElementById('in')
const go = document.getElementById('go')
const [me] = await atelier.cast.members()
const session = atelier.ai.session({
  system: 'You narrate a short, kind adventure in the second person. Keep each turn under 90 words. Use roll_dice when luck decides.',
  tier: 'smart',
  tools: [{ name: 'roll_dice', description: 'Rolls a six-sided die.', input: { type: 'object', properties: {} }, run: () => 1 + Math.floor(Math.random() * 6) }],
})
go.addEventListener('click', async () => {
  const text = input.value.trim()
  if (!text) return input.focus()
  input.value = ''
  go.disabled = true
  log.textContent += '\\n> ' + text + '\\n'
  try {
    const story = await session.send(text)
    log.textContent += story + '\\n'
    if (me) log.textContent += me.name + ': ' + (await atelier.cast.speak(me.ref, { situation: story.slice(0, 400) })) + '\\n'
  } catch (err) {
    log.textContent += err.message + '\\n'
  } finally {
    go.disabled = false
    atelier.test?.ready({ turns: session.history().length })
  }
})
atelier.test?.ready({ turns: 0 })
`

/** A starter's files and manifest for a new draft. */
export function starterFiles(starter: Starter, base: Pick<PackManifest, 'id' | 'name' | 'description'> & { builtBy?: string }): Map<string, Buffer> {
  const app: PackApp = { id: 'main', name: base.name, root: 'app', entry: 'index.html', build: 'kit', kind: starter.startsWith('game') || starter === 'phone-controller' ? 'game' : 'tool', kit: 1, sidebar: true }
  if (starter === 'game-3d' || starter === 'story') app.cast = { min: 1, max: 1 }
  const permissions = {
    ...NO_PACK_PERMISSIONS,
    ...(starter === 'tool' || starter === 'story' || starter === 'sorter' ? { model: true } : {}),
    ...(starter === 'story' ? { speak: true } : {}),
    // Its own web server on the Wi-Fi, for the phone page (atelier.server).
    ...(starter === 'phone-controller' ? { server: { lan: true } } : {}),
  }
  const manifest: PackManifest = {
    format: 'atelier-pack',
    manifestVersion: 2,
    id: base.id,
    name: base.name,
    version: '0.1.0',
    description: base.description,
    ...(base.builtBy ? { builtBy: base.builtBy } : {}),
    contributes: { apps: [app] },
    permissions,
  }
  const main = starter === 'game-3d' ? GAME_3D : starter === 'game-2d' ? GAME_2D : starter === 'tool' ? TOOL : starter === 'phone-controller' ? PHONE_APP : starter === 'sorter' ? SORTER : STORY
  const files = new Map([
    ['atelier-pack.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['app/index.html', Buffer.from(PAGE(base.name))],
    ['app/style.css', Buffer.from(starter === 'phone-controller' ? PHONE_APP_STYLE : STYLE)],
    ['app/main.js', Buffer.from(main)],
  ])
  if (starter === 'phone-controller') {
    // The page phones open, served by the app's own server from this folder.
    files.set('phone/index.html', Buffer.from(PHONE_PAGE))
    files.set('phone/phone.css', Buffer.from(PHONE_STYLE))
    files.set('phone/phone.js', Buffer.from(PHONE_SCRIPT))
  }
  return files
}

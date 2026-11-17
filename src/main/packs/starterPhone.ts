/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The phone controller starter (docs/packs.md › A web server of its own): an
// app that starts its own web server on the Wi-Fi, shows the QR code phones
// scan, and draws each phone's tilt and buttons as they move. The phone page
// is the pack's phone/ folder: it joins with a name, turns on motion (an
// iPhone asks on a tap), and sends motion and A, B, Home and a pointer pad
// over its socket; the app can buzz it back. Plain scripts, small enough to
// read in one go, in English and Dutch by the phone's language. Nothing here
// is about one game: change the phone page and main.js into yours.

import { BRAND_NAME } from '@shared/branding'
/** The app's page script (a module on the kit). */
export const PHONE_APP = `// Phones as controllers: this app runs a small web server of its own
// (permissions.server with lan), shows a QR code that phones on the same
// Wi-Fi scan, and draws each phone's tilt and buttons. The phone page is
// phone/ in this pack (phone.js sends what the phone does over its socket).
const app = document.getElementById('app')
app.className = 'ax-app'
app.innerHTML = '<div class="ax-stack">'
  + '<h1 class="ax-title">Phone controller</h1>'
  + '<section class="join ax-card"><img class="qr" alt="QR code to join" hidden>'
  + '<div class="ax-stack"><p class="ax-subtitle" id="say">Starting…</p><p class="address ax-muted" id="address"></p>'
  + '<ol class="steps ax-small"><li>Join the same Wi-Fi as this computer.</li><li>Scan the code with the phone’s camera, or type the address.</li>'
  + '<li>The first time, the phone warns about the certificate: choose to go on (it is ${BRAND_NAME}’s own, on this computer).</li><li>Tap Allow motion, then tilt the phone.</li></ol></div></section>'
  + '<section class="players" id="players" aria-live="polite"></section></div>'
const qr = app.querySelector('.qr')
const say = document.getElementById('say')
const address = document.getElementById('address')
const players = document.getElementById('players')

// Every phone: its socket, its name, where it points and what it holds.
const phones = new Map()

function card(phone) {
  const el = document.createElement('article')
  el.className = 'player ax-card'
  el.innerHTML = '<div class="tilt"><div class="paddle"></div></div><div class="ax-stack"><p class="ax-subtitle name"></p>'
    + '<p class="ax-small ax-muted angles">Waiting for motion…</p><div class="ax-cluster"><span class="key" data-key="a">A</span><span class="key" data-key="b">B</span>'
    + '<button class="ax-btn ax-btn--sm buzz" type="button">Buzz</button></div></div>'
  el.querySelector('.name').textContent = phone.name
  el.querySelector('.buzz').addEventListener('click', () => phone.socket.send({ t: 'buzz', ms: 80 }))
  players.append(el)
  return el
}

function render() {
  for (const phone of phones.values()) {
    const paddle = phone.el.querySelector('.paddle')
    // beta tilts forward and back, gamma left and right (degrees).
    paddle.style.transform = 'rotateX(' + (-phone.beta).toFixed(1) + 'deg) rotateY(' + phone.gamma.toFixed(1) + 'deg)'
    if (phone.moved) phone.el.querySelector('.angles').textContent = 'Tilt ' + Math.round(phone.beta) + '°, ' + Math.round(phone.gamma) + '° · swing ' + phone.swing.toFixed(0)
    for (const key of phone.el.querySelectorAll('.key')) key.classList.toggle('down', phone.held.has(key.dataset.key))
  }
  apex.test?.ready({ serving: Boolean(status), phones: phones.size })
  requestAnimationFrame(render)
}

apex.server.onConnection((socket) => {
  const phone = { socket, name: socket.query.name || 'Phone', beta: 0, gamma: 0, swing: 0, moved: false, held: new Set(), el: null }
  phone.el = card(phone)
  phones.set(socket.id, phone)
  socket.send({ t: 'welcome', slot: phones.size })
  socket.onMessage((m) => {
    if (!m || typeof m !== 'object') return
    if (m.t === 'motion') {
      phone.beta = Number(m.b) || 0
      phone.gamma = Number(m.g) || 0
      // How fast it turns (degrees a second): a swing is a big number.
      phone.swing = Math.hypot(Number(m.rx) || 0, Number(m.ry) || 0, Number(m.rz) || 0)
      phone.moved = true
    } else if (m.t === 'button' && typeof m.b === 'string') {
      if (m.down) phone.held.add(m.b)
      else phone.held.delete(m.b)
      if (m.b === 'a' && m.down) socket.send({ t: 'buzz', ms: 30 })
    }
  })
  socket.onClose(() => {
    phone.el.remove()
    phones.delete(socket.id)
  })
})

apex.server.onStop((reason) => {
  status = null
  qr.hidden = true
  say.textContent = reason === 'person' ? 'Sharing stopped. Reload to share again.' : 'The server stopped.'
})

// On the Wi-Fi when it can be (in test_pack, on this computer only).
let status = null
try {
  status = await apex.server.start({ lan: true, root: 'phone' })
} catch {
  status = await apex.server.start({ root: 'phone' }).catch((err) => {
    say.textContent = err.message
    return null
  })
}
if (status) {
  say.textContent = status.lanUrl ? 'Scan with a phone on the same Wi-Fi' : 'Open this address on this computer'
  address.textContent = status.lanUrl || status.url
  if (status.qr) {
    qr.src = status.qr
    qr.hidden = false
  }
}
requestAnimationFrame(render)
`

export const PHONE_APP_STYLE = `/* ${BRAND_NAME} UI (linked first) brings the tokens and the ax-* components; this file adds the join card and the players. */
html, body { min-height: 100%; }
.join { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; }
.qr { width: 184px; height: 184px; padding: var(--space-2); border-radius: var(--radius-md); background: white; image-rendering: pixelated; }
.address { word-break: break-all; user-select: all; }
.steps { margin: 0; padding-left: var(--space-5); }
.players { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-3); }
.player { display: flex; gap: var(--space-3); align-items: center; }
.tilt { flex: none; display: grid; width: 88px; height: 88px; place-items: center; perspective: 300px; }
.paddle { width: 44px; height: 72px; border-radius: var(--radius-lg); background: var(--accent); box-shadow: var(--shadow-md); transition: transform 50ms linear; }
.key { display: inline-grid; min-width: 28px; height: 28px; place-items: center; border-radius: var(--radius-pill); background: var(--bg-muted); font-weight: 650; }
.key.down { background: var(--accent); color: var(--text-on-accent); }
`

/** The phone page: Apex UI from the server, the socket helper, then the page's own script. */
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="light dark">
<title>Controller</title>
<link rel="stylesheet" href="__apex/kit/1/apex-kit/ui.css">
<link rel="stylesheet" href="phone.css">
<script src="__apex/client.js"></script>
<script src="phone.js" defer></script>
</head>
<body>
<main id="join" class="screen ax-stack">
  <h1 class="ax-title" data-t="title">Controller</h1>
  <label class="ax-label" for="name" data-t="name">Your name</label>
  <input class="ax-input" id="name" maxlength="20" autocomplete="nickname">
  <button class="ax-btn ax-btn--accent ax-btn--lg ax-btn--full" id="go" type="button" data-t="join">Join</button>
</main>
<main id="pad" class="screen" hidden>
  <p class="status ax-small" id="status" role="status"></p>
  <button class="ax-btn ax-btn--full" id="motion" type="button" data-t="motion">Allow motion</button>
  <button class="key a" id="a" type="button">A</button>
  <div class="row">
    <button class="key b" id="b" type="button">B</button>
    <button class="key home" id="home" type="button" data-t="home">Home</button>
  </div>
  <div class="touch" id="touch" data-t="touch">Pointer</div>
</main>
</body>
</html>
`

export const PHONE_STYLE = `/* The phone page, on ${BRAND_NAME} UI's tokens: a big A, B and Home below it, a pad to point with. Portrait or landscape. */
html, body { height: 100%; margin: 0; overscroll-behavior: none; touch-action: manipulation; -webkit-user-select: none; user-select: none; }
body { padding: max(var(--space-4), env(safe-area-inset-top)) max(var(--space-4), env(safe-area-inset-right)) max(var(--space-4), env(safe-area-inset-bottom)) max(var(--space-4), env(safe-area-inset-left)); box-sizing: border-box; background: var(--bg-page); color: var(--text-primary); font-family: var(--font); }
.screen { max-width: 30rem; height: 100%; margin: 0 auto; box-sizing: border-box; }
#join { justify-content: center; }
#pad { display: grid; grid-template-rows: auto auto 1fr auto auto; gap: var(--space-3); }
#pad[hidden] { display: none; }
.status { margin: 0; text-align: center; color: var(--text-secondary); }
.key { border: 0; border-radius: var(--radius-lg); background: var(--bg-raised); color: var(--text-primary); box-shadow: var(--shadow-md); font: 700 var(--text-xl) var(--font); }
.key:active, .key.down { background: var(--accent); color: var(--text-on-accent); box-shadow: none; }
.a { min-height: 9rem; border-radius: 50%; aspect-ratio: 1; justify-self: center; width: min(60vw, 14rem); font-size: 3rem; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.row .key { min-height: 4rem; }
.touch { display: grid; min-height: 7rem; place-items: center; border-radius: var(--radius-lg); background: var(--bg-sunken); color: var(--text-tertiary); touch-action: none; }
@media (orientation: landscape) {
  #pad { grid-template-columns: 1fr 1fr; grid-template-rows: auto auto 1fr; }
  .status, #motion { grid-column: 1 / -1; }
  .a { grid-row: 3; width: min(40vh, 12rem); min-height: 0; align-self: center; }
  .row { grid-column: 2; grid-row: 3; align-content: center; }
  .touch { grid-column: 1 / -1; min-height: 4rem; }
}
`

export const PHONE_SCRIPT = `// The phone: joins the app with a name, turns on motion, and sends what the
// phone does over its socket (apexServer comes from __apex/client.js, which
// reconnects by itself). The app can buzz it: Android vibrates; an iPhone has
// no vibration for pages, but Safari gives a light tap when a switch flips.
(function () {
  'use strict'
  var nl = /^nl\\b/i.test(navigator.language || '')
  var words = nl
    ? { title: 'Controller', name: 'Je naam', join: 'Doe mee', motion: 'Sta beweging toe', motionOn: 'Beweging staat aan', noMotion: 'Deze telefoon geeft geen beweging door', home: 'Home', touch: 'Aanwijzen', on: 'Verbonden', off: 'Opnieuw verbinden…' }
    : { title: 'Controller', name: 'Your name', join: 'Join', motion: 'Allow motion', motionOn: 'Motion is on', noMotion: 'This phone doesn’t share motion', home: 'Home', touch: 'Pointer', on: 'Connected', off: 'Reconnecting…' }
  document.documentElement.lang = nl ? 'nl' : 'en'
  document.querySelectorAll('[data-t]').forEach(function (el) {
    el.textContent = words[el.getAttribute('data-t')]
  })
  var $ = function (id) {
    return document.getElementById(id)
  }
  var link = null
  var send = function (m) {
    if (link) link.send(m)
  }
  // Motion and pad moves share 90 messages a second. The app takes 120 a
  // second from each phone, so a button press or release always fits: a lost
  // release would leave a button held down.
  var streamTokens = 0
  var streamAt = 0
  function mayStream() {
    var now = performance.now()
    streamTokens = Math.min(6, streamTokens + (now - streamAt) * 0.09)
    streamAt = now
    if (streamTokens < 1) return false
    streamTokens -= 1
    return true
  }
  var name = $('name')
  try {
    name.value = localStorage.getItem('apex-controller-name') || ''
  } catch (e) {}

  // The screen stays on while you play.
  var lock = null
  function stayAwake() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return
    navigator.wakeLock.request('screen').then(function (l) {
      lock = l
    }, function () {})
  }
  document.addEventListener('visibilitychange', function () {
    if (!lock || lock.released) stayAwake()
  })

  $('go').addEventListener('click', function () {
    var who = name.value.trim() || 'Phone'
    try {
      localStorage.setItem('apex-controller-name', who)
    } catch (e) {}
    link = apexServer.connect({ query: { name: who } })
    link.onOpen(function () {
      $('status').textContent = words.on
    })
    link.onClose(function () {
      $('status').textContent = words.off
    })
    link.onMessage(function (m) {
      if (m && m.t === 'buzz') buzz(Number(m.ms) || 40)
    })
    $('join').hidden = true
    $('pad').hidden = false
    stayAwake()
  })

  // Motion: rotation rate, acceleration (with and without gravity) and the angles, at most 60 times a second.
  var frame = { t: 'motion' }
  var last = 0
  function sendFrame() {
    var now = performance.now()
    if (now - last < 16 || !mayStream()) return
    last = now
    frame.ts = Math.round(now)
    send(frame)
  }
  function round(n) {
    return typeof n === 'number' ? Math.round(n * 100) / 100 : null
  }
  function onOrientation(e) {
    frame.a = round(e.alpha)
    frame.b = round(e.beta)
    frame.g = round(e.gamma)
    sendFrame()
  }
  function onMotion(e) {
    var r = e.rotationRate || {}
    var a = e.acceleration || {}
    var g = e.accelerationIncludingGravity || {}
    frame.rx = round(r.alpha)
    frame.ry = round(r.beta)
    frame.rz = round(r.gamma)
    frame.x = round(a.x)
    frame.y = round(a.y)
    frame.z = round(a.z)
    frame.gx = round(g.x)
    frame.gy = round(g.y)
    frame.gz = round(g.z)
    frame.screen = (screen.orientation && screen.orientation.angle) || 0
    sendFrame()
  }
  function listen() {
    addEventListener('devicemotion', onMotion)
    addEventListener('deviceorientation', onOrientation)
    $('motion').textContent = words.motionOn
    $('motion').disabled = true
  }
  $('motion').addEventListener('click', function () {
    // An iPhone asks, and only on a tap; other phones just send.
    var ask = window.DeviceMotionEvent && DeviceMotionEvent.requestPermission
    if (!window.DeviceMotionEvent) {
      $('motion').textContent = words.noMotion
      return
    }
    if (!ask) return listen()
    DeviceMotionEvent.requestPermission().then(function (answer) {
      if (answer === 'granted') listen()
      else $('motion').textContent = words.noMotion
    }, function () {
      $('motion').textContent = words.noMotion
    })
  })

  // A, B and Home: down and up.
  ;['a', 'b', 'home'].forEach(function (b) {
    var el = $(b)
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault()
      el.classList.add('down')
      send({ t: 'button', b: b, down: true })
    })
    ;['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
      el.addEventListener(type, function () {
        if (!el.classList.contains('down')) return
        el.classList.remove('down')
        send({ t: 'button', b: b, down: false })
      })
    })
  })

  // The pad: where the finger is, 0 to 1 across and down.
  var touch = $('touch')
  var lastMove = 0
  function at(e) {
    var r = touch.getBoundingClientRect()
    return { x: Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 1000) / 1000 }
  }
  touch.addEventListener('pointerdown', function (e) {
    touch.setPointerCapture(e.pointerId)
    var p = at(e)
    send({ t: 'button', b: 'pad', down: true, x: p.x, y: p.y })
  })
  touch.addEventListener('pointermove', function (e) {
    if (!touch.hasPointerCapture(e.pointerId) || performance.now() - lastMove < 16 || !mayStream()) return
    lastMove = performance.now()
    var p = at(e)
    send({ t: 'pointer', x: p.x, y: p.y })
  })
  touch.addEventListener('pointerup', function (e) {
    var p = at(e)
    send({ t: 'button', b: 'pad', down: false, x: p.x, y: p.y })
  })

  var tapper = null
  function buzz(ms) {
    if (navigator.vibrate) return void navigator.vibrate(Math.min(ms, 400))
    if (!tapper) {
      tapper = document.createElement('label')
      tapper.style.cssText = 'position:fixed;left:-200px;top:0;opacity:0;pointer-events:none'
      var input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('switch', '')
      tapper.append(input)
      document.body.append(tapper)
    }
    tapper.click()
  }
})()
`

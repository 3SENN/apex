/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The helper an app's server hands its pages at __atelier/client.js (docs/packs.md
// › A web server of its own): one socket to the app that reconnects by itself.
// A classic script, readable, for any browser a phone has:
//
//   <script src="__atelier/client.js"></script>
//   const link = atelierServer.connect({ query: { name: 'Sam' } })
//   link.onOpen(() => …); link.onMessage((value, text) => …); link.onClose(() => …)
//   link.send({ t: 'tap' })   // objects go as JSON, text as it is
//
// It works out the server's base from its own address, so pages need no
// configuration, with or without the token in the path.
import { BRAND_NAME } from '@shared/branding'
export const SERVER_CLIENT_JS = `/* ${BRAND_NAME}: the socket to the app that serves this page. */
(function () {
  'use strict'
  var script = document.currentScript
  var base = new URL('../', script && script.src ? script.src : location.href)

  function decode(text) {
    try {
      return JSON.parse(text)
    } catch (e) {
      return text
    }
  }

  function Link(options) {
    options = options || {}
    this.state = 'connecting'
    this._query = options.query || {}
    this._handlers = { open: [], message: [], close: [] }
    this._queue = []
    this._tries = 0
    this._closed = false
    this._socket = null
    this._timer = 0
    var self = this
    var nudge = function () {
      if (!self._closed && self.state === 'closed') self._open()
    }
    window.addEventListener('online', nudge)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') nudge()
    })
    this._open()
  }

  Link.prototype._url = function () {
    var url = new URL('__atelier/socket', base)
    url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    var query = this._query
    Object.keys(query).forEach(function (name) {
      url.searchParams.set(name, String(query[name]))
    })
    return url.href
  }

  Link.prototype._emit = function (kind, a, b) {
    this._handlers[kind].forEach(function (fn) {
      try {
        fn(a, b)
      } catch (err) {
        setTimeout(function () {
          throw err
        })
      }
    })
  }

  Link.prototype._open = function () {
    var self = this
    clearTimeout(this._timer)
    this.state = 'connecting'
    var socket
    try {
      socket = new WebSocket(this._url())
    } catch (err) {
      return this._retry()
    }
    this._socket = socket
    socket.onopen = function () {
      self._tries = 0
      self.state = 'open'
      var queued = self._queue.splice(0)
      queued.forEach(function (text) {
        socket.send(text)
      })
      self._emit('open')
    }
    socket.onmessage = function (event) {
      var text = typeof event.data === 'string' ? event.data : ''
      self._emit('message', decode(text), text)
    }
    socket.onclose = function (event) {
      if (self._socket !== socket) return
      self._socket = null
      self.state = 'closed'
      self._emit('close', event.code)
      if (!self._closed) self._retry()
    }
  }

  Link.prototype._retry = function () {
    var self = this
    this.state = 'closed'
    var wait = Math.min(5000, 400 * Math.pow(2, this._tries++))
    clearTimeout(this._timer)
    this._timer = setTimeout(function () {
      if (!self._closed) self._open()
    }, wait)
  }

  /** Sends text as it is and anything else as JSON; while it reconnects, the last 50 wait. */
  Link.prototype.send = function (data) {
    var text = typeof data === 'string' ? data : JSON.stringify(data)
    if (this._socket && this._socket.readyState === 1) return this._socket.send(text)
    this._queue.push(text)
    if (this._queue.length > 50) this._queue.shift()
  }
  Link.prototype.onOpen = function (fn) {
    this._handlers.open.push(fn)
    if (this.state === 'open') fn()
  }
  Link.prototype.onMessage = function (fn) {
    this._handlers.message.push(fn)
  }
  Link.prototype.onClose = function (fn) {
    this._handlers.close.push(fn)
  }
  Link.prototype.close = function () {
    this._closed = true
    clearTimeout(this._timer)
    if (this._socket) this._socket.close(1000)
  }

  window.atelierServer = {
    base: base.href,
    connect: function (options) {
      return new Link(options)
    },
  }
})()
`

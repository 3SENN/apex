/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The smoke run's network guard: nothing may leave
// the machine. scripts/smoke.mjs starts the app with Chromium's net log and,
// after the run, lists every host the log names that isn't this machine or a
// reserved test name. src/main/smoke.ts fences the main process's own fetch.

/** Hosts that never leave the machine: loopback, and names reserved for tests (RFC 2606, RFC 6761). */
export function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h)) return true
  return /\.(test|invalid|localhost|example)$/.test(h)
}

/**
 * Windows' proxy auto-discovery: with "Automatically detect settings" on (the
 * default), Chromium asks the local network for wpad, then wpad.<the PC's
 * domain>, while it settles on the system proxy, as every browser there does.
 * The lookup carries nothing of the run.
 */
export function isProxyDiscovery(host) {
  return /^wpad(\.|$)/.test(String(host).toLowerCase())
}

/** The external hosts a net log mentions, sorted and unique. Tolerates a log cut off mid-write. */
export function externalHosts(netLogText) {
  const hosts = new Set()
  const outside = (host) => !isLocalHost(host) && !isProxyDiscovery(host)
  const url = /"url":"(?:https?|wss?|ftp):\/\/(?:[^@/"]*@)?(\[[^\]]+\]|[^/":?#]+)/g
  for (const m of netLogText.matchAll(url)) if (outside(m[1])) hosts.add(m[1].toLowerCase())
  const resolve = /"host":"(\[[^\]]+\]|[^":/]+)(?::\d+)?"/g
  for (const m of netLogText.matchAll(resolve)) if (outside(m[1])) hosts.add(m[1].toLowerCase())
  return [...hosts].sort()
}

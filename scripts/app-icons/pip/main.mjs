/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Electron main for scripts/app-icons/render-pip.mjs. Opens the built render
// page in a hidden window, asks it for Pip's head and full body at the size
// given (and the .apexpack group picture's members), and writes them as PNGs. Serves only local files, from a private
// scheme; every other request is refused, so nothing leaves the machine.
//   electron main.mjs <built page dir> <companion assets dir> <out dir> <size>
import { app, BrowserWindow, protocol, session } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const [pageDir, assetsDir, outDir, sizeArg] = process.argv.slice(-4)
const size = Number(sizeArg)
const SCHEME = 'pip-render'
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm'
}

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.dock?.hide()

function fail(message) {
  console.error(`render-pip: ${message}`)
  app.exit(1)
}

/** A file under root, or null when the path tries to leave it. */
function inside(root, rel) {
  const abs = normalize(join(root, rel))
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${SCHEME}:`) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') })
  })
  protocol.handle(SCHEME, async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname)
    const file = path.startsWith('/companion/') ? inside(assetsDir, path.slice('/companion/'.length)) : inside(pageDir, path.slice(1))
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 640,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true }
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') console.error(`[page] ${event.message}`)
  })
  const timer = setTimeout(() => fail('timed out'), 90_000)
  try {
    await win.loadURL(`${SCHEME}://pip/render.html`)
    const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const go = () => window.__renderPip(${JSON.stringify(size)}).then(resolve, (e) => reject(String(e)))
      if (window.__renderPip) go(); else window.addEventListener('load', go)
    })`)
    if (result.errors.length) return fail(`the companion renderer reported: ${result.errors.join('; ')}`)
    await mkdir(outDir, { recursive: true })
    for (const name of ['head', 'full']) {
      const url = result[name]
      if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) return fail(`no ${name} image`)
      await writeFile(join(outDir, `pip-${name}.png`), Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'))
    }
    // The group picture for .apexpack documents: each member's whole figure and floating head.
    const group = await win.webContents.executeJavaScript(`window.__renderGroup(${JSON.stringify(size)}).then((r) => r, (e) => ({ error: String(e) }))`)
    if (group.error) return fail(`the group render failed: ${group.error}`)
    if (group.errors.length) return fail(`the companion renderer reported: ${group.errors.join('; ')}`)
    for (const m of group.members) {
      for (const name of ['head', 'full']) {
        const url = m[name]
        if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) return fail(`no ${m.id} ${name} image`)
        await writeFile(join(outDir, `group-${m.id}-${name}.png`), Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'))
      }
    }
    clearTimeout(timer)
    app.exit(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
})

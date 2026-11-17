#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Builds the Atelier kit (docs/apps.md › The kit) into out/kit/<major>/: what a
// kit app imports by bare name and what it loads by address, served inside
// each pack's own origin at /__atelier/kit/<major>/ (src/main/packs/sandbox.ts).
//
//   three/build/                 three.js's module build, the companions' version
//   three/examples/jsm/          the addons the kit lists, with the files they import
//   atelier-kit/character.js        a companion in an app's own scene (src/kit/character.ts)
//   atelier-kit/guide.js            the person's companion in a corner of the page, with a bubble (src/kit/guide.ts)
//   atelier-kit/props.js            the kit's props in the companions' style (src/kit/props.ts)
//   atelier-kit/world.js            a world file as a three.js scene (src/kit/world.ts)
//   atelier-kit/ui.css              Atelier UI for apps: the browser's tokens and components (src/kit/ui.css), Inter inline
//   companion/                   the companion art the runtime loads
//   importmap.json               the import map Atelier adds to a kit app's pages
//
// Run by `npm run build` and `npm run smoke`; the output is generated, not committed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAJOR = 1
const out = join(root, 'out', 'kit', String(MAJOR))
const base = `/__atelier/kit/${MAJOR}`
const three = join(root, 'node_modules', 'three')

/** The addons a kit app can import (three/addons/<path>); each comes with what it imports. */
const ADDONS = ['loaders/GLTFLoader.js', 'libs/meshopt_decoder.module.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js', 'controls/OrbitControls.js']

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// three.js: the module build and the addons with their relative imports.
for (const file of ['three.module.js', 'three.core.js']) {
  mkdirSync(join(out, 'three', 'build'), { recursive: true })
  cpSync(join(three, 'build', file), join(out, 'three', 'build', file))
}
cpSync(join(three, 'LICENSE'), join(out, 'three', 'LICENSE'))
const jsm = join(three, 'examples', 'jsm')
const seen = new Set()
const copyAddon = (rel) => {
  if (seen.has(rel)) return
  const from = join(jsm, ...rel.split('/'))
  if (!existsSync(from)) return
  seen.add(rel)
  const to = join(out, 'three', 'examples', 'jsm', ...rel.split('/'))
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  const text = readFileSync(from, 'utf8')
  for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) copyAddon(posix.normalize(posix.join(posix.dirname(rel), m[1])))
}
for (const addon of ADDONS) copyAddon(addon)

// The companion art, as the chrome serves it.
cpSync(join(root, 'src', 'renderer', 'public', 'companion'), join(out, 'companion'), { recursive: true })

// atelier-kit/character.js: the companion runtime as one readable module; three stays external.
await build({
  configFile: false,
  logLevel: 'warn',
  root,
  resolve: {
    alias: [
      { find: /^@shared\/companion$/, replacement: join(root, 'src', 'kit', 'companionShared.ts') },
      { find: /^@shared\/(.*)$/, replacement: join(root, 'src', 'shared', '$1') },
    ],
  },
  build: {
    outDir: join(out, 'atelier-kit'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: 'es2022',
    lib: { entry: { character: join(root, 'src', 'kit', 'character.ts'), guide: join(root, 'src', 'kit', 'guide.ts'), props: join(root, 'src', 'kit', 'props.ts'), world: join(root, 'src', 'kit', 'world.ts') }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
    rolldownOptions: { external: [/^three($|\/)/] },
    rollupOptions: { external: [/^three($|\/)/] },
  },
})

// atelier-kit/ui.css: Atelier UI for apps, with Inter as a data: font (apps have no network; font-src allows data:).
const inter = readFileSync(join(root, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2')).toString('base64')
const interFace = `@font-face {
  font-family: 'Inter Variable';
  font-style: normal;
  font-display: block;
  font-weight: 100 900;
  src: url(data:font/woff2;base64,${inter}) format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`
writeFileSync(join(out, 'atelier-kit', 'ui.css'), `${interFace}\n${readFileSync(join(root, 'src', 'kit', 'ui.css'), 'utf8')}`)
cpSync(join(root, 'node_modules', '@fontsource-variable', 'inter', 'LICENSE'), join(out, 'atelier-kit', 'INTER-LICENSE'))

const importMap = {
  imports: {
    three: `${base}/three/build/three.module.js`,
    'three/addons/': `${base}/three/examples/jsm/`,
    'three/examples/jsm/': `${base}/three/examples/jsm/`,
    'atelier-kit/': `${base}/atelier-kit/`,
  },
}
writeFileSync(join(out, 'importmap.json'), `${JSON.stringify(importMap, null, 2)}\n`)
console.log(`Atelier kit ${MAJOR} built in ${relative(root, out)}: three ${JSON.parse(readFileSync(join(three, 'package.json'), 'utf8')).version}, ${seen.size} addon files, the companion art and atelier-kit (character, guide, props, world, ui.css).`)

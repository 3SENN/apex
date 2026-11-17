/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// electron-builder's afterPack hook. Runs after the app is
// laid out and before it is signed, so whatever it adds gets signed too.
//
// macOS 26 draws app icons from an Icon Composer document (light, dark,
// tinted and clear), compiled by actool into Assets.car and named by
// CFBundleIconName. When Xcode 26's actool is here, this compiles the
// branding's Icon Composer document (branding/official/Atelier.icon; the
// unofficial branding has none) into the bundle; icon.icns stays as
// CFBundleIconFile for older macOS either way. Without actool the app keeps
// the .icns only, with a warning, rather than a CFBundleIconName that names
// nothing (which would give a generic Dock icon).
//
// It also finishes naming the helpers: electron-builder renames their files,
// executables and display names to "Atelier Helper (…)" but leaves CFBundleName
// as "Electron Helper (…)", so this sets that too.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { loadBranding } from '../branding.mjs'

/** The official Icon Composer document's name (Atelier.icon); a branding's own document names its icon. */
export const ICON_NAME = 'Atelier'

/** The branding's Icon Composer document and the icon name it compiles to, or null when the branding has none. */
export function iconComposer(branding) {
  const file = branding.icons?.macIconComposer
  return typeof file === 'string' && file.endsWith('.icon') ? { dir: join(branding.dir, file), name: basename(file, '.icon') } : null
}

function actoolVersion() {
  try {
    const out = execFileSync('xcrun', ['actool', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(out)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Compiles `iconDir` (an .icon document) into `outDir`; returns the Assets.car path. */
export function compileIcon(iconDir, outDir, iconName = ICON_NAME) {
  execFileSync(
    'xcrun',
    [
      'actool', iconDir,
      '--compile', outDir,
      '--output-format', 'human-readable-text',
      '--errors',
      '--output-partial-info-plist', join(outDir, 'partial.plist'),
      '--app-icon', iconName,
      '--include-all-app-icons',
      '--enable-on-demand-resources', 'NO',
      '--development-region', 'en',
      '--target-device', 'mac',
      '--minimum-deployment-target', '13.0',
      '--platform', 'macosx',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const car = join(outDir, 'Assets.car')
  if (!existsSync(car)) throw new Error('actool finished without Assets.car')
  return car
}

/** "Electron Helper (GPU)" becomes "Atelier Helper (GPU)"; any other name stays. */
export function helperName(name, productName) {
  return name.startsWith('Electron Helper') ? productName + name.slice('Electron'.length) : name
}

/** Sets CFBundleName of every helper app in `app` to Atelier's name; returns how many changed. */
export function nameHelpers(app, productName) {
  const frameworks = join(app, 'Contents', 'Frameworks')
  let changed = 0
  for (const entry of existsSync(frameworks) ? readdirSync(frameworks) : []) {
    const plist = join(frameworks, entry, 'Contents', 'Info.plist')
    if (!entry.endsWith('.app') || !existsSync(plist)) continue
    const current = execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
    const next = helperName(current, productName)
    if (next === current) continue
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', next, plist])
    changed += 1
  }
  return changed
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const helpers = nameHelpers(app, context.packager.appInfo.productName)
  if (helpers > 0) console.log(`  • Atelier: named ${helpers} helper app${helpers === 1 ? '' : 's'} ${context.packager.appInfo.productName}`)
  const resources = join(app, 'Contents', 'Resources')
  if (existsSync(join(resources, 'Assets.car'))) return // electron-builder compiled an .icon itself

  const icon = iconComposer(loadBranding(process.env, context.packager.projectDir))
  if (!icon) return // the branding draws its icon from icon.icns alone
  const version = process.platform === 'darwin' ? actoolVersion() : null
  if (version === null || version < 26) {
    console.warn(`  • Atelier: ${version === null ? 'no actool' : `actool ${version}`} (needs Xcode 26), so the app keeps icon.icns only`)
    return
  }
  const work = mkdtempSync(join(tmpdir(), 'atelier-icon-'))
  try {
    copyFileSync(compileIcon(icon.dir, work, icon.name), join(resources, 'Assets.car'))
    execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', icon.name, join(app, 'Contents', 'Info.plist')])
    console.log(`  • Atelier: compiled ${icon.name}.icon into Assets.car (actool ${version})`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

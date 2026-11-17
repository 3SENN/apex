/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { session } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ARTIFACTS_PARTITION, LIBRARY_FILES_URL, artifactUrl, fileViewerUrl, type FilesEvent } from '@shared/files'
import { ARTIFACT_CSP, artifactRequestAllowed } from '../artifacts/policy'
import { filesForSmoke } from '../features/files'
import { fileTokenOf, serveFile } from '../files/fileProtocol'
import { setupFiles } from '../files/service'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Library › Files, the viewer for each type, quick look and
// artifact tabs. Offline only: temp folders for the
// stand-alone service, the smoke profile's library for the live one, and a
// local trash folder instead of the person's Trash.

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

const CHAT = '11111111-2222-4333-8444-555555555555'

/** A stand-alone files service over a temp folder, its deletions going to a local bin. */
function standalone(): { dir: string; files: ReturnType<typeof setupFiles>; events: FilesEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), 'apex-smoke-c4-'))
  const bin = join(dir, '.trash')
  const events: FilesEvent[] = []
  const files = setupFiles({
    dataDir: dir,
    broadcast: (e) => events.push(e),
    trash: async (path) => {
      mkdirSync(bin, { recursive: true })
      renameSync(path, join(bin, basename(path)))
    },
  })
  return { dir, files, events }
}

export const checks: SmokeCheck[] = [
  {
    name: 'files: a generated file shows in Library › Files and opens in the viewer and in quick look',
    async run() {
      const { files } = standalone()
      try {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex')
        const ref = files.library.addGenerated({ chatId: CHAT, companionId: 'pip', name: 'chart.png', mediaType: 'image/png', bytes: png })
        assert(files.services.files.list({ kind: 'generated' }).some((f) => f.id === ref.id), 'the generated file is not in Library › Files')
        const inTab = await files.services.viewer.open({ kind: 'library', id: ref.id }, 't-smoke')
        assert(inTab.state === 'ready' && inTab.previewable === 'image' && inTab.url, 'the viewer did not open the image')
        const look = await files.services.viewer.open({ kind: 'library', id: ref.id })
        const served = serveFile(new Request(look.url as string), files.documents.served(fileTokenOf(look.url as string) as string))
        assert(served.status === 200 && served.headers.get('content-type') === 'image/png', 'apex-file did not serve the image')
        files.services.viewer.release(look.token)
        assert(files.documents.served(look.token) === null, 'a released quick look token still serves')
        files.documents.releaseOwner('t-smoke')
        assert(files.documents.served(inTab.token) === null, 'the viewer token outlived its tab')
      } finally {
        files.dispose()
      }
    },
  },
  {
    name: 'files: a report still being written shows its live state until it is finished',
    async run() {
      const { files } = standalone()
      try {
        const ref = files.library.beginReport({ chatId: CHAT, companionId: 'pip', name: 'Brief.md', mediaType: 'text/markdown' })
        files.library.updateReport(ref.id, '# Brief\n\nFirst part')
        const writing = await files.services.viewer.open({ kind: 'library', id: ref.id })
        assert(writing.state === 'writing' && writing.text?.includes('First part') && !writing.editable, 'the report does not show as being written')
        files.library.finishReport(ref.id, '# Brief\n\nFirst part\n\nDone.')
        const done = await files.services.viewer.open({ kind: 'library', id: ref.id })
        assert(done.state === 'ready' && done.text?.includes('Done.') && done.editable, 'the finished report did not become ready')
      } finally {
        files.dispose()
      }
    },
  },
  {
    name: 'files: the viewer edits, renames and deletes a memory file; missing and outside files are refused',
    async run() {
      const { dir, files } = standalone()
      const outside = mkdtempSync(join(tmpdir(), 'apex-smoke-c4-out-'))
      try {
        const memories = join(dir, 'memory', 'memories')
        mkdirSync(memories, { recursive: true })
        writeFileSync(join(memories, 'notes.md'), '---\ntitle: Notes\n---\n\nOld line\n')
        const doc = await files.services.viewer.open({ kind: 'memory', owner: 'shared', path: 'notes.md' })
        assert(doc.editable && doc.frontmatter?.title === 'Notes', 'the memory file did not open for editing with its front matter')
        files.services.viewer.save(doc.token, '---\ntitle: Notes\n---\n\nNew line\n')
        assert(readFileSync(join(memories, 'notes.md'), 'utf8').includes('New line'), 'the edit was not saved')
        const renamed = files.services.viewer.rename(doc.token, 'renamed.md')
        assert(renamed.name === 'renamed.md' && existsSync(join(memories, 'renamed.md')), 'the rename did not happen on disk')
        let deleted = ''
        const off = files.viewer.onDelete((d) => (deleted = d.name))
        await files.services.viewer.remove(doc.token)
        off()
        assert(!existsSync(join(memories, 'renamed.md')) && existsSync(join(dir, '.trash', 'renamed.md')) && deleted === 'renamed.md', 'the delete did not go to the trash')
        const missing = await files.services.viewer.open({ kind: 'memory', owner: 'shared', path: 'gone.md' })
        assert(missing.state === 'missing', 'a missing file did not show the missing state')
        writeFileSync(join(outside, 'secret.txt'), 'secret')
        let linked = 'link.txt'
        try {
          symlinkSync(join(outside, 'secret.txt'), join(memories, linked))
        } catch (err) {
          // Windows only lets an admin (or Developer Mode) make a symlink; anyone can make a junction to a folder.
          if (process.platform !== 'win32') throw err
          symlinkSync(outside, join(memories, 'away'), 'junction')
          linked = 'away/secret.txt'
        }
        const refused = await files.services.viewer.open({ kind: 'memory', owner: 'shared', path: linked }).then(
          () => false,
          () => true,
        )
        assert(refused, 'a symlink out of Apex’s folders was opened')
        const local = await files.services.viewer.open({ kind: 'local', path: join(outside, 'secret.txt') }).then(
          () => false,
          () => true,
        )
        assert(local, 'a local path that was never picked was opened')
      } finally {
        files.dispose()
      }
    },
  },
  {
    name: 'files: an artifact is served in its own partition with the sandbox policy, and nothing else loads there',
    async run() {
      const live = filesForSmoke()
      assert(live, 'the files feature is not running')
      const ref = live.library.saveArtifact({ chatId: CHAT, companionId: 'pip', title: 'Smoke artifact', format: 'html', content: '<p id="x">Made by the smoke run</p><script>fetch("http://127.0.0.1:9/")</script>' })
      try {
        const artifacts = session.fromPartition(ARTIFACTS_PARTITION)
        const res = await artifacts.fetch(artifactUrl(ref.id))
        assert(res.status === 200, `the artifact was not served (${res.status})`)
        assert(res.headers.get('content-security-policy') === ARTIFACT_CSP, 'the artifact lacks its sandbox policy')
        assert((await res.text()).includes('Made by the smoke run'), 'the artifact served the wrong document')
        assert(!artifactRequestAllowed({ url: 'http://127.0.0.1:9/', resourceType: 'xhr' }), 'the artifact filter lets a network request through')
        const other = await artifacts.fetch(artifactUrl('00000000-0000-4000-8000-000000000000'))
        assert(other.status === 404, 'an unknown artifact id was served')
      } finally {
        await live.services.files.remove(ref.id).catch(() => undefined)
      }
    },
  },
  {
    name: 'files: Library › Files lists a file and the viewer page draws it',
    async run(ctx) {
      const live = filesForSmoke()
      assert(live, 'the files feature is not running')
      const ref = live.library.addGenerated({ chatId: CHAT, companionId: 'pip', name: 'smoke-notes.md', mediaType: 'text/markdown', bytes: Buffer.from('# Smoke notes\n\nA line the smoke run wrote.\n') })
      try {
        ctx.tabs.openInternal(LIBRARY_FILES_URL)
        await ctx.chrome.until(`return [...document.querySelectorAll('.lf-card__name')].some((el) => el.textContent === 'smoke-notes.md')`, 8000, 'the Files page card')
        ctx.tabs.openInternal(fileViewerUrl({ kind: 'library', id: ref.id }, { name: ref.name }))
        await ctx.chrome.until(`return document.querySelector('.fv-page__name')?.textContent === 'smoke-notes.md' && document.querySelector('.fv-md')?.textContent.includes('A line the smoke run wrote')`, 8000, 'the viewer page')
      } finally {
        await live.services.files.remove(ref.id).catch(() => undefined)
      }
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'files-page',
    async run(ctx) {
      const live = filesForSmoke()
      if (!live) return
      const refs = [
        live.library.addGenerated({ chatId: CHAT, companionId: 'pip', name: 'Quarterly chart.png', mediaType: 'image/png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') }),
        live.library.saveArtifact({ chatId: CHAT, companionId: 'pip', title: 'Trip plan', format: 'html', content: '<h1>Trip plan</h1>' }),
      ]
      try {
        ctx.tabs.openInternal(LIBRARY_FILES_URL)
        await ctx.chrome.until(`return document.querySelectorAll('.lf-card').length >= 2`, 8000, 'the Files page cards')
        await ctx.shot('files-page')
      } finally {
        for (const ref of refs) await live.services.files.remove(ref.id).catch(() => undefined)
      }
    },
  },
  {
    name: 'files-viewer-markdown',
    async run(ctx) {
      const live = filesForSmoke()
      if (!live) return
      const ref = live.library.addGenerated({ chatId: CHAT, companionId: 'pip', name: 'Plan.md', mediaType: 'text/markdown', bytes: Buffer.from('---\ntitle: Plan\n---\n\n# Plan\n\n- One\n- Two\n') })
      try {
        ctx.tabs.openInternal(fileViewerUrl({ kind: 'library', id: ref.id }, { name: ref.name }))
        await ctx.chrome.until(`return !!document.querySelector('.fv-front') && !!document.querySelector('.fv-md')`, 8000, 'the Markdown viewer')
        await ctx.shot('files-viewer-markdown')
      } finally {
        await live.services.files.remove(ref.id).catch(() => undefined)
      }
    },
  },
]

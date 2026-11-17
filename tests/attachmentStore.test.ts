/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef, AttachmentsEvent } from '../src/shared/attachments'
import type { ChatContextEvent } from '../src/shared/chatContext'
import { setupIntake, type IntakeHost } from '../src/main/intake/service'
import type { ImageProcessor } from '../src/main/intake/prepare'
import { buildDocx, buildPdf, executableBytes } from '../src/main/smokeFilesConnectors/intakeFixtures'

// CH-21 to CH-25, MV-14, ST-54: the attachment store end to end on a temp
// folder, with the hidden renderer and the pdf worker faked.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')
const b64 = (data: Uint8Array | string): string => Buffer.from(data).toString('base64')

function images(over: Partial<ImageProcessor> = {}): ImageProcessor {
  return {
    prepareImage: async () => ({ bytes: new Uint8Array(100), mediaType: 'image/jpeg', width: 10, height: 10, thumbnail: 'data:image/webp;base64,AAAA' }),
    rasterizeSvg: async () => ({ bytes: new Uint8Array(50), mediaType: 'image/png', width: 10, height: 10, thumbnail: null }),
    pdfThumbnail: async () => null,
    dispose: () => {},
    ...over,
  }
}

function setup(host: IntakeHost = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'apex-intake-'))
  const events: (AttachmentsEvent | ChatContextEvent)[] = []
  let now = 1_000_000_000_000
  const intake = setupIntake({
    dataDir,
    broadcast: (e) => events.push(e),
    host: { images: images(), pdf: { read: async () => ({ ok: true, pages: 3, text: '--- Page 1 ---' }) }, now: () => now, ...host },
  })
  const add = intake.services.attachments.add
  const settle = async (chatId: string, ref: AttachmentRef): Promise<AttachmentRef> => (await intake.store.settled(chatId, [ref.id]))[0]!
  return { intake, dataDir, events, add, settle, advance: (ms: number) => (now += ms) }
}

describe('adding and preparing', () => {
  it('answers preparing at once, then ready, emitting each change', async () => {
    const { add, settle, events, intake } = setup()
    const chat = randomUUID()
    const ref = add(chat, { type: 'paste', text: 'one\ntwo\nthree' })
    expect(ref.state).toBe('preparing')
    const ready = await settle(chat, ref)
    expect(ready).toMatchObject({ state: 'ready', kind: 'paste', lines: 3, error: null })
    const states = events.filter((e): e is AttachmentsEvent => e.type === 'attachments').map((e) => e.items[0]?.state)
    expect(states).toEqual(['preparing', 'ready'])
    expect(intake.services.attachments.readText(chat, ref.id)).toBe('one\ntwo\nthree')
  })

  it('stores files privately under attachments/<chat>/<id>', async () => {
    const { add, settle, dataDir } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'file', name: 'notes.md', base64: b64('# Hi\n') }))
    expect(ref).toMatchObject({ kind: 'text', mediaType: 'text/markdown', lines: 1 })
    const folder = join(dataDir, 'attachments', chat, ref.id)
    expect(readdirSync(folder).sort()).toEqual(['meta.json', 'original', 'prepared.txt'])
    // Windows has no POSIX permission bits to check.
    if (process.platform !== 'win32') expect(statSync(join(folder, 'original')).mode & 0o777).toBe(0o600)
  })

  it('refuses the wrong kind at once, with its reason, and keeps nothing', async () => {
    const { add, dataDir } = setup()
    const chat = randomUUID()
    const ref = add(chat, { type: 'file', name: 'setup.txt', base64: b64(executableBytes()) })
    expect(ref).toMatchObject({ state: 'failed', error: `${BRAND_NAME} can't read this kind of file` })
    expect(existsSync(join(dataDir, 'attachments', chat, ref.id, 'original'))).toBe(false)
  })

  it('refuses an oversized file with its reason', () => {
    const { add } = setup()
    const chat = randomUUID()
    const ref = add(chat, { type: 'file', name: 'huge.txt', base64: b64('x'.repeat(2_000_001)) })
    expect(ref).toMatchObject({ state: 'failed', error: 'This text is over 2 MB' })
  })

  it('adds picked files from disk, refusing the unreadable ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-pick-'))
    writeFileSync(join(dir, 'a.csv'), 'a,b\n1,2\n')
    writeFileSync(join(dir, 'tool.txt'), executableBytes())
    const { intake } = setup({ pickFiles: async () => [join(dir, 'a.csv'), join(dir, 'tool.txt'), join(dir, 'missing.txt')] })
    const chat = randomUUID()
    const refs = await intake.services.attachments.pick(chat)
    expect(refs.map((r) => [r.name, r.state])).toEqual([['a.csv', 'preparing'], ['tool.txt', 'failed']])
    expect((await intake.store.settled(chat, [refs[0]!.id]))[0]).toMatchObject({ state: 'ready', mediaType: 'text/csv', lines: 2 })
  })

  it('needs Files and documents for office files', async () => {
    let on = false
    const { add, settle, intake } = setup({ documentsOn: () => on })
    const chat = randomUUID()
    const off = await settle(chat, add(chat, { type: 'file', name: 'a.docx', base64: b64(buildDocx()) }))
    expect(off).toMatchObject({ state: 'failed', error: 'Turn on Files and documents in Settings › Model and key to attach this' })
    on = true
    intake.services.attachments.retry(chat, off.id)
    expect(await settle(chat, off)).toMatchObject({ state: 'ready', kind: 'office' })
  })

  it('reports PDF pages and keeps the text for engines that need it', async () => {
    const { add, settle, intake } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'file', name: 'r.pdf', base64: b64(buildPdf(3)) }))
    expect(ref).toMatchObject({ kind: 'pdf', pages: 3 })
    const [prepared] = intake.store.resolve(chat, [ref.id])
    expect(prepared?.payload).toMatchObject({ type: 'pdf', pages: 3, text: '--- Page 1 ---' })
  })

  it('retries from the saved original after a failure', async () => {
    let fail = true
    const { add, settle, intake } = setup({ images: images({ prepareImage: async () => (fail ? Promise.reject(new Error('x')) : { bytes: new Uint8Array(3), mediaType: 'image/png', width: 1, height: 1, thumbnail: null }) }) })
    const chat = randomUUID()
    const failed = await settle(chat, add(chat, { type: 'file', name: 'a.png', base64: PNG }))
    expect(failed).toMatchObject({ state: 'failed', error: "This image couldn't be read" })
    fail = false
    intake.services.attachments.retry(chat, failed.id)
    const ready = await settle(chat, failed)
    expect(ready).toMatchObject({ state: 'ready', kind: 'image', size: 3 })
    expect(intake.store.resolve(chat, [ready.id])[0]?.payload).toMatchObject({ type: 'image', mediaType: 'image/png' })
  })

  it('caps a message at 20 attachments', () => {
    const { add } = setup()
    const chat = randomUUID()
    for (let i = 0; i < 20; i++) add(chat, { type: 'paste', text: `p${i}` })
    expect(() => add(chat, { type: 'paste', text: 'one more' })).toThrow('A message can hold up to 20 attachments')
  })

  it('fails the chip that takes the message over 32 MB', async () => {
    const big = (n: number) => ({ bytes: new Uint8Array(n), mediaType: 'image/jpeg' as const, width: 1, height: 1, thumbnail: null })
    const { add, settle } = setup({ images: images({ prepareImage: async () => big(20_000_000) }) })
    const chat = randomUUID()
    await settle(chat, add(chat, { type: 'file', name: 'a.png', base64: PNG }))
    const second = await settle(chat, add(chat, { type: 'file', name: 'b.png', base64: PNG }))
    expect(second).toMatchObject({ state: 'failed', error: 'These attachments are over 32 MB together. Remove some to send' })
  })
})

describe('text attachments (CH-24)', () => {
  it('edits pasted text, recounting its lines', async () => {
    const { add, settle, intake } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'paste', text: 'a\nb' }))
    const edited = intake.services.attachments.updateText(chat, ref.id, 'a\nb\nc\nd')
    expect(edited).toMatchObject({ state: 'ready', lines: 4 })
    expect(intake.services.attachments.readText(chat, ref.id)).toBe('a\nb\nc\nd')
  })

  it('frames a selection with its source and links (OV-20)', async () => {
    const { add, settle, intake } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'selection', text: 'quoted words', url: 'https://x.test/a', title: 'X', links: [{ text: 'b', url: 'https://x.test/b' }] }))
    expect(ref).toMatchObject({ kind: 'selection', source: { url: 'https://x.test/a', title: 'X' } })
    const [p] = intake.store.resolve(chat, [ref.id])
    expect(p?.payload).toMatchObject({ type: 'text', title: 'Selection from X', sourceUrl: 'https://x.test/a' })
    expect((p?.payload as { text: string }).text).toContain('https://x.test/b')
    expect(() => intake.services.attachments.updateText(chat, ref.id, 'new')).toThrow()
  })
})

describe('providers (CH-21, CH-25)', () => {
  const tabHost = (internal = false): IntakeHost => ({
    sources: {
      tab: (tabId) => (tabId === 't1' ? { url: internal ? 'apex://settings' : 'https://site.test/', title: 'Site', favicon: null, internal } : null),
      readTab: async () => ({ text: 'page words' }),
      chatTitle: () => 'Earlier',
      chatMarkdown: () => ({ title: 'Earlier', text: '# Earlier chat' }),
      skill: (id) => (id === 's1' ? { name: 'tidy', instructions: 'Tidy up.' } : null),
      record: async () => ({ title: 'Ticket 7', text: 'record body' }),
    },
  })

  it('reads a tab as a titled document and lists its page in the chat', async () => {
    const { add, settle, intake } = setup(tabHost())
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'tab', tabId: 't1' }))
    expect(ref).toMatchObject({ kind: 'tab', state: 'ready', name: 'Site', source: { url: 'https://site.test/', tabId: 't1' } })
    expect(intake.store.resolve(chat, [ref.id])[0]?.payload).toEqual({ type: 'text', text: 'page words', title: 'Site', sourceUrl: 'https://site.test/' })
    expect(intake.services.chatContext.list(chat)).toMatchObject([{ tabId: 't1', source: 'attached', inContext: true }])
    intake.services.attachments.remove(chat, ref.id)
    expect(intake.services.chatContext.list(chat)).toEqual([])
  })

  it('refuses apex:// tabs and closed tabs', async () => {
    const { add, settle } = setup(tabHost(true))
    const chat = randomUUID()
    expect(await settle(chat, add(chat, { type: 'tab', tabId: 't1' }))).toMatchObject({ state: 'failed', error: `${BRAND_NAME} pages can't be attached` })
    expect(await settle(chat, add(chat, { type: 'tab', tabId: 'gone' }))).toMatchObject({ state: 'failed', error: 'This tab is closed' })
  })

  it('attaches chats, skills and connector records', async () => {
    const { add, settle, intake } = setup(tabHost())
    const chat = randomUUID()
    const other = randomUUID()
    expect(await settle(chat, add(chat, { type: 'chat', chatId: other }))).toMatchObject({ kind: 'chat', name: 'Chat: Earlier', state: 'ready' })
    expect(await settle(chat, add(chat, { type: 'chat', chatId: chat }))).toMatchObject({ state: 'failed', error: "A chat can't be attached to itself" })
    const skill = await settle(chat, add(chat, { type: 'skill', skillId: 's1' }))
    expect(skill).toMatchObject({ kind: 'skill', name: '/tidy' })
    expect(intake.store.resolve(chat, [skill.id])[0]?.payload).toEqual({ type: 'skill', skillId: 's1' })
    expect(await settle(chat, add(chat, { type: 'connector-record', connectorId: 'c', uri: 'x://7', title: 'T' }))).toMatchObject({ kind: 'connector-record', name: 'Ticket 7' })
  })

  it('fetches a dragged page image through the tab, with a content-type check', async () => {
    let type = 'image/png'
    const { add, settle } = setup({ sources: { tab: () => ({ url: 'https://s.test/', title: 'S', favicon: null, internal: false }), fetchFromTab: async () => ({ bytes: Buffer.from(PNG, 'base64'), contentType: type }) } })
    const chat = randomUUID()
    expect(await settle(chat, add(chat, { type: 'page-url', tabId: 't', url: 'https://s.test/cat.png' }))).toMatchObject({ kind: 'image', state: 'ready', name: 'cat.png' })
    type = 'application/octet-stream'
    expect(await settle(chat, add(chat, { type: 'page-url', tabId: 't', url: 'https://s.test/x.bin' }))).toMatchObject({ state: 'failed', error: `${BRAND_NAME} can't read this kind of file` })
  })

  it('holds a meeting in preparing until its transcript is ready (MV-14)', async () => {
    let ready = false
    const { add, intake } = setup({ sources: { meeting: async () => ({ title: 'Standup', text: 'transcript', ready }) } })
    const chat = randomUUID()
    const ref = add(chat, { type: 'meeting', meetingId: 'm1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(intake.services.attachments.list(chat)[0]).toMatchObject({ state: 'preparing', name: 'Standup' })
    expect(() => intake.store.resolve(chat, [ref.id])).toThrow('Wait for attachments to finish preparing')
    ready = true
    intake.meetingsChanged()
    expect((await intake.store.settled(chat, [ref.id]))[0]).toMatchObject({ state: 'ready', kind: 'meeting' })
  })

  it('stores an older inline image as a file, so it is downscaled like any other', async () => {
    const { add, settle, intake } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'inline', attachment: { kind: 'image', mediaType: 'image/png', data: PNG, label: 'Voice' } }))
    expect(ref).toMatchObject({ kind: 'image', state: 'ready', name: 'Voice' })
    expect(intake.store.resolve(chat, [ref.id])[0]?.payload.type).toBe('image')
  })
})

describe('main-only API', () => {
  it('freezes attachments once sent', async () => {
    const { add, settle, intake } = setup()
    const chat = randomUUID()
    const ref = await settle(chat, add(chat, { type: 'paste', text: 'x' }))
    intake.store.bindToMessage(chat, [ref.id], 'm1')
    expect(intake.services.attachments.list(chat)).toEqual([])
    expect(() => intake.services.attachments.remove(chat, ref.id)).toThrow('This attachment was already sent')
    expect(intake.store.resolve(chat, [ref.id])).toHaveLength(1)
  })

  it('copies ready attachments for a new chat, counting failures', async () => {
    const { add, settle, intake } = setup()
    const from = randomUUID()
    const to = randomUUID()
    const good = await settle(from, add(from, { type: 'paste', text: 'keep' }))
    const bad = add(from, { type: 'file', name: 'x', base64: b64(executableBytes()) })
    expect(intake.store.copyForChat(from, to, [good.id, bad.id, randomUUID()])).toEqual({ copied: 1, failed: 2 })
    expect(intake.services.attachments.readText(to, good.id)).toBe('keep')
  })

  it('remembers Files API uploads per key', () => {
    const { intake } = setup()
    const chat = randomUUID()
    intake.store.setRemoteFile(chat, 'a', 'k1', 'file_1')
    intake.store.setRemoteFile(chat, 'a', 'k1', 'file_2')
    intake.store.setRemoteFile(chat, 'a', 'k2', 'file_3')
    expect(intake.store.remoteFiles(chat).sort()).toEqual(['file_2', 'file_3'])
    expect(intake.store.remoteFile(chat, 'a', 'k1')).toBe('file_2')
    expect(intake.store.remoteFile(chat, 'a', 'k9')).toBeNull()
  })

  it('prunes sent images older than the cutoff, keeping their text (ST-54)', async () => {
    const { add, settle, intake, advance } = setup()
    const chat = randomUUID()
    const image = await settle(chat, add(chat, { type: 'file', name: 'a.png', base64: PNG }))
    const draft = await settle(chat, add(chat, { type: 'file', name: 'b.png', base64: PNG }))
    const text = await settle(chat, add(chat, { type: 'paste', text: 'words' }))
    intake.store.bindToMessage(chat, [image.id, text.id], 'm1')
    const before = intake.store.sizes().chatAttachments
    advance(31 * 86_400_000)
    expect(intake.store.pruneImages(30)).toBe(1)
    expect(intake.store.pruneImages(30)).toBe(0)
    expect(intake.store.sizes().chatAttachments).toBeLessThan(before)
    expect(intake.store.resolve(chat, [image.id])[0]?.payload).toMatchObject({ type: 'text' })
    expect(intake.store.resolve(chat, [draft.id])[0]?.payload.type).toBe('image')
    expect(intake.services.attachments.readText(chat, text.id)).toBe('words')
  })

  it("measures one chat and prunes only the chats it's given (ST-54 per-chat rows)", async () => {
    const { add, settle, intake, advance } = setup()
    const [a, b] = [randomUUID(), randomUUID()]
    for (const chat of [a, b]) {
      const image = await settle(chat, add(chat, { type: 'file', name: 'a.png', base64: PNG }))
      const words = await settle(chat, add(chat, { type: 'paste', text: 'words' }))
      intake.store.bindToMessage(chat, [image.id, words.id], 'm1')
    }
    const before = intake.store.chatSize(a)
    expect(before.imageBytes).toBeGreaterThan(0)
    expect(before.bytes).toBeGreaterThan(before.imageBytes)
    expect(intake.store.chatSize('not-a-chat')).toEqual({ bytes: 0, imageBytes: 0 })
    advance(86_400_000)
    expect(intake.store.pruneImages(0, [a, '../escape'])).toBe(1)
    expect(intake.store.chatSize(a).imageBytes).toBe(0)
    expect(intake.store.chatSize(b).imageBytes).toBe(before.imageBytes)
    expect(intake.store.pruneImages(0)).toBe(1)
  })

  it('removes a chat with its folder, and sweeps old drafts of chats that never were', async () => {
    const { add, settle, intake, dataDir } = setup()
    const chat = randomUUID()
    await settle(chat, add(chat, { type: 'paste', text: 'x' }))
    intake.store.removeChat(chat)
    expect(existsSync(join(dataDir, 'attachments', chat))).toBe(false)
    const orphan = randomUUID()
    await settle(orphan, add(orphan, { type: 'paste', text: 'y' }))
    const old = new Date(1_000_000_000_000 - 2 * 86_400_000)
    utimesSync(join(dataDir, 'attachments', orphan), old, old)
    intake.sweep(() => false)
    expect(existsSync(join(dataDir, 'attachments', orphan))).toBe(false)
  })

  it('reloads saved attachments in a new launch', async () => {
    const first = setup()
    const chat = randomUUID()
    const ref = await first.settle(chat, first.add(chat, { type: 'paste', text: 'saved' }))
    const second = setupIntake({ dataDir: first.dataDir, broadcast: () => {} })
    expect(second.services.attachments.list(chat)).toMatchObject([{ id: ref.id, state: 'ready' }])
    expect(second.services.attachments.readText(chat, ref.id)).toBe('saved')
  })
})

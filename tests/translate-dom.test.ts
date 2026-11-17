/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DomTranslator, chunkText, collectSegments, contextAllows, makeBatches, sampleText, splitSpace } from '../src/preload/page/translateDom'
import { FText, h, serialize, texts } from './helpers/fakeDom'

// Page translation in the page (TR-07 to TR-09): which text goes out, in what
// batches, how it comes back in place, and that Show original restores the
// page exactly.

const upper = async (batch: string[]): Promise<string[]> => batch.map((t) => t.toUpperCase())

function page() {
  return h(
    'body',
    {},
    h('h1', { title: 'Le titre' }, 'Bonjour le monde'),
    h('p', {}, '  Bienvenue sur ', h('a', { href: '/x', class: 'link' }, 'notre site'), '.  '),
    h('img', { alt: 'Une image', src: 'a.png' }),
    h('input', { placeholder: 'Votre adresse', value: 'garder' }),
    h('input', { type: 'hidden', title: 'caché' }),
    h('pre', {}, 'const bonjour = 1'),
    h('code', { title: 'un titre' }, 'monde()'),
    h('textarea', {}, 'texte saisi'),
    h('div', { contenteditable: 'true' }, 'éditable', h('span', { translate: 'yes' }, 'quand même')),
    h('div', { translate: 'no' }, 'Marque', h('span', { translate: 'yes' }, 'oui ici')),
    h('span', { class: 'brand notranslate' }, 'Nom propre'),
    h('script', {}, 'var x = "texte"'),
    h('style', {}, '.a{content:"b"}'),
    h('p', {}, '12 345 — 2024'),
  )
}

describe('collecting text (TR-07)', () => {
  it('takes text and title, alt, placeholder; leaves code, inputs, editable and opted-out parts', () => {
    const body = page()
    const segs = collectSegments([body])
    const shown = segs.map((s) => (s.kind === 'text' ? s.node.data.trim() : `@${s.name}=${s.el.getAttribute(s.name)}`))
    expect(shown).toEqual([
      '@title=Le titre',
      'Bonjour le monde',
      'Bienvenue sur',
      'notre site',
      '@alt=Une image',
      '@placeholder=Votre adresse',
      '@title=un titre',
      'oui ici',
    ])
  })

  it('splits white space off and skips text without letters', () => {
    expect(splitSpace('  a b \n')).toEqual({ lead: '  ', core: 'a b', trail: ' \n' })
    expect(splitSpace('   ')).toEqual({ lead: '   ', core: '', trail: '' })
    expect(collectSegments([h('p', {}, '  42 % ', h('b', {}, '—'))])).toEqual([])
  })

  it('judges added nodes by their ancestors', () => {
    const inner = new FText('nouveau')
    h('div', { translate: 'no' }, h('span', {}, inner))
    expect(contextAllows(inner)).toBe(false)
    const ok = new FText('nouveau')
    h('div', { translate: 'no' }, h('span', { translate: 'yes' }, ok))
    expect(contextAllows(ok)).toBe(true)
    const code = new FText('x')
    h('pre', {}, h('span', {}, code))
    expect(contextAllows(code)).toBe(false)
    const edit = new FText('x')
    h('div', { contenteditable: '' }, h('p', { contenteditable: 'false' }, edit))
    expect(contextAllows(edit)).toBe(false)
  })

  it('walks open shadow roots', () => {
    const host = h('my-card')
    host.shadowRoot = h('#shadow', {}, h('p', {}, 'Dans l’ombre'))
    // The shadow root is a fragment-like node.
    ;(host.shadowRoot as unknown as { nodeType: number }).nodeType = 11
    expect(collectSegments([h('body', {}, host)]).map((s) => (s.kind === 'text' ? s.node.data : ''))).toEqual(['Dans l’ombre'])
  })

  it('samples only translatable text', () => {
    expect(sampleText([page()], 40)).toBe('Bonjour le monde Bienvenue sur notre sit')
  })
})

describe('batches (TR-08)', () => {
  it('dedupes and caps by count and characters; a long text goes alone', () => {
    expect(makeBatches(['a', 'b', 'a', 'c', 'd'], 2, 100)).toEqual([['a', 'b'], ['c', 'd']])
    expect(makeBatches(['aaaa', 'bb', 'cc', 'dddddddd', 'e'], 10, 5)).toEqual([['aaaa'], ['bb', 'cc'], ['dddddddd'], ['e']])
    expect(makeBatches([])).toEqual([])
  })

  it('cuts an overlong text at sentence ends', () => {
    const text = 'Une phrase. Deux phrases! Trois?'
    expect(chunkText(text, 15)).toEqual(['Une phrase.', 'Deux phrases!', 'Trois?'])
    expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
    expect(chunkText('court', 10)).toEqual(['court'])
  })
})

describe('translating in place and restoring (TR-09)', () => {
  it('changes only the translated parts, keeps markup and spaces, and restores exactly', async () => {
    const body = page()
    const before = serialize(body)
    const translator = new DomTranslator({ items: 3, chars: 1000 })
    const calls: string[][] = []
    const result = await translator.start([body], async (batch) => {
      calls.push(batch)
      return upper(batch)
    })
    expect(result).toEqual({ done: 8, total: 8 })
    expect(calls.every((c) => c.length <= 3)).toBe(true)
    const after = serialize(body)
    expect(after).toContain('<h1 title="LE TITRE">BONJOUR LE MONDE</h1>')
    expect(after).toContain('<p>  BIENVENUE SUR <a href="/x" class="link">NOTRE SITE</a>.  </p>')
    expect(after).toContain('alt="UNE IMAGE" src="a.png"')
    expect(after).toContain('placeholder="VOTRE ADRESSE" value="garder"')
    expect(after).toContain('<pre>const bonjour = 1</pre>')
    expect(after).toContain('Marque')
    expect(after).toContain('OUI ICI')
    expect(after).toContain('éditable')
    expect(after).toContain('var x = "texte"')
    expect(translator.size).toBe(8)
    expect(translator.restore()).toBe(8)
    expect(serialize(body)).toBe(before)
    expect(translator.active).toBe(false)
  })

  it('sends each text once', async () => {
    const body = h('body', {}, h('button', {}, 'Répondre'), h('button', {}, 'Répondre'), h('p', {}, 'Autre'))
    const calls: string[][] = []
    await new DomTranslator().start([body], async (b) => (calls.push(b), upper(b)))
    expect(calls).toEqual([['Répondre', 'Autre']])
    expect(texts(body).map((t) => t.data)).toEqual(['RÉPONDRE', 'RÉPONDRE', 'AUTRE'])
  })

  it('leaves text the page rewrote meanwhile, and keeps it on restore', async () => {
    const node = new FText('Prix: dix')
    const other = new FText('Bonjour')
    const body = h('body', {}, h('p', {}, node), h('p', {}, other))
    const translator = new DomTranslator({ items: 1 })
    await translator.start([body], async (batch) => {
      if (batch[0] === 'Prix: dix') node.data = 'Prix: onze' // the page updates while the batch is out
      return upper(batch)
    })
    expect(node.data).toBe('Prix: onze')
    expect(other.data).toBe('BONJOUR')
    other.data = 'Changed by page'
    translator.restore()
    expect(node.data).toBe('Prix: onze')
    expect(other.data).toBe('Changed by page')
  })

  it('stops a run that a restore or a newer start replaced', async () => {
    const body = h('body', {}, h('p', {}, 'Un'), h('p', {}, 'Deux'), h('p', {}, 'Trois'))
    const translator = new DomTranslator({ items: 1 })
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const run = translator.start([body], async (batch) => {
      if (batch[0] === 'Deux') await gate
      return upper(batch)
    })
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    translator.restore()
    release()
    expect(await run).toBeNull()
    expect(texts(body).map((t) => t.data)).toEqual(['Un', 'Deux', 'Trois'])
  })

  it('a new target starts from the originals', async () => {
    const body = h('body', {}, h('p', {}, 'Bonjour'))
    const translator = new DomTranslator()
    await translator.start([body], async (b) => b.map((t) => `en:${t}`))
    await translator.start([body], async (b) => b.map((t) => `de:${t}`))
    expect(texts(body)[0]!.data).toBe('de:Bonjour')
    translator.restore()
    expect(texts(body)[0]!.data).toBe('Bonjour')
  })

  it('a failing engine leaves what was done and throws', async () => {
    const body = h('body', {}, h('p', {}, 'Un'), h('p', {}, 'Deux'))
    const translator = new DomTranslator({ items: 1 })
    await expect(translator.start([body], async (b) => {
      if (b[0] === 'Deux') throw new Error('down')
      return upper(b)
    })).rejects.toThrow('down')
    translator.restore()
    expect(texts(body).map((t) => t.data)).toEqual(['Un', 'Deux'])
  })
})

describe('dynamic content (TR-10)', () => {
  it('translates what the page adds and rewrites, and ignores its own writes', async () => {
    const first = new FText('Bonjour')
    const body = h('body', {}, h('p', {}, first))
    const translator = new DomTranslator()
    await translator.start([body], upper)
    // Our own write shows up as a characterData mutation: nothing to do.
    expect(translator.changed([{ type: 'characterData', target: first }])).toEqual([])
    // The page adds a card and rewrites the first paragraph.
    const card = h('div', {}, h('p', {}, 'Nouveau contenu'), h('code', {}, 'x()'))
    body.append(card)
    first.data = 'Au revoir'
    const roots = translator.changed([
      { type: 'childList', target: body, addedNodes: [card] },
      { type: 'characterData', target: first },
      { type: 'childList', target: card, addedNodes: [card.childNodes[0]!] },
    ])
    expect(roots).toEqual([card, first])
    expect(await translator.more(roots)).toEqual({ done: 2, total: 2 })
    expect(serialize(body)).toBe('<body><p>AU REVOIR</p><div><p>NOUVEAU CONTENU</p><code>x()</code></div></body>')
    translator.restore()
    // The rewritten text comes back as the page last wrote it.
    expect(serialize(body)).toBe('<body><p>Au revoir</p><div><p>Nouveau contenu</p><code>x()</code></div></body>')
  })

  it('translates an attribute the page changes', async () => {
    const img = h('img', { alt: 'Chat' })
    const body = h('body', {}, img)
    const translator = new DomTranslator()
    await translator.start([body], upper)
    expect(translator.changed([{ type: 'attributes', target: img, attributeName: 'alt' }])).toEqual([])
    img.setAttribute('alt', 'Chien')
    const roots = translator.changed([{ type: 'attributes', target: img, attributeName: 'alt' }])
    await translator.more(roots)
    expect(img.getAttribute('alt')).toBe('CHIEN')
    translator.restore()
    expect(img.getAttribute('alt')).toBe('Chien')
  })

  it('does nothing while not translated', async () => {
    const translator = new DomTranslator()
    expect(translator.changed([{ type: 'childList', target: h('p'), addedNodes: [h('p', {}, 'x')] }])).toEqual([])
    expect(await translator.more([h('p', {}, 'x')])).toBeNull()
  })
})

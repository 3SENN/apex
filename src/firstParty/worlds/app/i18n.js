/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Worlds app's words in the person's language (Apex passes its language
// to every page as navigator.language). The English text is the key, so the
// code stays readable; a word missing here shows in English.
const NL = {
  Worlds: 'Werelden',
  'Walk around with your companions, step into places, and build a world of your own to share.': 'Loop rond met je companions, stap plaatsen binnen en bouw een eigen wereld om te delen.',
  'New world': 'Nieuwe wereld',
  '← Worlds': '← Werelden',
  Edit: 'Bewerken',
  'Share…': 'Delen…',
  Save: 'Opslaan',
  'WASD or arrows to walk · click to walk there · E to talk · Enter to step in': 'WASD of pijltjes om te lopen · klik om erheen te lopen · E om te praten · Enter om binnen te stappen',
  'The world': 'De wereld',
  Editor: 'Editor',
  'No worlds yet. Start one with New world.': 'Nog geen werelden. Begin er een met Nieuwe wereld.',
  Yours: 'Van jou',
  'From {from}': 'Van {from}',
  '{n} place': '{n} plaats',
  '{n} places': '{n} plaatsen',
  '{n} resident': '{n} bewoner',
  '{n} residents': '{n} bewoners',
  Visit: 'Bezoeken',
  Remove: 'Verwijderen',
  'Click again to remove': 'Klik nog eens om te verwijderen',
  'Make a copy': 'Een kopie maken',
  '{name} (my copy)': '{name} (mijn kopie)',
  'Saved {path}. Anyone who opens it gets the world, with their own companions in its open spots.': '{path} is opgeslagen. Wie het opent krijgt de wereld, met de eigen companions op de open plekken.',
  'Talk to {name} · E': 'Praat met {name} · E',
  'Step into {name} · Enter': 'Stap {name} binnen · Enter',
  '{who} walks up to say hello at {place}.': '{who} loopt naar je toe om gedag te zeggen bij {place}.',
  '{who} walks up to say hello.': '{who} loopt naar je toe om gedag te zeggen.',
  Someone: 'Iemand',
  '{name} opens an app you don’t have yet. Find it, add it, then step in again.': '{name} opent een app die je nog niet hebt. Zoek hem op, voeg hem toe en stap dan opnieuw binnen.',
  'Leave without saving your changes to this world?': 'Weggaan zonder je wijzigingen aan deze wereld op te slaan?',
  // The editor.
  World: 'Wereld',
  Name: 'Naam',
  Palette: 'Palet',
  Sky: 'Lucht',
  Width: 'Breedte',
  Depth: 'Diepte',
  Tools: 'Gereedschap',
  Select: 'Selecteren',
  Ground: 'Grond',
  Props: 'Voorwerpen',
  Places: 'Plaatsen',
  People: 'Mensen',
  'Look around': 'Rondkijken',
  Brush: 'Kwast',
  Small: 'Klein',
  Medium: 'Middel',
  Large: 'Groot',
  'Click to place; R turns it.': 'Klik om neer te zetten; R draait het.',
  Who: 'Wie',
  'Open spot': 'Open plek',
  'Click to add them. Guests come with the world; an open spot is filled with a companion of whoever visits.': 'Klik om ze toe te voegen. Gasten horen bij de wereld; een open plek krijgt een companion van wie er op bezoek komt.',
  'Drag over the ground to draw a place, then pick the app it opens.': 'Sleep over de grond om een plaats te tekenen en kies dan de app die hij opent.',
  Selected: 'Geselecteerd',
  'Click a prop, a resident or a place to change it. Drag props and residents to move them; R turns a prop, Delete removes.': 'Klik op een voorwerp, een bewoner of een plaats om het te wijzigen. Sleep voorwerpen en bewoners om ze te verplaatsen; R draait een voorwerp, Delete verwijdert.',
  Turn: 'Draaien',
  Colour: 'Kleur',
  Opens: 'Opent',
  'Opens nothing': 'Opent niets',
  '{name} (not installed)': '{name} (niet geïnstalleerd)',
  'No home': 'Geen thuis',
  'A guest of this world': 'Een gast van deze wereld',
  Personality: 'Persoonlijkheid',
  'An open spot: one of your companions lives here, and one of theirs for whoever adds the world.': 'Een open plek: hier woont een van je companions, en een van de hunne voor wie de wereld toevoegt.',
  'What they do here': 'Wat ze hier doen',
  Home: 'Thuis',
  Undo: 'Ongedaan maken',
  Redo: 'Opnieuw',
  'The ground has {n} painted areas; a world keeps {max}. Paint bigger, plainer areas to save it.': 'De grond heeft {n} geverfde stukken; een wereld bewaart er {max}. Verf grotere, eenvoudigere stukken om op te slaan.',
  'Place {n}': 'Plaats {n}',
  Place: 'Plaats',
  Guest: 'Gast',
  // Palettes, skies, grounds.
  Meadow: 'Weide',
  Seaside: 'Kust',
  City: 'Stad',
  Snow: 'Sneeuw',
  Dusk: 'Schemer',
  Morning: 'Ochtend',
  Midday: 'Middag',
  'Late afternoon': 'Late middag',
  Night: 'Nacht',
  Grass: 'Gras',
  Path: 'Pad',
  Sand: 'Zand',
  Boards: 'Planken',
  Stone: 'Steen',
  Floor: 'Vloer',
  Water: 'Water',
  // The kit's props.
  Tree: 'Boom',
  Pine: 'Den',
  Bush: 'Struik',
  'Flower bed': 'Bloemperk',
  Rock: 'Rots',
  Bench: 'Bank',
  Table: 'Tafel',
  Chair: 'Stoel',
  'Lamp post': 'Lantaarnpaal',
  Fence: 'Hek',
  House: 'Huis',
  Shop: 'Winkel',
  'Market stall': 'Marktkraam',
  Counter: 'Toonbank',
  'Table tennis table': 'Pingpongtafel',
  Fountain: 'Fontein',
  Sign: 'Bord',
  Crate: 'Kist',
  Barrel: 'Ton',
  Parasol: 'Parasol',
}

const TABLES = { nl: NL }

/** The person's language, as Apex set it ('en' when Apex has no words for it here). */
export const lang = (() => {
  const code = String(navigator.language || 'en').toLowerCase().split('-')[0]
  return code in TABLES ? code : 'en'
})()

/** A text in the person's language, with {names} filled in. */
export function t(text, vars = {}) {
  const table = TABLES[lang]
  const out = (table && table[text]) || text
  return out.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
}

/** Translates the page's own HTML: data-t for text, data-t-label for aria-label. */
export function translatePage(root = document) {
  document.documentElement.lang = lang
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.textContent.trim())
  for (const el of root.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.getAttribute('aria-label') || ''))
}

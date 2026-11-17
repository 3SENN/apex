/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { media as en } from '../en/media'
import type { Dutch } from './types'

// Dutch for the media.* strings: every English key, in English order.
export const media = {
  'media.button.label': 'Wat er speelt',
  'media.button.count': '{count, plural, one {# tabblad speelt} other {# tabbladen spelen}}',
  'media.hub.title': 'Nu aan het spelen',
  'media.hub.empty': 'Er speelt nu niets.',
  'media.hub.mediaKeys': 'De mediatoetsen bedienen deze',
  'media.source.playing': 'Speelt',
  'media.source.paused': 'Gepauzeerd',
  'media.source.thisTab': 'Dit tabblad',
  'media.source.elsewhere': 'In een ander venster',
  'media.source.goTo': 'Naar tabblad',
  'media.source.goToNamed': 'Naar {title}',
  'media.source.play': 'Afspelen',
  'media.source.pause': 'Pauzeren',
  'media.source.previous': 'Vorige',
  'media.source.next': 'Volgende',
  'media.source.mute': 'Tabblad dempen',
  'media.source.unmute': 'Tabblad niet meer dempen',
  'media.source.pip': 'Beeld-in-beeld',
  'media.source.pipLeave': 'Beeld-in-beeld sluiten',
  'media.source.dismiss': 'Verbergen',
  'media.source.speed': 'Afspeelsnelheid',
  'media.source.speedNow': 'Afspeelsnelheid, {rate}',
  'media.source.more': 'Alles tonen wat er speelt',
  'media.source.artwork': 'Afbeelding bij {title}',
  'media.error': 'Kan niet bedienen wat er speelt.',
  'media.speed.normal': 'Normaal',
  'media.menu.speed': 'Afspeelsnelheid',
  'media.menu.loop': 'Herhalen',
  'media.menu.controls': 'Bediening tonen',
  'media.menu.pip': 'Beeld-in-beeld',
  'media.menu.openVideo': 'Video openen in nieuw tabblad',
  'media.menu.openAudio': 'Audio openen in nieuw tabblad',
  'media.menu.saveVideo': 'Video opslaan als…',
  'media.menu.saveAudio': 'Audio opslaan als…',
  'media.menu.copyVideo': 'Videoadres kopiëren',
  'media.menu.copyAudio': 'Audioadres kopiëren',
  'media.settings.button': 'Toon wat er speelt in de werkbalk',
  'media.settings.button.description': 'Er verschijnt een knop zodra een tabblad geluid of video afspeelt, met afspelen, pauzeren, volgende, snelheid en beeld-in-beeld voor elk.',
} as const satisfies Dutch<typeof en>

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { migrations as en } from '../en/migrations'
import type { Dutch } from './types'

// Dutch for the migrations.* strings: every English key, in English order.
export const migrations = {
  'migrations.notice.failed': 'Deze chat kon niet worden bijgewerkt.',
  'migrations.notice.newer': 'Deze chat is bewaard door een nieuwere versie van {brand}. Werk {brand} bij om verder te gaan.',
  'migrations.notice.failedTitle': 'Deze chat moet worden hersteld',
  'migrations.notice.newerTitle': 'Bewaard door een nieuwere {brand}',
  'migrations.notice.readOnly': 'Je kunt hem hier lezen, maar niet voortzetten, tot dit is opgelost. Er is niets in het bestand veranderd.',
  'migrations.notice.newerReadOnly': 'Hij opent hier alleen-lezen, dus er gaat niets verloren van wat hij bewaarde.',
  'migrations.notice.stillFailing': 'Deze chat kan nog steeds niet worden bijgewerkt.',
  'migrations.notice.fixed': 'De chat is weer bijgewerkt.',
  'migrations.notice.restored': 'De oorspronkelijke chat is terug.',
  'migrations.notice.restoreTitle': 'Oorspronkelijke chat terugzetten?',
  'migrations.notice.restoreMessage': 'De chat gaat terug naar hoe hij was voor deze update. Het huidige bestand blijft in de back-upmap.',
  'migrations.notice.damaged': 'Het bestand van deze chat is beschadigd.',
  'migrations.notice.unknownFormat': 'Het bestand van deze chat heeft een indeling die deze versie van {brand} niet kent.',
  'migrations.notice.noBackup': 'Er is geen oorspronkelijke kopie van deze chat om terug te zetten.',
  'migrations.notice.notNeeded': 'Deze chat is al bijgewerkt.',
  'migrations.composer.locked': 'Deze chat kan nu niet worden voortgezet',
  'migrations.action.retry': 'Probeer opnieuw',
  'migrations.action.reload': 'Herlaad',
  'migrations.action.restore': 'Zet oorspronkelijke terug',
  'migrations.action.reveal': 'Toon bestand',
  'migrations.action.open': 'Open',
  'migrations.about.title': 'Gegevensupdates',
  'migrations.about.upToDate': 'Al je chats zijn bijgewerkt',
  'migrations.about.summary': '{count, plural, one {# chat bijgewerkt} other {# chats bijgewerkt}} op {date}',
  'migrations.about.description': 'Wanneer een update verandert hoe chats worden bewaard, werkt {brand} ze ter plekke bij en bewaart de originelen in een back-upmap.',
  'migrations.about.retryAll': 'Probeer alles opnieuw',
  'migrations.about.failedTitle': '{count, plural, one {# chat kon niet worden bijgewerkt} other {# chats konden niet worden bijgewerkt}}',
  'migrations.about.newerTitle': 'Bewaard door een nieuwere {brand}',
  'migrations.about.newerChat': 'Opent alleen-lezen tot je {brand} bijwerkt.',
  'migrations.about.newerFile': 'Er is een kopie bewaard, dus er gaat niets verloren van wat hij bewaarde.',
  'migrations.about.untitled': 'Naamloze chat',
  'migrations.about.loadError': 'De resultaten van de gegevensupdate konden niet worden geladen.',
  'migrations.about.retryAllDone': '{count, plural, =0 {Elke chat is nu bijgewerkt.} one {# chat moet nog worden hersteld.} other {# chats moeten nog worden hersteld.}}',
  'migrations.file.settings': 'Instellingen',
  'migrations.file.companions': 'Companions',
} as const satisfies Dutch<typeof en>

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { HELP_TOPICS, HELP_TOPIC_IDS } from '@shared/help'
import { menuContributions } from '@shared/menuModel'
import { HELP_NOTES, createHelpService, helpMenuItems, helpTopicFromItem, registerHelpMenus } from '../src/main/help'
import { FakeHost } from './helpers/fakeHost'

describe('help topics', () => {
  it('maps every topic to shipped notes, in menu order', () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual([...HELP_TOPIC_IDS])
    for (const id of HELP_TOPIC_IDS) {
      expect(HELP_NOTES[id].startsWith('# ')).toBe(true)
      expect(HELP_NOTES[id].length).toBeGreaterThan(200)
    }
  })

  it('asks by starting a chat with the notes in a help_notes block', () => {
    const host = new FakeHost()
    const help = createHelpService({ host, activeCompanionId: () => 'c1' })
    expect(help.topics()).toHaveLength(6)
    const chatId = help.ask('connectors')
    const started = host.startedChats[0]!
    expect(started.chatId).toBe(chatId)
    expect(started.text).toContain('connectors')
    expect(started.options?.context).toMatch(/^<help_notes topic="connectors">/)
    expect(started.options?.context).toContain(HELP_NOTES.connectors.trim())
    expect(started.options).toMatchObject({ companionId: 'c1', open: 'page' })
  })

  it('registers the topics in the Help menu and the main menu, and maps items back', () => {
    const asked: string[] = []
    const off = registerHelpMenus((t) => asked.push(t))
    const help = menuContributions('help').find((c) => c.id === 'd-help-topics')!
    expect(menuContributions('main-menu:help').some((c) => c.id === 'd-help-topics-main')).toBe(true)
    const items = helpMenuItems()
    expect(items.filter((i) => i.id.startsWith('help-topic:'))).toHaveLength(6)
    void help.run?.('help-topic:meetings', null)
    void help.run?.('help-topics-header', null)
    expect(asked).toEqual(['meetings'])
    expect(helpTopicFromItem('help-topic:nope')).toBeNull()
    off()
    expect(menuContributions('help').some((c) => c.id === 'd-help-topics')).toBe(false)
  })
})

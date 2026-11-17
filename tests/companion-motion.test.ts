/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SETTINGS } from '@shared/settingsRegistry'
import { SETTINGS_INDEX } from '@shared/settingsIndex'
import { FLOAT_METHODS, floatMayCall } from '@shared/float'
import { LAUNCHER_PRESENCE } from '@shared/voice'
import { settings as enSettings } from '@shared/i18n/en/settings'
import { settings as nlSettings } from '@shared/i18n/nl/settings'
import { tabs as enTabs } from '@shared/i18n/en/tabs'
import { tabs as nlTabs } from '@shared/i18n/nl/tabs'
import { createFloor, landingSquash, pondLayout, stepFloor, throwActor, grabActor } from '../src/renderer/src/components/newtab/floorSim'
import { floorShown, takeLegacyFloorSetting } from '../src/renderer/src/components/newtab/newtabLogic'
import { noteAskOrigin, takeAskHandoff, takeAskOrigin } from '../src/renderer/src/components/newtab/handoff'
import { cheerIsFresh, CHEER_FRESH_MS } from '../src/renderer/src/companion/presenceCore'
import { greetingPlacement, GREETING_MAX_PX, START_STAGES } from '../src/renderer/src/chat/logic/start'
import { chatMood } from '../src/renderer/src/chat/logic/view'
import { chatListRows } from '../src/renderer/src/components/sidebar/logic/chatRows'
import { tabFace } from '../src/renderer/src/components/sidebar/logic/tabFace'
import { SKELETON_GRACE_MS, SKELETON_HOLD_MS, skeletonHoldLeft, skeletonVisible } from '../src/renderer/src/ui/logic/skeleton'
import { MOTION, SPRING, springDuration, springEasing } from '../src/renderer/src/ui/logic/motion'
import { nextRelay, TYPING_REFRESH_MS } from '../src/renderer/src/float/launcher/presenceRelay'
import type { ChatSummary } from '@shared/chats'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })

describe('DS-75: the pond sits under the ask card', () => {
  it('centres a little below the card itself, so the card sits on its back half', () => {
    const card = rect(300, 300, 640, 114)
    const layout = pondLayout({ width: 1240, height: 900 }, card)
    expect(layout.cx).toBe(620)
    expect(layout.rx).toBe(540)
    const centre = card.top + card.height / 2
    expect(layout.cy).toBeGreaterThan(centre)
    // The card's middle is on the back (upper) half of the ellipse, within it.
    expect(layout.cy - centre).toBeLessThan(layout.ry)
  })

  it('ignores whatever hangs below the card (tray, ideas) and falls back low without a card', () => {
    const withTray = pondLayout({ width: 1240, height: 900 }, rect(300, 300, 640, 114))
    expect(withTray.cy).toBeLessThan(300 + 114 + 0.5 * withTray.ry)
    expect(pondLayout({ width: 1000, height: 800 }, null).cy).toBeCloseTo(800 * 0.62)
  })

  it('tags the ask card as the pond anchor', () => {
    expect(read('src/renderer/src/components/newtab/StartComposer.tsx')).toContain('data-pond-anchor')
  })
})

describe('DS-75b: Companions on New Tab is a profile setting', () => {
  it('is registered per profile, on by default, with a search row and both languages', () => {
    expect(SETTINGS.companionFloor.scope).toBe('profile')
    expect(SETTINGS.companionFloor.default).toBe(true)
    const row = SETTINGS_INDEX.find((r) => r.id === 'companion-floor')
    expect(row?.page).toBe('appearance')
    expect(row?.anchor).toBe('companion-floor')
    expect(enSettings['settings.appearance.companionFloor']).toBe('Companions on New Tab')
    expect(nlSettings['settings.appearance.companionFloor']).toBeTruthy()
  })

  it('follows settings, and hands an old per-window "off" over once', () => {
    expect(floorShown(null)).toBe(true)
    expect(floorShown({ companionFloor: false })).toBe(false)
    const store = new Map<string, string>([['apex.newtab.companionFloor', 'off']])
    const storage = { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) }
    expect(takeLegacyFloorSetting(storage)).toBe(false)
    expect(takeLegacyFloorSetting(storage)).toBeNull()
    store.set('apex.newtab.companionFloor', 'on')
    expect(takeLegacyFloorSetting(storage)).toBeNull()
    expect(store.size).toBe(0)
  })
})

describe('DS-73: the new tab hands its standing figure to the chat', () => {
  it('notes the figure with the field, once', () => {
    const r = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, width: w, height: h, x, y, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect
    noteAskOrigin('tab-1', r(10, 20, 640, 114), { rect: r(300, 100, 112, 112), image: 'data:image/png;base64,AAAA' })
    const note = takeAskHandoff('tab-1')
    expect(note?.rect).toEqual({ left: 10, top: 20, width: 640, height: 114 })
    expect(note?.figure?.rect).toEqual({ left: 300, top: 100, width: 112, height: 112 })
    expect(note?.figure?.image).toContain('data:image/png')
    expect(takeAskHandoff('tab-1')).toBeNull()
    noteAskOrigin('tab-2', r(0, 0, 10, 10))
    expect(takeAskOrigin('tab-2')).toEqual({ left: 0, top: 0, width: 10, height: 10 })
  })

  it('is passed on when the chat starts', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/noteStanding\(chatId, rectOf\(handoff\.figure\.rect\)/)
  })
})

describe('DS-69: focus alone does not change the mood', () => {
  it('an idle chat stays idle unless something listens', () => {
    const base = { status: 'idle' as const, activity: null, activityAt: 0, outcome: null, outcomeAt: 0, now: 1000 }
    expect(chatMood({ ...base, listening: false }).mood).toBe('idle')
    const view = read('src/renderer/src/chat/ChatView.tsx')
    expect(view).not.toMatch(/onFocusChange=\{setListening\}/)
    expect(view).toMatch(/useChatMood\(state, false\)/)
  })
})

describe('DS-79: a newly added companion celebrates', () => {
  it('plays a cheer for a figure that mounts just after it', () => {
    expect(cheerIsFresh(0, 5000)).toBe(false)
    expect(cheerIsFresh(1000, 1200)).toBe(true)
    expect(cheerIsFresh(1000, 1000 + CHEER_FRESH_MS)).toBe(false)
    expect(cheerIsFresh(2000, 1000)).toBe(false)
  })

  it('celebrates in the create and import sheets instead of closing on a toast', () => {
    const sheets = read('src/renderer/src/companion-card/sheets.tsx')
    expect(sheets.match(/setWelcomed\(created\)/g)?.length).toBe(2)
    expect(sheets).toContain('<WelcomeSheet')
    expect(enTabs['tabs.welcome.title']).toContain('{name}')
    expect(nlTabs['tabs.welcome.title']).toContain('{name}')
  })
})

describe('DS-80: the greeting is never cut off', () => {
  it('stays on the right with enough room, and wraps inside it', () => {
    const place = greetingPlacement({ left: 0, right: 1200 }, { left: 540, width: 120 })
    expect(place.side).toBe('left')
    expect(place.maxWidth).toBe(GREETING_MAX_PX)
  })

  it('goes to the roomier side in a narrow panel and fits inside the chat', () => {
    // A 360 px panel with the figure a little right of centre.
    const view = { left: 1000, right: 1360 }
    const figure = { left: 1150, width: 120 }
    const place = greetingPlacement(view, figure)
    const start = place.side === 'left' ? figure.left + figure.width * 0.66 : figure.left + figure.width * 0.34
    if (place.side === 'left') expect(start + place.maxWidth).toBeLessThanOrEqual(view.right)
    else expect(start - place.maxWidth).toBeGreaterThanOrEqual(view.left)
  })

  it('drops the one-line rule', () => {
    const css = read('src/renderer/src/chat/chat.css')
    const rule = css.slice(css.indexOf('.chat-empty__greeting {'), css.indexOf('}', css.indexOf('.chat-empty__greeting {')))
    expect(rule).not.toContain('nowrap')
    expect(rule).toContain('--greeting-max')
  })
})

describe('DS-72 and DS-111: an empty chat is the start surface, staged', () => {
  it('stages composer, figure and floor, then ideas, then the last button', () => {
    expect(START_STAGES.composer).toBeLessThan(START_STAGES.figure)
    expect(START_STAGES.floor).toBe(START_STAGES.figure)
    expect(START_STAGES.figure).toBeLessThan(START_STAGES.ideas)
    expect(START_STAGES.ideas).toBeLessThan(START_STAGES.last)
    const css = read('src/renderer/src/chat/chat.css')
    expect(css).toContain(`chat-start-rise 220ms var(--ease-out) ${START_STAGES.composer}ms both`)
    expect(css).toContain(`chat-start-soft 140ms var(--ease-out) ${START_STAGES.figure}ms both`)
    expect(css).toContain(`chat-start-fade 220ms var(--ease-out) ${START_STAGES.ideas}ms both`)
    expect(css).toMatch(/:root\[data-motion='reduced'\] :is\(\.chat-view--empty > \.chat-composer/)
  })

  it('has the pill, the corner buttons, the floor and the figure button', () => {
    const start = read('src/renderer/src/chat/StartSurface.tsx')
    for (const piece of ['<SwitcherPill', '<Floor', '<InboxButton', "tabs.newTab.floor"]) expect(start).toContain(piece)
    const view = read('src/renderer/src/chat/ChatView.tsx')
    expect(view).toContain('<StartChrome')
    expect(view).toMatch(/nt__figure-button chat-start__figure/)
  })
})

describe('DS-72b: nothing joins Chats before its first send', () => {
  it('lists saved chats only', () => {
    const chat = (id: string, draft: boolean) => ({ id, draft }) as unknown as ChatSummary
    const byId = new Map([chat('a', false), chat('b', true)].map((c) => [c.id, c]))
    expect(chatListRows(['b', 'a', 'missing'], byId).map((c) => c.id)).toEqual(['a'])
    expect(read('src/renderer/src/components/sidebar/Sidebar.tsx')).not.toContain('draftSummary(')
  })
})

describe('DS-67: tab rows show one head with its mark', () => {
  it('marks working, waiting and done beside the head; waiting wins', () => {
    expect(tabFace({ agentControlled: true, agentChatId: 'c1', needsInput: false }, false)).toMatchObject({ state: 'working', mark: 'working', chatId: 'c1' })
    expect(tabFace({ agentControlled: true, agentChatId: 'c1', needsInput: true }, true)).toMatchObject({ state: 'waiting', mark: 'approval' })
    expect(tabFace({ agentControlled: false, agentChatId: null, needsInput: false }, true)).toMatchObject({ state: 'done', mark: 'done' })
    expect(tabFace({ agentControlled: false, agentChatId: null, needsInput: false }, false)).toBeNull()
    const section = read('src/renderer/src/components/sidebar/TabsSection.tsx')
    const badges = section.slice(section.indexOf('function TabBadges'), section.indexOf('function rowKeys'))
    expect(badges).not.toContain('StatusDot')
    expect(badges).not.toContain('chat-row__done')
  })
})

describe('DS-106: skeleton timing', () => {
  it('waits out a grace before showing and holds once shown', () => {
    expect(skeletonVisible(SKELETON_GRACE_MS - 1)).toBe(false)
    expect(skeletonVisible(SKELETON_GRACE_MS)).toBe(true)
    expect(skeletonHoldLeft(40)).toBe(0)
    expect(skeletonHoldLeft(SKELETON_GRACE_MS + 30)).toBe(SKELETON_HOLD_MS - 30)
    expect(skeletonHoldLeft(SKELETON_GRACE_MS + SKELETON_HOLD_MS + 5)).toBe(0)
    expect(read('src/renderer/src/ui/States.tsx')).toContain('data-grace')
    expect(read('src/renderer/src/settings/data.ts')).toContain('skeletonHoldLeft')
  })
})

describe('DS-81: one decelerate curve; the spring is the floor’s', () => {
  it('settles landings on the shared spring', () => {
    const actor = { squashAt: 10, squashFrom: 0.6 }
    expect(landingSquash(actor, 10)).toBeCloseTo(0.6)
    const end = springDuration(SPRING)
    expect(landingSquash(actor, 10 + end + 0.01)).toBe(0)
    // Past rest a little (a stretch) on the way, like the spring's overshoot.
    let min = 1
    for (let t = 0; t < end; t += 1 / 120) min = Math.min(min, landingSquash(actor, 10 + t))
    expect(min).toBeLessThan(0)
    expect(landingSquash(actor, 9)).toBe(0)
  })

  it('a thrown companion still squashes and comes to rest', () => {
    const world = createFloor(['a', 'b'], { seed: 3 })
    for (let i = 0; i < 60; i++) stepFloor(world, 1 / 30)
    grabActor(world, 'a')
    throwActor(world, 'a', 0.5, 0.2)
    let squashed = false
    for (let i = 0; i < 240; i++) {
      stepFloor(world, 1 / 60)
      if ((world.actors.find((x) => x.id === 'a')?.squash ?? 0) > 0.05) squashed = true
    }
    expect(squashed).toBe(true)
    expect(world.actors.find((x) => x.id === 'a')?.squash).toBe(0)
  })

  it('keeps one token set with a ~600 ms settle and the spring as the floor curve', () => {
    const css = read('src/renderer/src/styles.css')
    expect(css).toContain(`--ease-floor: ${springEasing(SPRING)};`)
    expect(css).toContain('--ease-spring: var(--ease-out);')
    expect(css).toContain(`--motion-settle: ${MOTION.settle}ms;`)
    expect(Math.abs(MOTION.settle - springDuration(SPRING) * 1000)).toBeLessThan(60)
    for (const alias of ['--dur-instant: var(--motion-', '--dur-fast: var(--motion-', '--dur-base: var(--motion-', '--dur-slow: var(--motion-', '--dur-slower: var(--motion-']) expect(css).toContain(alias)
    // No overshoot curve outside the floor.
    expect(read('src/renderer/src/companion/companion.css')).not.toContain('--ease-spring')
    expect(read('src/renderer/src/components/newtab/newtab.css')).toContain('var(--ease-floor)')
  })
})

describe('DS-68: quick ask is a presence input', () => {
  it('relays typing (not every key), idle after typing, and send', () => {
    const idle = { signal: null, at: 0 }
    expect(nextRelay(idle, { kind: 'focus', text: '' }, 0)).toBeNull()
    expect(nextRelay(idle, { kind: 'text', text: 'h' }, 100)).toBe('typing')
    expect(nextRelay({ signal: 'typing', at: 100 }, { kind: 'text', text: 'he' }, 200)).toBeNull()
    expect(nextRelay({ signal: 'typing', at: 100 }, { kind: 'text', text: 'hel' }, 100 + TYPING_REFRESH_MS)).toBe('typing')
    expect(nextRelay({ signal: 'typing', at: 100 }, { kind: 'text', text: '' }, 150)).toBe('idle')
    expect(nextRelay({ signal: 'typing', at: 100 }, { kind: 'blur' }, 150)).toBe('idle')
    expect(nextRelay(idle, { kind: 'blur' }, 150)).toBeNull()
    expect(nextRelay(idle, { kind: 'send' }, 150)).toBe('sent')
  })

  it('only the launcher may send it, and the chrome feeds it to presence', () => {
    expect(floatMayCall('launcher', LAUNCHER_PRESENCE)).toBe(true)
    expect(FLOAT_METHODS['voice-hud']).not.toContain(LAUNCHER_PRESENCE)
    expect(read('src/main/voice/quickAsk.ts')).toMatch(/z\.tuple\(\[z\.enum\(QUICK_ASK_SIGNALS\)/)
    expect(read('src/renderer/src/companion/presence.ts')).toContain("event.type === 'quick-ask-presence'")
  })
})

describe('DS-84b: a closed split wipes away', () => {
  it('keeps the removed pane for one layout beat', () => {
    expect(read('src/renderer/src/App.tsx')).toContain('pane--split-leaving')
    expect(read('src/renderer/src/styles.css')).toMatch(/@keyframes pane-split-out/)
  })
})

describe('DS-86: the ambient field replaces the dot grid', () => {
  it('draws ShapeField on the look editor’s stage (the card hero) and a still frame in preset thumbnails', () => {
    expect(read('src/renderer/src/companion-card/GeneralTab.tsx')).toMatch(/<ShapeField[\s\S]{0,200}co-hero__field/)
    expect(read('src/renderer/src/pages/CompanionEditor.tsx')).toMatch(/co-preset__thumb[\s\S]{0,200}<ShapeField[^>]*still/)
    expect(read('src/renderer/src/companion-card/card.css')).not.toMatch(/radial-gradient\(circle, var\(--co-dots\)/)
  })
})

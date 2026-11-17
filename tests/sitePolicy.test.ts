/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { savedPermissionsView, siteLabel, type ChatGrant, type PermissionsOverview, type SiteRule } from '@shared/agentTools'
import type { AgentEvent } from '@shared/ipc'
import type { WatchedFolder } from '@shared/workspace'
import { SessionAgentTools, type AgentToolsRuntime, type SessionAgentToolsHost } from '../src/main/agent/sessionAgentTools'
import { ruleOrigin, SiteRulesStore } from '../src/main/agent/sitePolicy'

// Per-site rules (ST-13): never, ask and allow, rules
// read afresh at every step so a revoke applies at the next one, remembered
// approvals per chat, and the Saved permissions view.

function store(defaultAccess: 'allow' | 'ask' = 'allow') {
  const path = join(mkdtempSync(join(tmpdir(), 'apex-sites-')), 'agent-site-rules.json')
  let now = 1000
  const sites = new SiteRulesStore(path, { defaultAccess: () => defaultAccess, now: () => now++ })
  return { sites, path }
}

function session(sites: SiteRulesStore, mode: AgentToolsRuntime['mode'] = () => 'standard') {
  const log: AgentEvent[] = []
  const content = { log, capabilities: {}, grants: [] as ChatGrant[] }
  let saves = 0
  const host: SessionAgentToolsHost = {
    chatId: 'chat-1',
    companionId: () => 'nova',
    companionName: () => 'Nova',
    content: () => content as never,
    emit: (e) => log.push(e),
    waiting: () => undefined,
    persist: () => {
      saves++
    },
    actWithoutAsking: () => false,
    confirmConsequential: () => true,
  }
  const runtime = { mode, sites, recordUsage: () => undefined, flags: () => ({}), project: () => null, isRunning: () => false } as unknown as AgentToolsRuntime
  const d = new SessionAgentTools(host, () => runtime, {}, false)
  const lastRequest = <T extends AgentEvent['type']>(type: T) => log.findLast((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
  return { d, log, content, saves: () => saves, lastRequest }
}

const signal = () => new AbortController().signal

describe('SiteRulesStore', () => {
  it('keys rules by origin, keeps http and https only, and survives a reload', () => {
    const { sites, path } = store()
    expect(ruleOrigin('https://shop.example/cart?x=1')).toBe('https://shop.example')
    expect(ruleOrigin('apex://settings')).toBeNull()
    sites.set('https://shop.example/cart', 'never')
    sites.allowAction('https://news.example/a', 'post')
    expect(() => sites.set('file:///etc/hosts', 'allow')).toThrow(/web addresses/)
    expect(sites.access('https://shop.example/other')).toBe('never')
    expect(sites.allows('https://news.example', 'post')).toBe(true)
    expect(sites.access('https://news.example')).toBe('allow')
    const again = new SiteRulesStore(path, { defaultAccess: () => 'ask' })
    expect(again.list().map((r) => [r.origin, r.access])).toEqual([['https://news.example', 'allow'], ['https://shop.example', 'never']])
    expect(again.access('https://unknown.example')).toBe('ask')
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('"Always on this site" never lifts a block, and remove forgets the rule', () => {
    const { sites } = store()
    sites.set('https://shop.example', 'never')
    expect(sites.allowAction('https://shop.example', 'purchase').access).toBe('never')
    sites.remove('https://shop.example/x')
    expect(sites.get('https://shop.example')).toBeNull()
  })

  it('counts chats with remembered approvals, and forgets deleted chats', () => {
    const { sites } = store()
    const changes: SiteRule[][] = []
    sites.on('changed', (r) => changes.push(r))
    sites.setChatGrants('a', 2)
    sites.setChatGrants('b', 1)
    sites.forgetChats(['b'])
    expect(sites.chatGrants()).toEqual([{ chatId: 'a', grants: 2 }])
    sites.setChatGrants('a', 0)
    expect(sites.chatGrants()).toEqual([])
    // Grant counts aren't site rules, so they don't fire agent-sites.
    expect(changes).toEqual([])
  })
})

describe('site access before each browser step', () => {
  it('never refuses reading and acting on the site with an error the model can explain', async () => {
    const { sites } = store()
    sites.set('https://bank.example', 'never')
    const { d } = session(sites)
    await expect(d.gate('get_page_text', 'https://bank.example/a', 'Read the page', signal())).rejects.toThrow(`blocked ${BRAND_NAME}'s agent on bank.example`)
    await expect(d.gate('navigate', 'https://bank.example/', 'Open the page', signal())).rejects.toThrow(/Settings › Agent permissions/)
    await expect(d.gate('left_click', 'https://other.example/', 'Click', signal())).resolves.toBeUndefined()
  })

  it('ask asks before the first acting step only; reads never ask', async () => {
    const { sites } = store('ask')
    const { d, log, lastRequest } = session(sites)
    await d.gate('screenshot', 'https://shop.example/', 'Take a screenshot', signal())
    expect(log).toEqual([])
    const first = d.gate('left_click', 'https://shop.example/', 'Click Add to cart', signal())
    expect(lastRequest('site-access')).toMatchObject({ origin: 'https://shop.example', action: 'click Add to cart' })
    d.respond(lastRequest('site-access')!.requestId, { kind: 'site-access', choice: 'chat' })
    await first
    // "This chat": no more asking here for this chat.
    await d.gate('type', 'https://shop.example/', 'Type', signal())
    expect(log.filter((e) => e.type === 'site-access')).toHaveLength(1)
  })

  it('once asks again next time; always allows the site; block saves never', async () => {
    const { sites } = store('ask')
    const { d, log, lastRequest } = session(sites)
    const answer = async (choice: 'once' | 'site' | 'block', origin: string) => {
      const step = d.gate('left_click', origin, 'Click', signal())
      d.respond(lastRequest('site-access')!.requestId, { kind: 'site-access', choice })
      return step
    }
    await answer('once', 'https://a.example/')
    await answer('once', 'https://a.example/')
    expect(log.filter((e) => e.type === 'site-access')).toHaveLength(2)
    await answer('site', 'https://b.example/')
    expect(sites.access('https://b.example')).toBe('allow')
    await expect(answer('block', 'https://c.example/')).rejects.toThrow(/blocked/)
    expect(sites.access('https://c.example')).toBe('never')
  })

  it('a revoke in Settings applies at the next agent step', async () => {
    const { sites } = store()
    const { d } = session(sites)
    await d.gate('left_click', 'https://shop.example/', 'Click', signal())
    sites.set('https://shop.example', 'never')
    await expect(d.gate('left_click', 'https://shop.example/', 'Click', signal())).rejects.toThrow(/blocked/)
    sites.remove('https://shop.example')
    await expect(d.gate('left_click', 'https://shop.example/', 'Click', signal())).resolves.toBeUndefined()
  })
})

describe('remembered approvals', () => {
  const purchase = { member: 'left_click', guard: { reason: 'click button "Buy"', action: 'purchase' as const, alwaysAsk: false }, url: 'https://shop.example/cart', label: 'Click Buy' }

  it('scope chat is stored in the chat record; scope site in the site rules', async () => {
    const { sites } = store()
    const { d, content, lastRequest } = session(sites)
    const first = d.approve(purchase, signal())
    expect(lastRequest('approval')).toMatchObject({ action: 'purchase', scopes: ['once', 'chat', 'site'], origin: 'https://shop.example' })
    d.respond(lastRequest('approval')!.approvalId, { kind: 'approval', allowed: true, scope: 'chat' })
    await first
    expect(content.grants).toEqual([expect.objectContaining({ origin: 'https://shop.example', action: 'purchase' })])
    expect(sites.chatGrants()).toEqual([{ chatId: 'chat-1', grants: 1 }])
    expect(d.savedRule('https://shop.example', 'purchase')).toBe('chat')

    const other = session(sites)
    const step = other.d.approve(purchase, signal())
    other.d.respond(other.lastRequest('approval')!.approvalId, { kind: 'approval', allowed: true, scope: 'site' })
    await step
    expect(sites.allows('https://shop.example', 'purchase')).toBe(true)
  })

  it('revoking a chat forgets its approvals at once', async () => {
    const { sites } = store()
    const { d, content, lastRequest } = session(sites)
    const step = d.approve(purchase, signal())
    d.respond(lastRequest('approval')!.approvalId, { kind: 'approval', allowed: true, scope: 'chat' })
    await step
    d.revokeGrants()
    expect(content.grants).toEqual([])
    expect(d.savedRule('https://shop.example', 'purchase')).toBeNull()
  })

  it('a declined approval throws an error the model reads, and always-ask answers stay once', async () => {
    const { sites } = store()
    const { d, content, lastRequest } = session(sites)
    const declined = d.approve(purchase, signal())
    d.respond(lastRequest('approval')!.approvalId, { kind: 'approval', allowed: false, scope: 'once' })
    await expect(declined).rejects.toThrow(/declined/)
    const pay = d.approve({ ...purchase, guard: { reason: 'pay', action: 'payment', alwaysAsk: true } }, signal())
    expect(lastRequest('approval')).toMatchObject({ action: 'payment', scopes: ['once'] })
    d.respond(lastRequest('approval')!.approvalId, { kind: 'approval', allowed: true, scope: 'site' })
    await pay
    expect(content.grants).toEqual([])
    expect(sites.allows('https://shop.example', 'payment')).toBe(false)
  })
})

describe('Saved permissions view', () => {
  const overview = (over: Partial<PermissionsOverview> = {}): PermissionsOverview => ({ connectors: [], toolPolicies: [], sites: [], folders: [], chats: [], ...over })
  const folder = (id: string, name: string): WatchedFolder => ({ id, name, path: `/Users/me/${name}`, mode: 'read', scope: 'all-chats', companionId: null, addedAt: 0, fileCount: null })

  it('lists connectors and the tool policies that differ from their default', () => {
    const connectors = [
      { id: 'c2', name: 'files', displayName: 'Files', enabled: true, execution: 'local' as const, tools: [
        { name: 'read', title: '', description: '', readOnly: true, policy: 'allow' as const, inputSchema: {} },
        { name: 'write', title: '', description: '', readOnly: false, policy: 'allow' as const, inputSchema: {} },
        { name: 'move', title: '', description: '', readOnly: false, policy: 'ask' as const, inputSchema: {} },
      ] },
      { id: 'c1', name: 'cal', displayName: 'Calendar', enabled: false, execution: 'server' as const, tools: [
        { name: 'list', title: '', description: '', readOnly: true, policy: 'off' as const, inputSchema: {} },
      ] },
    ]
    const view = savedPermissionsView(overview(), connectors, null)
    expect(view.connectors).toEqual([{ id: 'c1', name: 'Calendar', enabled: false }, { id: 'c2', name: 'Files', enabled: true }])
    expect(view.toolPolicies).toEqual([
      { connectorId: 'c2', tool: 'write', policy: 'allow', connectorName: 'Files' },
      { connectorId: 'c1', tool: 'list', policy: 'off', connectorName: 'Calendar' },
    ])
  })

  it('prefers main’s registered sources, sorts sites newest first, and lists only chats with grants', () => {
    const sites: SiteRule[] = [
      { origin: 'https://a.example', access: 'ask', actions: {}, updatedAt: 1 },
      { origin: 'https://b.example', access: 'never', actions: {}, updatedAt: 5 },
    ]
    const view = savedPermissionsView(
      overview({ connectors: [{ id: 'x', name: 'Mail', enabled: true }], sites, folders: [folder('f0', 'Old')], chats: [{ chatId: 'c', title: 'Trip', grants: 2 }, { chatId: 'd', title: 'None', grants: 0 }] }),
      [],
      [folder('f2', 'Taxes'), folder('f1', 'Photos')],
    )
    expect(view.connectors.map((c) => c.name)).toEqual(['Mail'])
    expect(view.sites.map((s) => s.origin)).toEqual(['https://b.example', 'https://a.example'])
    expect(view.folders.map((f) => f.name)).toEqual(['Photos', 'Taxes'])
    expect(view.chats).toEqual([{ chatId: 'c', title: 'Trip', grants: 2 }])
    // Without folders.list (no workspace wired), main's overview folders show.
    expect(savedPermissionsView(overview({ folders: [folder('f0', 'Old')] }), null, null).folders.map((f) => f.id)).toEqual(['f0'])
    expect(siteLabel('https://shop.example:8443')).toBe('shop.example:8443')
  })
})

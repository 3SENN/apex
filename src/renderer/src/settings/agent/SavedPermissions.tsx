/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Agent permissions: the default for sites without a rule
//, and Saved permissions (ST-13), every standing
// permission on one page: connectors, connector tools set away from their
// default, per-site rules, folders shared with the agent, and chats that
// remember approvals. Main re-reads rules at every agent step, so a change
// here applies at the next step.
import { useState, type ReactElement, type ReactNode } from 'react'
import { ExternalLink, Folder, Globe, MessageSquare, Plug, Wrench } from 'lucide-react'
import { savedPermissionsView, siteLabel, type SavedPermissionsView, type SiteAccess } from '@shared/agentTools'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { call, errorText } from '../../api'
import { useT, type T } from '../../i18n/useT'
import { Badge, Button, Select, useToast } from '../../ui'
import { useEvent, useResource } from '../data'
import { Card, PageError, PageSkeleton, Row, Section } from '../kit'

const ACCESS: readonly SiteAccess[] = ['allow', 'ask', 'never']

/** Settings › Agent permissions › Sites: what a site without a rule gets. */
export function SiteDefaultSection({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void> }): ReactElement {
  const t = useT()
  return (
    <Section title={t('agent.sites.title')}>
      <Card>
        <Row title={t('agent.sites.default')} description={t('agent.sites.defaultHint')} htmlFor="agent-site-default">
          <Select
            id="agent-site-default"
            value={settings.siteAccessDefault}
            options={[
              { value: 'allow', label: t('agent.sites.access.allow') },
              { value: 'ask', label: t('agent.sites.access.ask') },
            ]}
            onChange={(siteAccessDefault) => void update({ siteAccessDefault })}
          />
        </Row>
      </Card>
    </Section>
  )
}

async function loadView(): Promise<SavedPermissionsView> {
  // Connectors and folders are other features' services; one that isn't available leaves its part to main's overview.
  const [overview, connectors, folders] = await Promise.all([
    call('agentSites', 'overview'),
    call('connectors', 'list').catch(() => null),
    call('folders', 'list').catch(() => null),
  ])
  return savedPermissionsView(overview, connectors, folders)
}

function Group({ title, icon, empty, action, children }: { title: string; icon: ReactNode; empty: string; action?: ReactNode; children: ReactNode[] }): ReactElement {
  return (
    <div className="ag-saved" role="group" aria-label={title}>
      <div className="ag-saved__head">
        <span className="ag-saved__icon" aria-hidden>
          {icon}
        </span>
        <h3 className="ag-saved__title">{title}</h3>
        {action}
      </div>
      <Card>{children.length > 0 ? children : <p className="ag-saved__empty">{empty}</p>}</Card>
    </div>
  )
}

function policyLabel(t: T, policy: string): string {
  if (policy === 'allow') return t('agent.saved.policy.allow')
  if (policy === 'ask') return t('agent.saved.policy.ask')
  if (policy === 'off') return t('agent.saved.policy.off')
  return policy
}

export function SavedPermissions(): ReactElement {
  const t = useT()
  const toast = useToast()
  const view = useResource(loadView)
  const [busy, setBusy] = useState<string | null>(null)
  useEvent('agent-sites', () => void view.reload())
  useEvent('connectors', () => void view.reload())

  const act = async (key: string, run: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(key)
    try {
      await run()
      if (done) toast.show({ tone: 'success', message: done })
      await view.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: `${t('agent.saved.failed')}: ${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const body = (): ReactNode => {
    if (view.data === null) {
      return view.error ? <PageError title={t('agent.saved.loadFailed')} message={view.error} onRetry={view.reload} /> : <PageSkeleton label={t('settings.kit.loading')} rows={3} />
    }
    const v = view.data
    return (
      <>
        <Group
          title={t('agent.saved.connectors')}
          icon={<Plug />}
          empty={t('agent.saved.connectorsEmpty')}
          action={
            <Button size="sm" variant="ghost" iconEnd={<ExternalLink aria-hidden />} onClick={() => void call('pages', 'open', 'apex://connectors')}>
              {t('agent.saved.manageConnectors')}
            </Button>
          }
        >
          {v.connectors.map((c) => (
            <Row key={c.id} title={c.name}>
              <Badge tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? t('agent.saved.on') : t('agent.saved.off')}</Badge>
            </Row>
          ))}
        </Group>
        <Group title={t('agent.saved.policies')} icon={<Wrench />} empty={t('agent.saved.policiesEmpty')}>
          {v.toolPolicies.map((p) => (
            <Row key={`${p.connectorId}/${p.tool}`} title={p.tool} description={p.connectorName}>
              <Badge tone={p.policy === 'off' ? 'neutral' : p.policy === 'allow' ? 'accent' : 'info'}>{policyLabel(t, p.policy)}</Badge>
            </Row>
          ))}
        </Group>
        <Group title={t('agent.sites.title')} icon={<Globe />} empty={t('agent.sites.empty')}>
          {v.sites.map((rule) => {
            const site = siteLabel(rule.origin)
            const allowed = Object.keys(rule.actions).length
            return (
              <Row key={rule.origin} title={site} description={allowed > 0 ? t('agent.sites.allowedActions', { n: allowed }) : undefined}>
                <span className="ag-saved__controls">
                  <Select
                    size="sm"
                    aria-label={t('agent.sites.accessFor', { site })}
                    value={rule.access}
                    disabled={busy !== null}
                    options={ACCESS.map((a) => ({ value: a, label: t(`agent.sites.access.${a}`) }))}
                    onChange={(access) => void act(`site:${rule.origin}`, () => call('agentSites', 'setSite', rule.origin, access))}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('agent.sites.removeFor', { site })}
                    loading={busy === `remove:${rule.origin}`}
                    disabled={busy !== null}
                    onClick={() => void act(`remove:${rule.origin}`, () => call('agentSites', 'removeSite', rule.origin), t('agent.sites.removed', { site }))}
                  >
                    {t('agent.sites.remove')}
                  </Button>
                </span>
              </Row>
            )
          })}
        </Group>
        <Group title={t('agent.saved.folders')} icon={<Folder />} empty={t('agent.saved.foldersEmpty')}>
          {v.folders.map((f) => (
            <Row
              key={f.id}
              title={f.name}
              description={`${f.mode === 'read' ? t('agent.saved.folderRead') : t('agent.saved.folderReadWrite')} · ${f.scope === 'all-chats' ? t('agent.saved.folderAllChats') : t('agent.saved.folderOneChat')} · ${f.path}`}
            >
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('agent.saved.revokeFor', { name: f.name })}
                loading={busy === `folder:${f.id}`}
                disabled={busy !== null}
                onClick={() => void act(`folder:${f.id}`, () => call('folders', 'revoke', f.id), t('agent.saved.revoked'))}
              >
                {t('agent.saved.revoke')}
              </Button>
            </Row>
          ))}
        </Group>
        <Group title={t('agent.saved.chats')} icon={<MessageSquare />} empty={t('agent.saved.chatsEmpty')}>
          {v.chats.map((c) => (
            <Row key={c.chatId} title={c.title} description={t('agent.saved.grants', { n: c.grants })}>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('agent.saved.revokeFor', { name: c.title })}
                loading={busy === `chat:${c.chatId}`}
                disabled={busy !== null}
                onClick={() => void act(`chat:${c.chatId}`, () => call('agentSites', 'revokeChat', c.chatId), t('agent.saved.revoked'))}
              >
                {t('agent.saved.revoke')}
              </Button>
            </Row>
          ))}
        </Group>
      </>
    )
  }

  return (
    <Section title={t('agent.saved.title')} note={t('agent.saved.note')}>
      {body()}
    </Section>
  )
}

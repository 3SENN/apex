/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy › Permissions › Websites: one row per site permission
// with its default for websites you haven't answered (Ask first or Block,
// the sitePermissionDefaults setting) and, behind Show, the websites with
// their own answer, each changeable and removable. Notifications also get
// the quieter prompt switch. The list follows site settings changed elsewhere.
import { Fragment, useId, useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { decisionOptions } from '@shared/permissions'
import { SITE_PERMISSIONS, type GrantedDevice, type SitePermission, type SiteSettingsEntry, type SiteSettingsPatch } from '@shared/sites'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Badge, Button, Select, useToast } from '../../ui'
import { PermIcon } from '../../overlay/surfaces/sites/parts'
import { useEvent, useResource } from '../data'
import { Card, Notice, Row, Section, SwitchRow } from '../kit'
import { defaultFor, sitesFor, withDefault, type PermissionSites, type SiteDefault } from '../logic/permissions'

interface SitePermissionsSectionProps {
  settings: SettingsView
  update(patch: SettingsPatch): Promise<void>
}

export function SitePermissionsSection({ settings, update }: SitePermissionsSectionProps): ReactElement {
  const t = useT()
  const sites = useResource(() => call('sites', 'list'))
  const [open, setOpen] = useState<ReadonlySet<SitePermission>>(new Set())
  useEvent('site-settings', () => void sites.reload())

  const toggle = (perm: SitePermission): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(perm)) next.add(perm)
      return next
    })
  const setDefault = (perm: SitePermission, value: SiteDefault): void => void update({ sitePermissionDefaults: withDefault(settings.sitePermissionDefaults, perm, value) })

  return (
    <Section title={t('permissionsHub.sites.title')} note={t('permissionsHub.sites.note')}>
      {sites.error && !sites.data && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={() => void sites.reload()}>{t('permissionsHub.retry')}</Button>}>
          {t('permissionsHub.sites.loadError')}
        </Notice>
      )}
      <Card>
        {SITE_PERMISSIONS.map((perm) => (
          <Fragment key={perm}>
            <PermissionRow
              perm={perm}
              entries={sites.data ?? []}
              value={defaultFor(settings.sitePermissionDefaults, perm)}
              expanded={open.has(perm)}
              onDefault={(value) => setDefault(perm, value)}
              onToggle={() => toggle(perm)}
              onChanged={sites.reload}
            />
            {perm === 'notifications' && (
              <SwitchRow
                anchor="quiet-notifications"
                label={t('permissionsHub.sites.quiet')}
                description={t('permissionsHub.sites.quiet.description')}
                checked={settings.quietNotificationPrompts === true}
                onChange={(quietNotificationPrompts) => void update({ quietNotificationPrompts })}
              />
            )}
          </Fragment>
        ))}
      </Card>
    </Section>
  )
}

interface PermissionRowProps {
  perm: SitePermission
  entries: SiteSettingsEntry[]
  value: SiteDefault
  expanded: boolean
  onDefault(value: SiteDefault): void
  onToggle(): void
  onChanged(): Promise<void>
}

function summary(t: ReturnType<typeof useT>, data: PermissionSites): string {
  const parts: string[] = []
  if (data.allowed) parts.push(t('permissionsHub.sites.summary.allowed', { count: data.allowed }))
  if (data.blocked) parts.push(t('permissionsHub.sites.summary.blocked', { count: data.blocked }))
  if (data.devices.length) parts.push(t('permissionsHub.sites.summary.devices', { count: data.devices.length }))
  return parts.length ? parts.join(' · ') : t('permissionsHub.sites.summary.none')
}

function PermissionRow({ perm, entries, value, expanded, onDefault, onToggle, onChanged }: PermissionRowProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const listId = useId()
  const label = t(`sites.perm.${perm}`)
  const data = sitesFor(entries, perm)
  const count = data.sites.length + data.devices.length
  // Changing or removing a stored answer: anything but allow and block is the default.
  const choices = decisionOptions(perm).filter((d): d is 'allow' | 'block' => d !== 'ask')

  const save = async (origin: string, patch: SiteSettingsPatch, done?: string): Promise<void> => {
    try {
      await call('sites', 'set', origin, patch)
      if (done) toast.show({ tone: 'success', message: done })
      await onChanged()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) || t('permissionsHub.sites.failed') })
    }
  }
  const revoke = (origin: string, device: GrantedDevice): Promise<void> => {
    const current = entries.find((e) => e.origin === origin)?.settings.devices ?? []
    return save(origin, { devices: current.filter((d) => !(d.kind === device.kind && d.id === device.id)) })
  }

  return (
    <div className="ph-perm" data-settings-anchor={`site-${perm}`}>
      <Row icon={<PermIcon perm={perm} size={18} />} title={label} description={summary(t, data)}>
        <Select
          size="sm"
          aria-label={t('permissionsHub.sites.defaultLabel', { permission: label })}
          value={value}
          options={[
            { value: 'ask', label: t('permissionsHub.sites.default.ask') },
            { value: 'block', label: t('permissionsHub.sites.default.block') },
          ]}
          onChange={onDefault}
        />
        {count > 0 && (
          <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
            {expanded ? t('permissionsHub.sites.hide') : t('permissionsHub.sites.show', { count })}
          </Button>
        )}
      </Row>
      {expanded && count > 0 && (
        <ul className="ph-sites" id={listId} aria-label={t('permissionsHub.sites.listLabel', { permission: label })}>
          {data.sites.map((site) => (
            <li key={site.origin} className="ph-site">
              <span className="ph-site__host">{site.host}</span>
              <span className="ph-site__controls">
                {choices.length > 1 ? (
                  <Select
                    size="sm"
                    aria-label={t('permissionsHub.sites.decisionLabel', { permission: label, site: site.host })}
                    value={site.decision}
                    options={choices.map((d) => ({ value: d, label: t(`sites.decision.${d}`) }))}
                    onChange={(decision) => void save(site.origin, { permissions: { [perm]: decision } })}
                  />
                ) : (
                  <Badge tone={site.decision === 'allow' ? 'success' : 'danger'}>{t(`sites.decision.${site.decision}`)}</Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('permissionsHub.sites.removeLabel', { site: site.host })}
                  onClick={() => void save(site.origin, { permissions: { [perm]: 'ask' } }, t('permissionsHub.sites.removed', { site: site.host }))}
                >
                  {t('permissionsHub.sites.remove')}
                </Button>
              </span>
            </li>
          ))}
          {data.devices.map(({ origin, host, device }) => (
            <li key={`${origin}|${device.id}`} className="ph-site">
              <span className="ph-site__host">
                {device.name} <span className="ph-site__sub">{host}</span>
              </span>
              <span className="ph-site__controls">
                <Button size="sm" variant="ghost" aria-label={t('permissionsHub.sites.revokeLabel', { device: device.name, site: host })} onClick={() => void revoke(origin, device)}>
                  {t('sites.info.revoke')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

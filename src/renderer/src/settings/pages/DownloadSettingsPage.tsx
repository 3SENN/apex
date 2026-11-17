/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Downloads (ST-45): the download folder with Change and
// Reset, the ask-where-to-save switch, a notice when the chosen folder has
// gone missing (downloads fall back to the default), and the Downloads list.
import { useState, type ReactElement } from 'react'
import { Download, FolderOpen } from 'lucide-react'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, Skeleton, Switch, useToast } from '../../ui'
import { useResource } from '../data'
import { Card, Notice, PageHeader, Row, Section } from '../kit'
import type { SettingsPageProps } from '../pageTypes'

export function DownloadSettingsPage({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  // Read again whenever the chosen folder changes (Change, Reset, or another window).
  const folder = useResource(() => call('downloads', 'folder'), settings.downloadDir)
  const [changing, setChanging] = useState(false)
  const [resetting, setResetting] = useState(false)
  const view = folder.data

  const change = async (): Promise<void> => {
    if (changing) return
    setChanging(true)
    try {
      const picked = await call('downloads', 'chooseFolder')
      if (picked) toast.show({ tone: 'success', message: t('downloads.settings.changed', { path: picked }) })
      await folder.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setChanging(false)
    }
  }

  const reset = async (): Promise<void> => {
    if (resetting) return
    setResetting(true)
    try {
      await call('downloads', 'resetFolder')
      toast.show({ message: t('downloads.settings.resetDone') })
      await folder.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setResetting(false)
    }
  }

  const custom = view?.custom ?? settings.downloadDir !== null
  return (
    <>
      <PageHeader title={t('downloads.settings.title')} description={t('downloads.settings.description')} />
      {view?.missing && settings.downloadDir && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" loading={changing} onClick={() => void change()}>
              {t('downloads.settings.change')}
            </Button>
          }
        >
          {t('downloads.settings.missing', { path: settings.downloadDir })}
        </Notice>
      )}
      {folder.error && !view && (
        <Notice
          tone="error"
          action={
            <Button size="sm" onClick={() => void folder.reload()}>
              {t('downloads.settings.retry')}
            </Button>
          }
        >
          {t('downloads.settings.loadError')} {folder.error}
        </Notice>
      )}
      <Section>
        <Card>
          <Row
            id="downloads-folder"
            title={t('downloads.settings.folder')}
            description={
              view ? (
                <>
                  {!custom && <>{t('downloads.settings.folderDefault')} · </>}
                  <span className="sp-mono">{view.path}</span>
                </>
              ) : (
                <Skeleton width={180} height={12} />
              )
            }
          >
            <Button size="sm" icon={<FolderOpen />} loading={changing} onClick={() => void change()}>
              {t('downloads.settings.change')}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t('downloads.settings.resetLabel')} disabled={!custom} loading={resetting} onClick={() => void reset()}>
              {t('downloads.settings.reset')}
            </Button>
          </Row>
          <div id="downloads-ask" className="sp-switch-anchor">
            <Switch label={t('downloads.settings.ask')} description={t('downloads.settings.askDetail')} checked={settings.askWhereToSave} onChange={(askWhereToSave) => void update({ askWhereToSave })} />
          </div>
        </Card>
      </Section>
      <Section>
        <Card>
          <Row id="downloads-list" title={t('downloads.settings.list')} description={t('downloads.settings.listDetail')}>
            <Button size="sm" icon={<Download />} onClick={() => void call('pages', 'open', 'apex://downloads')}>
              {t('downloads.settings.open')}
            </Button>
          </Row>
        </Card>
      </Section>
    </>
  )
}

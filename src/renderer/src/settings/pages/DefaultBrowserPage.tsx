/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Default browser (ST-33): the status, rechecked whenever the
// page gets focus; a register button, replaced by a confirmation once set; an
// explanation in development builds.
import { useEffect, useState, type ReactElement } from 'react'
import { CircleCheck, Globe } from 'lucide-react'
import { atelier, call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, useAsyncAction } from '../../ui'
import { useResource } from '../data'
import { Card, Notice, PageError, PageHeader, PageSkeleton, Row, Section } from '../kit'

export function DefaultBrowserPage(): ReactElement {
  const t = useT()
  const status = useResource(async () => call('defaultBrowser', 'status'))
  const [waiting, setWaiting] = useState(false)
  // Back from System Settings (or the system prompt): check again.
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState === 'visible') void status.reload()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [])
  useEffect(() => {
    if (status.data?.isDefault) setWaiting(false)
  }, [status.data?.isDefault])

  const register = useAsyncAction(async () => {
    const next = await call('defaultBrowser', 'register')
    status.set(next)
    if (!next.isDefault) setWaiting(true)
  })

  const header = <PageHeader title={t('settings.defaultBrowser.title')} description={t('settings.defaultBrowser.description')} />
  if (status.data === null) {
    return (
      <>
        {header}
        {status.error ? <PageError title={t('settings.loadFailed')} message={status.error} onRetry={status.reload} /> : <PageSkeleton label={t('settings.kit.loading')} rows={1} />}
      </>
    )
  }
  const s = status.data
  const platformNote = atelier.platform === 'darwin' ? t('settings.defaultBrowser.mac') : atelier.platform === 'win32' ? t('settings.defaultBrowser.windows') : null
  return (
    <>
      {header}
      <Section>
        <Card>
          <Row
            anchor="default-browser"
            icon={s.isDefault ? <CircleCheck className="sp-icon--positive" /> : <Globe />}
            title={s.isDefault ? t('settings.defaultBrowser.isDefault') : t('settings.defaultBrowser.notDefault')}
            description={s.isDefault ? t('settings.defaultBrowser.isDefault.description') : waiting ? t('settings.defaultBrowser.pending') : t('settings.defaultBrowser.notDefault.description')}
          >
            {!s.isDefault && s.canRegister && (
              <Button variant="primary" size="sm" loading={register.busy} onClick={() => void register.run()}>
                {t('settings.defaultBrowser.make')}
              </Button>
            )}
          </Row>
        </Card>
        {register.error && <Notice tone="error">{register.error}</Notice>}
        {!s.isDefault && s.reason === 'dev-build' && <Notice tone="info">{t('settings.defaultBrowser.dev')}</Notice>}
        {!s.isDefault && s.reason === 'unsupported' && <Notice tone="info">{t('settings.defaultBrowser.unsupported')}</Notice>}
        {!s.isDefault && s.canRegister && platformNote && <p className="sp-section__note">{platformNote}</p>}
      </Section>
    </>
  )
}

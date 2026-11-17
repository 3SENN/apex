/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { CircleArrowUp, FolderOpen, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import type { ChatView } from '@shared/chats'
import { call, errorText } from '../api'
import { reloadChat } from '../chat/store'
import { useT } from '../i18n/useT'
import { Button, confirm, cx, toast } from '../ui'
import './migrations.css'

// The migration notice above a chat whose file couldn't be brought up to date, or
// that a newer Apex saved (SS-09). The chat stays readable and the composer
// is disabled while it shows. Try again re-runs the migration after a
// repair; Restore original puts the backup back (keeping the current file);
// Show file reveals it in Finder.

type Action = 'retry' | 'restore'

export function MigrationNotice({ chatId, notice }: { chatId: string; notice: ChatView['notice'] }): ReactElement | null {
  const t = useT()
  const [busy, setBusy] = useState<Action | null>(null)
  if (!notice) return null
  const failed = notice.kind === 'migration-failed'

  const run = async (action: Action): Promise<void> => {
    if (busy) return
    if (action === 'restore') {
      const ok = await confirm({ title: t('migrations.notice.restoreTitle'), message: t('migrations.notice.restoreMessage'), confirmLabel: t('migrations.action.restore') })
      if (!ok) return
    }
    setBusy(action)
    try {
      const view = await call('migrations', action === 'retry' ? 'retry' : 'restoreBackup', chatId)
      if (view.notice) toast.show({ message: t('migrations.notice.stillFailing'), tone: 'error' })
      else toast.show({ message: t(action === 'retry' ? 'migrations.notice.fixed' : 'migrations.notice.restored'), tone: 'success' })
      reloadChat(chatId)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const reveal = (): void => {
    void call('migrations', 'revealFile', chatId).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }

  const titleId = `migration-notice-${chatId}`
  return (
    <section
      className={cx('migration-notice', failed ? 'migration-notice--failed' : 'migration-notice--newer')}
      role={failed ? 'alert' : 'status'}
      aria-labelledby={titleId}
      data-kind={notice.kind}
    >
      <span className="migration-notice__icon" aria-hidden="true">
        {failed ? <TriangleAlert size={16} /> : <CircleArrowUp size={16} />}
      </span>
      <div className="migration-notice__body">
        <h2 id={titleId} className="migration-notice__title">
          {t(failed ? 'migrations.notice.failedTitle' : 'migrations.notice.newerTitle')}
        </h2>
        <p className="migration-notice__message">
          {notice.message} {t(failed ? 'migrations.notice.readOnly' : 'migrations.notice.newerReadOnly')}
        </p>
        <div className="migration-notice__actions">
          {failed && (
            <Button size="sm" variant="primary" icon={<RefreshCw size={14} />} loading={busy === 'retry'} disabled={busy !== null} onClick={() => void run('retry')}>
              {t('migrations.action.retry')}
            </Button>
          )}
          <Button size="sm" disabled={busy !== null} onClick={() => reloadChat(chatId)}>
            {t('migrations.action.reload')}
          </Button>
          {notice.backup && (
            <Button size="sm" icon={<RotateCcw size={14} />} loading={busy === 'restore'} disabled={busy !== null} onClick={() => void run('restore')}>
              {t('migrations.action.restore')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={reveal}>
            {t('migrations.action.reveal')}
          </Button>
        </div>
      </div>
    </section>
  )
}

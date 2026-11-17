/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Model and key › View system prompt: a
// read-only dialog with the instructions the active companion's next chat
// starts with (`agent.systemPrompt`), its tools, and Copy. A chat's own
// prompt is fixed at its first message; this shows what a new one would get.
import { useState, type ReactElement } from 'react'
import { Copy, FileText } from 'lucide-react'
import type { SystemPromptView } from '@shared/agentTools'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Badge, Button, Dialog, ErrorState, SkeletonText, useToast } from '../../ui'
import { useResource } from '../data'
import { Card, Row } from '../kit'

function PromptDialog({ companionId, name, onClose }: { companionId: string; name: string; onClose(): void }): ReactElement {
  const t = useT()
  const toast = useToast()
  const view = useResource<SystemPromptView>(() => call('agent', 'systemPrompt', { companionId }), companionId)

  const copy = async (): Promise<void> => {
    if (!view.data) return
    try {
      await navigator.clipboard.writeText(view.data.system)
      toast.show({ tone: 'success', message: t('agent.prompt.copied') })
    } catch (err) {
      toast.show({ tone: 'error', message: `${t('agent.prompt.copyFailed')}: ${errorText(err)}` })
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('agent.prompt.title')}
      description={t('agent.prompt.for', { name })}
      footer={
        <>
          <Button icon={<Copy aria-hidden />} disabled={!view.data} onClick={() => void copy()}>
            {t('agent.prompt.copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('agent.prompt.close')}
          </Button>
        </>
      }
    >
      {view.data === null ? (
        view.error ? (
          <ErrorState title={t('agent.prompt.loadFailed')} message={view.error} onRetry={view.reload} compact />
        ) : (
          <div aria-busy="true" aria-label={t('agent.prompt.loading')}>
            <SkeletonText lines={8} />
          </div>
        )
      ) : (
        <div className="ag-prompt">
          <p className="ag-prompt__note">{view.data.frozen ? t('agent.prompt.frozen') : t('agent.prompt.preview')}</p>
          <pre className="ag-prompt__text" tabIndex={0} aria-label={t('agent.prompt.title')}>
            {view.data.system}
          </pre>
          <div className="ag-prompt__tools" role="group" aria-label={t('agent.prompt.tools')}>
            <span className="ag-prompt__label">{t('agent.prompt.tools')}</span>
            {view.data.tools.length === 0 ? (
              <span className="ag-prompt__none">{t('agent.prompt.noTools')}</span>
            ) : (
              view.data.tools.map((tool) => (
                <Badge key={tool} tone="neutral">
                  {tool}
                </Badge>
              ))
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** The Model and key row that opens the viewer for the active companion. */
export function PromptViewerRow(): ReactElement {
  const t = useT()
  const companion = useResource(() => call('companion', 'get'))
  const [open, setOpen] = useState(false)
  const name = companion.data?.name ?? ''
  return (
    <Card>
      <Row icon={<FileText />} title={t('agent.prompt.rowTitle')} description={companion.data ? t('agent.prompt.viewHint', { name }) : undefined}>
        <Button size="sm" disabled={!companion.data} onClick={() => setOpen(true)} aria-haspopup="dialog">
          {t('agent.prompt.view')}
        </Button>
      </Row>
      {open && companion.data && <PromptDialog companionId={companion.data.id} name={name} onClose={() => setOpen(false)} />}
    </Card>
  )
}

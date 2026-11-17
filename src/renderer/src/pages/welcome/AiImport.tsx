/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Importing past AI conversations (ON-10, CH-31): pick one or more exports
// (a conversations.json, the .zip it comes in, or Atelier .md exports), see a
// preview with counts, then import in the background with progress. The
// chats open read-only; memory can be built from them afterwards.
// The scene: the exports flowing into the companion, and its memory.
import { BRAND_NAME } from '@shared/branding'
import { useEffect, useState, type ReactElement } from 'react'
import { Brain, FileText, FileUp } from 'lucide-react'
import type { ConversationPick, ConversationSource, ImportJob } from '@shared/onboarding'
import { call, errorText, useAppEvent } from '../../api'
import { useActiveCompanion } from '../../components/companionData'
import { TipsCarousel } from '../../guidance/TipsCarousel'
import { Button, CheckRow, Spinner } from '../../ui'
import { useMotion } from '../../ui/motion'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene, type SceneTile } from './StepFrame'
import { useT, t } from '../../i18n/useT'

const SOURCE_LABEL: Record<ConversationSource, string> = { chatgpt: 'ChatGPT', claude: 'Claude', get atelier() { return t('firstRun.welcomeAiImport.atelierExports') } }

function listSources(sources: readonly ConversationSource[]): string {
  const names = sources.map((s) => SOURCE_LABEL[s])
  return names.length <= 1 ? (names[0] ?? t('firstRun.welcomeAiImport.yourFiles')) : t('firstRun.welcomeAiImport.and', { value: names.slice(0, -1).join(', '), value2: names.at(-1) ?? '' })
}

type Phase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'preview'; pick: ConversationPick } | { kind: 'importing'; job: ImportJob } | { kind: 'done'; job: ImportJob } | { kind: 'failed'; message: string }

export function AiImportStep({ companion, next, back, ready }: StepProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const active = useActiveCompanion()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [buildMemory, setBuildMemory] = useState(true)
  // The sources of the files picked last: the scene lights them through the import.
  const [sources, setSources] = useState<readonly ConversationSource[]>([])
  const companionId = companion?.id ?? active?.id ?? null
  useEffect(() => ready(), [])

  useAppEvent('import-job', (e) => {
    setPhase((p) => {
      if (p.kind !== 'importing' || p.job.id !== e.job.id) return p
      if (e.job.state === 'done') return { kind: 'done', job: e.job }
      if (e.job.state === 'failed') return { kind: 'failed', message: e.job.error ?? t('firstRun.welcomeAiImport.theImportStopped') }
      return { kind: 'importing', job: e.job }
    })
  })

  const pick = async (): Promise<void> => {
    setPhase({ kind: 'reading' })
    try {
      const picked = await call('conversations', 'pick')
      setPhase(picked ? { kind: 'preview', pick: picked } : { kind: 'idle' })
      setSources(picked?.sources ?? [])
    } catch (err) {
      setPhase({ kind: 'failed', message: errorText(err) })
    }
  }
  const start = async (p: ConversationPick): Promise<void> => {
    if (!companionId) return
    try {
      const job = await call('conversations', 'start', p.token, { companionId, buildMemory })
      setPhase(job.state === 'done' ? { kind: 'done', job } : { kind: 'importing', job })
    } catch (err) {
      setPhase({ kind: 'failed', message: errorText(err) })
    }
  }

  const done = phase.kind === 'done'
  const tiles: SceneTile[] = [
    { id: 'chatgpt', text: SOURCE_LABEL.chatgpt, on: sources.includes('chatgpt'), badge: done && sources.includes('chatgpt') ? 'check' : undefined },
    { id: 'claude', text: SOURCE_LABEL.claude, on: sources.includes('claude'), badge: done && sources.includes('claude') ? 'check' : undefined },
    { id: 'files', icon: <FileText />, on: sources.includes('atelier') },
    { id: 'memory', icon: <Brain />, on: buildMemory && (done || phase.kind === 'importing'), current: buildMemory && phase.kind === 'importing' },
  ]
  return (
    <StepFrame
      title={t('firstRun.welcomeAiImport.bringYourAiConversations')}
      subtitle={t('firstRun.welcomeAiImport.importChatsFromChatgpt')}
      back={<BackButton onBack={back} />}
      actions={
        <>
          {phase.kind !== 'done' && <Button variant="ghost" onClick={() => next()}>{t('firstRun.welcomeAiImport.skip')}</Button>}
          <Button variant="primary" disabled={phase.kind === 'reading'} onClick={() => next(phase.kind === 'done' ? { answers: { 'imported-chats': String(phase.job.imported) } } : {})}>
            {t('firstRun.welcomeAiImport.continue')}
          </Button>
        </>
      }
    >
      <StepScene tiles={tiles} lines={phase.kind === 'importing' && !reduced ? 'in' : 'still'} />
      {phase.kind === 'idle' && (
        <>
          <ul className="wlx__howto">
            <li><strong>ChatGPT:</strong> {t('firstRun.welcomeAiImport.settingsDataControlsExport')}</li>
            <li><strong>Claude:</strong> {t('firstRun.welcomeAiImport.settingsPrivacyExportData')}</li>
            <li><strong>{BRAND_NAME}:</strong> {t('firstRun.welcomeAiImport.anyChatExportedAs')}</li>
          </ul>
          <Button variant="secondary" icon={<FileUp />} onClick={() => void pick()}>{t('firstRun.welcomeAiImport.chooseExportFiles')}</Button>
        </>
      )}
      {phase.kind === 'reading' && (
        <div className="wlx__thinking" role="status">
          <Spinner size={16} /> {t('firstRun.welcomeAiImport.readingYourFiles')}
          <TipsCarousel />
        </div>
      )}
      {phase.kind === 'preview' &&
        (phase.pick.conversations === 0 ? (
          <div className="wlx__slow" role="alert">
            <p>{t('firstRun.welcomeAiImport.noConversationsWereFound', { value: phase.pick.files.join(', ') })}</p>
            <Button variant="secondary" onClick={() => void pick()}>{t('firstRun.welcomeAiImport.chooseOtherFiles')}</Button>
          </div>
        ) : (
          <>
            <p className="wlx__preview" role="status">
              {t('firstRun.welcomeAiImport.preview', { count: phase.pick.conversations, sources: listSources(phase.pick.sources), files: phase.pick.files.length })}
            </p>
            <CheckRow label={t('firstRun.welcomeAiImport.buildMemoryFromThem')} checked={buildMemory} onChange={setBuildMemory} />
            <p className="co-hint">{t('firstRun.welcomeAiImport.yourCompanionReadsThe')}</p>
            <div className="wlx__row">
              <Button variant="primary" disabled={!companionId} onClick={() => void start(phase.pick)}>{t('firstRun.welcomeAiImport.import')}</Button>
              <Button variant="ghost" onClick={() => void pick()}>{t('firstRun.welcomeAiImport.chooseOtherFiles')}</Button>
            </div>
          </>
        ))}
      {phase.kind === 'importing' && (
        <div className="wlx__progress" role="status" aria-live="polite">
          <progress max={Math.max(1, phase.job.total)} value={phase.job.done} aria-label={t('firstRun.welcomeAiImport.importProgress')} />
          <span>
            {t('firstRun.welcomeAiImport.importingOf', { done: phase.job.done, total: phase.job.total })}
          </span>
        </div>
      )}
      {phase.kind === 'done' && (
        <p className="wlx__preview" role="status">
          {t('firstRun.welcomeAiImport.importedChats', { count: phase.job.imported })}
          {phase.job.skipped > 0 ? t('firstRun.welcomeAiImport.skipped', { count: phase.job.skipped }) : ''}{t('firstRun.welcomeAiImport.importedEnd')}{buildMemory && phase.job.imported > 0 ? t('firstRun.welcomeAiImport.memoryIsBeingBuilt') : ''}
        </p>
      )}
      {phase.kind === 'failed' && (
        <div className="wlx__slow" role="alert">
          <p>{phase.message}</p>
          <Button variant="secondary" onClick={() => void pick()}>{t('firstRun.welcomeAiImport.tryAgain')}</Button>
        </div>
      )}
    </StepFrame>
  )
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Claude Code in the renderer (ST-58, ST-59): its card in Settings › Model
// and key with the live status, sign-in, Re-check, Update Claude Code and the
// CLI picker; the welcome flow's optional step; and the error cards' Update
// Claude Code step. Reached through src/engines/renderer.tsx.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { BookOpen, Check, Download, FolderSearch, LogIn, RefreshCw, ShieldCheck, SquareTerminal } from 'lucide-react'
import type { EngineId, EngineStatus } from '@shared/engine'
import { atelier, call, errorText, useAppEvent } from '../../../../src/renderer/src/api'
import type { EngineErrorStep, EngineErrorStepArgs, EngineSectionsProps, WelcomeEngineProps } from '../../../../src/renderer/src/engines/seam'
import { useEngineStatus } from '../../../../src/renderer/src/engines/useEngineStatus'
import { useT } from '../../../../src/renderer/src/i18n/useT'
import { Card, Notice, Row, Section } from '../../../../src/renderer/src/settings/kit'
import { Badge, Button, Spinner, cx, toast, useToast } from '../../../../src/renderer/src/ui'
import { updateBusy, type CliUpdateStatus } from '../shared/status'
import { accountLine, claudeBadge, cliLine, installLine, limitLine, shouldRecheckOnFocus, tooOldLine, updateLine, updateStatusLine } from './logic'
import './claudeCode.css'

/** Anthropic's own page on installing Claude Code: Atelier never installs or bundles it in a public build. */
export const CLAUDE_CODE_SETUP_URL = 'https://code.claude.com/docs/en/setup'

/** Opens Anthropic's install guide in a new tab. */
function InstallGuideButton(): ReactElement {
  const t = useT()
  return (
    <Button size="sm" variant="primary" icon={<BookOpen />} onClick={() => void call('pages', 'open', CLAUDE_CODE_SETUP_URL)}>
      {t('engines.settings.modelAndKey.installGuide')}
    </Button>
  )
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Coming back from Terminal after signing in or updating: look again by itself. */
function useRecheckOnFocus(status: EngineStatus | null): void {
  const latest = useRef(status)
  latest.current = status
  useEffect(() => {
    let last = 0
    const onFocus = (): void => {
      const current = latest.current
      if (!current?.claudeCodeAvailable || !shouldRecheckOnFocus(current.claudeCode) || Date.now() - last < 3000) return
      last = Date.now()
      void call('claudeCode', 'recheck')
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
}

/** Settings › Model and key's Claude Code section, under the engine choice. */
export function ClaudeCodeSections({ status, settings, update }: EngineSectionsProps): ReactElement | null {
  const t = useT()
  useRecheckOnFocus(status)
  if (status && !status.claudeCodeAvailable) return null
  return (
    <Section title={t('engines.settings.modelAndKey.claudeCodeOnThis')}>
      <ClaudeCodeCard status={status} settings={settings} update={update} />
    </Section>
  )
}

/** Where Claude Code is, whether it is signed in, and the next step when it isn't. */
export function ClaudeCodeCard({ status, settings, update, compact = false }: EngineSectionsProps & { compact?: boolean }): ReactElement {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState<'sign-in' | 'choose' | 'update' | null>(null)
  const claude = status?.claudeCode ?? null
  const tooOld = claude ? tooOldLine(claude) : null
  const progress = updateStatusLine(claude?.update)
  const updating = busy === 'update' || (claude ? updateBusy(claude.update.phase) : false)
  const installs = claude?.installs ?? []
  const checking = !claude || claude.state === 'checking'
  const badge = claude ? claudeBadge(claude) : { tone: 'neutral' as const, label: t('engines.settings.modelAndKey.checking') }
  const limit = claude ? limitLine(claude.rateLimit, time) : null

  const signIn = async (): Promise<void> => {
    setBusy('sign-in')
    try {
      await call('claudeCode', 'openSignIn')
      toast.show({ tone: 'info', message: t('engines.settings.modelAndKey.terminalOpenedSignIn') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  // Update Claude Code: `claude update` in the background, or Terminal with the right command; the status shows how it goes.
  const updateCli = async (): Promise<void> => {
    setBusy('update')
    try {
      await call('claudeCode', 'updateCli', claude?.tooOld ? { model: claude.tooOld.model } : {})
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  const choose = async (): Promise<void> => {
    setBusy('choose')
    try {
      await call('claudeCode', 'chooseCli')
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="mk-card">
      <Row title="Claude Code" description={claude ? cliLine(claude) : t('engines.settings.modelAndKey.lookingForClaudeCode')}>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </Row>
      <Row title={t('engines.settings.modelAndKey.account')} description={claude ? accountLine(claude) : ''}>
        <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={checking} onClick={() => void call('claudeCode', 'recheck')}>
          {t('engines.settings.modelAndKey.reCheck')}
        </Button>
        {claude && claude.state !== 'ready' && claude.state !== 'not-found' && (
          <Button size="sm" variant={claude.state === 'signed-out' ? 'primary' : 'secondary'} icon={<LogIn />} loading={busy === 'sign-in'} onClick={() => void signIn()}>
            {t('engines.settings.modelAndKey.signIn')}
          </Button>
        )}
        {claude?.state === 'not-found' && <InstallGuideButton />}
      </Row>
      {claude?.nextStep && !checking && (
        <div className="mk-step" role="status">
          <span className="mk-step__label">{t('engines.settings.modelAndKey.nextStep')}</span>
          <span>{claude.nextStep}</span>
        </div>
      )}
      {limit && (
        <div className="mk-pad">
          <Notice tone={claude?.rateLimit?.status === 'limited' ? 'warning' : 'info'}>{limit}</Notice>
        </div>
      )}
      {(tooOld || progress) && (
        <div className="mk-pad">
          <Notice
            tone={tooOld && progress?.tone !== 'success' ? 'warning' : 'info'}
            action={
              tooOld ? (
                <Button size="sm" variant="primary" icon={<Download />} loading={updating} disabled={updating} onClick={() => void updateCli()}>
                  {t('engines.settings.modelAndKey.updateCli')}
                </Button>
              ) : undefined
            }
          >
            {tooOld && <span className="mk-update__line">{tooOld}</span>}
            {progress && (
              <span className="mk-update__progress" aria-live="polite">
                {progress.busy && <Spinner size={11} />} {progress.text}
              </span>
            )}
          </Notice>
        </div>
      )}
      {!compact && installs.length > 0 && (
        <div className="mk-installs">
          <p className="mk-installs__title">{t('engines.settings.modelAndKey.installs')}</p>
          <p className="mk-installs__note">{t('engines.settings.modelAndKey.installsNote')}</p>
          <ul className="mk-installs__list">
            {installs.map((install) => (
              <li key={install.path} className={cx('mk-install', install.chosen && 'mk-install--chosen')}>
                <span className="mk-install__text">
                  <span className="mk-install__path" title={install.path}>{install.path}</span>
                  <span className="mk-install__meta">{installLine(install)}</span>
                </span>
                {install.chosen ? (
                  <Badge tone="success">{settings.claudeCodePath === install.path ? t('engines.settings.modelAndKey.pinned') : t('engines.settings.modelAndKey.inUse')}</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => update({ claudeCodePath: install.path })}>
                    {t('engines.settings.modelAndKey.useThisOne')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!compact && (
        <Row
          title={t('engines.settings.modelAndKey.location')}
          description={
            settings.claudeCodePath ? (
              <>{t(claude?.overrideInvalid ? 'engines.settings.modelAndKey.runsPathInvalid' : 'engines.settings.modelAndKey.runsPath', { path: settings.claudeCodePath })}</>
            ) : (
              t('engines.settings.modelAndKey.looksInPath')
            )
          }
        >
          <Button size="sm" variant="secondary" icon={<FolderSearch />} loading={busy === 'choose'} onClick={() => void choose()}>
            {t('engines.settings.modelAndKey.choose')}
          </Button>
          {settings.claudeCodePath && (
            <Button size="sm" variant="ghost" onClick={() => update({ claudeCodePath: null })}>
              {t('engines.settings.modelAndKey.findAutomatically')}
            </Button>
          )}
        </Row>
      )}
      <p className="mk-foot">
        <ShieldCheck aria-hidden />
        <span>{t('engines.settings.modelAndKey.claudeCodeUsesYour')}</span>
      </p>
    </Card>
  )
}

/**
 * The optional Claude Code step in the welcome flow: live status, Sign in
 * (Terminal opens Claude Code), Re-check, and a button that makes it the engine.
 */
export function ClaudeCodeSetup({ settings, onSettings }: WelcomeEngineProps): ReactElement | null {
  const t = useT()
  const status = useEngineStatus()
  useRecheckOnFocus(status)
  const [error, setError] = useState<string | null>(null)
  if (!status?.claudeCodeAvailable) return null
  const claude = status.claudeCode
  const badge = claudeBadge(claude)
  const chosen = settings.engine === 'claude-code'
  const use = (engine: EngineId): void => {
    setError(null)
    atelier.settings.set({ engine }).then(onSettings, (err: unknown) => setError(errorText(err)))
  }
  const signIn = (): void => {
    setError(null)
    call('claudeCode', 'openSignIn').catch((err: unknown) => setError(errorText(err)))
  }
  return (
    <div className="mk-setup">
      <div className="mk-setup__head">
        <SquareTerminal aria-hidden />
        <span className="mk-setup__title">{t('engines.settings.modelAndKey.orUseClaudeCode')}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="mk-setup__text">{claude.state === 'ready' ? t('engines.settings.modelAndKey.itRunsOnYour', { value: accountLine(claude) }) : (claude.nextStep ?? claude.detail)}</p>
      <div className="sp-field__row">
        {claude.state === 'not-found' && <InstallGuideButton />}
        {claude.state !== 'ready' && claude.state !== 'not-found' && claude.state !== 'checking' && (
          <Button size="sm" variant="secondary" icon={<LogIn />} onClick={signIn}>
            {t('engines.settings.modelAndKey.signIn')}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={claude.state === 'checking'} onClick={() => void call('claudeCode', 'recheck')}>
          {t('engines.settings.modelAndKey.reCheck')}
        </Button>
        {claude.state === 'ready' &&
          (chosen ? (
            <Button size="sm" variant="ghost" onClick={() => use('api-key')}>
              {t('engines.settings.modelAndKey.useMyApiKey')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => use('claude-code')}>
              {t('engines.settings.modelAndKey.useClaudeCode')}
            </Button>
          ))}
      </div>
      {chosen && claude.state === 'ready' && <p className="mk-setup__chosen" role="status"><Check aria-hidden /> {t('engines.settings.modelAndKey.newChatsWillRun')}</p>}
      {error && <p className="co-field__error" role="alert">{error}</p>}
    </div>
  )
}


/**
 * A cc-too-old card's Update Claude Code: `claude update` in main; when the
 * version is new enough, main sends the message again (when this card is the
 * newest). Its progress comes with every engine status.
 */
export function useClaudeCodeErrorStep({ code, offered, chatId, model, last, arrivedAt, onAct }: EngineErrorStepArgs): EngineErrorStep | null {
  const t = useT()
  const [update, setUpdate] = useState<CliUpdateStatus | null>(null)
  const [updating, setUpdating] = useState(false)
  const active = offered && code === 'cc-too-old'
  useAppEvent('engine', (event) => {
    if (active) setUpdate(event.status.claudeCode.update)
  })
  useEffect(() => {
    if (!active) return
    let alive = true
    call('engine', 'status').then((status) => alive && setUpdate(status.claudeCode.update), () => undefined)
    return () => {
      alive = false
    }
  }, [active])
  if (!active) return null
  const run = async (): Promise<void> => {
    onAct()
    setUpdating(true)
    try {
      await call('claudeCode', 'updateCli', { ...(last ? { chatId } : {}), ...(model ? { model } : {}) })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setUpdating(false)
    }
  }
  // This card's update: one running now, or one that began after the error arrived (not an older one's outcome).
  const current = update && last && (updateBusy(update.phase) || (arrivedAt !== null && update.at >= arrivedAt)) ? update : null
  const line = updateLine(current)
  return {
    label: t('engines.chat.error.action.updateCli'),
    icon: <Download size={13} />,
    working: updating || (update ? updateBusy(update.phase) : false),
    run: () => void run(),
    progress: line ? { text: t(line.key, line.vars), tone: line.tone } : null,
    // After Terminal ran the update, Retry looks for the CLI again first.
    manual: current?.phase === 'manual',
    recheck: () => call('claudeCode', 'recheck'),
  }
}

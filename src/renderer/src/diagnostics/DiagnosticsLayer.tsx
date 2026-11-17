/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { TabsSnapshot } from '@shared/ipc'
import type { SurfaceAnchor } from '@shared/overlay'
import { isBlankUrl, isInternalUrl, parseInternalUrl } from '@shared/url'
import { apex, call, useAppEvent } from '../api'
import { useT } from '../i18n/useT'
import { openSurface } from '../overlay/useSurface'
import { Modal, toast } from '../ui'
import { CrashCard, type CrashNoticeChoice, type CrashNoticeProps } from './CrashNotice'
import { setReportOpener, type OpenReportOptions } from './menuItems'
import { ProblemReportForm, type ProblemReportProps } from './ProblemReportDialog'

// This layer opens the problem report and the crash notice (⇧⌘H, the
// report-problem command, the About row, the crash state at start-up), and
// shows Send Feedback's toast. Both open as overlay surfaces in the dialog
// layer; while the overlay host is not there, they draw in the chrome.

function windowAnchor(): SurfaceAnchor {
  return { kind: 'window', rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } }
}

/** The chat and tab the report may include, from what this window shows. */
async function reportContext(tabs: TabsSnapshot, options: OpenReportOptions): Promise<ProblemReportProps> {
  const active = tabs.rail ? null : (tabs.tabs.find((t) => t.id === tabs.activeId) ?? null)
  const route = active ? parseInternalUrl(active.url) : null
  const chatId = active ? (active.agentChatId ?? (route?.page === 'chat' ? route.id : null)) : null
  let chatTitle: string | null = null
  if (chatId) {
    chatTitle = await call('chats', 'get', chatId)
      .then((view) => view.summary.title || null)
      .catch(() => null)
  }
  // Only a web page has a screenshot of its own; apex:// pages are drawn by the chrome.
  const tabId = active && !isInternalUrl(active.url) && !isBlankUrl(active.url) ? active.id : null
  return { chatId: chatId && /^[0-9a-f-]{36}$/.test(chatId) ? chatId : null, chatTitle: chatTitle?.slice(0, 200) ?? null, tabId, preselectCrashDumps: options.preselectCrashDumps ?? false }
}

export function DiagnosticsLayer(): ReactElement | null {
  const t = useT()
  const tabs = useRef<TabsSnapshot>(apex.initial.tabs)
  const crashReportsOn = useRef(apex.initial.settings.crashReports)
  const [inlineReport, setInlineReport] = useState<ProblemReportProps | null>(null)
  const [inlineCrash, setInlineCrash] = useState<CrashNoticeProps | null>(null)
  const crashInstance = useRef<string | null>(null)
  const opening = useRef(false)

  useEffect(() => apex.tabs.onChanged((s) => void (tabs.current = s)), [])
  useAppEvent('settings', (e) => void (crashReportsOn.current = e.view.crashReports))

  const openReport = useCallback(async (options: OpenReportOptions = {}): Promise<void> => {
    if (opening.current) return
    opening.current = true
    try {
      const props = await reportContext(tabs.current, options)
      try {
        await openSurface('problem-report', windowAnchor(), props)
      } catch {
        // No overlay host yet: draw it in the chrome instead.
        setInlineReport(props)
      }
    } finally {
      opening.current = false
    }
  }, [])

  useEffect(() => setReportOpener((options) => void openReport(options)), [openReport])
  useEffect(
    () =>
      apex.onCommand((command) => {
        if (command === 'report-problem') void openReport()
      }),
    [openReport],
  )

  const chooseCrash = useCallback(
    (choice: CrashNoticeChoice, dumps: number): void => {
      setInlineCrash(null)
      crashInstance.current = null
      void call('diagnostics', 'dismissCrash').catch(() => undefined)
      if (choice === 'report') void openReport({ preselectCrashDumps: dumps > 0 })
      if (choice === 'keep') {
        void apex.settings
          .set({ crashReports: true })
          .then(() => toast.show({ tone: 'success', message: t('diagnostics.crash.kept') }))
          .catch(() => undefined)
      }
    },
    [openReport, t],
  )

  // The crash notice, once, on the launch after an unclean exit.
  useEffect(() => {
    let live = true
    call('diagnostics', 'crashState')
      .then(async (state) => {
        if (!live || !state.lastExitUnclean) return
        const props: CrashNoticeProps = { dumps: state.dumps, crashReportsOn: crashReportsOn.current }
        const width = 360
        const anchor: SurfaceAnchor = { kind: 'window', rect: { x: window.innerWidth - width - 16, y: window.innerHeight - 16, width, height: 0 } }
        try {
          const opened = openSurface('crash-notice', anchor, props)
          const result = await opened
          chooseCrash('value' in result && typeof result.value === 'string' ? (result.value as CrashNoticeChoice) : 'dismiss', state.dumps)
        } catch {
          if (live) setInlineCrash(props)
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [chooseCrash])

  // Dismissed in another window, or the dumps went away: this one closes too.
  useAppEvent('crash', (e) => {
    if (!e.state.lastExitUnclean) setInlineCrash(null)
  })

  useAppEvent('feedback-draft', (e) => {
    if (e.ok) {
      toast.show({ tone: 'success', message: t('diagnostics.feedback.opened') })
      return
    }
    const copy = e.address || e.system
    toast.show({
      tone: 'error',
      message: t('diagnostics.feedback.failed'),
      duration: 8000,
      action: {
        label: e.address ? t('diagnostics.feedback.copyAddress') : t('diagnostics.feedback.copyDetails'),
        onAction: () => void navigator.clipboard.writeText(copy).then(() => toast.show({ tone: 'success', message: t('diagnostics.feedback.copied') })),
      },
    })
  })

  if (apex.role !== 'chrome') return null
  return (
    <>
      <Modal open={inlineReport !== null} onClose={() => setInlineReport(null)} dismissible={false} label={t('diagnostics.report.title')} placement="center" className="dg-modal-panel">
        {inlineReport && <ProblemReportForm context={inlineReport} onClose={() => setInlineReport(null)} />}
      </Modal>
      {inlineCrash && (
        <div className="dg-crash-wrap dg-crash-wrap--inline">
          <CrashCard {...inlineCrash} onChoose={(choice) => chooseCrash(choice, inlineCrash.dumps)} />
        </div>
      )}
    </>
  )
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Component, useEffect, useRef, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import type { FloatKind } from '@shared/float'
import { t, useLanguageVersion } from '../i18n/useT'
import { floatApi } from './api'
import { VoiceHud } from './hud/VoiceHud'
import { Launcher } from './launcher/Launcher'
import { MeetingCard } from './meeting-card/MeetingCard'
import { RecordingWidget } from './recording/RecordingWidget'

// Picks the float's view by kind and keeps the window sized to it: the
// content is measured and main clamps the size to the kind's limits.
// An error in a view shows a small card with Close instead of a blank,
// always-on-top rectangle.

const VIEWS: Record<FloatKind, ComponentType> = {
  launcher: Launcher,
  'voice-hud': VoiceHud,
  'meeting-card': MeetingCard,
  recording: RecordingWidget,
}

class FloatErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="float-card float-error" role="alert">
        <p className="float-error__text">{t('float.error.title')}</p>
        <button type="button" className="float-button" onClick={() => floatApi?.close()}>
          {t('float.error.close')}
        </button>
      </div>
    )
  }
}

export function FloatRoot({ kind }: { kind: FloatKind }): ReactElement {
  const View = VIEWS[kind]
  // A language change relabels the whole float (its views read t() as they render).
  const language = useLanguageVersion()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !floatApi) return
    const report = (): void => {
      const rect = el.getBoundingClientRect()
      floatApi?.requestSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) })
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    report()
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={box} className="float-root" data-kind={kind}>
      <FloatErrorBoundary>
        <View key={language} />
      </FloatErrorBoundary>
    </div>
  )
}

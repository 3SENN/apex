/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's words for every speech error and warning (MV-08), each with what to
// do about it: open the right System Settings pane, try again, or choose
// another language or microphone. Pure, so every code is unit-tested.
import { decodeSpeechError, isSpeechErrorCode, type PermissionKind, type SpeechErrorCode, type SpeechPurpose } from '@shared/speech'
import { t, type MessageKey } from '@shared/i18n/core'

/** Session warnings and the interrupted state read the same way as errors. */
export type SpeechNoticeCode = SpeechErrorCode | 'device-fallback' | 'screen-missing' | 'interrupted'

export type SpeechAction =
  | { kind: 'open-settings'; pane: PermissionKind }
  | { kind: 'retry' }
  | { kind: 'choose-language' }
  | { kind: 'choose-mic' }

export interface SpeechCopy {
  code: SpeechNoticeCode
  message: string
  tone: 'info' | 'warning' | 'error'
  action: SpeechAction | null
}

const COPY: Record<SpeechNoticeCode, { key: MessageKey; tone: SpeechCopy['tone']; action: SpeechAction | null }> = {
  'mic-denied': { key: 'speech.error.micDenied', tone: 'error', action: { kind: 'open-settings', pane: 'microphone' } },
  'speech-denied': { key: 'speech.error.speechDenied', tone: 'error', action: { kind: 'open-settings', pane: 'speech' } },
  'screen-denied': { key: 'speech.error.screenDenied', tone: 'warning', action: { kind: 'open-settings', pane: 'screen' } },
  'screen-missing': { key: 'speech.error.screenMissing', tone: 'warning', action: { kind: 'open-settings', pane: 'screen' } },
  'mic-busy': { key: 'speech.error.micBusy', tone: 'error', action: { kind: 'retry' } },
  'device-missing': { key: 'speech.error.deviceMissing', tone: 'error', action: { kind: 'choose-mic' } },
  'device-fallback': { key: 'speech.error.deviceFallback', tone: 'warning', action: { kind: 'choose-mic' } },
  'locale-unsupported': { key: 'speech.error.localeUnsupported', tone: 'error', action: { kind: 'choose-language' } },
  'no-speech': { key: 'speech.error.noSpeech', tone: 'warning', action: { kind: 'retry' } },
  'recording-failed': { key: 'speech.error.recordingFailed', tone: 'warning', action: null },
  busy: { key: 'speech.error.busy', tone: 'warning', action: { kind: 'retry' } },
  invalid: { key: 'speech.error.invalid', tone: 'error', action: { kind: 'retry' } },
  failed: { key: 'speech.error.failed', tone: 'error', action: { kind: 'retry' } },
  'helper-missing': { key: 'speech.error.helperMissing', tone: 'info', action: null },
  'helper-failed': { key: 'speech.error.helperFailed', tone: 'error', action: { kind: 'retry' } },
  'helper-outdated': { key: 'speech.error.helperOutdated', tone: 'error', action: null },
  'unsupported-platform': { key: 'speech.error.unsupportedPlatform', tone: 'info', action: null },
  interrupted: { key: 'speech.error.interrupted', tone: 'info', action: null },
}

export const SPEECH_NOTICE_CODES = Object.keys(COPY) as SpeechNoticeCode[]

const HOLDER: Record<SpeechPurpose, MessageKey> = {
  dictation: 'speech.holder.dictation',
  'voice-command': 'speech.holder.voiceCommand',
  launcher: 'speech.holder.launcher',
  meeting: 'speech.holder.meeting',
  'level-test': 'speech.holder.levelTest',
  file: 'speech.holder.file',
}

/** The copy for a code; a busy error names what holds the helper when it is known. */
export function errorCopy(code: SpeechNoticeCode, holder?: SpeechPurpose): SpeechCopy {
  const entry = COPY[code]
  const message = code === 'busy' && holder ? t('speech.error.busyHolder', { holder: t(HOLDER[holder]) }) : t(entry.key)
  return { code, message, tone: entry.tone, action: entry.action }
}

/** The label of an action's button. */
export function actionLabel(action: SpeechAction): string {
  switch (action.kind) {
    case 'open-settings':
      return t('speech.action.openSettings')
    case 'retry':
      return t('speech.action.retry')
    case 'choose-language':
      return t('speech.action.chooseLanguage')
    case 'choose-mic':
      return t('speech.action.chooseMic')
  }
}

/** The copy for anything a speech call threw (codes cross IPC inside the message); unknown errors read as failed. */
export function copyForError(err: unknown): SpeechCopy {
  const text = err instanceof Error ? err.message : String(err)
  const decoded = decodeSpeechError(text)
  if (decoded) return errorCopy(decoded.code, decoded.holder)
  return errorCopy(isSpeechErrorCode(text) ? text : 'failed')
}

/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The speech kit: hooks and controls that dictation, voice, meeting
// capture, the meetings page and Settings › Transcription share.
import './speech.css'

export { useMicDevices, useScreenAccess, useSpeechLocales, useSpeechPermissions, useSpeechSession, useSpeechStatus, reduceSession, PERMISSION_POLL_MS, type Level, type MicDevicesState, type PermissionsState, type SessionView } from './hooks'
export { useSpeechAssets, type SpeechAssetsState } from './hooks'
export { errorCopy, copyForError, actionLabel, SPEECH_NOTICE_CODES, type SpeechAction, type SpeechCopy, type SpeechNoticeCode } from './errorCopy'
export { LevelMeter } from './LevelMeter'
export { PermissionChecklist, type PermissionChecklistProps } from './PermissionChecklist'
export { MicSelect, type MicSelectProps } from './MicSelect'
export { LanguageSelect, NO_LOCALE, type LanguageSelectProps } from './LanguageSelect'
export { MicTest, type MicTestProps } from './MicTest'
export { SensitivitySlider, type SensitivitySliderProps } from './SensitivitySlider'
export { SpeechNotice, type SpeechNoticeProps } from './SpeechNotice'
export { levelToFraction, formatClock, formatGain, vocabularyStats, localePrivacy, micMissing, showChecklist, effectiveLocale, type VocabularyStats } from './logic'
export { modelNotice, sameLocale, type ModelNotice } from './logic'

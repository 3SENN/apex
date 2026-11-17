/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Voice (ST-14, ST-15, ST-16): hold-to-talk and its keys,
// where commands go, sounds, the screenshot, reading replies aloud, the
// quick-ask launcher with its shortcut status, and a microphone test.
import { useEffect, useState, type ReactElement } from 'react'
import { CircleAlert, CircleCheck, Play } from 'lucide-react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import type { ScreenAccess, SpeechPermissions, SpeechStatus } from '@shared/speech'
import {
  VOICE_CHORDS,
  chordAccelerator,
  effectiveReadAloudModifier,
  freeReadAloudModifiers,
  type ReadAloudModifier,
  type VoiceChord,
  type VoiceTarget,
} from '@shared/voice'
import { apex, call, errorText } from '../../api'
import { t, type MessageKey } from '../../i18n/useT'
import { Button, SegmentedControl, Select } from '../../ui'
import { isMac } from '../../ui/hooks'
import { formatShortcut } from '../../ui/logic/shortcut'
import { speak, useVoices } from '../../voice/speak'
import { LevelMeter, MicTest, useSpeechSession } from '../../speech'
import '../../voice/voice.css'
import { Card, Notice, PageHeader, Row, Section, SwitchRow } from '../kit'
import { PermissionsLink } from '../permissions/PermissionsLink'

interface VoicePageProps {
  settings: SettingsView
  update(patch: SettingsPatch): Promise<void> | void
  /** Opens another settings page (Transcription for the microphone and language). */
  onOpenSection?(id: string): void
}

const TARGETS: ReadonlyArray<{ value: VoiceTarget; label: string }> = [
  { value: 'auto', label: t('voice.settings.target.auto') },
  { value: 'companion', label: t('voice.settings.target.companion') },
  { value: 'field', label: t('voice.settings.target.field') },
]

const SYSTEM_VOICE = '__system__'

function keysLabel(chord: VoiceChord): string {
  return formatShortcut(chordAccelerator(chord), isMac)
}

/** Speech status, permissions and Screen Recording (as screenshots need it), kept current from their events. */
function useSpeech(): { status: SpeechStatus | null; permissions: SpeechPermissions | null; screen: ScreenAccess | null; refresh(): void } {
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const [permissions, setPermissions] = useState<SpeechPermissions | null>(null)
  const [screen, setScreen] = useState<ScreenAccess | null>(null)
  const refresh = (): void => {
    void call('speech', 'status').then(setStatus, () => setStatus({ available: false, reason: 'helper-missing', active: null }))
    void call('speech', 'permissions').then(setPermissions, () => setPermissions(null))
    void call('speech', 'screenAccess').then(setScreen, () => setScreen(null))
  }
  useEffect(() => {
    refresh()
    const off = apex.onAppEvent((e) => {
      if (e.type === 'speech-status') setStatus(e.status)
      else if (e.type === 'speech-permissions') {
        setPermissions(e.permissions)
        void call('speech', 'screenAccess').then(setScreen, () => undefined)
      }
    })
    // Coming back from System Settings: look again.
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])
  return { status, permissions, screen, refresh }
}

/** The launcher's global shortcut: ready, or held by another app. */
function useShortcutStatus(settings: SettingsView): { registered: boolean; conflict: boolean } | null {
  const [status, setStatus] = useState<{ registered: boolean; conflict: boolean } | null>(null)
  useEffect(() => {
    const load = (): void => void call('voice', 'shortcutStatus').then(setStatus, () => setStatus(null))
    load()
    return apex.onAppEvent((e) => {
      if (e.type === 'voice') load()
    })
  }, [settings.voice.launcher, settings.voice.chord])
  return status
}

export function VoicePage({ settings, update, onOpenSection }: VoicePageProps): ReactElement {
  const v = settings.voice
  const { status, permissions, screen, refresh } = useSpeech()
  const shortcut = useShortcutStatus(settings)
  const voices = useVoices()
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof v>): void => void Promise.resolve(update({ voice: patch })).catch((err: unknown) => setError(errorText(err)))

  const modifier = effectiveReadAloudModifier(v.chord, v.readAloudModifier)
  const modifiers = freeReadAloudModifiers(v.chord).map((m) => ({ value: m, label: t(`voice.settings.modifier.${m}` as MessageKey) }))
  const keys = keysLabel(v.chord)
  const blocked = permissions && (permissions.microphone === 'denied' || permissions.microphone === 'restricted' || permissions.speech === 'denied' || permissions.speech === 'restricted')
  const blockedPane = permissions && (permissions.microphone === 'denied' || permissions.microphone === 'restricted') ? 'microphone' : 'speech'

  const voiceOptions = [
    { value: SYSTEM_VOICE, label: t('voice.settings.voiceDefault') },
    ...voices
      .filter((voice, i, all) => all.findIndex((o) => o.name === voice.name) === i)
      .map((voice) => ({ value: voice.name, label: `${voice.name} · ${voice.lang}` })),
  ]
  // A saved voice that this Mac no longer has still shows, so the select never lies.
  if (v.voiceName && !voiceOptions.some((o) => o.value === v.voiceName)) voiceOptions.splice(1, 0, { value: v.voiceName, label: v.voiceName })
  const sample = (name: string | null): void => void speak(t('voice.settings.voiceSample'), name)

  // macOS asks only the first time, so Allow asks then; System Settings opens only once it was refused.
  const askScreen = async (): Promise<void> => {
    try {
      await call('speech', 'requestScreen')
      refresh()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const screenOn = screen === 'granted' || screen === 'unsupported'
  const screenAction =
    screen === 'relaunch' ? (
      <Button size="sm" onClick={() => void call('speech', 'relaunch').catch((err: unknown) => setError(errorText(err)))}>
        {t('voice.settings.relaunch')}
      </Button>
    ) : screen === 'denied' ? (
      <Button size="sm" onClick={() => void call('speech', 'openPrivacySettings', 'screen').catch((err: unknown) => setError(errorText(err)))}>
        {t('voice.settings.screenOpen')}
      </Button>
    ) : (
      <Button size="sm" onClick={() => void askScreen()}>
        {t('voice.settings.screenGrant')}
      </Button>
    )
  const screenNote: MessageKey = screen === 'relaunch' ? 'voice.settings.screenRelaunch' : screen === 'denied' ? 'voice.settings.screenOff' : 'voice.settings.screenDenied'

  return (
    <>
      <PageHeader title={t('voice.settings.title')} description={t('voice.settings.description')} />
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {status && !status.available && status.reason && <Notice tone="warning">{t(`voice.settings.unavailable.${status.reason}` as MessageKey)}</Notice>}
      {status?.available && blocked && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" onClick={() => void call('speech', 'openPrivacySettings', blockedPane).catch((err: unknown) => setError(errorText(err)))}>
              {t('voice.settings.openPrivacy')}
            </Button>
          }
        >
          {t('voice.settings.permDenied')}
        </Notice>
      )}

      <Section title={t('voice.settings.holdSection')} actions={<PermissionsLink />}>
        <Card>
          <SwitchRow anchor="voice-hold" label={t('voice.settings.enable')} description={t('voice.settings.enableHint')} checked={v.holdToTalk} onChange={(holdToTalk) => set({ holdToTalk })} />
          <Row anchor="voice-keys" title={t('voice.settings.chord')} description={t('voice.settings.chordHint')} htmlFor="voice-chord">
            <Select
              id="voice-chord"
              value={v.chord}
              options={VOICE_CHORDS.map((c) => ({ value: c, label: keysLabel(c) }))}
              onChange={(chord) => set({ chord, readAloudModifier: effectiveReadAloudModifier(chord, v.readAloudModifier) })}
            />
          </Row>
          <Row anchor="voice-target" title={t('voice.settings.target')} description={t('voice.settings.targetHint')}>
            <SegmentedControl label={t('voice.settings.target')} size="sm" options={TARGETS} value={v.target} onChange={(target) => set({ target })} />
          </Row>
          <SwitchRow anchor="voice-rewrite" label={t('voice.settings.rewrite')} description={t('voice.settings.rewriteHint')} checked={v.rewriteField} onChange={(rewriteField) => set({ rewriteField })} />
          <SwitchRow anchor="voice-sounds" label={t('voice.settings.sounds')} description={t('voice.settings.soundsHint')} checked={v.sounds} onChange={(sounds) => set({ sounds })} />
        </Card>
      </Section>

      <Section title={t('voice.settings.screenshotSection')}>
        <Card>
          <SwitchRow anchor="voice-screenshot" label={t('voice.settings.screenshot')} description={t('voice.settings.screenshotHint')} checked={v.screenshot} onChange={(screenshot) => set({ screenshot })} />
          <Row anchor="voice-source" title={t('voice.settings.source')} description={t('voice.settings.sourceHint')} htmlFor="voice-source">
            <Select
              id="voice-source"
              value={v.screenshotSource}
              disabled={!v.screenshot}
              options={[
                { value: 'tab', label: t('voice.settings.source.tab') },
                { value: 'screen', label: t('voice.settings.source.screen') },
              ]}
              onChange={(screenshotSource) => {
                set({ screenshotSource })
                // Choosing the whole screen is the moment to ask, the first time.
                if (screenshotSource === 'screen' && screen === 'not-determined') void askScreen()
              }}
            />
          </Row>
          {v.screenshot && v.screenshotSource === 'screen' && screen !== null && (
            <Row
              anchor="voice-screen-access"
              title={t('voice.settings.screenAccess')}
              description={screenOn ? undefined : t(screenNote)}
              icon={screenOn ? <CircleCheck className="voice-settings__ok" /> : <CircleAlert className="voice-settings__warn" />}
            >
              {screenOn ? <span className="voice-settings__state">{t('voice.settings.screenGranted')}</span> : screenAction}
            </Row>
          )}
        </Card>
      </Section>

      <Section title={t('voice.settings.readSection')}>
        <Card>
          <Row anchor="voice-modifier" title={t('voice.settings.modifier')} description={t('voice.settings.modifierHint')} htmlFor="voice-modifier">
            <Select id="voice-modifier" value={modifier} options={modifiers} onChange={(m: ReadAloudModifier) => set({ readAloudModifier: m })} />
          </Row>
          <Row anchor="voice-voice" title={t('voice.settings.voice')} description={t('voice.settings.voiceHint')} htmlFor="voice-voice">
            <div className="voice-settings__voice">
              <Select
                id="voice-voice"
                value={v.voiceName ?? SYSTEM_VOICE}
                options={voiceOptions}
                onChange={(value) => {
                  const voiceName = value === SYSTEM_VOICE ? null : value
                  set({ voiceName })
                  sample(voiceName)
                }}
              />
              <Button size="sm" variant="ghost" aria-label={t('voice.settings.voicePlay')} title={t('voice.settings.voicePlay')} onClick={() => sample(v.voiceName)}>
                <Play size={14} aria-hidden="true" />
              </Button>
            </div>
          </Row>
        </Card>
      </Section>

      <Section title={t('voice.settings.launcherSection')}>
        <Card>
          <SwitchRow anchor="voice-launcher" label={t('voice.settings.launcher')} description={t('voice.settings.launcherHint', { keys })} checked={v.launcher} onChange={(launcher) => set({ launcher })} />
          {v.launcher && shortcut && (shortcut.conflict || shortcut.registered) && (
            <Row
              title={shortcut.conflict ? t('voice.settings.launcherConflict', { keys }) : t('voice.settings.launcherReady')}
              icon={shortcut.conflict ? <CircleAlert className="voice-settings__warn" /> : <CircleCheck className="voice-settings__ok" />}
            />
          )}
        </Card>
      </Section>

      <Section title={t('voice.settings.micSection')} note={t('voice.settings.moreMic')} actions={onOpenSection ? <Button size="sm" variant="ghost" onClick={() => onOpenSection('transcription')}>{t('voice.settings.openTranscription')}</Button> : undefined}>
        <Card>
          <VoiceMicTest disabled={Boolean(status && !status.available)} />
        </Card>
      </Section>
    </>
  )
}

/** Test microphone: the speech kit's level-test session and controls, shared with Settings › Transcription. */
function VoiceMicTest({ disabled }: { disabled: boolean }): ReactElement {
  const test = useSpeechSession({ purpose: 'level-test' })
  return (
    <Row anchor="voice-test-mic" title={t('voice.settings.testMic')} description={t('voice.settings.testMicHint')}>
      <div className="voice-settings__test">
        <LevelMeter level={test.levels.mic} label={t('voice.settings.testMic')} disabled={disabled || test.state !== 'listening'} />
        <MicTest session={test} disabled={disabled} />
      </div>
    </Row>
  )
}

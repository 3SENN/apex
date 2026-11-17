/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// ON-04 in the welcome flow: under the browser import, a card that starts the
// guided import from the macOS Passwords app, then a second card that turns
// on Apple Passwords (iCloud Keychain). Both are optional; Continue skips
// them. Only on macOS, where that app and Apple's helper exist.
import { useState, type ReactElement } from 'react'
import { CircleCheck, KeyRound } from 'lucide-react'
import { Button, isMac } from '../ui'
import { useT } from '../i18n/useT'
import { ImportDialog } from './ImportDialog'
import { WelcomeApplePasswords } from './ApplePasswords'
import './passwords.css'

export function WelcomePasswords(): ReactElement | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  if (!isMac) return null
  return (
    <>
      <div className="pw-welcome">
        <div className="pw-welcome__text">
          <p className="pw-welcome__title">{t('passwords.system.welcome.title')}</p>
          <p className="pw-welcome__body">{t('passwords.system.welcome.body')}</p>
        </div>
        {done ? (
          <span className="pw-welcome__body" role="status">
            <CircleCheck size={14} aria-hidden /> {t('passwords.system.welcome.done')}
          </span>
        ) : (
          <Button icon={<KeyRound />} onClick={() => setOpen(true)}>
            {t('passwords.system.welcome.button')}
          </Button>
        )}
        <ImportDialog open={open} source="system" onClose={() => setOpen(false)} onImported={(r) => setDone(r.added + r.updated + r.same > 0)} />
      </div>
      <WelcomeApplePasswords />
    </>
  )
}

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// How the setup flow's one companion looks and what it says on each step
// (DS-78 kept from the original welcome). Where it stands is the step template's
// slot (stage.ts), the same on every step.
import type { CompanionMood } from '@shared/companion'
import type { SetupStepId } from '@shared/onboarding'
import { t } from '@shared/i18n/core'

export const STEP_MOOD: Record<SetupStepId, CompanionMood> = {
  intro: 'happy',
  name: 'happy',
  look: 'happy',
  engine: 'listening',
  layout: 'idle',
  questions: 'listening',
  workspace: 'happy',
  connectors: 'idle',
  'import-browser': 'idle',
  'import-ai': 'idle',
  showcase: 'talking',
  favorites: 'idle',
  launch: 'happy',
}

/** The step's title, for the progress dots and screen readers. */
export const STEP_TITLE: Record<SetupStepId, string> = {
  get intro() { return t('firstRun.welcomeLogic.welcome') },
  get name() { return t('firstRun.welcomeLogic.name') },
  get look() { return t('firstRun.welcomeLogic.look') },
  get engine() { return t('firstRun.welcomeLogic.connectClaude') },
  get layout() { return t('firstRun.welcomeLogic.layout') },
  get questions() { return t('firstRun.welcomeLogic.aFewQuestions') },
  get workspace() { return t('firstRun.welcomeLogic.yourWorkspace') },
  get connectors() { return t('firstRun.welcomeLogic.yourApps') },
  get 'import-browser'() { return t('firstRun.welcomeLogic.browserData') },
  get 'import-ai'() { return t('firstRun.welcomeLogic.aiConversations') },
  get showcase() { return t('firstRun.welcomeLogic.whatAtelierCanDo') },
  get favorites() { return t('firstRun.welcomeLogic.favouriteSites') },
  get launch() { return t('firstRun.welcomeLogic.ready') },
}

/** What the companion says on each step, in its bubble. */
export function stepLine(step: SetupStepId, name: string): string {
  switch (step) {
    case 'intro':
      return t('firstRun.welcomeLogic.hiIM', { name })
    case 'name':
      return t('firstRun.welcomeLogic.whatWouldYouLike')
    case 'look':
      return t('firstRun.welcomeLogic.shuffleMeOrStart')
    case 'engine':
      return t('firstRun.welcomeLogic.connectMeToClaude')
    case 'layout':
      return t('firstRun.welcomeLogic.tabsDownTheSide')
    case 'questions':
      return t('firstRun.welcomeLogic.tellMeALittle')
    case 'workspace':
      return t('firstRun.welcomeLogic.hereSWhatIllSetUp')
    case 'connectors':
      return t('firstRun.welcomeLogic.iCanReachYour')
    case 'import-browser':
      return t('firstRun.welcomeLogic.bringYourBookmarksAlong')
    case 'import-ai':
      return t('firstRun.welcomeLogic.talkedToOtherAssistants')
    case 'showcase':
      return t('firstRun.welcomeLogic.hereSWhatWe')
    case 'favorites':
      return t('firstRun.welcomeLogic.pinTheSitesYou')
    case 'launch':
      return t('firstRun.welcomeLogic.allSetLetS')
  }
}

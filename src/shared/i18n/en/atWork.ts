/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The at-work English strings: the agent at work (notice, shield, pill),
// the selection chip and the companion's extras.
export const atWork = {
  'atWork.activity.reading': 'Reading the page',
  'atWork.activity.looking': 'Looking at the page',
  'atWork.activity.clicking': 'Clicking around',
  'atWork.activity.typing': 'Typing',
  'atWork.activity.opening': 'Opening a page',
  'atWork.activity.tabs': 'Switching tabs',
  'atWork.activity.searching': 'Searching the web',
  'atWork.activity.fetching': 'Reading a page',
  'atWork.activity.memory': 'Checking memory',
  'atWork.activity.connector': 'Using {name}',
  'atWork.activity.working': 'Working',
  'atWork.activity.approval': 'Waiting for your OK',

  'atWork.notice.label': '{name} at work in this tab',
  'atWork.notice.driving': '{name} is using this tab',
  'atWork.notice.resuming': '{name} is picking up again',
  'atWork.notice.solved': 'Solved. {name} carries on',
  'atWork.notice.paused': '{name} is paused',
  'atWork.notice.takenOver': 'You have this tab',
  'atWork.notice.takenOverDetail': '{name} waits until you hand it back',
  'atWork.notice.challenge': 'This page wants a person',
  'atWork.notice.challengeDetail': 'Solve the check, then {name} carries on',
  'atWork.notice.nudge': 'Want to use this tab yourself?',
  'atWork.notice.takeOver': 'Take over',
  'atWork.notice.handBack': 'Hand back',
  'atWork.notice.resume': 'Resume',
  'atWork.notice.solvedIt': 'I solved it',
  'atWork.notice.skipPage': 'Skip page',
  'atWork.notice.openChat': 'Open chat',
  'atWork.notice.besideOn': 'Show the chat beside this page',
  'atWork.notice.besideOff': 'Hide the chat beside this page',
  'atWork.notice.stop': 'Stop',
  'atWork.notice.drag': 'Move the notice',
  'atWork.notice.dragHint': 'Drag to move. Arrow keys move it too; Home puts it back.',

  'atWork.shield.label': '{name} is using this page. Click to take over.',
  'atWork.shield.cursor': '{name}’s pointer',

  'atWork.pill.working': '{name} is working',
  'atWork.pill.approval': '{name} needs you',
  'atWork.pill.more': '{count, plural, one {and # more} other {and # more}}',
  'atWork.pill.open': 'Open the chat',

  'atWork.skipNote': 'The person skipped this page because it asked for a human check. Do not come back to it; find another way or another source.',
  'atWork.takenOverNote': 'The person took over this tab for a while. Look at the page again before you act; it may have changed.',

  'atWork.selection.label': 'Selected text',
  'atWork.selection.ask': 'Ask {name}',
  'atWork.selection.explain': 'Explain',
  'atWork.selection.copy': 'Copy',
  'atWork.selection.copied': 'Copied',
  'atWork.selection.search': 'Search',
  'atWork.selection.hint': '{keys} asks about it',
  'atWork.selection.explainRequest': 'Explain this, from {url}:\n\n{quote}',
  'atWork.menu.askSelection': 'Ask {name} about “{text}”',
  'atWork.menu.askLink': 'Ask {name} about this link',
  'atWork.menu.askPage': 'Ask {name} about this page',

  'atWork.quote.label': 'Quoted from {host}',
  'atWork.quote.remove': 'Remove the quote',
  'atWork.quote.links': '{count, plural, one {# link} other {# links}}',

  'atWork.routines.running': 'Running now',
  'atWork.routines.runningDot': 'A routine is running',

  'atWork.companion.unavailable': '{name} can’t work right now',
  'atWork.companion.fallbackName': 'Your companion',
} as const

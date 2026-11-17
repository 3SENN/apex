/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The new tab's web search (NT-01): the ask-or-search switch in the start
// composer, its actions and suggestions, and the one-time engine choice
// (setup and the new tab).
export const newTabSearch = {
  'newTabSearch.mode.label': 'Ask or search the web',
  'newTabSearch.mode.ask': 'Ask {name}',
  'newTabSearch.mode.web': 'Search the web with {engine}',
  'newTabSearch.placeholder': 'Search {engine} or type a site',
  'newTabSearch.label': 'Search {engine} or go to a site',
  'newTabSearch.action.go': 'Go to {host}',
  'newTabSearch.action.search': 'Search {engine}',
  'newTabSearch.action.ask': 'Ask {name}',
  'newTabSearch.list': 'Actions and suggestions',
  'newTabSearch.choose.title': 'Search the web with',
  'newTabSearch.choose.hint': 'You can change this later in Settings › Search.',
  'newTabSearch.choose.keep': 'Keep {engine}',
  'newTabSearch.choose.label': 'Choose a search engine',
} as const

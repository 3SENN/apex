# Contributing to Atelier

Thanks for helping make Atelier better. This guide covers how to set up the project, what a good change looks like, and
how it gets merged.

## Before you start

- **Bugs:** search the [issues](https://github.com/3SENN/atelier/issues) first. If it is new, open one with the bug
  template: what you did, what you expected, what happened, your Atelier version and platform.
- **Features and bigger changes:** open an issue or a [discussion](https://github.com/3SENN/atelier/discussions) before
  writing code, so we can agree on the approach. Product behaviour is specified in [docs/design](docs/design/).
- **Questions and chat:** ask in [GitHub Discussions](https://github.com/3SENN/atelier/discussions) or on
  [Discord](https://discord.gg/sKUTVCYAZY).
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

## Setting up

Requirements: Node.js 22.12 or later (an even-numbered release) and npm. On Windows, the .NET 8 SDK if you work on
the speech helper. An Anthropic API key to try the companion; the tests don't need one.

```bash
git clone https://github.com/3SENN/atelier.git
cd atelier
npm install          # dependencies and Electron
npm run dev          # the app with hot reload
```

If `npm run dev` fails with `reading 'registerSchemesAsPrivileged'`, your shell has `ELECTRON_RUN_AS_NODE` set
(some editor terminals do). Run `unset ELECTRON_RUN_AS_NODE` and try again.

## Checks

Every pull request runs these on macOS, Windows and Linux. Run them locally first:

```bash
npm run typecheck    # TypeScript, main and renderer
npm test             # unit tests (Vitest)
npm run i18n:check   # every string in English and Dutch
npm run smoke        # builds the app and drives it end to end in real Electron (no API key, no network)
```

`npm run smoke` takes a while; `ATELIER_SMOKE_ONLY=<group>` runs one part of it (`BROWSER`, `VOICE-PASSWORDS`,
`FILES-CONNECTORS`, `AGENT-WORKSPACE`, `MAINTENANCE`, `TWEAKS`, `MEDIA`, `PRIVACY`, `TRANSLATE`, `READER`, `PACKS`,
`DECISIONS` or `LAYOUT`; several with commas). See
[docs/architecture.md](docs/architecture.md#testing) for what each suite covers.

## Finding your way around

| Folder | What lives there |
|---|---|
| `src/main/` | Electron's main process: windows and tabs, the agent and its tools, services, storage and security rules |
| `src/preload/` | The bridges: `ui.ts` for the browser's own interface, `page.ts` for the agent's view of each web page |
| `src/renderer/src/` | The interface (React): sidebar, toolbar, chats, the companion, settings and every built-in page |
| `src/shared/` | Contracts shared by both sides: IPC and service types, URL rules, i18n catalogues, branding |
| `src/kit/` | The kit that packs and apps use to build on Atelier |
| `src/stubs/` | Public stand-ins for optional parts that official builds add |
| `native/` | Small native helpers: speech, calendar, translation and haptics |
| `branding/` | The official and unofficial branding (names, icons, logo, default companion) |
| `scripts/` | Build, release, asset and smoke-test tooling |
| `tests/` | Unit tests (Vitest); end-to-end smoke checks live next to the code as `smoke*.ts` |
| `docs/` | Architecture, the design specs, and the guides for packs and apps |

A good first read is [docs/architecture.md](docs/architecture.md), then the spec for the area you want to work on in
[docs/design](docs/design/). The project's direction is in [ROADMAP.md](ROADMAP.md) and how decisions are made is in
[GOVERNANCE.md](GOVERNANCE.md).

## What a good change looks like

- **Small and focused.** One fix or feature per pull request, with a clear description of what changes for people
  using Atelier.
- **Tested.** Logic gets unit tests next to the existing ones in `tests/`; anything you can only see in the running
  app gets a smoke check.
- **Translated.** User-facing text goes through the i18n catalogues in `src/shared/i18n/` with an English and a Dutch
  string. No hard-coded strings in the UI.
- **The app's name is `{brand}`.** Never write "Atelier" in user-facing text: the same code ships as Atelier and as Summit
  (the unofficial branding every source build gets; see [README.md](README.md#official-builds-and-source-builds)).
  Catalogue strings say `{brand}`, and the i18n layer fills it in, so no call site passes it:
  `'updates.ready': '{brand} {version} is ready'`. Avoid an article right before it ("an {brand} page" reads wrong
  for Summit); "a built-in {brand} page" or "a page in {brand}" works for both. Text outside the catalogues uses
  `BRAND_NAME` from `src/shared/branding.ts`, and Markdown shipped with the app says `{brand}` and goes through
  `withBrand()`. `npm run i18n:check` refuses a written-out name. Run the tests with `ATELIER_OFFICIAL_BRANDING=0` and
  `=1` when a change touches names, icons or the default companion.
- **Light and dark.** Every surface works in both themes and at every window width. Colours come from the design
  tokens in `src/renderer/src/styles.css`, never hard-coded.
- **Safe by default.** The agent's guard, approvals and the page bridge are security boundaries. Changes there need a
  test that proves the boundary still holds.
- **Comments explain the code.** Say why something is the way it is. Spec ids such as `CH-22` or `DS-40` point to
  the requirement in [docs/design](docs/design/).

## Commits and pull requests

- Write commit messages in plain sentences that say what changed and why.
- Keep your branch up to date with `main`; we squash or rebase when merging.
- A maintainer reviews every pull request. Expect questions; they are about the change, not about you.

## Licence and copyright

Atelier's code is licensed under the [Mozilla Public License 2.0](LICENSE). By contributing code, you agree that your
contribution is licensed under the same licence (inbound = outbound), and you confirm you have the right to submit it.

New source files start with the standard notice:

```js
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
```

Other file types carry the same four lines in their own comment syntax: `#` in YAML and gyp files, `;` in the NSIS
script, and `<!-- … -->` in property lists and the .NET project. Add your name to [AUTHORS](AUTHORS) with your first
contribution.

The companion art is not MPL: the files listed in section 1 of the [Atelier Companion Art License](ART-LICENSE.md) (the
asset recipes in `scripts/companion-assets/` and what they generate in `src/renderer/public/companion/`, the
character images in `branding/official/`, and `scripts/app-icons/art.mjs`, `render-pip.mjs` and `pip/`). When you
contribute to the art, you do so under section 5 of that licence, and its source files carry its notice instead of
the MPL one:

```js
/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */
```

`tests/licenseHeaders.test.ts` checks that every source file carries the right one. The Atelier name, logo, sprout mark
and the six Atelier characters are trademarks, and neither licence grants trademark rights; see
[TRADEMARKS.md](TRADEMARKS.md).

You may share builds of your branch, with the companion art, so others can test or review your change for Atelier
(pull-request previews, testers, CI artifacts; [ART-LICENSE.md](ART-LICENSE.md), section 2.1). A build you
distribute as your own product is a fork: it uses a name and icons of its own and its own character designs in
place of the companion art (section 3.1).

## Code of conduct

Everyone taking part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

# Apex

**The browser you make your own.**

[![CI](https://github.com/3SENN/apex/actions/workflows/ci.yml/badge.svg)](https://github.com/3SENN/apex/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)

Apex is a Chromium-based browser (Electron) with a companion that works in your real tabs while you watch. It reads
pages, clicks, types, fills in forms, searches the web, remembers what matters to you, uses your connected tools and
runs routines on a schedule. Describe a skill, a routine or a small app and it builds it with you, and anything you make
can travel to someone else as a pack. It runs on Claude, asks before anything that matters, and is never allowed to enter
passwords or card details.

Apex runs on macOS, Windows and Linux.

## Download

Official builds are on the [releases page](https://github.com/3SENN/apex/releases) and at
[apexbrowser.eu](https://apexbrowser.eu). They update themselves.

## Features

- **A full browser.** Tabs and a sidebar, split view, link peek, bookmarks, history, downloads, find in page, reader
  mode, translation, ad and tracker blocking, permission prompts, Chrome Web Store extensions, passwords and passkeys,
  and import from Chrome, Arc, Brave, Edge, Vivaldi, Firefox and Safari.
- **A companion at work.** Anthropic's browser toolset in your real tabs, web search, persistent memory, MCP connectors,
  skills, scheduled routines, meetings with on-device transcription, and saved chat history. Anything consequential
  waits for your approval.
- **Make and share.** Apps built from a description, skills, routines, site tweaks and themes, all shareable as signed,
  sandboxed packs with a review before every install. The community index is
  [3SENN/apex-packs](https://github.com/3SENN/apex-packs); see [docs/packs.md](docs/packs.md) and
  [docs/apps.md](docs/apps.md).
- **Private by design.** Your data stays on your computer. There is no Apex account and no analytics; besides the sites
  you visit, Apex only contacts the services listed in [PRIVACY.md](PRIVACY.md), such as the model provider you choose,
  with your own key.

## Official builds and source builds

This repository holds the complete browser and agent under the [MPL-2.0](LICENSE), the companion art under the
[Apex Companion Art License](ART-LICENSE.md), and, like Firefox, two brandings:

- **Official branding** ([branding/official](branding/official/)): the Apex name, logo, sprout mark and icons, with Pip
  as the default companion and all six Apex characters. Only builds made and published by the Apex project use it.
- **Unofficial branding** ([branding/unofficial](branding/unofficial/)): the placeholder name **Summit**, a plain icon
  and logo, and a neutral default companion named Companion, with none of the Apex characters. Every build from source
  gets it, so you can build from source, change it and share your changes under the MPL-2.0 without touching the Apex
  trademarks ([TRADEMARKS.md](TRADEMARKS.md)). Builds shared so others can test or review changes for Apex
  (pull-request previews, testers, CI artifacts) are fine. A build you distribute as your own product, a fork, must
  use a name and icons of its own and its own character designs in place of the companion art
  ([ART-LICENSE.md](ART-LICENSE.md), section 3.1;
  [docs/companion-system.md](docs/companion-system.md#bring-your-own-designs)).

Neither licence grants trademark rights, and the trademark policy decides who may ship the official branding. Summit
works the same in every way, and keeps its own bundle id (`dev.summit.browser`) and profile folder, so it runs beside
an installed Apex. `APEX_OFFICIAL_BRANDING=1` or `0` picks a branding for any command; without it, builds are official
only in the maintainer's checkout (see [docs/architecture.md](docs/architecture.md#branding)).

## Building from source

Requirements: Node.js 22.12 or later (an even-numbered release) and npm. On Windows, the .NET 8 SDK for the speech
helper. To use the companion you need an Anthropic API key; the welcome flow asks for it and stores it encrypted in your
system keychain.

```bash
git clone https://github.com/3SENN/apex.git
cd apex
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Runs the browser with hot reload (as Summit, unless official branding is on) |
| `npm run typecheck` | TypeScript, main and renderer |
| `npm test` | Unit tests (Vitest) |
| `npm run smoke` | Builds the app and drives it end to end in real Electron, offline and without an API key |
| `npm run package` | Builds an unsigned installer into `dist/` (`Summit.app`, `Summit-Setup-….exe` and so on) |

If `npm run dev` fails with `reading 'registerSchemesAsPrivileged'`, your shell has `ELECTRON_RUN_AS_NODE` set (some
editor terminals do). Run `unset ELECTRON_RUN_AS_NODE` and try again.

Releasing, signing and notarization are described in [docs/release.md](docs/release.md). Credentials always come from
the environment; nothing personal is committed.

## Documentation

- [Architecture](docs/architecture.md): how Apex is put together, its security model and its tests
- [Design specs](docs/design/): the product and design specifications, and the ids used in code comments
- [Packs](docs/packs.md) and [apps](docs/apps.md): building and sharing add-ons
- [Quick decisions](docs/decisions.md): the small models Apex can use for fast choices
- [Privacy](PRIVACY.md): what Apex keeps on your computer and every service it can contact

## Contributing

Contributions are welcome: code, translations, docs, testing on your platform, and packs, apps and companions for
Apex. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Where Apex is heading is in [ROADMAP.md](ROADMAP.md), and how decisions are made is in [GOVERNANCE.md](GOVERNANCE.md).
Report security issues privately as described in [SECURITY.md](SECURITY.md).

## How Apex is funded

Apex is free, and its browser and agent are open source for good. The project is sustained by what only the Apex
project can offer: signed official builds with automatic updates, optional services and paid content in the packs
ecosystem. None of it depends on advertising or on collecting your data; see [PRIVACY.md](PRIVACY.md).

## License

- **Code:** the [Mozilla Public License 2.0](LICENSE).
- **Companion art** (the characters' parts, rigs, face layers and presets, their recipes, and the images of Apex
  characters in `branding/official/`): the [Apex Companion Art License](ART-LICENSE.md). Create and share characters
  for Apex, in packs, apps and worlds too, and share builds to test changes for Apex; don't use them outside Apex or
  in a fork you distribute.
- **Trademarks:** the Apex name, logo and sprout mark and the six Apex characters are trademarks of Senne Chin; see
  [TRADEMARKS.md](TRADEMARKS.md).

Third-party licences are listed in the app under Settings › About.

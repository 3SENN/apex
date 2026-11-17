# Unofficial branding: Summit

What every build from source gets unless official branding is switched on (`ATELIER_OFFICIAL_BRANDING=1`; see
[scripts/branding.mjs](../../scripts/branding.mjs) and
[docs/architecture.md › Branding](../../docs/architecture.md#branding)): the name **Summit**, a plain icon, a plain
logo (the name in the UI font beside the mark) and a neutral default companion named **Companion**. None of Atelier's six
characters (Pip, Juniper, Bolt, Mochi, Sage and Pepper) is offered. Summit's bundle id is `dev.summit.browser`, and it
keeps its own profile folder, so it runs beside an installed Atelier the way Firefox Nightly runs beside Firefox.

Like Firefox's unofficial branding, it exists so you can build from source, change it and share your changes without
using the Atelier name, logo, sprout mark and characters, which are trademarks; trademark rights are not granted by the
licences ([TRADEMARKS.md](../../TRADEMARKS.md)). These files are licensed under the
[Mozilla Public License 2.0](../../LICENSE) like the rest of the code, and you may change or replace them. Summit is a
placeholder name for source builds, not an Atelier trademark: if you publish a fork, ship it under a name and icons of
your own by changing them here.

Companion's look is assembled from the companion parts in `src/renderer/public/companion/`, which are Atelier Companion
Art ([ART-LICENSE.md](../../ART-LICENSE.md)): a build from source may use them, and so may builds shared so others can
test or review changes for Atelier (pull-request previews, testers, CI artifacts; section 2.1). A build you distribute as
your own product (a fork) brings character designs of its own in place of the companion art (section 3.1) and points
`companion.json` at them
([docs/companion-system.md › Bring your own designs](../../docs/companion-system.md#bring-your-own-designs)).

## What is here

The same files as [branding/official](../official/), so the packaging and the app take either folder:

| File | Used for |
| --- | --- |
| `branding.json` | The name, bundle id, publisher, copyright line, an empty trademark line (Summit claims no marks), the default companion (`companion`, from `companion.json`), the presets left out (all six of Atelier's characters) and the files below |
| `companion.json` | The default companion, a preset of its own: its name, tagline, personality, summary and look (part ids, face ids and four colours). Its English name, tagline and summary are the catalogues' `galleries.ownCompanion.*` text, so the app shows them translated |
| `icon.svg` | The one source every icon here is drawn from |
| `icon.icns`, `icon.ico`, `icon.png`, `icons/` | The app icons (no Icon Composer document: macOS 26 draws `icon.icns`) |
| `html-document.*`, `ateliercompanion.*`, `atelierpack.*` | Document icons |
| `dmg-background*.png`, `installerSidebar.bmp` | The macOS disk image window and the Windows installer pages |
| `resources/` | Packaged as `resources/`: the runtime app icon and the tray images |
| `renderer/` | The in-app mark and the standard icon, through the `@branding` alias |
| `svg/` | The icon and tray glyph as SVG, for review |

Edit `icon.svg` (a rect with id `tile` and the paths in the group with id `mark`), then run
`node scripts/app-icons/unofficial.mjs` to redraw every file; `--check` says whether they are current.

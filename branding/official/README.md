# Official branding: Apex

The name **Apex**, its logo and sprout mark, the app and document icons, the installer art and **Pip**, the
default companion (with all six Apex characters offered). Only builds made and published by the Apex project use this
folder: they are built with
`APEX_OFFICIAL_BRANDING=1` (see [scripts/branding.mjs](../../scripts/branding.mjs) and
[docs/architecture.md › Branding](../../docs/architecture.md#branding)).

## Licence

The files that depict an Apex character (the icons, the installer sidebar, the tray images and the rendered art; the
mark is Pip) are Apex Companion Art, under the [Apex Companion Art License](../../ART-LICENSE.md); the rest is under
the [Mozilla Public License 2.0](../../LICENSE). [LICENSE.md](LICENSE.md) lists which is which. All of it is
trademarked: the Apex name, logo, sprout mark and characters are trademarks of Senne Chin, neither licence grants
trademark rights, and their use is governed by the [trademark policy](../../TRADEMARKS.md). Builds you share,
including ones shared to test changes for Apex, use the [unofficial branding](../unofficial/) instead, which is what
a build from source gets by default; a build you distribute as your own product (a fork) also replaces the companion
art with character designs of its own ([ART-LICENSE.md](../../ART-LICENSE.md), section 3.1).

## What is here

| File | Used for |
| --- | --- |
| `branding.json` | The name, bundle id (`com.sennechin.apex`), publisher, copyright and trademark lines, default companion (`pip`, from presets.json) and the files below |
| `icon.icns`, `Apex.icon/` | The macOS app icon (`.icns` for macOS 13 to 15, the Icon Composer document for macOS 26) |
| `icon.ico`, `icon.png`, `icons/` | The Windows and Linux app icons |
| `html-document.*`, `apexcompanion.*`, `apexpack.*` | Document icons for the file types Apex opens |
| `dmg-background*.png`, `installerSidebar.bmp` | The macOS disk image window and the Windows installer pages |
| `resources/` | Packaged as `resources/`: the runtime app icon (About panel, dev Dock) and the tray images |
| `renderer/` | The in-app mark, the standard icon and the wordmark (`logo.svg`), through the `@branding` alias |
| `art/` | The rendered masters of Pip, Mochi and Bolt for the document icons (`scripts/app-icons/render-pip.mjs`) |
| `LICENSE.md` | Which files are Apex Companion Art and which are MPL-2.0 |
| `svg/` | The icons as SVG, for review |

Every image except `logo.svg` and `art/` is drawn by `node scripts/app-icons/generate.mjs --release-art`
(`npm run icons`), and `scripts/app-icons/manifest.json` records what each file holds.

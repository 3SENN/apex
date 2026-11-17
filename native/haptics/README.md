# Atelier haptics addon

A tiny Node-API addon that plays a trackpad haptic on macOS through AppKit's
`NSHapticFeedbackManager`. On every other platform, and whenever the binary is
missing or won't load, the JS loader hands back a stub with the same shape, so
callers never branch. Used for SH-41.

```js
const { loadHaptics } = require('./native/haptics')
const haptics = loadHaptics()           // or loadHaptics({ paths: [file] })
haptics.available                       // true when the addon loaded
haptics.reason                          // 'loaded' | 'unsupported-platform' | 'missing' | 'load-failed' | 'invalid-addon'
haptics.perform('alignment')            // true when handed to macOS, false for the stub
```

`perform` takes `alignment`, `levelChange` or `generic`, plus `level-change` as
the haptics service's spelling of `levelChange`. Anything else throws a
`TypeError`, from the stub as well as the real addon. If the native call
fails, `perform` returns false rather than throwing.

## Files

| File | What it is |
|---|---|
| `binding.gyp` | node-gyp target `atelier_haptics`: AppKit on macOS, a no-op source elsewhere; Node-API 8, macOS 13 floor (Electron 45's own) |
| `addon.cc` | the Node-API surface: `perform(pattern)`, which checks its argument |
| `haptics.h` | the platform seam (`atelier_haptics::Play`) |
| `haptics.mm` | macOS: `[[NSHapticFeedbackManager defaultPerformer] performFeedbackPattern:…]`, on the main thread |
| `haptics_noop.cc` | Windows and Linux: returns false |
| `index.js`, `index.d.ts` | the loader (`process.dlopen`, stub fallback) and its types |
| `package.json`, `package-lock.json` | build-only tools (node-gyp, node-addon-api), installed into this folder's `node_modules`, never the repo root |
| `test/*.test.js` | `node --test` checks, outside the main vitest suite |

## Build

```sh
node scripts/build-native.mjs                # universal: arm64 + x64, merged with lipo
node scripts/build-native.mjs --arch=host    # this Mac only (or --arch=arm64 / --arch=x64)
```

The script reads the Electron version from `node_modules/electron/package.json`.
It installs the build tools here on first run (`npm ci --ignore-scripts`), and
downloads the Electron headers into `.electron-gyp/`. It runs node-gyp once per
architecture, merges the slices into `build/atelier_haptics.node`, signs it ad hoc,
and loads it inside the installed Electron (as Node) to prove the ABI and the
architecture. On other platforms it prints a notice and exits 0. Rebuild after
every Electron upgrade.

## Test

```sh
node --test native/haptics/test/loader.test.js native/haptics/test/build-native.test.js
ATELIER_HAPTICS_LIVE=1 node --test native/haptics/test/loader.test.js   # also plays real patterns
```

The loader tests inject the platform, file checks and dlopen, so they run
anywhere. When a build with this Mac's architecture exists, they also load the
real addon and check its argument handling. They pass under Electron's runtime
too: `ELECTRON_RUN_AS_NODE=1 "$(node -p "require('electron')")" --test …`.

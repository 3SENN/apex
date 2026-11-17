# Packs

A pack is the one thing in Apex you can make, install, share and remix. It is
a folder with a manifest (`apex-pack.json`) that lists what it adds: skills,
routine templates, site tweaks, accent themes, companions, connectors, panels,
commands, page menu items and agent tools. Packs can be written by hand, built
by a companion in a chat, exported from what you already have (a skill, a
site tweak, an app, a companion), and passed around as a signed `.apexpack` file,
a link, or through a community index.

Chrome Web Store extensions stay what they are (`src/main/extensions/`).
Settings › Extensions shows both.

## Principles

1. **One format for everything shareable.** Skills, site tweaks, apps and companions
   keep their own export formats for compatibility, and each also offers
   Share as pack.
2. **Data first, code second.** Most packs need no code: skills, templates,
   CSS, themes and companions are data.
3. **The sandbox is the boundary, not trust.** Pack code runs in its own
   locked-down partition with no network, no device access and no Node. What
   it can reach is exactly what its manifest asks for, checked in main on
   every call. A model-written summary is a reading aid, never a gate.
4. **Companions author, people install.** A companion can write, test and
   propose a pack. Only a person installs one or grants a permission, from a
   card that lists every permission in plain words.
5. **Sharing needs no backend.** Files, links and a Git-hosted index. A hosted
   gallery (ratings, takedowns) is the one part that needs a backend and is
   out of scope.
6. **Apex uses the format itself.** The built-in skills are a first-party pack
   you can turn off, and an example pack ships for companions to learn from.

## Layout on disk

```
<userData>/packs/
  index.json            installed packs: enabled, source, hash, signature, dates
  installed/<id>/       each installed pack's files (read-only to the pack)
  dev/<id>/             drafts: companion-built, exported or remixed packs
  data/<id>.json        each pack's apex.storage (removed with the pack)
  logs/<id>.log         each pack's runtime log (JSON lines, capped)
  signatures/<id>.json  the author's signature an installed pack came with (passed on unchanged by Export)
  trusted-keys.json     author keys pinned on first install, by pack id
  author-key.json       your signing key (private half encrypted with safeStorage)
```

`index.json` also holds the community index addresses you added and when
updates were last checked. Settings › Your data counts the folder, and Reset
Apex clears it (your author key only with the secrets).

## The manifest

```json
{
  "format": "apex-pack",
  "manifestVersion": 1,
  "id": "price-tracker",
  "name": "Price tracker",
  "version": "1.2.0",
  "description": "Watches prices on shops you choose.",
  "author": { "name": "Senne" },
  "builtBy": "Pip",
  "homepage": "https://github.com/someone/price-tracker",
  "updateUrl": "https://github.com/someone/price-tracker/releases/latest/download/price-tracker.apexpack",
  "forkedFrom": { "id": "price-watch", "version": "1.0.0", "hash": "…" },
  "contributes": {
    "skills": ["skills/track-price"],
    "routines": [{ "id": "daily", "name": "Daily price check", "prompt": "/track-price Check my tracked prices.", "schedule": { "kind": "daily", "time": "09:00", "days": [] } }],
    "tweaks": [{ "id": "bol", "match": ["bol.com"], "subdomains": true, "css": "tweaks/bol.css", "js": "tweaks/bol.js" }],
    "themes": [{ "id": "mint", "name": "Mint", "accent": "#2bb39a" }],
    "companions": ["companions/scout.json"],
    "connectors": [{ "id": "docs", "name": "Docs search", "url": "https://mcp.example.com/mcp" }],
    "panels": [{ "id": "main", "title": "Tracked prices", "html": "panel/index.html", "sidebar": true, "icon": "icon.svg" }],
    "cards": [{ "id": "drops", "title": "Price drops", "module": "cards/drops.js", "open": "panel:main" }],
    "commands": [{ "id": "track", "title": "Track this price", "run": "skill:track-price" }],
    "menus": [{ "id": "track-sel", "title": "Track this price", "context": "selection", "run": "skill:track-price" }],
    "tools": [{ "name": "read_price", "description": "Reads the price on the open product page.", "inputSchema": { "type": "object", "properties": {} }, "module": "tools/read-price.js" }]
  },
  "permissions": { "sites": ["bol.com", "*.bol.com"], "network": [], "pageScripts": true, "notifications": true, "model": false, "clipboard": false }
}
```

Rules, all checked by `validatePack` (`src/main/packs/manifest.ts`):

- `id`: `^[a-z0-9][a-z0-9-]{1,31}$`. `version`: `major.minor.patch`.
- File paths are relative, `/`-separated, `[A-Za-z0-9._-]` segments, no `..`,
  nothing under the reserved `__apex/`. Every path the manifest names exists.
  Files inside an app's folder may also use spaces and `& ' ( ) + , ! @ [ ] ~ =`
  (assets are named that way), never `# % ?`, a leading or trailing space, a
  trailing dot or a Windows device name.
- Limits: 200 files, 2 MB per file, 10 MB per pack, 64 KB manifest, 50 of each
  contribution. Scripts, pages and SVG files together stay under 1 MB, so the
  review always shows all of them. No two paths may differ only by case. A pack
  with an app (manifest version 2, [apps.md](apps.md)) may hold 5,000 files, 50
  MB per file and 300 MB in all.
- `.js` and `.mjs` files must be readable: a line over 2,000 characters fails
  as minified. The files of a `bundled` app are the exception: they don't count
  toward the 1 MB either, and the review says it can't show them.
- A `run` is `skill:<name>` (one of the pack's own skills), `panel:<id>`,
  `app:<id>` or `tool:<name>` (the agent is asked to use it).
- Tweak `match` hosts, and every host a tool or panel reads, are in
  `permissions.sites`. A tweak with `js` needs `pageScripts`.
- `network` hosts are https hosts (`*.` allowed); `http` only for
  `localhost` and `127.0.0.1`. `"*"` is refused there.
- `sites` may be `["*"]`: every web site (never sign-in pages), shown as its
  own line. A tweak always names its sites.
- Only panels, apps, tools and cards may use `network`, `model`,
  `notifications` and `clipboard`; `pageScripts` needs a tweak with `js`.
- `secrets` (manifest version 2): keys the person enters, which Apex adds to
  requests to their hosts and the pack's code never reads; `env`: public values
  its pages read as `apex.env`. The rules are in [apps.md](apps.md) › Your own
  servers. No file in a pack may be a `.env` file, and a linked folder never
  reads `.env`, `.env.*` or `.npmrc` into one.
- Tool `name`: `^[a-z][a-z0-9_]{0,23}$`, and its `inputSchema` must compile as
  a JSON Schema. The agent sees it as `pk_<id>_<name>`; pack ids have no
  underscores and tool names no dashes, so two packs' tools never share a name.
- Unknown keys are refused (a newer manifest version is refused with a clear
  message).
- Compatibility: older packs list site tweaks as `contributes.boosts`; that
  key is still read, as `contributes.tweaks` (same shape, any file paths), and
  a manifest with both is refused. New packs, and Share as pack, write
  `tweaks`.

## Contributions

| Contribution | What happens while the pack is on |
|---|---|
| `skills` | Read-only skills with a From <pack> badge and their supporting files; Duplicate makes your own copy. A pack skill named like a built-in skill isn't used. |
| `routines` | Templates on the pack's page; Add routine creates a paused routine for the active companion. |
| `tweaks` | CSS (and scripts with `pageScripts`) on matching sites, like your own site tweaks; never on sign-in or apex:// pages, and never in private windows. Pack CSS loads nothing from elsewhere (`url()` and `image-set()` keep only `data:`, no `@import`), so it can't send what's on a page anywhere. Scripts stay off any site that has sign-in pages at all. |
| `themes` | Extra accents in Settings › Appearance. |
| `companions` | Add companion imports it (look, persona, instructions, its own skills with their steps and text files; never memory). Skills in the companion's file are that companion's alone; `skills` above go to every companion, so a companion that gives itself skills uses `draft_skill`, not a pack. |
| `connectors` | Add connector adds it (no token yet) and opens its page, for a token or sign-in; a local command still needs its first-start approval. |
| `panels` | Open in a tab at `apex-pack://<id>/<path>` in the pack's sandbox, or beside the page in front (split view). With `sidebar: true` it starts as a row in the sidebar's apps (under the destinations), which opens it beside the page; the person can make it an icon or take it out (feature-spec AP-01); `icon` is a .png or .svg up to 64 KB, drawn as an image. |
| `apps` | Full pages in a tab, for games and bigger tools ([apps.md](apps.md)): everything under the app's `root` is served with a wider CSP (workers, WebAssembly, its own frames, and only the network hosts the pack lists), and a `game` may go full screen and lock the pointer. Same partition as the pack's other code, so they share storage. An app's files stay on disk and are read when served. The command bar offers Open <app>; Workspace › Apps lists it with every other app; `sidebar: true` starts it as a row in the sidebar, which the person can change to an icon or take out. |
| `worlds` | World files (manifest version 2, [apps.md](apps.md) › Worlds): places to walk around in, with kit props, named places that open apps, and residents (guests, and open spots the person's own companions fill). They show in Apex's Worlds app; a pack that holds only worlds shares as `.apexworld`. |
| `cards` | Cards on the new tab page, under the ideas card. The card's module runs in the pack's sandbox (`export async function run()`, 10 s limit, kept 5 minutes) and returns a string or up to five lines of up to 160 characters; Apex draws the text itself, so no pack code runs in the new tab page. `open` runs on a click. |
| `commands` | Rows in the command bar's Packs group (not in private windows). |
| `menus` | Page menu items for the page, a selection or a link (on the pack's sites when it lists any, never in private windows); more than three go in a Packs submenu. |
| `tools` | Agent tools in new chats (not private ones), on both engines; a chat keeps the tools it started with. A result reaches the model inside `<pack_tool_result>`, marked as the pack's output to use as data. |

A skill or tool `run` starts a chat in the side panel: `skill:<name>` sends
`/name`, `tool:<name>` asks the companion to use that tool, and the page, the
selection or the link goes along as context. A pack's skill name another pack
already has is skipped and shown as a problem on the second pack.

### Companions in packs

A companion in a pack is made from Apex's companion art: its look is part ids,
face ids and colours from Apex's part library. The
[Apex Companion Art License](../ART-LICENSE.md) allows it: you may make
characters for Apex and share them in packs, `.apexcompanion` files, apps and
worlds, including packs you sell. A character of your own, with a name and
personality of your own, may be your brand's mascot inside Apex, for example
the companion that represents your pack. It can't be a mascot or logo outside
Apex, and Apex's own six characters (Pip, Juniper, Bolt, Mochi, Sage and
Pepper) are never another brand's mascot ([TRADEMARKS.md](../TRADEMARKS.md)).

## Permissions in plain words

`describePackPermissions` (`src/shared/packs.ts`) turns a manifest into the
lines the install card shows, each with a level:

- *info*: adds skills, themes, companions, routine templates, commands.
- *notice*: changes how listed sites look; shows notifications; copies to the clipboard;
  asks you for a key and says where it goes (`secrets`); runs a small web server
  on this computer (`server`).
- *warning*: reads pages on listed sites; runs scripts on listed sites; uses your
  model account (`model`); adds a connector; adds agent tools; runs a web server
  that phones and computers on your Wi-Fi can open (`server.lan`).
- *danger*: can read listed sites **and** send data to listed network hosts; a
  connector that runs a program on this Mac.

An update that adds a permission, a site, a network host, a key or a host a
key goes to, a tool or a page script (`permissionDiff`), or changes what its skills or tools tell the
assistant (a `prompts` line), is not applied until you approve the new lines.
The review also shows every skill's instructions and tool's description under
What it tells the assistant.

## The sandbox and the bridge

Each pack gets `persist:apex-pack-<id>`, served only from its own files at
`apex-pack://<id>/`:

- `apex-pack` is a privileged standard, secure scheme, so a pack's pages and
  tool modules import each other by relative path.
- CSP: `default-src 'none'`, scripts only from the pack's own files (no inline
  scripts or `on*` handlers, so nothing that isn't a reviewed `.js` file runs;
  `nosniff` keeps other files from running as scripts), styles from the pack
  and inline, images and fonts from the pack and `data:`, `connect-src 'self'`
  (its own files only), no frames, workers, objects or forms.
- http, https, ws and file are refused in the session, the webRequest lockdown
  allows only the pack's own address, and every permission and download is
  denied. (An app's pages may reach the hosts in `network` straight, and the
  session is opened for those hosts only: [apps.md](apps.md) › Your own
  servers.) The session's proxy is a dead end, WebRTC's IP policy is
  `disable_non_proxied_udp` and the page has no `RTCPeerConnection`, so
  sockets that never become a request (preconnect, STUN, TURN) get nowhere.
  Navigation, pop-ups and `mailto:` are blocked, and a sleeping pack tab is
  hardened again when it wakes. The agent never acts there. Pack partitions are
  never browsing sessions: no browsing layers, and the proxy setting never
  replaces their dead end.
- A session frame preload (`src/preload/pack.ts`) exposes `window.apex`. Every
  call is `ipcRenderer.invoke('apex-pack:bridge')`, checked in main: the sender
  must be a top frame on its own pack's address, the pack must be on, the op's
  arguments pass zod, and the op's permission must be granted.

`window.apex`:

| Call | Needs |
|---|---|
| `apex.pack` | – (id, name, version) |
| `apex.env.NAME` | – (the manifest's public `env`) |
| `apex.secrets.status()`, `request(id)` | the key in `secrets` (whether it has a value, never the value; `request` opens the pack's page at it) |
| `apex.storage.get/set/remove/keys` | – (JSON, 1 MB per pack, in `data/<id>.json`) |
| `apex.page.info()` | the page's host in `sites` (url and title, else null) |
| `apex.page.text()` | the page's host in `sites` (visible text, 100 KB cap) |
| `apex.page.query(selector)` | the page's host in `sites` (text of up to 50 matches) |
| `apex.fetch(url, init)` | the host in `network` (main fetches, no cookies, 5 MB, 20 s; a key in `secrets` for that host goes on, hop by hop) |
| `apex.notify({ title, body })` | `notifications` |
| `apex.ask(prompt, { system })` | `model` (a one-shot call on your chosen engine) |
| `apex.clipboard.write(text)` | `clipboard` |
| `apex.open(url)` | the host in `network` (an address can carry what a pack read; 5 a minute) |
| `apex.log(...values)` | – (the pack's log) |
| `apex.tools.serve(handler)` | – (the tool host only) |
| `apex.server.start/stop/status/onRequest/onConnection/onStop/broadcast/sockets` | `server` (an app's own pages; see [A web server of its own](#a-web-server-of-its-own)) |

"The page" is the web tab you last used in the panel's window, or the chat's
own tab for a tool (else the front window's tab). Pages in private windows are
never read. A read is refused while the page is still loading, and the script
reports the address it actually ran on, which is checked again, so a page that
moved on (a redirect, a click) is never read.

### Tools

A tool module exports `async function run(input, ctx)` and returns a string or
anything JSON can hold. Apex runs a pack's tools in one hidden window in the
pack's sandbox (`apex-pack://<id>/__apex/tool-host.html`, made by Apex), which
imports every tool module and serves calls through `apex.tools.serve`. A call
times out after 60 s; the host closes after 5 idle minutes. Results are
untrusted content to the model, capped like every client tool.

## A web server of its own

An app can run a small web server, so people build things other devices open:
phones as game controllers, a second screen, local multiplayer, a tool a
colleague opens on the same Wi-Fi. Apex runs it (`src/main/packs/localServer.ts`,
`localServers.ts`); the app's page only ever sees what passed Apex's checks.

The manifest asks for it in `permissions.server`: `{}` for this computer only,
`{ "lan": true }` for phones and computers on the same Wi-Fi too. It needs an
app. The review says "Can run a small web server on this computer" (a note) or
"Can run a small web server that phones and computers on your Wi-Fi can open"
(a warning); an update that adds `lan` asks again. An organisation's
`PackPermissionCeiling` can say `server: false` or `serverLan: false`.

| Call | What it does |
|---|---|
| `apex.server.start({ lan, root, token, maxConnections })` | Starts the server, or answers the running one: `{ running, url, lanUrl, port, qr, lan, token, connections }`. `qr` is an image data URL of `lanUrl` for the app's own UI. |
| `apex.server.stop()`, `status()` | Stops it; what runs now. |
| `apex.server.onRequest(async (req) => …)` | Requests no file answers: `req` is `{ method, path, query, headers, body, json }`; return text, `{ status, headers, body }` (a body that isn't text goes as JSON) or any value as JSON. |
| `apex.server.onConnection((socket) => …)` | A served page opened a socket: `socket.id`, `socket.query`, `socket.remote` (`local` or `lan`), `socket.send(data)`, `socket.close(code)`, `socket.onMessage((value, text) => …)`, `socket.onClose((code) => …)`. |
| `apex.server.broadcast(data)`, `sockets()` | Sends to every socket; the sockets open now. |
| `apex.server.onStop((reason) => …)` | `stopped` (its own `stop()`), `person` (Stop on Apex's bar), `idle`, `closed` (the page or pack went away). |

Messages are text; `send` and `broadcast` send objects as JSON, and handlers
get the value parsed when it is JSON and the text as it came. Events reach the
page on the pack event channel in batches (`server.batch`, in order: requests,
new and closed sockets at once, messages within 8 ms), so a phone streaming
motion at 60 Hz doesn't flood IPC.

What the server serves, under `/<token>/` (or `/` with `token: false`):

- the pack's folder `root` as it is: a folder gets its `index.html`, nothing is
  listed, nothing outside the folder is reached, types as the pack sandbox
  serves them;
- `__apex/socket`: the WebSocket to the app's page;
- `__apex/client.js`: a helper for served pages:
  `apexServer.connect({ query })` gives `send`, `onOpen`, `onMessage`,
  `onClose` and `close`, and reconnects by itself;
- `__apex/kit/…`: Apex UI and the kit, so served pages can look like Apex;
- everything else goes to `onRequest` (404 without a handler).

Security:

- It binds 127.0.0.1 (plain HTTP) unless the manifest has `lan` and the call
  asks for it; then every interface, over HTTPS with Apex's own self-signed
  certificate (RSA 2048, SHA-256, a year, naming this computer's LAN addresses;
  made once per install in Apex's data folder, `local-server/`, and remade only
  near its end or for a new address, keeping the addresses before it). Phones
  give motion sensors only to secure pages; a phone accepts the certificate once.
- Peers must be this computer (or, on the Wi-Fi, private networks: 10/8,
  172.16/12, 192.168/16, link-local, IPv6 unique and link-local). A request
  must name this server in its Host header (no DNS rebinding), and a socket's
  or a request's Origin must be the server's own page (or none: a program, not
  a web page), so another site's page can't make the app act.
- By default the path carries an unguessable token (128 bits): kept per app
  while Apex runs, so phones reconnect after the app reloads; new when Apex
  starts, and thrown away when the person presses Stop.
- Limits: 16 sockets (up to 32); 16 KB a message in, 64 KB out; 120 messages a
  second per socket (a flood is dropped, then closed); text only; 60 requests a
  second; request bodies of 64 KB (text, JSON or forms); answers of 2 MB within
  10 s; 32 waiting requests. Only `accept`, `accept-language`, `content-type` and
  `user-agent` reach the page; answers may set `content-type`, `cache-control`,
  `content-language`, `content-disposition`, `etag`, `last-modified`, `x-*` and a
  `location` on the same server; Apex adds `nosniff`, `no-referrer`,
  same-origin resource policy and `frame-ancestors 'self'`, and no CORS, so
  other pages can't read the answers.
- It lives as long as the page that started it: closing, reloading or leaving
  the page stops it, so does turning the pack off (or an update without the
  permission), the app's `stop()`, the person's Stop, and 15 minutes with no
  request and no socket. Its tab never sleeps while it runs. The port is kept
  per app, so a phone's bookmark keeps working.
- Apex's own bar sits over the app's tab while it runs (trusted UI the app
  can't draw over): "‹App› is sharing on your Wi-Fi" (or "runs a web server on
  this computer"), how many are connected, and Stop. The first time on the
  Wi-Fi on a Mac it adds that macOS will ask whether Apex may accept incoming
  connections (choose Allow).
- In `test_pack` a server runs on this computer only, with the token and at
  most 4 sockets.

The `phone-controller` starter builds on it: the app shows the QR code and each
phone's tilt and buttons; the pack's `phone/` page joins with a name, turns on
motion (an iPhone asks on a tap), sends motion, A, B, Home and a pointer pad,
buzzes when the app asks (Android vibrates; an iPhone taps), keeps the screen
awake, and speaks English or Dutch by the phone's language.

## Logs

Bridge denials, tool calls (name, time, ok or error), console errors from
panels and the tool host, and `apex.log` lines go to `logs/<id>.log` (last 500
lines). The pack's page shows them, and `test_pack` returns a test run's lines.
A tool host that doesn't start reports the page's last console error.

## Companions as builders

Client tools (group `packs`, both engines, not in private chats or routines;
the experiment `pack-builder`, on by default, turns them off) that only
Creator chats have: chats started from New pack, New app, Edit or Remix, or a
chat whose companion called `creator_mode` when the person asked it to make
something ([apps.md](apps.md) › Creator mode). Every other chat carries only
that one small tool. Their descriptions stay short; `create_pack`'s result
carries the full format guide:

- `create_pack(id, name, description)`: a draft in `dev/<id>/` with a minimal
  manifest (or, for the id of an installed pack of yours, its files one patch
  version up; someone else's id is refused with a `-remix` id to use instead).
  The companion then writes files with `write_pack_file`. A draft's manifest id
  must match its folder.
- `write_pack_file(id, path, content)` and `read_pack_file(id, path)`: files in
  a draft only; never in an installed pack.
- `test_pack(id, tests?)`: validates the draft, lists the permission lines,
  loads each panel off-screen and reports its console errors, and runs tool
  calls (`{ tool, input, url? }`) in a throwaway in-memory sandbox
  (`apex-pack-test-<id>`, cleared after each run: storage isn't kept and is
  capped like a pack's, notifications and new tabs are skipped). A test never
  gets more than you granted: `apex.fetch` reaches only this computer and hosts
  an installed version of the same pack may already reach, and `apex.ask`
  returns a stand-in answer unless the installed version may ask the model. A
  `url` (http or https) opens in a background tab of a normal window, in a fresh
  partition with no cookies or sign-ins, so a draft never reads your signed-in
  pages. Returns problems, results and the run's log lines.
- `propose_pack(id, note)`: a card in the chat with the permission lines and
  Review and install.
- `list_packs()`: installed packs and drafts, with versions and errors.

A companion can't install, enable or grant anything, and pack tools can't call
these. Remix copies an installed pack into `dev/` and opens a chat that edits
it: your own pack keeps its id and goes up a patch version; anyone else's
becomes `<id>-remix` with `forkedFrom` filled and no author or update address.
A draft installs signed with your author key. Drafts also have Continue with a
companion, Export, Show in Finder and Delete.

## Sharing

- **File:** Export makes `<id>-<version>.apexpack` (`.apexapp` for a pack with an app), a zip with the pack's files
  and `__apex/signature.json`. The pack hash is SHA-256 over the sorted
  `path NUL sha256(file)` lines. The signature is Ed25519 over the hash with your
  author key, created on first export. Before export, a check refuses files that
  look like secrets (API keys, tokens, private keys).
- **Trust on first use:** the first install pins the pack id to its author
  key's full SHA-256 fingerprint (the 16-character id is only for people to
  read); a later install or update signed by another key is refused. Unsigned
  packs install with a warning and are pinned to "unsigned". Export passes on
  someone else's signature unchanged, or exports their pack unsigned when it's
  missing; it never signs their pack as yours.
- **Archives** are unzipped as a stream, a slice at a time, counting the bytes
  actually inflated, so a zip that lies about its sizes stops at the limit.
  Links in a pack folder are skipped, never followed.
- **Link:** `apex://packs?install=<https url>` or Install from a link downloads
  an `.apexpack` (about 301 MB cap, five redirects; a pack without an app is still held to 10 MB when it is unzipped) and shows the same review.
- **Finder:** double-clicking an `.apexpack` (or, on Windows and Linux, passing
  one on the command line) opens its review on `apex://packs?opened=<token>`.
- **Updates:** a pack with `updateUrl` is checked when you press Check for
  updates (and once a day while Apex runs). A newer version that widens
  permissions waits for approval.
- **The Apex community index** (github.com/3SENN/apex-packs) comes with Apex:
  added once on first run, removable under Browse › Sources. It holds signed starter packs
  with their readable sources, pins each pack's author key in `keys.json`, and
  checks every pull request (signatures and pins, hashes, Apex's file rules,
  sources matching the packs).
- **Packs made outside Apex:** `node scripts/packs/pack.mjs <folder>
  <out.apexpack> --key <key.pem>` builds and signs one with the same hash and
  signature Apex checks; `--new-key <key.pem>` makes an Ed25519 key. The
  community index's maintainer key lives outside every repository.
- **The file type:** `.apexpack` files have their own icon, a group picture of
  Mochi, Pip and Bolt under confetti (`scripts/app-icons/art.mjs`
  `packDocument`, from masters the app's companion renderer draws; Summit's is
  a plain one), registered on macOS, Windows (the installer) and Linux.
- **Community index:** an https JSON file (`{ "format": "apex-pack-index",
  "packs": [{ "id", "name", "description", "version", "url", "sha256",
  "author", "kind", "image", "category", "size", "color" }], "withdrawn":
  [{ "id", "reason" }] }`; everything after `author` is optional, and an entry
  without `kind` is a pack). Add an index address on the Packs page; its packs
  show under Browse. A downloaded file must match the listed `sha256`. To
  publish one, put the `.apexpack`, `.apexapp` and `.apexworld` files in a
  folder (with the `.png` Share… saves beside each, for its picture), run
  `node scripts/packs/make-index.mjs <folder> <https base url> [name]`, and host
  the folder (a public GitHub repository works: people add packs by pull
  request). An app too big for the repository goes up as a release asset:
  `node scripts/packs/pack.mjs <folder> <out> --key <key> --entry <its https
  address>` prints the entry to add. [apps.md](apps.md) › The community index
  has the rest: Browse, pictures, withdrawn ids.

## Where packs show up

- `apex://packs`: Your packs (a card per pack that says what it is, filtered
  by type; a card opens the pack's sheet) with the packs being built above
  them, and Browse (its indexes under Sources); Add (from a file, a link or a
  folder you're building) and New pack (a companion builds it). Addresses:
  `?pack=<id>`, `?draft=<id>&review=1`, `?tab=browse`, `?install=<url>`,
  `?opened=<token>`.
- The Packs page has front doors ([AP-02](design/feature-spec.md#ap-02)): a sidebar destination
  (in More until shown), Packs in the main menu's tools, Packs… and Get apps
  and packs… in the menu bar's Extensions menu, Manage packs in Workspace ›
  Apps, and Settings › Extensions and packs.
- The command bar offers the Packs page and each pack's commands.
- Workspace › Apps lists the apps and panels packs bring with every other
  app; the sidebar shows the ones the person keeps there (as rows or icons),
  starting with those whose manifest says `sidebar: true`; the new tab page
  shows up to four pack cards.
- Settings › Extensions and packs has the Packs section first, then the Web Store extensions.
- Settings › Appearance lists enabled packs' accents; Settings › Notifications
  has a Packs switch; the usage meter counts `apex.ask` under Packs.
- Skills shows pack skills under From packs, read-only with a From <pack> badge.
- Share as pack is on a skill's menu and editor, a site tweak's editor, an app's
  menu and a companion's menu in Settings › Companions.
- A companion's `propose_pack` card opens the review.

## First-party packs

- `apex-builtin-skills`: the built-in skills. Turning it off hides them.
- `apex-example-reading-time`: a skill, a sidebar panel, a new tab card, a
  command, a page menu item and a tool that read a Wikipedia article's length.
  Off by default; the build guide points companions at it, and Remix copies it.

## Out of scope

- A hosted gallery with ratings, install counts and takedowns: needs a backend.
- npm packages, TypeScript or Python in packs: pack code is plain JavaScript
  modules. Heavy work goes through server-side code execution or a local MCP
  server.
- Custom 3D companion parts in packs: companions in packs use Apex's part
  library.

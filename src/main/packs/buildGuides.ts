/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build guide in parts (docs/apps.md › Creator mode): apex_inspect({ guide })
// returns one focused recipe at a time, so a chat that builds an app pays
// for the parts it needs and a chat that doesn't pays nothing. This is the
// harness's progressive disclosure: a short core in create_pack's result,
// references loaded on demand. Each stays well under the size at which
// tool results are trimmed; a test checks.

import { BRAND_NAME } from '@shared/branding'
import { PACK_DESIGN_NOTES } from '@shared/appDesign'

export const GUIDE_TOPICS = ['apps', 'design', 'kit', 'cast', 'ai', 'servers', 'local-server', 'worlds', 'services', 'files', 'assets', 'notifications', 'sharing'] as const
export type GuideTopic = (typeof GUIDE_TOPICS)[number]

/** The largest a part may be: under the point where a long tool result is cut. */
export const GUIDE_MAX_CHARS = 3_500

export const BUILD_GUIDES: Record<GuideTopic, string> = {
  apps: `APPS (manifestVersion 2)
contributes.apps: [{ id, name, root (folder, default "app"), entry (page in root, default "index.html"), build: "kit" | "bundled", kind: "game" | "tool", icon?, sidebar?: true, kit?: 1, cast?: { min, max }, assets?: [slots], isolated?: true, eval?: true }]
- Start from a starter: create_pack({ id, name, description, starter: "game-3d" | "game-2d" | "tool" | "story" | "phone-controller" | "sorter" }). Read app/main.js, change it, keep the test hook.
- "kit": readable modules, no build step; with kit: 1 the page gets an import map (see guide "kit"). "bundled": any build tool's output (minified is fine; the review says it can't show it).
- Everything under root gets the app sandbox: module scripts, workers, WebAssembly, its own iframes, inline <script> in its own HTML (allowed by hash; scripts injected later are blocked). It reaches only the hosts in permissions.network (see the servers part); no Node; it can't navigate away.
- Addresses work like a static host: in a pack with one app, /assets/x.js is the app's; about serves about.html, blog/ serves blog/index.html; a page address the app lacks serves the entry (client routes).
- kind "game" may go full screen and lock the pointer. isolated: true gives SharedArrayBuffer (threaded WebAssembly). eval: true allows eval/new Function (shown on the review).
- apex.status.set({ text, badge, progress }) shows on the app's sidebar row; apex.status.clear().
- Test hook: call apex.test?.ready(state) with what matters (score, position, step); every frame is fine.
- Verify before proposing: test_pack({ id, playtest: { steps: [{ capture: "start" }, { key: "ArrowRight", holdMs: 500 }, { click: [x, y] }, { type: "text" }, { wait: ms }, { capture: "after" }] } }). Look at the frames you get back, read errors, frames (frame times) and state. Fix, play again, then propose_pack.
- Files in root may have spaces and & ' ( ) + , ! @ [ ] ~ = in their names. Limits for a pack with an app: 5,000 files, 50 MB each, 300 MB.`,

  design: PACK_DESIGN_NOTES,

  kit: `THE APEX KIT (kit: 1 on the app)
Import map names: "three" (0.186.1), "three/addons/…" (loaders/GLTFLoader.js, libs/meshopt_decoder.module.js, utils/BufferGeometryUtils.js, utils/SkeletonUtils.js, controls/OrbitControls.js), "apex-kit/…".
- import { character } from 'apex-kit/character.js'
  const pip = await character(member.look, { mood: 'idle' })  // a three.js Group in pip.object3d
  scene.add(pip.object3d); each frame pip.update(dt); pip.setMood('happy' | 'sad' | 'talking' | 'thinking' | 'working' | 'listening' | 'sleeping' | 'approval' | 'idle'); pip.blink() every few seconds; pip.move('walk' | 'run' | null, speed) while you move pip.object3d (speed in units a second keeps the steps with the ground; call it when the gait changes, turn object3d to face the way it goes, null stands still); pip.bounds = { min: [x,y,z], max: [x,y,z] }; pip.dispose().
  Scale: +Y up, 1 unit ≈ the height of the round rig's body. Light it with a HemisphereLight plus a DirectionalLight; MeshToonMaterial matches the companions' look.
- import { guide } from 'apex-kit/guide.js'
  const g = await guide({ corner: 'bottom-right', size: 160 }); g.say('Nice!', { mood: 'happy' }); g.quiet(); g.show(false); g.dispose(). Needs cast on the app.
- import { prop, PROPS, PALETTES } from 'apex-kit/props.js'
  const bench = prop('bench', { palette: 'meadow', tint: { accent: '#ff8a5c' } })  // a Group standing on y = 0; PROPS lists ids, names and footprints
- import { createWorldView, SKIES } from 'apex-kit/world.js'
  const view = createWorldView(worldFile); scene.add(view.root, view.lights); scene.background = view.sky; view.ground is the mesh to raycast; view.rebuild(changed); view.dispose().
- Not in kit 1 yet: Phaser, Preact, Rapier, walk/run/jump clips. Use plain canvas or DOM for 2D, or bundle a library yourself in a "bundled" app.
- ${BRAND_NAME} UI, the browser's look for apps: /__apex/kit/1/apex-kit/ui.css (tokens, Inter, ax-* components; see guide "design").
- Kit files are served at /__apex/kit/1/ in the app's own origin; companion art is under /__apex/kit/1/companion/.`,

  cast: `THE CAST (the person's companions as characters)
On the app: cast: { min: 1, max: 2 }. Review line: "Uses your companions as characters (names and looks)".
- const members = await apex.cast.members()  // [{ ref, name, rig, look }]: the active companion until the person picks
- const picked = await apex.cast.pick({ max: 2 })  // ${BRAND_NAME} asks the person who plays
- Draw a member with apex-kit/character.js (character(member.look)). Send member.look to other players if the app is online; it is only part ids and colours.
- A line in character: permissions.model and permissions.speak: true, then await apex.cast.speak(member.ref, { situation: 'lost a long rally 9-11', mood: 'disappointed' }). ${BRAND_NAME} writes the line from the companion's personality; the app never sees the personality, memory or instructions.
- ref is opaque and different in every app; never store or show it as a name.
- In test_pack, members() is [] and speak returns a stand-in: handle an empty cast (draw a stand-in shape).`,

  ai: `APEX AS THE AI ENGINE (permissions.model)
Calls run on the person's engine (their API key, or another engine they set up); the app ships no key. Ask for a tier, never a model: "fast" or "smart".
- const text = await apex.ai.ask(prompt, { system, tier: 'fast', maxTokens })
- const value = await apex.ai.json(prompt, { schema: { type: 'object', properties: { … }, required: [ … ] } })  // checked against the schema, asked again once
- For a yes or no, a pick from options or a rating, use apex.ai.decide instead: no text, just probabilities, and on a decision model it answers in about 0.1 s.
  const { answers, source } = await apex.ai.decide(text, { spam: { type: 'noul', instructions: 'Is this message spam?' }, topic: { type: 'choice', instructions: 'What is it about?', criteria: { billing: 'Payments', bug: 'Something broken', other: null } }, mood: { type: 'score', instructions: 'How upset is the writer?', criteria: ['Calm', 'Annoyed', 'Angry'] } })
  answers.spam.noul is the probability of yes; answers.topic.choice with answers.topic.probabilities; answers.mood.score (a level, may be fractional) with probabilities. Act only when sure (noul ≥ 0.7 or ≤ 0.3, the chosen option ≥ 0.75); otherwise ask the person. source is "model" (a decision model) or "claude" (the person's Claude engine, less calibrated: be stricter).
- const all = await apex.ai.stream(prompt, { onText: (piece) => out.textContent += piece })  // pieces as they arrive with an API key; one piece on other engines
- const s = apex.ai.session({ system, tier: 'smart', tools: [{ name: 'roll_dice', description: 'Rolls a die.', input: { type: 'object', properties: {} }, run: (input) => 4 }] }); const reply = await s.send('I open the door'); s.history(); s.close()  // up to 8 tool rounds a message, on either engine
- Budget: 60 model calls an hour and 500 a day per pack (apex.ask, apex.ai and each session round). apex.ai.decide on the person's decision model has its own budget (600 an hour, 5,000 a day); on Claude it counts as a model call. Show a friendly message when a call is refused.
- Treat model output as data: render it as text, never as HTML or code.
- In test_pack, model calls return stand-ins unless the installed version may already use the model.`,

  servers: `YOUR OWN SERVERS, KEYS AND SETTINGS (manifestVersion 2)
- An app's pages connect straight to the hosts in permissions.network: fetch, WebSocket, EventSource, <img>, <audio> (https and wss; http and ws on localhost). Normal CORS: the page's origin is apex-pack://<pack id>, so the server allows that origin (or *). Scripts, styles and frames still come only from the pack; no WebRTC. Panels and tools use apex.fetch(url, init) instead (from main: no CORS, no cookies, text up to the fetch limit).
- A pack's files are public: never put a key in one (export refuses known key formats and .env files). Keep your own keys on your server and let the app talk to it.
- A key the person brings (their API key, their account's token) goes in secrets: [{ id: "ACME_KEY", name: "Acme API key", description: "From acme.com › Settings › API", hosts: ["api.acme.com"], header: "Authorization", prefix: "Bearer " }]. Every host must be in network or optionalPermissions.network. The person enters it on the pack's page; ${BRAND_NAME} keeps it in the keychain and puts it in that header on every request to those hosts (fetch, WebSocket handshake, images, apex.fetch), and on none to any other. The code never reads it.
- const { ACME_KEY } = await apex.secrets.status() → true or false. Without one: const { set } = await apex.secrets.request('ACME_KEY') opens the pack's page at that key and resolves once it's saved. Then just call the API without the header; ${BRAND_NAME} adds it.
- env: { "SERVER_URL": "https://api.myapp.com" } holds public values; pages read apex.env.SERVER_URL. Nothing secret goes there (it's checked).
- An account the person signs in with (OAuth 2 or OpenID Connect: a company's Entra ID, Okta, Google, Keycloak) goes in auth: [{ id: "corp", name: "Contoso account", issuer: "https://login.contoso.com", clientId: "<a public client>", scopes: ["openid", "email", "api.read"], hosts: ["api.contoso.com"] }]. The client allows the redirect http://127.0.0.1/callback on any port, with PKCE and no secret. const { corp } = await apex.auth.status() → { signedIn, user }; await apex.auth.signIn('corp') opens the provider in a tab and resolves once signed in; apex.auth.signOut('corp'). ${BRAND_NAME} sends Authorization: Bearer <token> on requests to those hosts and refreshes it; the code never sees a token. A host can't get both a sign-in and a secret in Authorization. An organisation can set its own issuer, clientId and scopes for the pack.
- Developing from a folder (Load a folder…): its .env and .env.local fill env values and secrets with the same names (only those; other lines are never read), and the app may reach localhost and 127.0.0.1 without listing them. Neither file is read into the pack.
- The person's connectors (Jira, GitHub, Notion…: what they connected in ${BRAND_NAME}): permissions.connectors: ["atlassian", "github"] (directory ids, or a server's name). const { atlassian } = await apex.connectors.status() → { connected, name }; await apex.connectors.tools('atlassian') lists the tools they have on; const { text, data, isError } = await apex.connectors.call('atlassian', 'search', { query }) runs one, as they set it (off refuses; "ask" asks them each time, so call write tools from a click). Not connected: apex.connectors.connect('atlassian') opens Connectors at it.
- In test_pack, apps reach localhost and hosts the installed version may already reach, with no keys, sign-ins or connectors.`,

  'local-server': `A WEB SERVER OF THE APP'S OWN (permissions.server: {} for this computer, { "lan": true } for phones and computers on the same Wi-Fi)
For phones as controllers, a second screen, local multiplayer, a tool other devices open. ${BRAND_NAME} runs the server; it lives as long as the app's page that started it (closing, reloading or leaving the page stops it, so does Stop on ${BRAND_NAME}'s bar over the app, and 15 minutes with nobody using it).
- const s = await apex.server.start({ lan: true, root: 'phone', token: true, maxConnections: 16 })  // { url, lanUrl, port, qr, token, connections }. Show s.qr (an image data URL of lanUrl) in an <img> and lanUrl as text. Without lan: http://127.0.0.1 only. On the Wi-Fi: https with ${BRAND_NAME}'s own certificate (phones warn once; say "choose to go on"), which phones need for motion sensors. The address carries an unguessable token (token: false drops it); it stays the same while ${BRAND_NAME} runs, so phones reconnect after the app reloads.
- root: a folder of the pack served as it is (index.html for folders, no listing, nothing outside it). Served pages may load __apex/client.js and __apex/kit/1/apex-kit/ui.css (${BRAND_NAME} UI), with relative addresses.
- Sockets: in a served page, <script src="__apex/client.js"></script> then const link = apexServer.connect({ query: { name } }); link.send({ t: 'tap' }); link.onMessage((value, text) => …); link.onOpen(fn); link.onClose(fn). It reconnects by itself. In the app: apex.server.onConnection((socket) => { socket.id; socket.query.name; socket.onMessage((value, text) => …); socket.onClose((code) => …); socket.send({ t: 'buzz' }) }); apex.server.broadcast(data); apex.server.sockets(). Text only (objects go as JSON): 16 KB a message in, 64 KB out, 120 a second per socket (60 Hz motion fits).
- Requests no file answers: apex.server.onRequest(async (req) => …) gets { method, path, query, headers, body, json } and returns text, { status, headers, body } (a non-text body goes as JSON) or a value sent as JSON; 10 seconds, 64 KB in, 2 MB out.
- apex.server.onStop((reason) => …): 'stopped', 'person' (Stop on ${BRAND_NAME}'s bar), 'idle' or 'closed'. apex.server.status(); apex.server.stop().
- Only this computer and private networks get in; other pages can't read its answers or open its sockets. On a Mac, macOS asks once whether ${BRAND_NAME} may accept incoming connections: tell people to choose Allow.
- In test_pack the server runs on this computer only (lan is refused): start with lan, and on an error start without it. The phone-controller starter does all of this.`,

  worlds: `WORLDS (manifestVersion 2): places to walk around in, as a pack's contributes.worlds: ["worlds/town.json"]
- The file: { "format": "apex-world", "version": 1, "id", "name", "description"?, "palette": meadow|seaside|city|snow|dusk, "sky": morning|midday|late-afternoon|dusk|night, "size": [width, depth] (8 to 128 tiles), "ground": { "base", "paint": [{ "type", "area": [x0, z0, x1, z1] }] }, "props": [{ "kit", "at": [x, 0, z], "turn"?, "tint"?: { "accent" } }], "places": [{ "id", "name", "area", "opens"?: { "pack", "app" } }], "residents": [...], "spawn"?: [x, z], "camera"?: { "at", "lookAt" } }.
- Ground: grass, path, sand, boards, stone, floor, water (not walkable), snow; the last paint covering a tile wins. Areas include both corners.
- Props: tree, pine, bush, flowers, rock, bench (2×1), table, chair, lamp, fence (2×1), house (3×3), shop (3×3), stall (2×1), counter (2×1), table-tennis-table (2×1), fountain (2×2), sign, crate, barrel, umbrella. One unit is a tile, about a companion's height; "at" is the prop's middle (x + 0.5 centres it on a tile).
- Residents: a guest { "id", "home"?, "at"?, "role"?, "guest": { "name", "look", "personality"? } } carries a companion look (rig, parts, face, colors) and a short personality, never memory or instructions; an open spot { "id", "home"?, "at"?, "role"?, "companion": "local" } is filled with one of the visitor's own companions. 32 residents at most.
- A place with "opens" launches that app (any pack's; a missing one is offered to get). In the app, apex.world.context() gives { world, place, cast }: the visitor's companion first, then the residents there; guests speak through apex.cast.speak(ref) like companions.
- ${BRAND_NAME}'s own Worlds app shows and edits worlds; you write the file. test_pack checks every world file (sizes, areas inside the world, homes, looks).`,

  services: `PACKS WORKING TOGETHER (manifestVersion 2)
- provides: [{ service: "story-library", description, methods: { list: { description, input: { type: "object" } } }, module?: "svc/library.js", agent?: true }]
  The module exports one async function per method: export async function list(input, ctx) { … } (ctx.from is the calling pack, or "companion"). Or an open page serves it: apex.services.provide('story-library', { list: async (input) => … }) — an open page wins over the module.
- uses: ["story-library"] — the pack waits (its page says why) until a pack that is on provides it; then apex.services.call('story-library', 'list', { … }). Inputs are checked against the method's schema; answers must be JSON (1 MB).
- agent: true offers the service to the person's companions through use_app (shown on the review).
- events: { emits: ["chapter-done"], on: ["other-pack/achievement", "apex.theme"] } — apex.events.emit('chapter-done', data); apex.events.on('other-pack/achievement', (data) => …). Listening only, 50 events a second, 64 KB each.
- requires: { packs: { "other-pack": ">=1.2.0" } } — waits until that pack (at that version or newer) is on.
- Service names ${BRAND_NAME} keeps for itself (ai, cast, files, …) can't be provided.`,

  files: `FILES (permissions.files: true)
- const files = await apex.files.open({ accept: ['.txt', '.md'], multiple: true })  // [{ name, size, data: Uint8Array }], 50 MB each
- await apex.files.save('story.md', textOrBytes)  // the person picks where; { saved, name }
- await apex.files.folder()  // asks once for a folder; then apex.files.list('chapters'), apex.files.read('chapters/one.md') (Uint8Array), apex.files.write('chapters/one.md', text). Paths stay inside the folder; the person can take it back.
- await apex.files.own({ folder: true, note: 'Choose the data folder from your copy of the game' })  // copies the person's own files into the app's private space: { files: [paths] }; read them at apex.files.ownUrl(path). They never leave this computer and are never part of the pack (for data the author can't ship).
- Decode text with new TextDecoder().decode(data).`,

  assets: `ASSET SLOTS AND ASSET PACKS
On the app: assets: [{ id: "art", name: "Art", description: "Sprites and signs.", layout: "app/art" }] (slot ids unique in the pack; layout is the app's own folder for that slot).
- Read slot files at apex.assets.url('art', 'sign.png') (works in src attributes): the chosen asset pack's file, else the app's own layout/sign.png. apex.assets.active('art') → { pack, packName, set, setName } or null.
- The person picks a pack on the app's page under Look and sound; the app reloads.
An asset pack: contributes.assets: [{ id: "winter", name: "Winter", for: { pack: "<app pack id>", app: "main", slot: "art" }, root: "winter" }]. Files only (images, sound, video, fonts, models, JSON, text); .html, .js, .mjs and .wasm are refused. It may replace only some files; the rest come from the app.`,

  notifications: `NOTIFICATIONS AND ASKING FOR MORE
- permissions.notifications: apex.notify({ title, body }) now; apex.notifications.schedule({ id, at: Date.now() + 60_000, title, body }) for later (fires while ${BRAND_NAME} runs, even with the app closed; the same id replaces; 50 at most, 30 days ahead); cancel(id); list().
- optionalPermissions: { network: ["api.example.com"], sites: [], notifications: true, model: true, clipboard: true } — not asked at install. When a feature needs one: const { granted } = await apex.permissions.request({ network: ['api.example.com'] }). A refusal holds for the session; the person can take a grant back on the pack's page. Install with the least, ask for the rest when it's needed.`,

  sharing: `SHARING
- propose_pack(id, note) puts a card in the chat; the person reviews the permission lines and installs. You never install.
- Installed packs with an app have Share… on their page: a note and a picture made from the app's still, saved as an .apexapp (the image also next to it). Export… saves the pack as .apexpack (.apexapp with an app).
- Anyone can open the file (double-click or drop on ${BRAND_NAME}) and gets the same review. Packs signed by the same author update each other; someone else's pack can only be remixed (a -remix id).
- Developer mode for hand-built packs: Packs page › Load a folder… runs a folder in place and reloads when its files change.`,
}

/** One part of the build guide, or the list of parts. */
export function buildGuide(topic: GuideTopic | undefined): string {
  if (!topic) return `Build guide parts: ${GUIDE_TOPICS.join(', ')}. Ask for one with apex_inspect({ guide: "<part>" }).`
  return BUILD_GUIDES[topic]
}

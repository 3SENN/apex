# UX plan

This plan gives an overview of Atelier's layout and UX structure: which surfaces exist, where they sit, and how the flows work. Each item is specified in detail in [feature-spec.md](feature-spec.md). The visual system and motion are in [design-spec.md](design-spec.md), which wins where the two disagree.

## Shell

**Foundations:**
- **One agent session per chat** in main, with agent events keyed by chat id. Chat pages, per-chat badges, parallel chats and companion ownership all rely on this.
- **Data model:** chat summaries carry companion, unread, pinned, archived and needs-input fields. Skills, routines, files and memory have an owner: a companion, or shared with all. Older global items migrate to the first companion, or become shared.
- **Settings schema:** `layout` (sidebar by default, and unknown values fall back to sidebar) and `theme`.
- **Pages:** the atelier:// table (`src/shared/url.ts`) has `chats`, `chat/<id>`, `routines`, `skills`, `connectors` and `companion/<id>/<section>`. `atelier://library` redirects to the matching destination. Memory lives on the companion card (shared memory in Settings › Memory), and Connectors has its own row.

**Layout: sidebar first, horizontal kept as an option.**
- The sidebar layout is the default. The horizontal strip stays as the alternative behind the `layout` setting.
- Settings › Appearance (with illustrated previews), the View menu and ⇧⌘S switch layouts live, without reloading tabs.
- Pinning, groups, the context menu, previews and drag work in both layouts. In the horizontal layout, Atelier pages share a navigation rail.

**Sidebar:**
- **Header:** the toolbar's height (40 px), with its icons on the toolbar's centre line. The macOS window controls are on the left.
  - When the sidebar hides, the controls travel with it as it slides away and are hidden while it is collapsed; the toolbar has no inset ([DS-19](design-spec.md#ds-19)). In full screen macOS manages them.
  - On the right are downloads (only while there are downloads), the sidebar-options button and Search, which opens the tab-and-chat search (⇧⌘A).
- **Destination rows:** each opens its `atelier://` page, reusing one tab per destination.
  - The rows are All chats (with unread and needs-input dots, never counts; right-click marks all read), Routines (a countdown to the next run, and an unread dot when a result arrives), Skills and Connectors.
  - Connectors is the integrations row; the name keeps it apart from Apps, the tools the agent builds.
  - Meetings and Guides (the guides library) are destinations too.
  - Clicking the active destination again returns it to its root view.
  - Hidden destinations go into an overflow row, which ends with a link to sidebar options.
- **Sidebar options** (stored locally per profile and applied live):
  - a checkbox per destination and section;
  - the sections mode: tabs and chats, or tabs only;
  - chat sort: recent, manual, or by progress when both sections show;
  - tab sort: manual or recent activity;
  - a toggle that shows how long ago each chat and tab was used.
- **Chats section** (collapsible):
  - **Entries:** open chats are tab-like entries, closable, ordered, previewable and counted by ⌘1–8. The full list lives in All chats.
  - **Header and rows:** the header has search and a new-chat button (⇧⌘E opens a new chat in the side panel), and the section has an empty state. Rows show the companion's avatar and a badge for working, needs approval or input, unread result or finished. Pinned chats sit on top.
  - **Divider:** a draggable divider between Chats and Tabs sets how many rows show. It has keyboard control, a summary of hidden rows (a count plus badges) and a show-all link.
  - **No duplicates:** a chat open as a page tab highlights its row instead of appearing twice.
  - **Menus:** a row menu (open, open in new tab, pin, mark read or unread, rename inline, duplicate, archive, export, delete with confirmation), a bulk version, and a section menu that marks every chat read.
- **New Tab row** at the top, under the pinned grid and above the destinations ([DS-06](design-spec.md#ds-06)). It adds the tab at the top of the list, below the pinned tiles, in both sort modes.
- **Tabs section:**
  - pinned tabs as a grid of favicon tiles: one or two columns for one or two tiles, otherwise three or four, whichever balances the rows. Dragging a tab in or out pins or unpins it, and a tile's close control unpins it. Pinned tabs are stored locally, restored on restart and skipped by bulk close actions;
  - the vertical list (favicon and title), with agent-controlled (the companion's avatar), audio, needs-input and finished badges. A split pair is one row, with a separate action in place of close;
  - sort: manual drag order (the default) or recent activity, with groups moving as blocks and no reshuffling while the pointer is over the sidebar;
  - top and bottom fades when the list scrolls, an edge badge that jumps to an active or needs-input tab out of view, and scroll-into-view on activation;
  - row interactions: click, Enter or Space activates; ⇧-click selects a range; ⌥-click opens split view with the active tab; middle-click closes; right-click opens the tab context menu;
  - drag between typed zones (pinned grid, chats, groups, tabs), with tab groups, multi-select, tear-off and split drop zones.
- **Background menu** on empty sidebar space: new tab, reopen closed tab, bookmark all, close all, a layout submenu, system, light or dark with a link to Appearance, and rename this window.
- **Footer:**
  - **Profile row:** shows your local name's initial, ringed in the profile colour, plus a warning chip linking to Settings when no API key is set. It opens the main menu popover.
  - **Update pill:** on the right, showing downloading with progress, ready to restart, or an error. The main menu mirrors it.
- **Size and visibility:**
  - **Width:** about 300 px (a fifth of the window), resizable live from 220 to 360. Esc cancels a drag, double-click resets, arrow keys work on the focused handle, the width is saved on release, and there is no animation under reduced motion.
  - **Toggle:** the toolbar button and ⌘S (sidebar layout only). Save Page As gets no shortcut and lives in the File and main menus. The open state is saved per window, and while collapsed the toggle shows a dot when chats are unread or need input.
  - **Narrow windows:** the sidebar hides itself when the content card would get too narrow (the window's minimum width is 820 px).
  - **Edge-hover reveal:** page views cover the chrome, so main polls the cursor while the sidebar is hidden, and the revealed sidebar floats in the overlay view.

**Toolbar above the content:**
- **The sidebar toggle, back, forward and reload:** tooltips with shortcuts. ⌘-click opens in a new tab, and a long press or right-click lists that direction's history. ⇧-click on reload bypasses the cache, and the icon animates while loading before it turns into Stop.
- **A centred address pill:**
  - **Websites:** the host without www (long hosts shortened in the middle), plus a slash and the page title when the URL has a path, query or fragment. A not-secure marker shows for plain http (except localhost) and after a certificate bypass.
  - **Atelier pages:** breadcrumbs ("Chat / <title>", "Settings / <page>") with stable page titles, and `atelier://settings` rewritten to the resolved page. The new tab shows a placeholder.
  - **Inside the pill:** a site-info button on the left and the bookmark star on the right, both hidden on Atelier pages. A zoom chip shows when zoom isn't 100%.
  - **Editing:** a click or Enter edits the pill in place with the full URL, and suggestions grow below it in the overlay layer ([DS-23](design-spec.md#ds-23)). The pill's context menu has copy, paste and go, edit, and a show-full-URLs checkbox (also in Settings › Appearance, off by default).
- **The bookmark star** lives in the pill, not among the actions. It and ⌘D open the bookmark editor popover.
- **Actions on the right** are contextual ([DS-24](design-spec.md#ds-24)):
  - **Atelier pages:** none on chat and app pages.
  - **Websites:** a chat-about-this-page button that toggles the side panel (⌘J) and carries the working and approval indicators. The agent status pill anchors near it.
  - **Split:** only while the view is split; it shows which side has focus and opens the split menu.
  - **Downloads** live in the sidebar header in the sidebar layout ([DS-05](design-spec.md#ds-05)) and stay here in the horizontal one.
  - **No companion button or avatar:** the profile card opens from the chat header, chat rows and reply avatars.
  - **Extensions:** extension buttons, when extensions are installed.
- **Bookmarks bar** under the toolbar, in the content column above the permission and find strips and the content card. Its setting is always, new tab only, or never.
- **Space row:** spaces inside a profile belong to workspace projects, so the row stays hidden until projects exist.

**Light and dark mode are both first-class:**
- **Choice:** Settings › Appearance (not a separate Theme page) offers System, Light or Dark, as do View-menu radio items and the sidebar background menu.
  - The choice sets `nativeTheme.themeSource`, which also flips `prefers-color-scheme` in the chrome, popups, the peek view and websites, so one token block in `styles.css` covers them.
  - The Appearance page also holds the accent, layout previews, the tint and the other appearance rows.
- **Before first paint:**
  - The window is created with the resolved mode's chrome colour (`nativeTheme.shouldUseDarkColors`) and updated on nativeTheme's `updated` event, so dark mode never flashes light at start-up or while resizing.
  - The chrome gets the resolved theme and accent before React renders, so the default accent never flashes either.
- **Reach:** live switching covers every window, popup windows (`POPUP_OPTIONS`), the peek view, internal pages and the overlay view. The in-page agent overlay (`src/preload/page.ts`) uses the companion accent and theme tokens.
- **Tokens:** the sidebar tint is a flat profile hue (`--profile-ground`, `--profile-hue`, from `src/shared/profile.ts`), never the companion accent ([DS-03](design-spec.md#ds-03)), defined for light and dark. The tint switch needs no extra tokens. Sidebar vibrancy has an opaque fallback under Reduce Transparency.
- **Coverage:** every surface is designed, tested and screenshot-checked in both modes before it counts as done: sidebar, toolbar, cards, overlays, dialogs, the companion card's hero background, error pages and the welcome flow.
- **Companion:** its outline, shadow and hero pattern adapt to the mode.
- **Switching:** happens live without a reload, and the macOS window material (vibrancy) follows the mode.

**Content:** one sheet ([DS-01](design-spec.md#ds-01)): the toolbar, the bookmarks bar and the page share one paper surface that touches the window's top, right and bottom edges, rounds only its top-left corner and casts a short shadow onto the sidebar; a hairline separates the bars from the page, which is flush. Beside a chat (and in split view) the page becomes an inset rounded card ([DS-02](design-spec.md#ds-02)). The chrome is neutral (warm greys and paper) with the profile hue on the sidebar; the companion's accent stays on companion surfaces. A matching dark theme. "Content card" elsewhere means the page area of the sheet.
- **Page navs:** internal pages with their own left nav (such as Settings) collapse it to an icon rail when the card is narrower than about 960 px.
- **Companion panel:**
  - **Width:** a draggable seam with a minimum and maximum width, arrow keys and a saved width, using the same seam component as split view.
  - **Placement:** it docks on the right, or on the left.
  - **Header:** shows which chat is attached, with a way to switch, and an expand button that opens the same chat as a page.
  - **Driving:** only one surface drives a running chat; the others mirror it.
- **Page full screen:** a chromeless layout state hides the sidebar, toolbar and panel, and lets the page view fill the window (`enter-html-full-screen`, `leave-html-full-screen`). Focus mode reuses the state, and a notice says how to leave.
- **Chrome crash:** one renderer draws the sidebar, toolbar and every Atelier page, so a crash would blank the window. Atelier handles `render-process-gone` and failed loads on the chrome's webContents with an automatic reload and a visible retry.
- **Order:** ⌘1–8 and next or previous tab follow the sidebar's visible order (pinned tiles, then chats, then tabs, skipping collapsed groups). ⌥⌘→/⌥⌘← and ⇧⌘]/⇧⌘[ step in that order, since ⌃Tab is the recent-tab switcher.
- **Window title:** follows the active tab's title, or a custom window name.
- **Menu bar:**
  - The View menu has System, Light and Dark radios, the layout switch, Show Sidebar (⌘S) and new chat beside the page (⇧⌘E).
  - History has about ten recent chats and Show All Chats.

**Chats as pages:**
- `atelier://chat/<id>` shows the conversation centred in the content card, with the composer at the bottom. The composer hint uses the companion's name and follows its state: new chat, follow-up, queued while running, editing a queued message, meeting attached, or no API key.
- **Header** inside the content card: the title (click to rename), the owning companion's avatar, a routine pill for routine chats, a button for the tabs this chat used, and a ⋯ menu (new chat, rename, duplicate, open in a new tab, export, and delete with confirmation or Undo). The address-pill breadcrumb can't hold these.
- **Composer:**
  - a companion chip (switching mid-chat continues in a new chat, because the system prompt is fixed per chat);
  - a model and effort override before the first message;
  - a per-chat ask-first toggle;
  - the mic button and the + menu.
- **Your messages:** copy, and edit and resend (↑ in an empty composer edits the latest), which cuts the chat back to that point after a confirmation.
- **Replies:**
  - copy as Markdown and retry;
  - helpful and not helpful, stored locally with an optional local note;
  - a details popover (time, model, tokens);
  - a marker when the turn changed memory.
- **States:** a skeleton while loading, a not-found state for deleted chats, and a could-not-load state with retry. The view doesn't force-scroll when you have scrolled up; a jump-to-newest button appears instead.
- The side panel stays as "ask about this page" next to websites. Both views share the same chat.
- **All chats** (`atelier://chats`): grouped by date with pinned chats on top, search, filters (companion, routine runs, status), row menus with inline rename, and delete with confirmation.

**New tab page:** the active companion with previous and next controls (and ←/→ in an empty ask field) to choose who takes the next chat, plus an add-companion entry. Tab keeps moving focus.

**Companion profile card** (opened from the companion avatar):
- a large card on the right of the content area: only the page there is washed and blurred, while the sidebar, toolbar and bookmarks bar stay sharp and usable. Opened from the side panel's chat, it fills that column instead. It fades in and out and resizes from its left edge ([DS-29](design-spec.md#ds-29) to [DS-32](design-spec.md#ds-32));
- **header** (one row):
  - a switcher pill with the companion's face, its name and a chevron; its menu lists the companions, then New companion… and Add from file…;
  - only a "⋯" menu (use for new chats, the Dock icon, duplicate with progress, hide or unhide, reset, delete) and close;
  - one floating save pill under the header (saving, saved, or couldn't save with retry).
- **Deleting:** delete is disabled, with an explanation, for the last visible companion. Deleting the active one switches to another, and its past chats stay readable with a neutral avatar.
- **tabs** (arrow keys move between them; each tab and item has a deep link, `atelier://companion/<id>/<section>`):
  - **General:**
    - an edge-to-edge hero washed in the companion's colour, with the animated shape field behind the live full-body companion, the big editable name, Export… (which saves a `.ateliercompanion` file plus a share image rendered off-screen) and Customize look, which edits the look in place (with undo and redo);
    - exactly two summary rows, Skills (N skills ›) and Routines (N routines ›);
    - Standing instructions: prose edited in place, added to the companion's system prompt next to its personality, autosaved and applied to new chats only. The personality preset is a small ghost select at the end of its label row.
  - **Skills, Routines, Files, Memory:** this companion's own plus shared ones, so each companion has its own memory folder.
  - **Models:** model and effort per companion. The companion's default overrides the global default, and a per-chat choice made before the first message overrides both. Existing chats keep their snapshot.
- **Create and import:**
  - a new-companion sheet, from the switcher, the new-tab picker, the card and Settings › Companions;
  - built-in presets, which add a new companion instead of overwriting the current one;
  - opening or dropping a `.ateliercompanion` file shows a review sheet before it is added.

Atelier has multiple companions. Chats, skills, routines, files and memory are owned per companion, or shared with all.

**Settings** start with a local You card (name, optional avatar, API key status), Appearance and Companions (list, create, import). The other pages come with their features below.

## Layered UI and browser essentials

**Layered overlay surfaces.**
- One transparent `WebContentsView` sits above the tab views, loading the chrome bundle with `#overlay`. It renders whichever floating surfaces are open, so the page stays visible underneath.
- Main sizes the view to the open surface's bounds (or the full window for modal surfaces) and routes clicks through when nothing is open.
- Menus and popovers never hide the page.

**Surfaces:**

| Surface | Behaviour |
|---|---|
| Command bar | ⌘L / ⌘T. Centred palette that searches URLs and the web, history, open tabs (switch to a tab), bookmarks and commands (Ask the companion, split view, settings pages, new routine…). Fully keyboard-driven. |
| Tab hover preview | Hovering a tab shows a card with a live thumbnail (`capturePage`, cached and refreshed on tab switch), title and domain. |
| Recent-tab switcher | Holding Ctrl+Tab shows recently used tabs with thumbnails; releasing switches. |
| Agent status pill | When the agent panel is closed and the agent is busy or needs approval, a floating pill shows the companion and its status. Clicking opens the panel. |
| Selection actions | Selecting text on a page shows Ask the companion, Copy and Search, using selection rectangles from the page preload. |
| Toasts | Link copied (⌘⇧C), download finished, routine ready, password saved. |
| Permission dialog | A card anchored under the address area. |
| Screen picker | For `getDisplayMedia`, via `session.setDisplayMediaRequestHandler`. |
| Device picker | WebHID, WebUSB, serial and Bluetooth selection events. |
| Fullscreen notice | "Press Esc to exit full screen" when a page goes fullscreen. |
| Split-view menu | Choose the second tab, swap, or close the split. |

**Behaviours and settings:**
- automatic picture-in-picture when leaving a tab with playing video;
- per-site settings (permissions, zoom, ad blocking on or off) from the site info button;
- a Theme setting (system, light or dark);
- Clear browsing data;
- Default browser;
- Languages (spellcheck).

**More browser essentials:**
- **Markdown in agent replies:** sanitized, with code blocks and copy buttons, tables, and links that open in a tab.
- **Sessions:** restore tabs, split and sidebar state on restart; Reopen Closed Tab (⌘⇧T); a recently closed list.
- **Windows:** multiple windows (⌘N); drag a tab out into its own window, or drop it into another.
- **Print:** Print and Save as PDF (⌘P).
- **Popovers:** bookmarks and downloads as quick popovers.
- **Dock:** a badge when the agent needs approval.
- **Taking over:** a notice when you click into a tab the agent controls, with Take over or Pause.
- **Settings pages:** Notifications, Privacy (block third-party cookies, Global Privacy Control, clear on exit), Storage (usage, clear data), Downloads (location, ask where to save), About (version and licences).

**Links:**
- **Status bubble:** hovering a link shows its URL in a small bubble at the bottom left (`update-target-url`).
- **Link preview:** hovering a link with ⌥ held, or long-pressing it, shows a preview card: title, description and site image, fetched from the page's metadata by the preview loader, not by the page.
- **Opening links:** ⇧-click opens in Peek; ⌘-click opens a background tab; ⌘⇧-click opens a foreground tab; middle-click opens a background tab.
- **Drag:** dragging a link onto the tab list opens it there.
- **Context menu:** Open in Split View, Open in Peek, Copy Link, and Ask the companion about this link.
- **External links** (`mailto:`, `zoommtg:`, app links): an "Open in <app>?" confirmation with "always allow for this site", instead of opening silently.

**Dialogs and modals** (page dialogs go through the overlay surface):
- **Page dialogs:** `alert`, `confirm` and `prompt` are styled modals in the overlay, anchored to the tab, instead of native boxes (Electron does not support `prompt()` at all).
  - The page preload installs the overrides in the main world (`contextBridge.executeInMainWorld`) and blocks on a synchronous IPC reply, as the APIs require.
  - Repeated dialogs offer "Stop this site from showing dialogs".
  - The agent sees a page dialog in its next result and asks you before answering it.
- **Leave this page?** (`will-prevent-unload`) as a styled confirm.
- **Sign-in required** (HTTP basic auth, `app.on('login')`) as a styled username and password modal.
- **Certificate errors:** a full interstitial page with "Back to safety" and an advanced "Proceed anyway" (`certificate-error`).
- **Confirmations:** closing a window with many tabs, clearing browsing data, removing a connector or memory, and resetting the companion.
- **Ask where to save** downloads, as a setting.
- **Shared modal component:** focus trap, Esc to dismiss, and dialog accessibility roles.

**Colours and themes:**
- **Appearance:** System, Light or Dark. `nativeTheme.themeSource` also tells websites the choice through `prefers-color-scheme`.
- **Accent:** follows the companion (the default) or a picked colour, with contrast checked in both modes.
- **Theme presets** (palettes such as Lavender, Ocean, Forest, Sunset, Graphite and Midnight): chrome background, surfaces, borders and accent, each tuned for light and dark.
- **Material:** on macOS, translucent window vibrancy behind the sidebar and tab strip (`vibrancy: 'sidebar'`), with an opaque fallback elsewhere and when "Reduce transparency" is on.
- **Per-profile colour:** each profile tints the sidebar so you can tell profiles apart.
- **Website dark mode:** an optional "force dark pages" per site (Chromium auto dark mode) for sites without a dark theme.
- **Density:** comfortable or compact (tab height, spacing), plus the interface font size.
- **Mechanics:** all colours are CSS custom properties that themes set. Nothing is hard-coded in components.

**Loading, error and empty states:**
- **Page loading:** a thin progress bar along the top of the content card.
  - It moves through stages: navigation started, response received, DOM ready, then finished and fades out.
  - The bar sits in the overlay, so it shows above the page.
  - The tab favicon becomes a spinner while loading, and slow loads (over 8 s) show "Still loading…" with Stop.
- **Error pages** are styled internal pages with a retry and the companion in its "sad" mood:
  - no connection (with automatic retry when back online), site not found, connection refused or reset, timed out, too many redirects;
  - certificate errors (see Dialogs);
  - blocked by the ad blocker, with "Allow on this site".
- **Crashed or unresponsive tabs:**
  - a crashed tab (`render-process-gone`) shows "This page crashed" with Reload;
  - an unresponsive tab (`unresponsive` and `responsive`) shows a non-blocking "Page isn't responding" with Wait or Reload.
- **App start:**
  - The window appears only when the chrome has painted.
  - Restored tabs show skeleton favicons and titles until their pages report in.
  - The companion shows its 2D face while its 3D parts load, then crossfades.
- **Internal pages:** skeleton rows while lists load (Library, History, Bookmarks, Downloads, Passwords, Meetings), and friendly empty states with a primary action.
- **Agent panel:**
  - a "thinking" shimmer before the first token, with the step in progress shown live ("Reading the page…", "Searching the web…");
  - streaming text with a caret;
  - tool steps with running, done and error states, and approvals that pulse until answered;
  - an offline or rate-limited banner with automatic retry and a countdown.
- **Buttons and forms:**
  - async actions show an inline spinner and disable re-submission (save, import, connect, run routine);
  - success confirms with a short toast;
  - errors stay inline, next to the field.
- **Progress for long jobs:**
  - import with counts;
  - downloads with speed and time left;
  - meeting transcription elapsed time;
  - routine "running now" indicators.
- **Motion:** state changes use 150–250 ms fades and slides, and all of it respects `prefers-reduced-motion`.

**Site safety and controls:**
- **Page developer tools:** Inspect Element, ⌥⌘I, ⌥⌘J, and View Source (⌥⌘U) as a pretty-printed page.
- **Site safety:**
  - a dangerous-site interstitial, plus a warning on dangerous downloads;
  - lookalike-domain protection: punycode for confusable domains, with the registrable domain highlighted;
  - connection security and certificate details in site info.
- **Per-site controls:**
  - cookies and site data (clear for this site, allow or block exceptions, a full site-data list);
  - a pop-up and redirect blocker with notice and Allow; mute a site; JavaScript, images and automatic downloads; insecure content.
- **Network:** system proxy by default, or manual HTTP, HTTPS, SOCKS or PAC with a bypass list.
- **Notifications:** app events for routines, approvals, meetings, downloads and saved passwords (each toggleable), with click-to-focus; a list of sites allowed or blocked from notifications.

**Tabs, windows and media:**
- **Tab previews and sharing:**
  - live frame previews on hover for media tabs (still thumbnails otherwise);
  - "Create QR code for this page".
- **Tab groups:** name, colour, collapse and drag; spaces.
- **Tab handling:**
  - the tab context menu (pin, duplicate, mute, split, new window, copy link, close others or below, reopen closed);
  - multi-select tabs;
  - drag zones that create a split; dragging text or URLs onto tabs or the command bar to search or open.
- **Popups and media:**
  - popup windows with a read-only origin and lock strip; `window.close()` from popups returns focus to the opener;
  - camera, microphone and screen-sharing indicators with stop and revoke, a sharing bar, and an audio speaker icon on tabs.
- **Import and bookmarks:**
  - import of open and pinned tabs and search engines, available from Settings too, with a choice per type;
  - bookmarks HTML import and export;
  - the bookmark editor popover (name and folder); Settings › Bookmarks (bar always or on the new tab only, folders).
- **Downloads and bookmarks by drag:** drag downloads out to Finder or the composer; reorder bookmarks and drop onto folders.
- **Focus mode:** hide the chrome, toggled by shortcut.
- **Task manager:** ⇧Esc, with per-tab memory and CPU and End process.

**Interaction details:**
- **Overlay behaviour:** page-anchored surfaces follow scrolling or dismiss.
- **Composer:** drafts persist per chat.
- **Keyboard and feedback:**
  - keyboard navigation everywhere, with focus rings and Esc or click-outside to dismiss;
  - tooltips that show shortcuts, and a Keyboard Shortcuts sheet (⌘/);
  - a zoom badge with a popover in the address field;
  - Undo on destructive toasts.
- **Companion:** acts out agent steps with props (book while reading, magnifier while searching, typing while filling forms), and looks desaturated when unavailable.
- **Typeface:** Inter, bundled.

## Passwords, voice and meetings

**Passwords:**
- The vault lives in `src/main/passwords/vault.ts`.
- The page preload detects login forms and submissions; there is a save or update prompt, and an autofill dropdown on login fields.
- A Passwords page in Settings, where revealing a password asks for Touch ID (`systemPreferences.promptTouchID`).
- Generate password on new-password fields.
- Password import from CSV exports (Chrome, Firefox, Safari, 1Password, Bitwarden), started by you.

**Autofill:**
- Saved addresses (name, email, phone, address) filled on matching fields. Cards are stored encrypted without the CVC, and filling one requires Touch ID. The agent stays blocked from all of it.
- Autofill works inside nested and cross-origin frames, with keyboard control of the dropdown.
- Guarded inputs: password, card, CVC and one-time-code fields are marked and refused to the agent.

**Voice:**
- Speech runs through the `native/speech` helper.
- The companion panel has a microphone button, and holding ⌥Space opens a voice-command overlay. The transcript goes to the agent.
- Dictating into the focused field.
- Voice and Transcription settings, with "Test microphone" in Settings › Voice.

**Meetings:**
- When a tab is on a meeting site (Meet, Zoom web, Teams), a toast offers to transcribe.
- A transcript window shows live captions labelled You and Others.
- A Meetings page lists transcripts, with a companion summary and action items.
- macOS requires Screen Recording permission for the other participants' audio.
- Optional meeting audio recording, compressed, with export and storage size, and playback synced to the transcript.

**Passkeys:** Apple's web-browser public-key-credential entitlement lets a browser offer the system's passkeys (iCloud Keychain and credential provider apps) for any website. Official signed builds can carry it and then turn platform passkeys on; unsigned builds, and signed builds without it, refuse passkey requests at once instead of hanging. See [Browser passkeys and iCloud Passwords](../release.md#browser-passkeys-and-icloud-passwords).

## Extensions, attachments, documents and context

- **Chrome Web Store extensions** via `electron-chrome-extensions` and `electron-chrome-web-store` (both MIT): install from the store, extension buttons in the toolbar or sidebar, and an Extensions page in Settings. Native messaging hosts work too, with a prompt per host.
- **Chat attachments:** images, PDFs and text files sent as content blocks. **@tab mentions** add an open tab's text as context.
- **Documents:**
  - an optional "Files and documents" ability using Anthropic's code execution with the pptx, xlsx, docx and pdf skills (on another engine, its own way of running that code, [ST-61](feature-spec.md#st-61));
  - generated files land in Library › Files.
  - It is off by default, because standalone code execution next to dynamic web search can confuse the model.
- **Long chats:** server-side compaction (`compact-2026-01-12`), keeping compaction blocks in history.
- **Profiles:** separate browsing profiles (each its own session and colour) with a switcher.
- **Connectors:**
  - local (stdio) MCP servers next to the remote connectors;
  - a searchable connector directory, with service logos used under each brand's guidelines;
  - tools listed per connector;
  - one-click OAuth where an official remote MCP server exists;
  - Needs-reconnect badges and inline Reconnect;
  - an illustrated Google setup.
- **Files and artifacts:**
  - an artifacts viewer (HTML, SVG, images, files) in a sandboxed tab;
  - Library › Files for saved reports and generated files;
  - a "brand kit" skill for document generation;
  - SVG rasterized for attachments, and thumbnails;
  - PDF tabs readable by the agent through pdf.js;
  - a document quick-look overlay;
  - dropping files on the composer, pasting images, and dragging page images or text into it.

## Workspace and intelligence

- **Companions:** multiple companions, each with its own memory folder, skills and chats; a gallery to add more; intro animations rendered from the live companion.
- **Memory upkeep:** "Tidy memory", a built-in nightly routine that reviews recent chats and organizes memory.
- **Activity memory (opt-in):** turns browsing into notes the agent can use, with a schedule, pause and a status indicator. It is local and editable, has an inspector and "Turn on until… / Off until tomorrow" overrides, and skips excluded sites (sensitive categories plus your own list), as do the timeline and suggestions.
- **Search everything:** a SQLite full-text index over chats, memory, history, bookmarks and files.
- **Timeline and site insights** from local history.
- **Files:** watched local folders the agent can search and read, with a file viewer.
- **Organizing work:** the Workspace hub (home and section navigation), projects that group chats and files, and Recently Deleted with restore.
- **Apps:** small tools the agent builds as sandboxed HTML artifacts, made through the "New app" flow (describe → build → preview → save).
- **Tables:** CSV import into local SQLite that the agent can query.
- **Proactive help (opt-in):** suggested routines and insights.
- **Skills and routines:** built-in official skills, "Save as skill" from a chat, and routine run history.
- **Agent safety:** per-site agent permissions (allow, ask, never).
- **Agent panel:** a chat-history popover and find inside the panel.
- **Chat export:** Markdown, PDF and print.
- **Settings › Agent:** a token usage and cost meter, and a read-only system prompt viewer.
- **Onboarding:** choosing what you do (suggests skills and routines), a connectors step, favourite sites as pinned tabs, importing ChatGPT or Claude history, and a launch step, with illustrations and optional UI sounds.
- **Guidance:** a getting-started checklist, dismissible tips, new-tab nudges, and a guides library.
- **Calendar:** macOS Calendar and Reminders read access through a native helper (opt-in).
- **Experiments:** an `atelier://flags` page.
- **App links:** "open in the site's app" suggestions for known app links.

## Release and operations

- Code signing and notarization; auto-update through `electron-updater` with GitHub Releases (needs signing).
- Rotating local logs with a viewer, opt-in crash reports, and "Send feedback" as an email draft. No analytics.
- Windows and Linux packages, plus Windows system audio for meetings.
- Optional macOS niceties: a haptic snap when resizing split view, and pausing meetings when the lid closes.
- **Localization:** a message catalogue, app language, Accept-Language and spellcheck languages.
- **Background mode:** open at login and keep running in the menu bar for routines and meetings.
- **App icons:** a full set (macOS dark and tinted, Windows, Linux, document icons).
- **What's new:** a card after an update.
- **Migrations:** versioned chat-store migrations with repair notices.

## Out of scope

- Teams and billing: Atelier needs no backend to work, and leaves out what only a server could provide.
- Hosted publishing.
- Device fingerprinting.
- Platform passkeys in builds without Apple's browser passkey entitlement (official signed builds can turn them on; see [docs/release.md](../release.md#browser-passkeys-and-icloud-passwords)).

Items that are still partial or missing are marked ◐ or ○ in [feature-spec.md](feature-spec.md).

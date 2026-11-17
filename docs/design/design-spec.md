# Design spec: layout, motion and interplay

This document specifies Apex's layout, structure, motion, background animation, and the way its surfaces work together. It turns each of these into a testable requirement.

**Conventions.**
- **Measurements:** CSS px in a 1470×923 design window, with y = 0 at the window's top edge. The sheet is x 300–1470. The content area under the bars is y 78–923 (1170×845).
- **Colour:** colours are given as roles and relative steps (lighter, darker, one step, a few levels on a 0–255 grey scale). Apex keeps the values in its colour tokens.
- **Motion:** every timing here has a tolerance of ±50 ms, and "within one frame" means 50 ms or less. Apex keeps these timings in its motion tokens ([DS-81](#ds-81)).
- **Dark mode:** layout, sizes and type are identical to light mode. Dark notes give tone relationships as relative steps, and the dark tokens hold the values.

**Precedence.**
- Where this document contradicts [feature-spec.md](feature-spec.md) or [ux-plan.md](ux-plan.md), this document wins. Each such item names what it supersedes, and the [last section](#spec-items-superseded-or-refined) lists them all.
- [CO-18](feature-spec.md#co-18), [CO-19](feature-spec.md#co-19) and [CO-20](feature-spec.md#co-20) stand as written. Items here link to them and add only detail.
- **The empty chat:** a new chat opens the start surface, with a live companion standing above the composer, as CO-20 asks ([DS-72](#ds-72)). CO-20's larger size, greeting and in-panel version stand.
- **Dark mode:** every item needs a designed dark version, checked in screenshots, before it counts as done.

**Item format.**
- Each item has an id, an area tag (`shell`, `card`, `chat`, `companion` or `motion`), the behaviour Apex must have, the Apex files to change, and a test where one isn't obvious.
- Ids run in document order within each section.
- Paths are relative to `src/renderer/src` unless they start with `src/`.

<a id="colour-roles"></a>**Colour roles** (these apply to every section):

| Role | Where it appears | Where it never appears |
|---|---|---|
| **Neutral** (ink, greys, paper) | Toolbar, address pill at rest, bookmarks bar, labels and icons; the active chip; popovers, menus, the palette and tooltips; the composer, the user bubble and the details card; the card surface, tabs, underline and list group; primary buttons on destination, settings and list pages (ink pills that invert in dark mode); the backdrop behind overlays | n/a |
| **Profile hue** (a per-profile setting, independent of the companion) | The flat sidebar tint and its hover step; the footer's update capsule and avatar ring; the address field's focus ring and text selection; the hue-filled button in the main menu; the selected settings row; links, progress, and the details panel's action pill and usage count | Companion surfaces; the composer and message surfaces; primary buttons on pages |
| **Companion colours** (from its look) | Small avatars; the card hero wash and share pill; the live figure; the voice pill and the mic and send fills; the composer chip's label and chevron; the start-surface switcher name; the glow on a tab and page the companion is controlling, drag highlights, speech-bubble accents and the working sweep | Chrome (sidebar, toolbar, pill, bookmarks bar); composer and bubble surfaces; settings; primary buttons on pages |

- Links, progress and the selected settings row use the profile hue too ([Design choices: shell](#shell-design-choices)).
- Companion-coloured fills are identical in light and dark mode. Only companion-coloured text gets a lifted dark variant ([DS-139](#ds-139)).

---

## Shell

The window shell covers the sidebar, the toolbar, the address pill, the bookmarks bar, the content area, and the popovers, menus, cards and tooltips that belong to them.

### Layout

**Two planes.**
- **The ground** is the sidebar column, x 0–300 (about 20% of the window) and full height. It is one flat tint carrying the profile hue, with no gradient, borders or dividers anywhere, including above the footer.
- **The sheet** holds the toolbar (y 0–40), the bookmarks bar (y 40–77) and the page (y 78 to the bottom, 1170×845).
  - It starts at x 300 and touches the window's top, right and bottom edges.
  - Only its top-left corner is rounded, at about 10 px.
  - There is no stroke at the seam. Instead, a soft shade 2–2.5 px wide darkens the last pixels of the sidebar toward the edge.
  - A one-device-pixel hairline at y 77, one step darker than the pill fill, separates the bars from the page. There is no shadow under it.
  - The page has no inner card, radius or gutter. The toolbar band is the same tone as the page.
- **Collapsed sidebar:** the sheet fills the window and the window controls are hidden.

**Sidebar, top to bottom** (window px):

| Element | Geometry | Look |
|---|---|---|
| Header row | 40 tall. The 16 px window controls sit at x 14, 37 and 60, y 12. Options and search are 32×32 boxes at (226, 4) and (262, 4), 4 px apart and 6 px from the right edge, with 16 px glyphs. | Muted glyphs. Hover gives a rounded-square neutral fill (radius about 8), which stays while its popover is open. A downloads button joins only while downloads exist. The row drags the window. |
| Pinned tile grid | Only when tabs are pinned | Same raised-chip language as the active row |
| New-tab row | 280×32 at (10, 49) | Plus glyph and label in the strong tone. The only top row at full strength. |
| Destination rows | y 83, 117, 151, 185, 219 and 253: 32 tall on a 34 px pitch | A 16 px outline icon at x 20 and the label at x 44, both muted. The last row is the overflow row, a pop-up button that is always present. |
| Chats header | A 216×24 button at (18, 295), 10 px below the overflow row | A muted label with a chevron after the word (down when open, sideways when closed). Two 20×20 actions at x 238 and 262 show only while the pointer is in the chats section. |
| Chat rows | (10, 324) and (10, 358), starting 5 px below the header | A 20 px avatar at x 18 (the only companion colour in the chrome), then the title in the strong tone at x 44. The title fades out linearly over its last 40–44 px, ending about 10 px before the row edge, with no ellipsis. Trailing slot 20×20 at x 262. |
| Tabs label | x 18, y 404, 16 tall, 14 px below the last chat row | Muted, with no controls and no hover change |
| Tab rows | From y 429, on a 34 px pitch | A 16 px favicon at x 20, the title at x 44 fading like chat titles, and a 20×20 close at x 272. No fill at rest. |
| Empty space | Down to the footer | Drags the window |
| Footer | Profile button 153×36 at (20, 877), 10 px from the bottom, no divider above | A 20 px avatar (an initial on a dark disc with a thin ring in the profile hue that works as a progress gauge), then muted account text from x 45 with an ellipsis. On the right, the update capsule: 109×28 at (177, 881), 14 px from the right edge, fully rounded, solid profile hue, a 14 px glyph and a white 12 px semibold label. |
| Resize handle | 8 px wide, centred on x 300, from y 8 to 8 px above the bottom | Invisible. Only the cursor changes; no hover line. |

**Rhythm and type.**
- **Rhythm:** rows are 32 tall on a 34 px pitch (2 px gaps). With chats collapsed, the header's top to the tabs label's top is 41 px; expanded with two rows, it is 109 px.
- **Sizes:** rows, labels and account text are 13 px regular on a 16 px line; bookmarks 12 px; pill text 14 px; the update capsule 12 px semibold; tooltips about 13 px.
- **Tones:** strong (near-black) for the new-tab row and the chat and tab titles; muted (a neutral grey near mid-luminance, not blue) for destinations, labels and account text; light (lighter still) only for the pill's title and placeholders. Unread rows go to medium weight.

**Row states.**
- **Hover:** a fill one step darker than the ground, in the same hue, with a radius of about 8. The label and icon go to near-black.
- **Active chip:** x 9.5–290.5, 32 tall, radius 7–8. A near-white fill, a half-pixel bright rim on all four sides, and a shadow about 2 px down with about 8 px blur, reaching about 9 px below the chip and about 5 px at the sides.
- **Stamps:** while the pointer is anywhere in the sidebar, chat and tab rows (the active one included) show a muted short relative time in the trailing slot. A hovered row swaps its stamp for the close button. With the pointer elsewhere, the slot is empty.

**Toolbar (y 0–40).**
- **Left cluster:** the toggle is a 32×32 box at sheet + 8. Back, forward and reload sit at sheet + 48, + 82 and + 116: 32 px boxes, 2 px apart, 8 px after the toggle.
  - Glyphs: the toggle is 16 px in the strong tone, back and forward are 18 px thin chevrons, and reload is 16 px.
  - Disabled controls fade and get no hover fill. On a chat page, back, forward and reload are all inert.
- **Address pill:** 527×32 at (622, 4). That is exactly 45% of the sheet's width, centred on the sheet's midline (x 885). With the sidebar collapsed it is 662 wide and centred at x 735.
  - It is a rounded rectangle with a radius of about 8, not a capsule.
  - It has a flat neutral fill, with no border, no shadow, and no companion or profile colour.
  - Its text is centred, about 14 px regular, and two-tone: the prefix (the page kind, or "Apex" on destination surfaces) in mid-grey, then the slash and the title in the light tone.
  - Internal pages show no favicon or lock. Site info and the star appear only on websites.
- **Right cluster:**
  - Empty on chat pages, destination surfaces and the new tab.
  - On internal tab pages (settings, history, bookmarks), one 32×32 extensions button sits at the far right, 8 px in.
  - On websites it is contextual: a chat-about-this-page button and extension actions; while a chat shows pages beside it, a thin divider followed by that chat's pages and their expand and hide controls.

**Bookmarks bar (y 40–77, 37 px tall).**
- **Items:** a 130×29 box at sheet + 12 (y 44), a 16 px glyph at sheet + 20, and a label of about 12 px in the strong tone at sheet + 42. No chip at rest. Hover shows a rounded neutral fill (radius about 8).
- **Folders:** a click opens an in-window dropdown card directly under the item, left-aligned: radius about 12, a hairline border and a soft shadow, with rows of a 16 px favicon and an about 15 px title. A second click on the item closes it.

**Popovers, menus, cards and tooltips.** All are in-window, white, with a hairline and a soft shadow, and none has a title or a close button.

| Surface | Geometry | Contents |
|---|---|---|
| Sidebar options | Under the options button, x 15–285, top at y 41, about 310 tall, radius about 16 | A muted section label; five 36 px check rows (a round check: a filled ink disc with a white tick when on, a thin grey ring when off; a 16 px glyph at x 57; the label at x 79); a full-width hairline; two rows of a label at x 31 and a 164×32 segmented control at x 105 (2 px inset, 28 px segments) |
| Overflow dropdown | 272×90 at (14, 289), 4 px under its row and overlapping the chats list, radius about 12 | The hidden destinations, a hairline, then a customise row: 36 px items with 16 px glyphs and muted labels. The row shows a pressed neutral fill while it's open. |
| Main menu | 236×539 at (20, 330), its bottom 8 px above the footer button, radius about 12 | An account row; a usage-gauge row; a 32 px hue-filled button (radius 8); a hairline; a profile row; then 30 px tool rows (15 px glyphs at x 35, labels at x 60, chevrons or shortcut glyphs right-aligned near x 228); hairline groups with about 6 px padding; a hue-washed update row; help and settings rows. The footer stays pressed while it's open. |
| Command palette | Overlay 752×542 at (359, 191), centred on the window rather than the sheet. The visible card is about 640 wide, with its top near y 248, radius about 20, slightly translucent near-white, a large soft shadow and no dim behind it. | A 20 px input (517×28) with a light shortcut hint at the right; two 24 px filter chips at y 304; results 619 wide from y 346, in 40 px rows on a 44 px pitch, with a 20 px icon at x 436 and the label at x 466. The first row is preselected with a neutral fill (radius 8) and a muted go-hint plus arrow at the right. |
| Row preview cards | x 304 (4 px past the sidebar edge), about 261 wide, top = the hovered row's top − 12, radius about 12, about 15 px inset | **Chat:** about 228 tall: a semibold title (up to two lines), the opening prompt in a grey bubble with a tail (or a grey inset block), and the reply, muted and clipped. **Tab:** about 205 tall: a 16:9 page thumbnail about 145 tall, then a semibold title and the muted host. **Routines:** about 61 tall: a title and one muted line. |
| Tooltip | Centred under its anchor with a 6–8 px gap, drawn in its own small window | Near-black, radius about 8, a thin lighter edge and a 13 px white label. Shortcuts show as small lighter grey key-cap chips. |
| Context menus | Tab row: 251×379. Sidebar background. | Native macOS. Tab row: four groups (new and reopen; split, group and move; page actions; close actions). Background: new and reopen; bookmark all and close all; a layout submenu; a customise submenu (profile colour); name window. |

**Colour.**
- At rest the chrome carries no companion colour except the chat-row avatars.
- The sidebar tint and its hover step, the update capsule, the footer ring, the pill's focus ring and text selection, and the main menu's filled button use the profile hue.
- Everything else in the chrome is neutral.

**Dark.**
- Geometry, sizes and type are unchanged.
- **Planes swap order:** the ground is a slate of the profile hue, about 14 levels **lighter** than the sheet, with slightly more tint than in light mode. The sheet is near-black, the darkest plane.
- Hover on the ground is one step lighter. The active chip is a much lighter slate (about four times the hover step) with a faint light rim and a short dark shadow.
- The pill and other filled controls become a lifted grey (their polarity flips). The hairline is about two steps above the sheet. The seam shade almost vanishes; the tone step does the work.
- The pill's focus ring keeps its hue at much lower luminance. The update capsule is slightly deeper.

### Behaviour and motion

- **Still at rest.** The chrome has no ambient or idle animation, in either mode. Something moves only when state changes, briefly, and Reduce Motion removes it. The new-tab floor is static too. Ambient life belongs to the companion surfaces.
- **Sidebar show and hide** run on one shared timeline.
  - The sidebar slides as one rigid block in about 150 ms, with no overshoot. Its contents are never squeezed; they are clipped at the moving edge.
  - The sheet's edge travels the full 300 px in the same ~150 ms: ease-out on hide, ease-in-out on show. The page and pill re-centre in step with it.
  - The macOS window controls vanish on the first frame of a hide and reappear on the last frame of a show. The collapsed toolbar starts at the window edge with the toggle.
  - While collapsed, the toggle shows a dot for unread chats or chats that need input.
- **Resize.** The width previews live and is saved on release. Esc restores the old width and a double-click resets it.
- **Fixed header, one scrolling list**.
  - The pinned grid, the new-tab row and the destinations never scroll.
  - Chats and tabs scroll together as one list with no visible scrollbar, and the list's edges fade.
  - A hairline under the fixed header fades in only while content is scrolled beneath it.
  - Edge badges jump to an active or needs-input row that is out of view.
- **Destinations are a surface, not tabs.**
  - A destination row swaps the content area. The chip moves and the content blanks in the same frame, and the page appears in one step 200–300 ms later. There is no slide or fade.
  - While a destination shows, no tab or chat row is active, the destination never appears in the Tabs list, and the pill reads "Apex / ‹page›".
  - A destination chosen from the overflow dropdown behaves the same way and makes the overflow row active.
  - Details are in [Destination pages](#destination-pages).
- **Destination and new-tab rows.**
  - Hover adds the ground's darker step and brings the text to near-black.
  - The selected destination becomes the raised chip.
  - Rows activate on pointer-down, so they feel instant.
  - A faint hint can appear at the right on hover.
- **Tab and chat rows**.
  - Hover adds the darker step. Multi-selected rows keep a tint, which deepens on hover.
  - The trailing slot has no width at rest. While the pointer is anywhere in the sidebar, a faint time-since-last-used stamp appears in it, on the active row too. Main tracks the hover, so this also works when the pointer arrives from the page.
  - Hovering or focusing a row swaps the stamp for the close button.
- **Chats section.**
  - **Collapse:** about 150 ms, ease-out. The tabs label rises into place while the rows clip upward from the top and fade.
  - **Expand:** about 150 ms, ease-out. The tabs label falls into place while the rows reveal from the top and fade in. The chevron flips between pointing down and pointing sideways.
  - **Header:** the two actions show while the pointer is in the section, and the label darkens on hover. At rest, small unread and needs-input dots sit at its right end.
  - **Drag target:** a drag hovering over the section tints it faintly.
  - **Row limit:** a thin draggable divider sets how many chat rows show, with a count of hidden rows and their badges.
- **Rows appearing, closing and reordering.**
  - **New tab:** its row is inserted at the top of the Tabs list. An empty chip appears at once, and the rows below slide down one 34 px pitch over about 150 ms, ease-out; the label appears partway through. The new row becomes the active chip. A new chat opened from the sidebar shows its row already in place, with no insert motion.
  - **Close:** the active chip jumps to the next row at once. The closing row fades while the rows below slide up one pitch, in about 100 ms.
  - **Active chip:** it never glides between rows; it jumps.
  - Reorders glide. Rows created in the background wait until the pointer leaves the sidebar before reshuffling.
- **Drag.** Rows part to open a gap, and a drop settles with a short glide. The floating preview resizes smoothly, for example into a tile over the pinned grid.
- **Arrival.** When a chat arrives in the background, the chats destination's icon briefly gives way to the arriving companion's mini face, then returns. The whole sequence is brief ([DS-17](#ds-17)).
- **Downloads.** The header button appears once there are downloads. A new download flies into it, the button pulses a highlight for a moment, and a thin progress bar runs along its bottom edge.
- **Hover cards.** Resting on a chat or tab row for about 1 s, or on the Routines row for under 450 ms, shows that row's preview card beside the sidebar. Leaving fades it out in about 100 ms. Other destinations have no card.
- **Popovers and menus.** The options popover, the overflow dropdown, the main menu and the palette appear at full size and opacity within one frame, and Escape or a second click removes them within one frame. The palette may show a centred searching state briefly, then its results.
- **Tooltips.** Custom dark tooltips appear about 500 ms after the pointer rests on a chrome control. They draw in their own window, so they can cross the page.
- **Footer.** Hover fills the whole footer strip (about x 10–290, 44 tall) and shows a dark tooltip above it.
- **Update capsule.** Hover lightens the fill with no size change. It appears with a horizontal reveal ([Design choices: shell](#shell-design-choices)).
- **Status cues**.
  - Status is always a dot, never a number.
  - A pinned tile that needs attention pulses a warning tint.
  - A chat avatar that needs attention does a small bounce.
  - A routine run shows a small routine glyph beside the avatar, never on it ([DS-67](#ds-67)); while the chat works, the working mark shows instead.
- **Companion at work**.
  - The controlled tab's row gets a soft glow in that companion's colour, and the page gets an inner glow plus a notice bar.
  - The control listing that chat's open pages glows in the companion's colour.
  - The toolbar, pill and sidebar background don't change.
- **Toolbar.**
  - Hover is one neutral step darker. Inert history controls get nothing.
  - The reload glyph animates while loading.
  - Back and forward list their history on a long press or right-click.
  - Tooltips show the shortcuts as key chips.
- **Address pill.**
  - Hover deepens the fill one neutral step. On destination surfaces and an unfocused new tab, the pill may rest at that deeper step ([DS-98](#ds-98)).
  - **Editing:** in one frame, the pill turns white in place, a 16 px search glyph appears 12 px in, and the full address shows left-aligned in the strong tone, fully selected, with the selection in a light tint of the profile hue. A 2 px ring in the same light tint grows in outside the pill over about 100 ms. Escape snaps everything back in one frame.
  - **Suggestions** sit in a layer above the page, which reserves about 100 px of height.
  - **New tab:** the pill arrives focused, with a placeholder and a right-aligned hint (a small grey key chip plus muted text) saying one key hands the text to the companion.
  - A bypassed certificate tints the pill red, and a zoom chip rolls in vertically, holds briefly, then rolls out.
- **Bookmarks bar.** Hover shows a rounded tint and pressing deepens it. A folder opens its dropdown card, and a second click closes it. While dragging, a thin insertion line marks the drop point, and a folder highlights when you hover its middle.
- **Page beside a chat.** The page becomes an inset rounded card with its own shadow, changing shape in the same shared transition. The toolbar's right cluster gains the divider and that chat's page controls.
- **Overlays.**
  - With the companion card open, only the content area is blurred and lightened. The sidebar and bars stay sharp and usable.
  - Hover cards, the palette and tooltips draw over the page without hiding or dimming it.
- **Theme.** The whole window repaints in one frame, with no crossfade.

### Requirements

- <a id="ds-01"></a>**DS-01** `shell` **One sheet.** The toolbar, bookmarks bar and page share one surface that touches the window's top, right and bottom edges.
  - **Shape:** only the top-left corner is rounded, at 10 px. A soft shade 2–2.5 px wide sits on the sidebar's side of the seam, with no stroke.
  - **Inside:** a one-device-pixel hairline at y 77 separates the bars from the page, with no shadow under it. The page view has square corners and no gutter.
  - *Before:* the bars sit on the tinted window background, and the page is a separate rounded card (12 px radius) with a shadow and an 8 px gutter.
  - *Files:* `App.tsx`; `styles.css` (`.workspace`, `.content`, `.pane`); `src/main/tabs.ts` (`view.setBorderRadius(12)` becomes 0).
  - *Test:* in a screenshot, the column just right of the sidebar edge is sheet-coloured from top to bottom, the seam shade is at most 3 px wide, and there is no gutter at the right or bottom.
  - *Supersedes:* ux-plan "Content: one rounded card filling the rest of the window". Elsewhere in the spec, "content card" now means the page area of the sheet.
- <a id="ds-02"></a>**DS-02** `shell` **Inset page only beside a chat.** The page becomes an inset rounded card with its own shadow only while the side panel, or a chat with the page beside it, is open. The change runs on the shared layout timeline ([DS-84](#ds-84)). *Files:* `App.tsx`, `styles.css`, `src/main/tabs.ts`, `components/AgentPanel.tsx`.
- <a id="ds-03"></a>**DS-03** `shell` **Neutral chrome with a profile hue.**
  - The sidebar tint is flat (no gradient) and comes from a profile-hue token that is independent of the companion. Hover fills on the ground are a darker step of the same tint (a lighter step in dark mode).
  - The same token drives the address field's focus ring and text selection, the hue-filled button in the main menu, the selected settings row, links and progress ([colour roles](#colour-roles)).
  - The toolbar, pill, bookmarks bar, labels and icons are neutral, and so are primary buttons on pages ([DS-138](#ds-138)).
  - **Dark:** the ground is a mid slate of the hue, lighter than the sheet. The sheet is the lightest plane in light mode and the darkest in dark mode.
  - The companion accent never tints the chrome; see the colour roles above.
  - *Before:* `--tint-color`, `--focus-ring-color` and `--text-link` point at the companion accent; the sidebar has a top-down wash (lavender in light mode, purple in dark), and the dark ground is purple.
  - *Files:* `styles.css` (`:root` tokens, `--sidebar-tint-*`, `--sidebar-wash`, `--tint-color`, `--focus-ring-color`, `--text-link`, `--bg-sidebar`), `theme.ts`, `src/shared/accent.ts`, `src/shared/theme.ts` (`CHROME_BACKGROUND`), `src/main/theme.ts`.
  - *Test:* switching companion leaves every pixel of the sidebar, toolbar, pill and settings nav unchanged. In dark mode, a sample of the ground is lighter than a sample of the sheet.
  - *Supersedes:* [ST-26](feature-spec.md#st-26) ("accent or profile-colour wash" becomes the profile hue only); the "Tokens" bullet and the "lavender accent" wording in ux-plan. It narrows [ST-24](feature-spec.md#st-24): the accent no longer reaches the chrome.
- <a id="ds-04"></a>**DS-04** `shell` **Sidebar width and handle.**
  - The default is 300 px, about 20% of a 1470 px window. The resize range stays as specified.
  - The handle is 8 px wide, centred on the edge, from y 8 to 8 px above the bottom. It shows only the resize cursor, with no hover line.
  - *Files:* `src/shared/ipc.ts` (`SIDEBAR_WIDTH`), `ui/ui.css` (`.ui-seam::after` hover), `components/sidebar/sidebar.css` (`.sidebar__seam`).
  - *Supersedes:* the default of 260 in [SH-03](feature-spec.md#sh-03) and in ux-plan "Size and visibility".
- <a id="ds-05"></a>**DS-05** `shell` **Sidebar header row.**
  - It is the toolbar's height, 40 px. The window controls sit at x 14, 37 and 60, y 12.
  - Options and search are 32 px boxes at x 226 and 262 (4 px apart, 6 px from the right edge), with 16 px glyphs. Their radius-8 hover fill stays while their popover is open.
  - The first row (New Tab) starts at y 49.
  - The downloads button moves here from the toolbar and shows only while downloads exist. A new download makes it pulse a highlight briefly, and a thin progress bar runs along its bottom.
  - *Built:* the row and the toolbar are 40 px (`--bar-height`), and the downloads button sits in the header while downloads exist. Main reads the window controls' real frame back after each move (`getWindowButtonPosition`, `measureTrafficFrame` in `logic/traffic.ts`) and centres them on it, falling back to a 16 px frame (`tests/trafficFrame.test.ts`).
  - *Files:* `components/sidebar/Sidebar.tsx`, `components/Toolbar.tsx`, `components/sidebar/sidebar.css` (`.side-header`), `src/main/window.ts` (traffic-light position).
  - *Supersedes:* the downloads placement in [SH-32](feature-spec.md#sh-32).
- <a id="ds-06"></a>**DS-06** `shell` **Sidebar order.** From the top:
  1. the pinned grid (only when tabs are pinned);
  2. New Tab;
  3. the destinations in this order: All chats, Routines, Connectors, Skills, Meetings ([DS-105](#ds-105)), then the always-present overflow row ([DS-89](#ds-89));
  4. the chats label and its rows;
  5. the tabs label and its rows;
  6. empty drag space;
  7. the footer.

  - **Spacing:** 2 px between rows; 10 px from the overflow row to the chats header; 5 px after the header; 14 px from the last chat row to the tabs label; 9 px after the label.
  - *Before:* destinations, chats, pinned grid, New Tab, then tabs, with no tabs label.
  - *Files:* `components/sidebar/Sidebar.tsx`, `TabsSection.tsx`, `Destinations.tsx`, `src/shared/url.ts` (`DESTINATIONS` order).
  - *Supersedes:* [SH-08](feature-spec.md#sh-08) and ux-plan's "New Tab row just above the tab list". It also refines [SH-10](feature-spec.md#sh-10): the grid sits at the top of the fixed header.
- <a id="ds-07"></a>**DS-07** `shell` **Fixed header, one list.**
  - The top block (pinned grid, New Tab, destinations) never scrolls.
  - Chats and tabs scroll as one list with a hidden scrollbar and faded edges.
  - A hairline under the header fades in only while content is scrolled beneath it.
  - Edge badges jump to an active or needs-input row that is out of view.
  - *Before:* destinations scroll with everything else; the chats section scrolls on its own (capped at 46% of the height) and the tabs scroll separately.
  - *Files:* `Sidebar.tsx`, `ChatsSection.tsx`, `TabsSection.tsx`, `sidebar.css`.
  - *Refines:* [SH-13](feature-spec.md#sh-13).
- <a id="ds-08"></a>**DS-08** `shell` **Row geometry and type.**
  - **Size:** 32 px rows on a 34 px pitch (2 px gaps), radius 7–8, the chip inset about 10 px from both sidebar edges.
  - **Columns:** 16 px icons at x 20; 20 px avatars at x 18; text from x 44. The trailing slot is 20×20, with its right edge 8 px inside the row.
  - **Text:** 13 px regular on a 16 px line. Titles (chats included) fade out over their last 40–44 px, ending about 10 px before the row edge, with no ellipsis. Unread titles are medium weight, not heavier.
  - **Tones:** New Tab uses the strong tone.
  - *Before:* 33 px pitch (1 px gaps), medium weight (500), unread at about 650, an 18 px icon box, a faint New Tab, and ellipses.
  - *Files:* `sidebar.css` (`.side-row`, `.side-row__icon`, `.side-row__title`), `TabsSection.tsx`, `ChatsSection.tsx`, `components/sidebar/CompanionAvatar.tsx`.
- <a id="ds-09"></a>**DS-09** `shell` **Destination rows.**
  - The label and icon share one muted tone, at regular weight.
  - Hover gives a fill one step darker than the ground (radius 8) and near-black text and icon.
  - The active destination is the raised chip with a neutral icon, never the accent.
  - Rows activate on pointer-down, and they open the destination surface, not a tab ([DS-99](#ds-99)).
  - Status is shown only as dots and a faint countdown.
  - *Before:* All chats shows amber and purple number pills, and the active icon takes `var(--accent)`.
  - *Files:* `components/sidebar/Destinations.tsx`, `sidebar.css`.
  - *Supersedes:* the unread and needs-input counts on All chats in [SH-07](feature-spec.md#sh-07) (they become dots; the right-click "mark all read" stays).
- <a id="ds-10"></a>**DS-10** `shell` **Active chip and multi-select.**
  - **Light:** a near-white fill about one step above the sheet, radius 7–8, a half-pixel bright rim on all four sides, and a soft shadow about 2 px down with about 8 px blur (reaching about 9 px below and 5 px at the sides).
  - **Dark:** a much lighter slate fill (about four times the hover step above the ground), a faint light rim and a short dark shadow. Hover stays one step.
  - **Multi-select:** selected rows keep a neutral tint that deepens on hover.
  - *Before:* the active row reuses the card colour and the card shadow.
  - *Files:* `sidebar.css` (`.side-row--active`, `.pin-tile--active`), `styles.css` (new `--shadow-chip` and `--chip-rim` tokens).
- <a id="ds-11"></a>**DS-11** `shell` **Section labels.**
  - 13 px regular on a 16 px line box, sentence case, muted, no letter-spacing, at x 18 (the icon column's left edge).
  - The chats chevron comes after the word, is always visible, and turns between pointing down (open) and sideways (closed). The label darkens on hover.
  - A plain tabs label, with no controls and no hover change, shows whenever the chats section shows.
  - *Before:* "CHATS" in capitals, letter-spaced and semibold, with the chevron in front, and no tabs label.
  - *Files:* `ChatsSection.tsx`, `TabsSection.tsx`, `sidebar.css` (`.side-section__toggle`).
- <a id="ds-12"></a>**DS-12** `shell` **Chats header actions.**
  - Two 20 px actions, search chats and new chat, at the right end of the 24 px header (x 238 and 262), with a text Clear before them while there are unpinned chats (the Your tabs header has the same Clear for unpinned tabs).
  - They are hidden at rest and fade in while the pointer or focus is in the chats section ([DS-141](#ds-141)). At rest, the header's right end shows the unread and needs-input dots instead.
  - Search chats opens the palette filtered to chats ([DS-90](#ds-90)).
  - *Before:* three buttons (search, options, new chat), always visible.
  - *Files:* `ChatsSection.tsx`, `sidebar.css` (`.side-section__actions`).
  - *Refines:* [SH-11](feature-spec.md#sh-11).
- <a id="ds-13"></a>**DS-13** `shell` **Collapse animation.**
  - The chats section stays mounted when collapsed.
  - Collapse takes about 150 ms, decelerating. The rows clip from the top and fade together with the height change, and everything below slides up by the same amount.
  - Expand reverses it: the rows reveal from the top while fading in, and the chevron flips.
  - Reduce Motion makes it instant.
  - *Before:* the rows unmount with no animation.
  - *Files:* `ChatsSection.tsx`, `sidebar.css`, `styles.css` (`--motion-layout`).
- <a id="ds-14"></a>**DS-14** `shell` **Trailing slot.**
  - The slot has no width at rest.
  - While the pointer is anywhere in the sidebar, including when it arrives from the page (main tracks this), the faint time-since-last-used stamp shows, on the active row too.
  - Hovering or focusing a row swaps the stamp for close. The active row shows close only when hovered or focused.
  - *Built:* main's `SidebarPointerWatch` (`src/main/sidebarPointer.ts`) reports the pointer in the sidebar and stops polling when it leaves or the window blurs, hides or is minimised; those three also hide the stamps (`tests/sidebarPointer.test.ts`).
  - *Files:* `TabsSection.tsx`, `ChatsSection.tsx`, `sidebar.css`, `src/main/window.ts` (sidebar hover signal).
- <a id="ds-15"></a>**DS-15** `shell` **Row motion.**
  - **Insert:** the row's height opens from 0 to 34 px over about 150 ms, decelerating. The chip shows first and its content one frame later, and the rows below glide down with it.
  - **Close:** the active chip jumps to the next row at once. The closing row fades and folds away in about 80–100 ms while the rows below slide up.
  - **Active chip:** it never glides between rows; it jumps.
  - **Reorders** glide over about 150 ms. Rows created in the background still wait until the pointer leaves the sidebar.
  - Reduce Motion makes all of this instant.
  - *Files:* `TabsSection.tsx`, `ChatsSection.tsx`, `sidebar.css`.
- <a id="ds-16"></a>**DS-16** `shell` **Drag motion.**
  - The gap opens with a glide, and a drop settles with a short glide.
  - A section under a drag tints faintly.
  - The preview morphs into a tile over the pinned grid.
  - *Files:* `components/sidebar/dnd.ts`, `sidebar.css`.
- <a id="ds-17"></a>**DS-17** `shell` **Arrival cue.** When a chat arrives in the background, the All chats icon plays a short arrival sequence ([Design choices: shell](#shell-design-choices)). Reduce Motion skips it. *Files:* `components/sidebar/Destinations.tsx`, `sidebar.css`.
- <a id="ds-18"></a>**DS-18** `shell` **Footer.**
  - **Layout:** no divider above it. The profile button is 153×36 at x 20, 10 px from the bottom.
  - **Left:** a 20 px avatar with a thin ring in the profile hue that works as a gauge (its measure is set in [Design choices: shell](#shell-design-choices)), then the local name in muted 13 px regular text with an ellipsis.
  - **Right:** the update capsule: 109×28, 14 px from the right edge, solid profile hue, a 14 px glyph and a white 12 px semibold label. It enters with a horizontal reveal, and hover lightens the fill with no size change.
  - **API key chip:** uses the same capsule shape.
  - **Hover and press:** hover fills the whole footer strip (about x 10–290, 44 tall) and shows the dark tooltip above it ([DS-95](#ds-95)). A click opens the in-window main menu ([DS-93](#ds-93)), and the footer stays pressed while it's open.
  - *Built:* no divider, the ring avatar and muted name, the capsule; the footer tooltip is placed against the 44 px strip, not the 36 px button (`useTooltip`'s `anchor`, `tests/footerTooltip.test.ts`).
  - *Files:* `components/sidebar/SidebarFooter.tsx`, `sidebar.css` (`.side-footer`, `.profile-row`, `.profile-badge`, `.key-chip`).
  - *Refines:* [SH-16](feature-spec.md#sh-16).
- <a id="ds-19"></a>**DS-19** `shell` **Sidebar show and hide.**
  - Opening and closing run on the shared layout timeline ([DS-84](#ds-84)). The sidebar translates as one block, with its contents clipped at the moving edge and never reflowed.
  - It takes about 150 ms with no overshoot: decelerating on hide, easing in and out on show. The sheet, the pill and the native page-view bounds move in the same frames.
  - **Window controls:** hidden on the first frame of a hide (`setWindowButtonVisibility(false)`) and shown on the last frame of a show, so the collapsed toolbar has no inset.
  - The collapsed toggle shows the unread or needs-input dot.
  - Reduce Motion makes it instant.
  - *Before:* the hidden sidebar is simply removed from the layout (`display: none`), and the toolbar gets an inset of about 80 px for the controls.
  - *Files:* `App.tsx`, `sidebar.css` (`.sidebar--hidden`), `components/Toolbar.tsx` (drop `trafficInset`), `src/main/window.ts`, `src/main/tabs.ts`.
  - *Supersedes:* the toolbar inset in [SH-02](feature-spec.md#sh-02) and ux-plan "Sidebar › Header", and this document's earlier wipe on a spring.
- <a id="ds-20"></a>**DS-20** `shell` **Toolbar left cluster.**
  - The toolbar is 40 px tall.
  - The toggle sits at sheet + 8. Back, forward and reload sit at sheet + 48, + 82 and + 116: 32 px boxes, 2 px apart.
  - Glyphs: a 16 px toggle in the strong tone, 18 px thin chevrons for back and forward, and a 16 px reload.
  - Disabled controls fade and get no hover fill. On chat pages, back, forward and reload are inert.
  - The reload glyph animates while loading.
  - *Before:* the toolbar is 48 px tall, back and forward are arrows, and the controls sit about 37 px apart.
  - *Files:* `components/Toolbar.tsx`, `styles.css` (`.toolbar`, `.toolbar__group`).
- <a id="ds-21"></a>**DS-21** `shell` **Address pill shape and place.**
  - **Look:** a flat neutral fill with no border, shadow or white raised field. Radius 8, height 32, text 14 px.
  - **Width and position:** exactly 45% of the sheet's width (527 px at a 1170 px sheet, 662 px with the sidebar collapsed), centred on the sheet's midline. Position it against the midline rather than with flex centring. It shrinks, rather than shifting, to clear the side clusters.
  - **States:** hover deepens the fill one step, and an insecure page tints it red.
  - *Before:* a white raised field with a shadow and a hover ring, 54% wide (capped at 640 px), centred between the clusters.
  - *Files:* `components/AddressPill.tsx`, `styles.css` (`.pill`, `.toolbar__center`).
- <a id="ds-22"></a>**DS-22** `shell` **Breadcrumb tones.**
  - The prefix (the section or host) is in mid-grey, and the slash and title are in the light tone, both regular weight.
  - On destination surfaces the prefix is "Apex".
  - *Before:* a semibold host, and `.pill__crumb--last` in the primary tone at weight 600, which reverses this order.
  - *Files:* `AddressPill.tsx`, `components/address.ts`, `styles.css`.
- <a id="ds-23"></a>**DS-23** `shell` **Pill editing.**
  - **Entry, in one frame:** the pill turns white in place; a 16 px search glyph appears 12 px in; the full address shows left-aligned at 14 px in the strong tone, fully selected, with the selection in a light tint of the profile hue.
  - **Ring:** a 2 px ring outside the pill in the same light profile-hue tint (dimmer in dark mode) grows in over about 100 ms. It is never neutral grey and never the companion accent.
  - **Exit:** Escape or blur snaps back in one frame.
  - **Suggestions:** grow downward in the overlay layer ([DS-96](#ds-96)) and never hide the page.
  - The bookmark star uses a neutral or profile colour. The zoom chip rolls in vertically, holds briefly and rolls out.
  - *Before:* an accent ring plus a halo, and `useOverlay` hides the page while editing.
  - *Files:* `AddressPill.tsx`, `styles.css` (`.pill--editing`, `.suggestions`).
- <a id="ds-24"></a>**DS-24** `shell` **Contextual right cluster.**
  - **Apex pages:** empty on chat pages, destination surfaces and the new tab. Internal tab pages (settings, history, bookmarks, downloads) get at most one 32 px utility button at the far right, 8 px in: the extensions button.
  - **Websites:** a chat-about-this-page button that toggles the side panel (⌘J) and carries the working and approval indicators.
  - **While a chat shows pages beside it:** a thin divider, then that chat's pages with expand and hide.
  - **Split:** the split button shows only while the view is split.
  - **Avatar:** the toolbar avatar button is removed. The card opens from the chat header, chat rows and reply avatars.
  - **Activity memory:** a small glyph that breathes slowly while it records, hidden while activity memory is off.
  - *Before:* downloads, split, a companion chip and the avatar always show.
  - *Files:* `components/Toolbar.tsx`, `styles.css` (`.companion-btn`, `.avatar-btn`).
  - *Supersedes:* [SH-32](feature-spec.md#sh-32) and ux-plan "Actions on the right". The toolbar-avatar entry in [CO-18](feature-spec.md#co-18) no longer applies.
- <a id="ds-25"></a>**DS-25** `shell` **Bookmarks bar.**
  - **Size and inset:** about 37 px tall. Item boxes are 29 px tall, start at sheet + 12 and have 8 px of inner padding.
  - **Items:** favicons, or a 16 px outline folder glyph, with 12 px labels in the strong tone. Titles fade at the end.
  - **States:** no chip at rest, a rounded tint (radius 8) on hover and a deeper one on press.
  - **Folders:** a click opens an in-window dropdown card directly under the item, left-aligned ([DS-94](#ds-94)): radius 12, a hairline, a soft shadow, and rows with a 16 px favicon and an about 15 px title. A second click closes it, and so does Escape.
  - *Before:* 30 px tall, with coloured letter tiles (`.monogram`) and secondary-tone text.
  - *Files:* `components/Bars.tsx`, `styles.css` (`.bookmarks-bar`, `.bookmark-chip`, `.monogram`).
  - *Refines:* [SH-47](feature-spec.md#sh-47). Folders arrive with A.
- <a id="ds-26"></a>**DS-26** `shell` **Agent at work.**
  - The controlled tab's row gets a soft glow in that companion's colour, replacing the pulsing ring.
  - The page gets a soft inner glow and the notice bar ([OV-21](feature-spec.md#ov-21), [OV-22](feature-spec.md#ov-22)), replacing the heavy stroke and the bottom pill.
  - The glow fades in and out rather than cutting, driven by the presence store ([DS-68](#ds-68)).
  - Chrome colours never change.
  - *Files:* `styles.css`, `TabsSection.tsx`, `components/Toolbar.tsx`, `src/preload/page.ts`.
- <a id="ds-27"></a>**DS-27** `shell` **Status cues.**
  - Unread and needs-input are dots, never numbers.
  - A pinned tile that needs attention pulses a warning tint.
  - A chat avatar that needs attention bounces once.
  - A routine-run chat shows a small routine glyph beside the avatar, never on it ([DS-67](#ds-67)); while it works, the working mark shows instead.
  - Reduce Motion keeps the marks and drops the movement.
  - *Files:* `TabsSection.tsx`, `ChatsSection.tsx`, `components/sidebar/CompanionAvatar.tsx`, `sidebar.css`.
- <a id="ds-28"></a>**DS-28** `shell` **Still at rest.**
  - With no state change, the chrome's frames are identical over 5 s, in light and dark mode.
  - This now includes the new tab: only the live companion's pixels may change.
  - The looping chrome cues (`agent-ring`, `side-agent`, `pop`, `zzz`, `chat-attention`) are replaced by the [DS-67](#ds-67) marks and a single bounce.
  - *Files:* `styles.css`, `components/sidebar/sidebar.css`, `components/Toolbar.tsx`, `chat/chat.css`, `components/NewTabPage.tsx`.
  - *Test:* compare two screenshots of an idle window taken 5 s apart, in both modes: the sidebar, toolbar and bookmarks bar differ by zero pixels, and an idle new tab differs only inside the companion's canvas.
- <a id="ds-89"></a>**DS-89** `shell` **Overflow row always present.**
  - It is the last row of the top block and always shows, even when nothing is hidden.
  - A click opens an in-window dropdown ([DS-94](#ds-94)) 4 px under the row: 272 wide, radius 12, a hairline and a shadow. It holds 36 px items with 16 px glyphs and muted labels: the hidden destinations, a hairline, then sidebar options. It may overlap the chats list.
  - The row shows the pressed fill while it's open. A destination chosen from it opens on the destination surface ([DS-99](#ds-99)) and makes the overflow row the active chip.
  - It opens and closes within one frame ([DS-83](#ds-83)). Escape closes it, and focus returns to the row.
  - *Before:* More shows only when something is hidden, and it opens a native menu.
  - *Files:* `Destinations.tsx`, `ui/Popover.tsx`, `ui/ui.css`, `sidebar.css`.
  - *Refines:* [SH-07](feature-spec.md#sh-07) (the overflow row).
- <a id="ds-90"></a>**DS-90** `shell` **Sidebar search opens a command palette.**
  - The sidebar's search button, and its shortcut, open a palette centred on the window (not the sheet), about a quarter of the way down.
  - **Card:** about 640 wide, radius about 20, slightly translucent near-white, a large soft shadow, and no dim over the page.
  - **Input:** about 20 px, with a light shortcut hint at the right.
  - **Filters:** 24 px chips under the input: tabs and chats, plus Apex's pages.
  - **Results:** 40 px rows on a 44 px pitch, each with a 20 px icon and a label. The first row is preselected with a neutral fill and a muted go-hint with an arrow.
  - It appears within one frame, and Escape closes it at once. The chats header's search action opens it filtered to chats.
  - It reuses the [SH-35](feature-spec.md#sh-35) palette component and its keyboard model.
  - *Before:* an inline `side-search` filter field inside the sidebar.
  - *Files:* `components/sidebar/Sidebar.tsx` (remove `side-search`), new `components/CommandPalette.tsx` and `components/palette.css`, `App.tsx`, `src/main/menu.ts` (shortcut), the overlay layer ([DS-96](#ds-96)).
  - *Test:* with a web page showing, opening the palette leaves the page visible behind it.
- <a id="ds-91"></a>**DS-91** `shell` **Sidebar options popover.**
  - Anchored under the options button, about 270 wide and 5 px below it (x 15–285), radius 16, with a hairline and a shadow. It has no title and no close button.
  - A muted section label, then 36 px check rows: a round check (a filled ink disc with a white tick when on, a thin grey ring when off), the destination's 16 px glyph and a muted label.
  - A full-width hairline, then label-plus-segmented rows (the control is 164×32 with a 2 px inset and 28 px segments; the selected segment is a white raised pill).
  - The options button stays pressed while it's open. It opens and closes within one frame.
  - It fits inside the sidebar's bounds, so it draws in the chrome renderer, as [SH-09](feature-spec.md#sh-09) allows.
  - *Before:* switches, an uppercase heading and a close button.
  - *Files:* `components/sidebar/SidebarOptions.tsx`, `sidebar.css` (`.side-options*`), `ui/controls.tsx` (a round check variant).
  - *Refines:* [SH-09](feature-spec.md#sh-09).
- <a id="ds-92"></a>**DS-92** `shell` **Row preview cards.**
  - Resting on a chat or tab row for about 1 s, or on the Routines row for 450 ms or less, shows a card at x = sidebar edge + 4, about 261 wide, with its top 12 px above the row's top. Radius 12, a hairline and a shadow, 15 px inset.
  - **Chat card:** the title (semibold, up to two lines), the opening prompt in a grey bubble, then the reply, muted and clipped with a fade.
  - **Tab card:** a 16:9 thumbnail (from `pages.snapshot`), then the title and the host.
  - **Routines card:** the next runs, or one muted line when there are none.
  - Moving to another row glides the card there instead of reopening it. Leaving fades it out in about 100 ms. Other destinations have no card.
  - *Files:* new `components/sidebar/HoverCard.tsx`, `TabsSection.tsx`, `ChatsSection.tsx`, `Destinations.tsx`, `src/main/tabs.ts` (`capture`), the overlay layer ([DS-96](#ds-96)).
  - *Refines:* [SH-07](feature-spec.md#sh-07) (the upcoming-runs popover) and [SH-11](feature-spec.md#sh-11) (previewable rows).
- <a id="ds-93"></a>**DS-93** `shell` **In-window main menu.**
  - The footer opens a card 236 wide, left-aligned with the footer button, with its bottom 8 px above it. Radius 12, a hairline and a shadow.
  - **Header block:** the profile row, a meter row (the same measure as the [DS-18](#ds-18) gauge), and one 32 px hue-filled button.
  - **Then:** 30 px rows (15 px glyphs 15 px in, labels 40 px in, chevrons or shortcut glyphs right-aligned), hairline groups with about 6 px padding, and an update row washed in the profile hue when an update exists. Submenus open as side cards in the overlay layer ([DS-96](#ds-96)).
  - The contents come from the `mainMenu` data ([SH-54](feature-spec.md#sh-54)). It opens and closes within one frame.
  - The card fits inside the sidebar's bounds, so it no longer needs the native interim menu.
  - *Before:* a native `Menu.popup`.
  - *Files:* `SidebarFooter.tsx` (`openMainMenu`), `components/sidebar/logic/menus.ts`, new `ui/PopoverMenu.tsx` (built on [DS-94](#ds-94)), `ui/menu.ts`.
  - *Refines:* [SH-16](feature-spec.md#sh-16).
- <a id="ds-94"></a>**DS-94** `shell` **In-window popover menu primitive.**
  - One component serves every in-window menu: the overflow dropdown, sidebar options, the main menu, bookmark folders, the composer menus ([DS-125](#ds-125), [DS-126](#ds-126)) and the card's switcher and more menus.
  - **Card:** white (raised in dark mode), a hairline, a soft shadow, radius 12–14, 5 px padding, neutral throughout.
  - **Rows:** 36 px (30 px in the main menu); a glyph 12–14 px in; the label 36 px in; a trailing check circle, lock, chevron or shortcut 12 px from the right; a light grey rounded fill (radius 8) on the hovered row.
  - **Parts:** an optional search row at the top (no box; it filters the rows, and the arrow keys move through them), full-width hairline dividers with about 4 px of space around them, switch rows, and headed groups.
  - **Placement:** below the anchor by default, upward when anchored in the composer, and clamped inside the window. Submenus cascade about 3 px to the side, with their own search and scrolling list, and the parent row stays highlighted.
  - The anchor shows its pressed fill while the menu is open. Escape closes it and focus returns to the anchor. It appears and disappears within about one frame ([DS-83](#ds-83)).
  - A menu that would cross into the page draws in the overlay layer ([DS-96](#ds-96)); one that fits inside its renderer draws there.
  - Native menus stay for context menus.
  - *Before:* native `showMenu` popups.
  - *Files:* new `ui/Popover.tsx` and `ui/MenuList.tsx`, `ui/menu.ts`, `ui/overlay.ts`, `ui/ui.css`, `ui/logic/keys.ts`.
  - *Test:* keyboard navigation (arrows, Home and End, type to filter, Escape), and every menu stays inside the window in a 600 px-tall window.
- <a id="ds-95"></a>**DS-95** `shell` **Dark tooltips.**
  - Icon buttons across Apex (chrome, chat header, composer, footer, details panel, settings and the card header) use one tooltip instead of the native `title`.
  - **Look:** near-black, radius 8, a thin lighter edge and a 13 px white label. Shortcuts render as small lighter key-cap chips.
  - **Delay:** about 500 ms over chrome controls and about 1 s over controls inside pages. It appears at once after the delay.
  - **Placement:** centred 6–8 px below the anchor; above it for footer, composer and start-surface controls; shifted to stay inside the window near its edges.
  - It draws in a layer that can cross the page and leave the renderer's bounds ([DS-96](#ds-96)).
  - *Before:* native `title` tooltips.
  - *Files:* `ui/Button.tsx` (`tooltip` prop), new `ui/Tooltip.tsx`, `ui/logic/shortcut.ts`, `ui/ui.css`, `ui/overlay.ts`.
  - *Refines:* [SH-31](feature-spec.md#sh-31): the back, forward and reload tooltips are this tooltip, drawn in the overlay layer.
- <a id="ds-96"></a>**DS-96** `shell` **Overlay layer above the page.**
  - A transparent overlay view above the page views hosts the address suggestions, the palette, row preview cards, tooltips, and any menu or submenu that crosses into the page. Web pages are never hidden or dimmed by them.
  - Clicks pass through outside its content. Outside clicks, Escape and window blur close what it shows.
  - *Before:* `ui/overlay.ts` hides the page views while an overlay is open.
  - *Files:* new `src/main/overlay.ts`, `src/main/window.ts`, `src/main/tabs.ts`, `ui/overlay.ts`, `AddressPill.tsx`, `src/preload/ui.ts`.
  - *Test:* with a page playing video, opening the suggestions, the palette and a hover card never blanks or freezes the page.
  - *Refines:* [OV-01](feature-spec.md#ov-01).
- <a id="ds-97"></a>**DS-97** `shell` **New tabs open at the top.**
  - The New Tab row and ⌘T insert the tab at the top of the Tabs list (below the pinned tiles, in manual sort) and activate it, with the [DS-15](#ds-15) insert motion.
  - *Before:* the tab is inserted after the active tab.
  - *Files:* `src/main/tabs.ts` (`create` placement), `components/sidebar/logic/order.ts`, `Sidebar.tsx`.
  - *Implements:* [SH-08](feature-spec.md#sh-08) as written.
- <a id="ds-98"></a>**DS-98** `shell` **Pill rest tone on Apex surfaces** (optional).
  - On destination surfaces and an unfocused new tab, the pill may rest at its hover step.
  - Adopt it only if it reads well beside [DS-21](#ds-21).
  - *Files:* `AddressPill.tsx`, `styles.css`.

### <a id="shell-design-choices"></a>Design choices: shell

- **Profile hues.** Nine named hues: Stone (the default), Fig, Moss, Tide, Clay, Dusk, Plum, Sun and Peony.
  - Stone is a very low-chroma warm grey in light mode and a warm charcoal slate in dark mode, clearly not a cool hue.
  - The sheet is a slightly warm "paper" white in light mode and a warm near-black in dark mode. It is the lightest plane in light mode and the darkest in dark mode, with the dark ground one step above it.
- **One non-companion accent.** Links, progress, text selection, focus rings and the selected settings row all use the profile hue.
- **Raised chip.** A half-pixel inner highlight on all four sides plus a soft shadow about 2 px down, defined as Apex tokens (`--chip-rim`, `--shadow-chip`).
- **Footer gauge.** The avatar ring shows this month's API spend against your budget, or a full ring when no budget is set. The main menu's meter row shows the same figure.
- **Icons (lucide).**
  - Toolbar: `PanelLeft`, `ChevronLeft` and `ChevronRight`, `RotateCw`.
  - Sidebar header: `LayoutList` for sidebar options, `Search`, `Download`.
  - Rows: `Plus` for New Tab, `MessagesSquare` for All chats, `CalendarClock` for Routines, `WandSparkles` for Skills, `Plug` for Connectors, `Mic` for Meetings, `Ellipsis` for More.
  - Palette: `Search` in the input and `CornerDownLeft` for the go-hint.
  - Elsewhere: `Folder` for bookmark folders and `CircleArrowUp` for the update capsule.
- **Wording.**
  - Labels: New Tab, All chats, Routines, Skills, Connectors, Meetings, More, Chats, Your tabs, Restart to update, Add API key.
  - Breadcrumbs stay "Chat / ‹title›" and "Settings / ‹page›". Destination surfaces read "Apex / ‹page›".
  - Palette placeholder: "Jump to a tab or chat". The search button's tooltip uses the same words.
- **Tooltips.** A warm-up: once one tooltip has shown, the next one shows without the delay for about 1 s.
- **Motion.**
  - Sidebar slide and chats collapse: `--motion-layout` (about 150 ms) on `--ease-out`, with no overshoot.
  - Rows: inserts on `--motion-layout`, closes on `--motion-quick` (about 90 ms), reorders on `--motion-glide`. The active chip never animates its position.
  - Popovers and menus: `--motion-pop` (an opacity fade of 60 ms or less) and an instant exit.
  - **Arrival:** the mini face drops into the All chats icon with a small squash and settles.
  - **Update capsule:** it grows in from the footer's right edge.
- **At-work glow.** A wide, low-opacity inner aura on the page in the companion's colour, and a faint halo behind the controlled row's favicon.

---

## <a id="destination-pages"></a>Destination pages

This section covers the destinations (All chats, Routines, Connectors, Skills, Meetings, and Library from the overflow row) and how they take over the content area.

### Layout

**A surface, not a tab.** A destination fills the content area under the bars. While it shows, no tab or chat row is active, it never appears in the Tabs list, and the pill reads "Apex / ‹page›".

**Shared template** (Routines, the connectors page, Skills and Meetings):
- **Column:** 838 wide at x 466–1304, that is min(838, sheet − 2 × gutter), centred on the sheet.
- **Header:**
  - The title (about 18 px semibold in a 28 px heading box) at y 114, and a muted 14–15 px subtitle at y 150.
  - On the right: a plain text docs link with an arrow-out glyph (116×36 at y 123), then, 11 px later, a 36 px-tall near-black primary pill (radius 18, a 15 px leading glyph, 120–160 wide).
- **Row 2** (y 192):
  - On the left, a segmented control: a grey track 40 tall, 4 px inset, with a white 32 px selected pill that has a hairline edge and a small bottom shadow. Everything is fully rounded. Segment labels are 14–15 px medium: the selected one strong, the others muted.
  - On the right, a pill search field 36 tall (hairline border, 16 px magnifier, muted placeholder, about 278 wide; wider on pages without a filter), then, 10 px later, a 36 px round filter button.
- **Scrolling:** the header and row 2 are sticky. Content scrolls under them and fades out in a band of about 20 px below row 2. Content starts about 36 px under row 2.
- No icon tile and no accent colour anywhere.

**All chats** (the history destination):
- **Column:** 672 wide at x 549–1221, with the title at y 118.
- **Header actions:** a 37×36 more button, then a 109×36 ink pill.
- **Search:** a full-width 36 px pill field at y 174–210. It is focused on arrival, so its border shows the darker focus grey.
- **Filter row** (y 222): 28 px grey chips (three toggles, then two dropdown chips with chevrons) and, at the right, a sort control (a 14 px up-down glyph plus a muted label). Chips and list times are 13 px regular muted.
- **Results:** a 16 px semibold day heading at x 561, then single-line rows 672×48 on a 48 px pitch: a 30 px avatar at x 561, the 14–15 px title at x 603, and a muted time right-aligned to x 1201. No status pills and no second line.

**Routines:**
- Two segments, then a muted 15 px section label at y 274.
- Suggestion cards in two columns, 411×112 each, at x 467 and 892, with 14 px gaps (a 126 px row pitch). Each has a dashed hairline border, no fill and a radius of about 16; a glyph at the left; a 15–16 px semibold title and a two-line 13–14 px muted description 68 px in; and a 24 px dismiss button at the top right.
- A centred outlined pill, 147×36, about 80 px below the grid.

**Connectors:**
- A full-width search (a 744 px field) plus the filter button on one row.
- Sections with 16 px semibold headings, each followed by a three-column grid of 258×84 tiles at x 466, 756 and 1046 (32 px column gap, 84 px row pitch).
- Each tile: a white logo tile of about 44 px (hairline, radius about 10, a tiny shadow); the name, about 15 px semibold, at x 522; a one-line muted description with an ellipsis; and a trailing plus, or a chevron for connected ones.

**Skills:** three segments, then a centred empty state: a 30 px line glyph at y 501, a medium caption at y 543, and an ink pill and a white outlined pill side by side at y 579, 8 px apart.

**Meetings:** two segments, and a primary pill with a mic glyph. A centred empty state: a 416×234 media card, and a caption 20 px below.

**Library** (from the overflow row): a different, wide template.
- Content runs x 332–1438 (32 px gutters, fluid).
- Header at y 114–116: the title, then a 151×32 selector pill (an avatar, a label and a chevron). Two 32 px icon buttons sit at the far right (x 1362 and 1406).
- Row 2 at y 170: a four-segment track (395×40), the search field and a 36 px filter button.
- File cards 265×269 with 16 px gaps: a grey thumbnail tile, the filename, the muted size, a small grey type pill and a 24 px round more button. A centred outlined pill sits below the grid.

**Dark.** Ink pills invert to white with dark text. Filter chips and filled controls become a lifted grey. The selected segment is a lighter grey, never white. Secondary pills take the surface colour plus a hairline.

### Behaviour and motion

- **Switching:** the active chip moves and the content blanks in the same frame. The page appears in one step 200–300 ms later, with no slide or fade. Routines may show skeleton rows first, under the [DS-106](#ds-106) rule. A routines preview card that was open fades out over about 100 ms.
- **Arrival:** All chats focuses its search field.
- **Scrolling:** the header and row 2 stay; content fades out under the sticky edge.
- **Leaving:** clicking any tab or chat row leaves the destination surface.
- **Overflow:** the overflow dropdown lists the hidden destinations and a customise row ([DS-89](#ds-89)).

### Requirements

- <a id="ds-99"></a>**DS-99** `shell` **Destinations are a separate surface, not tabs.** This is the highest-impact change in this document.
  - Choosing a destination, or typing its `apex://` address, sets a window-level destination state.
  - The content area shows that page while the active tab's view is hidden but kept.
  - No tab or chat row is active; the destination row (or the overflow row) gets the chip. The pill reads "Apex / ‹page›".
  - Clicking any tab or chat row leaves the destination surface and restores that tab.
  - Destination pages never appear in the Tabs list. Middle-click and "open in new tab" keep their current behaviour.
  - *Before:* `openInternal` creates or reuses a tab, so an "All chats" row appears among the tabs.
  - *Files:* `src/main/tabs.ts` (`openInternal`; add `rail` to the snapshot), `src/shared/ipc.ts` (`TabsSnapshot.rail`), `src/shared/url.ts`, `App.tsx` (render the destination page in `.content`), `components/sidebar/Sidebar.tsx` (`currentDest` from the snapshot; `focusId`), `Destinations.tsx`, `components/address.ts`, `src/main/menu.ts`.
  - *Test:* clicking a destination leaves the tab count unchanged and shows no active tab row; clicking a tab row then restores that tab with its scroll position.
  - *Supersedes:* "Each row opens its apex:// page and reuses one tab per destination" in [SH-07](feature-spec.md#sh-07).
- <a id="ds-100"></a>**DS-100** `shell` **Destination page template.**
  - **Column:** min(838, sheet − 64), centred on the sheet.
  - **Header:** the title (about 18 px semibold), a muted 14–15 px subtitle, a text docs link with an arrow-out glyph, then a neutral ink primary pill (36 tall, radius 18, a 15 px leading glyph; it inverts in dark mode per [DS-138](#ds-138)).
  - **Row 2:** a segmented control on the left (a 40 px track, a 32 px pill, a 4 px inset); a pill search field (36 tall, hairline) plus a 36 px round filter button on the right.
  - **Sticky:** the header and row 2 stay put, with a 20 px fade under them. Content starts about 36 px below row 2.
  - **Empty states:** a 30 px line glyph, a medium caption, and an ink pill plus an outlined pill.
  - No accent icon tile, no accent buttons and no select dropdowns in the header.
  - *Before:* a 24 px weight-680 title, an accent icon tile, accent primary buttons and select dropdowns.
  - *Files:* `settings/kit.tsx` (`PageHeader`, `SearchField`), `settings/settings.css` (`.sp-header*`, `.sp-search`), `ui/Button.tsx` and `ui/ui.css` (the `ink` variant), `ui/controls.tsx` (segmented pill style), `pages/RoutinesPage.tsx`, `pages/SkillsPage.tsx`, `pages/ConnectorsPage.tsx`, `pages/Collections.tsx`.
- <a id="ds-101"></a>**DS-101** `shell` **All chats page.**
  - **Column:** 672 px. **Header:** the title, a 36 px more button and an ink pill.
  - **Search:** a full-width 36 px pill field, focused on arrival.
  - **Filters:** a 28 px chip row (toggle chips, then dropdown chips with chevrons) with a sort control at the right.
  - **Results:** 16 px semibold day headings, then single-line 48 px rows: a 30 px avatar carrying the [DS-67](#ds-67) state marks, a 14–15 px title, and a muted time right-aligned.
  - This replaces the coloured status pills and the second meta line.
  - *Files:* `pages/AllChats.tsx`, `chat/chat.css` (`.chats-page*`, `.chats-filters`).
  - *Refines:* [CH-45](feature-spec.md#ch-45) (presentation only; the groups, search, sorts and filters stay).
- <a id="ds-102"></a>**DS-102** `shell` **Routines page.**
  - Two segments (yours and past runs), the search field and the filter button.
  - With no routines (and below the list otherwise), a muted section label and a two-column grid of 411×112 suggestion cards with 14 px gaps: a dashed hairline border, radius 16, a 32 px Apex glyph tile, a title, a two-line muted description, and a dismiss button on hover.
  - A centred outlined guide pill below the grid.
  - *Files:* `pages/RoutinesPage.tsx`, `settings/logic/routines.ts` (suggestions), `settings/settings.css`.
- <a id="ds-103"></a>**DS-103** `shell` **Connectors page as a grid.**
  - A full-width search plus the filter button, then sections with 16 px semibold headings.
  - Each section is a three-column grid of 258×84 tiles with a 32 px column gap: a 44 px logo tile (hairline, radius 10), the name at 15 px semibold, a one-line muted description, and a trailing plus or chevron.
  - *Files:* `pages/ConnectorsPage.tsx`, `settings/settings.css`.
- <a id="ds-104"></a>**DS-104** `shell` **Skills page.** Three segments (yours, shared and built-in), and the centred empty state from [DS-100](#ds-100). *Files:* `pages/SkillsPage.tsx`.
- <a id="ds-105"></a>**DS-105** `shell` **Meetings and Library destinations.** Build both pages now; neither is deferred.
  - **Meetings:** two segments, an ink pill with a mic glyph, and an empty state with a 416×234 media card. Like the other destinations, a hidden Meetings row is listed in the overflow dropdown ([SH-07](feature-spec.md#sh-07)).
  - **Library:** under the overflow row, a wide, left-aligned template with 32 px gutters, a selector pill, four segments and 265×269 file cards with 16 px gaps.
  - *Files:* new `pages/MeetingsPage.tsx`, `pages/Collections.tsx` (Library), `src/shared/url.ts` (`DESTINATIONS`, `INTERNAL_PAGES`), `Destinations.tsx`.
- <a id="ds-106"></a>**DS-106** `motion` **Destination and page switching.**
  - The chip and the page swap in one frame, with no fade or slide. This also applies to settings pages ([DS-129](#ds-129)) and the card's tab bodies ([DS-36](#ds-36)).
  - The page frame (title, header controls and row 2) renders in the same frame as the click. If the data isn't ready within about 100 ms, skeleton rows show until it is, held for at least 100 ms so they never flash. The sheet is never blank.
  - A hover card that is open at the time fades out in about 100 ms.
  - *Files:* `App.tsx`, `ui/States.tsx` (skeleton), the destination pages.
  - *Test:* a frame recording of a destination click shows the new title in the first frame after the click.

### Design choices: destination pages

- **Words.** Titles, subtitles, segment and button labels keep their existing wording. The docs link opens Apex's help.
- **Icons (lucide).** `ArrowUpRight` for the docs link, `ListFilter` for the filter button, `ArrowUpDown` for sort, and each destination's own row icon, drawn at 30 px in line weight, for its empty state.
- **Routine suggestions.** The set from `settings/logic/routines.ts`, each with a 32 px glyph tile.
- **Library selector.** The selector pill picks whose files to show: a companion's face, its name and a chevron.
- **Meetings media card.** A still explainer image in the 416×234 slot.

---

## <a id="start-surface"></a>New tab and start surface

The new tab and an empty new chat are the same surface, and the side panel's empty state is a scaled-down version of it. Nothing is created in the chat list until the first send.

### Layout

Window px, in a 1170×845 content area.

**Background** (floor mode on, one companion):
- A static perspective floor of faint concentric rings ([Design choices: presence](#presence-design-choices)).
- It fades toward the centre and is denser at the edges. Light mode: the tiles are a step darker than the page. Dark mode: a step lighter.
- Nothing in it animates.

**Top row.**
- **Switcher pill:** a grey track 206×38 centred on the sheet (x 885), with its top at y 94, 16 px below the content top. A white selected segment, 132×38, holds a 30 px avatar and the name in the companion colour. A grey add segment, 74×38, holds an 18 px plus and a muted label.
- **Top-right:** two 38 px round buttons at x 1371 and 1413, y 94 (4 px apart, 19 px from the edge), with muted glyphs: the floor toggle and notifications.

**Figure.**
- Live and full body, in a square button centred on x 885, sized to the room between the switcher pill and the composer ([DS-72](#ds-72)).
- Its feet are at y 376.5, with a soft contact shadow, 39 px above the composer.
- A small round pencil badge (15–20 px) sits at its lower right.

**Composer.** The same component as on the chat page ([DS-58](#ds-58)):
- 640×114 at (565, 415.5), so its top sits at 40% of the content height. White, radius about 24, a hairline and an about 22 px soft shadow.
- The text field is 612×26 at (585, 432): 20 px side padding and about 16 px top padding.
- **Action row** at y 482: a 36 px round add button at x 577; the mode chip, 80×36 at x 1073 (a companion-tinted label and chevron, with no avatar here); and a 36 px round mic in the companion fill at x 1157, 12 px from the right.

**Tray.**
- A grey band the composer's width, tucked under it, extending about 44 px below its bottom edge, with a 24 px bottom radius.
- 32 px chips at y 536, 7 px apart, starting at x 577 (in line with the add button): a glyph plus a label. One chip carries a stack of three overlapping round logos. A help chip sits right-aligned, 14 px in (x 1121–1191).

**Ideas.**
- **Header row:** 28 tall at y 602, 28 px below the tray. A bulb glyph and a muted label at x 591 on the left; 28×28 previous and next buttons at x 1143 and 1173 on the right. Previous is disabled at the start.
- **Panel:** 640 wide and about 167–176 tall, from y 635, grey, radius about 20, in two columns. Left (23 px in): a semibold title, three muted lines and a see-all link with an arrow. Right: four rows of 318×33–37 on a 36 px pitch, each with a small coloured glyph and a label.

**Bottom-right.** A 38 px round white button with a hairline and a soft shadow at (1413, 866), 19 px from the right and bottom edges: the keep-awake switch.

**Address pill.** Focused on arrival: white, with the profile-hue ring, a placeholder, and a right-aligned key-chip hint saying one key hands the typed text to the companion.

**Dark.**
- The composer is one step above the page. The tray sits below the page level, darker than the composer. The ideas panel is a step above the composer.
- The switcher's selected segment is a lifted grey on a darker track, and the name in it is lifted slightly so it reads.
- The floor tiles are a step lighter than the page.

### Behaviour and motion

- **Arrival** (staged, about 1 s):
  1. At t0 the content clears, the tab's row is inserted, and the pill is focused.
  2. At +150–250 ms the composer card and the tray appear.
  3. At +250–400 ms the chip, the mic, the switcher pill and the figure arrive (the figure fades in from partial opacity over about 100–150 ms), and the floor fades in over about 200–250 ms. The figure is opaque by about +400 ms.
  4. At +700–1050 ms the ideas header and panel fade from pale to full over about 200–250 ms, and the notifications button appears.
  5. Then the idle loop starts.
- **Idle:** only the companion moves: a bob of about 1 px with a period of about 1.5 s, snap blinks of about 130 ms every 2.5–5 s at random (sometimes doubled), and a held sideways glance with occasional shifts.
- **Focusing the composer:** the pill returns to rest with a centred placeholder. The composer shows only a caret (no ring). The figure's glance shifts slightly.
- **Typing:**
  - In the same frame as the first character, the mic becomes send, a smaller outlined mic appears to its left, the mode chip jumps 40 px left with no slide, and the placeholder clears.
  - The figure blinks or squints once, then its pupils swing to the composer over about 180 ms and hold there. A double blink (two blinks about 400 ms apart) follows about 1.8 s later.
  - Clearing reverses the controls in one frame and eases the gaze back over about 180 ms, with a blink about 2 s later.
- **Hovers:**
  - The figure dims slightly, its badge darkens and a tooltip appears above it.
  - The switcher segments, round buttons, tray chips and arrows get rounded grey fills. The mic gets paler. The composer's hairline darkens one step.
  - An idea row gets a grey fill and a dismiss ×. After about 0.9 s a large white preview card of its full prompt appears.
- **Clicks:** the figure opens the companion card. The arrows page the ideas panel on the paged-strip motion (about 450 ms, ease-in-out; [DS-142](#ds-142)).
- **Closing the tab** returns to the previous chat unchanged.

### Requirements

The figure, its typing reaction and the send handoff live in [Companion presence](#companion-presence) ([DS-72](#ds-72) to [DS-77](#ds-77)); the shared composer is [DS-58](#ds-58) and [DS-59](#ds-59).

- <a id="ds-107"></a>**DS-107** `shell` **One start surface.** The new tab, the empty chat page and (scaled down) the side panel's empty chat share one composition.
  - **Top centre:** the switcher pill ([DS-77](#ds-77)), 16 px below the content top.
  - **Top-right:** two 38 px round icon buttons, 4 px apart and 19 px from the edge: the floor toggle ([DS-75](#ds-75)) and notifications ([DS-112](#ds-112)).
  - **Centre:** the live companion standing about 40 px above the composer, inside a square hit area, with a small pencil badge ([DS-74](#ds-74)).
  - **Composer:** the shared start variant, its top at 40% of the content height, with the tray ([DS-108](#ds-108)) and the ideas card ([DS-109](#ds-109)) below it.
  - **Bottom-right:** one 38 px keep-awake button ([DS-112](#ds-112)).
  - **Background:** Apex's floor, or the start surface's plain page when the floor is off. Nothing in it animates.
  - New chat from any surface lands here. No chat record exists until the first send (the usual draft rules apply).
  - **Remove** the greeting heading, the lead line, the monogram shortcut grid, the hint line, and the arrows and dots.
  - *Built:* the shared start surface. The empty chat page drops its header bar when the switcher pill can show in its place (`showsChatHeader` in `components/startSurfaceLogic.ts`); the switcher and corner buttons then sit 16 px from the top, as on the new tab. The side panel keeps its header (`tests/emptyChatHeader.test.ts`).
  - *Files:* new `components/StartSurface.tsx`, `components/NewTabPage.tsx`, `chat/ChatView.tsx` (empty branch), `styles.css` (`.newtab*`).
  - *Supersedes:* ux-plan "New tab page".
- <a id="ds-108"></a>**DS-108** `chat` **Start tray.**
  - A light grey band the composer's width, tucked under the card, extending 44 px below it with a 24 px bottom radius.
  - 32 px chips, 7 px apart, the first in line with the add button: skills, routines, and connectors (with the overlapping logos of connected ones); a help chip right-aligned 14 px in. Meetings joins when it ships.
  - Chip hover: a rounded grey fill and darker text.
  - **Dark:** the tray sits below the page level, darker than the composer ([DS-137](#ds-137)).
  - *Files:* new `components/newtab/ChipTray.tsx`, `components/StartSurface.tsx`, `chat/chat.css`.
- <a id="ds-109"></a>**DS-109** `chat` **Ideas card.** This replaces the three bordered starter buttons.
  - **Header row:** 28 px below the tray: a bulb glyph and a muted label, with previous and next 28 px arrow buttons. Previous is disabled at the first page.
  - **Card:** 640 × about 170, light grey, radius about 20, in two columns. Left: a semibold title, a three-line muted description and a see-all link. Right: four rows of about 33 px on a 36 px pitch, each with a small glyph and a label.
  - **Rows:** hover gives a grey fill and a dismiss ×, and after about 0.9 s a large preview of the full prompt. A click prefills the composer (or sends, for one-shot ideas).
  - **Paging:** the arrows page the card on the paged-strip motion ([DS-142](#ds-142)).
  - The ideas are built locally.
  - *Before:* three bordered starter cards under a headline (empty chat), and none on the new tab.
  - *Files:* new `components/newtab/IdeasCard.tsx`, `components/StartSurface.tsx`, `chat/ChatView.tsx` (starters), `chat/chat.css`.
- <a id="ds-110"></a>**DS-110** `shell` **Address pill on arrival.**
  - On a new tab the pill is focused on arrival, in its [DS-23](#ds-23) editing state: white, the profile-hue ring, a placeholder, and a right-aligned key-chip hint. One key moves the typed text into the companion composer.
  - Focusing the composer returns the pill to rest with a centred placeholder.
  - ⌘T and the New Tab row both land here, and ⌘L edits the pill in place ([DS-23](#ds-23)) rather than opening a centred palette.
  - *Before:* the new-tab ask field autofocuses and the pill shows a white placeholder.
  - *Files:* `AddressPill.tsx`, `NewTabPage.tsx`, `App.tsx` (`focusOmnibox` on new-tab creation).
  - *Refines:* [SH-36](feature-spec.md#sh-36) (Tab hands the text to the composer, with the hint now in the pill). *Supersedes in part:* [SH-35](feature-spec.md#sh-35)'s centred palette for ⌘L and ⌘T; the palette opens from sidebar search ([DS-90](#ds-90)).
- <a id="ds-111"></a>**DS-111** `motion` **Staged arrival.** A new tab or new chat builds in about 1 s:
  1. at once: the old content clears, the row is inserted and the pill is focused;
  2. at about +200 ms: the composer card and tray;
  3. at about +300 ms: the chip, mic and switcher pill, and the figure fading in from partial opacity over about 120 ms, with the floor fading in over about 200–250 ms;
  4. by about +400 ms: the figure is opaque;
  5. at about +800–1000 ms: the ideas header and card fade in over about 200–250 ms, then the notifications button.

  - Reduce Motion shows everything at once.
  - *Files:* `components/StartSurface.tsx`, `components/NewTabPage.tsx`, `ui/motion.ts`, `styles.css`.
  - *Test:* a frame recording of a new tab shows the composer before the figure and the ideas card last.
- <a id="ds-112"></a>**DS-112** `shell` **Notifications inbox and keep-awake.** Both round buttons open working features: an inbox and a keep-awake switch.
  - **Notifications:** the top-right round button opens an inbox of routine results and pending approvals, newest first, with mark-read. It appears last in the staged arrival and carries an unread dot.
  - **Keep-awake:** the bottom-right round button toggles keeping the Mac awake while a companion works (`powerSaveBlocker`). It shows its on state with a filled glyph, and the setting is remembered.
  - Both use the dark tooltip ([DS-95](#ds-95)) above or below as space allows.
  - *Files:* `components/StartSurface.tsx`, new `components/newtab/Inbox.tsx`, `src/main/shell.ts` and `src/shared/ipc.ts` (keep-awake, notifications).
  - *Test:* toggling keep-awake on starts the power-save blocker while a run is active and stops it when the run ends or the switch goes off.

### Design choices: start surface

- **Icons (lucide).** `Sofa` for the floor toggle (Apex's floor is "the Lounge"), `Bell` for notifications, `Coffee` for keep-awake, `Lightbulb` for the ideas header, `ChevronLeft` and `ChevronRight` for paging, `ArrowRight` for the see-all link, `Plus` for the add segment and `CircleHelp` for the help chip.
- **Tray chips.** Skills, Routines, Connectors and Help.
- **Ideas.** Built locally from your skills, routines and recent tabs, plus a fixed starter set.
- **Keep-awake.** Uses `prevent-app-suspension`, and only while a companion run is active.
- **Pill hint.** Uses SH-36's Tab key, for example "⇥ Ask ‹name› instead".

---

## Companion card

### Layout

**Placement** (window px):
- The sidebar, toolbar and bookmarks bar stay pixel-identical before and after: sharp, at full contrast and usable. The selected chat row stays highlighted.
- The content area is x 300–1470 and y 78–923.
- **The card** is 608×829 at (854, 86). It sits 8 px inside the content area's top, right and bottom edges (right edge at 1462, bottom at 915), always below the bookmarks bar.
- **Width:** 52% of the content area, or 41% of the window. About 554 px of the page stays visible to its left. It opens over the chat's details panel and hides it.
- **Surface:** white, with a 1 px hairline about 10% darker than white and a radius of about 22–24. Its shadow is a very soft halo of about 6–7 px at the sides, a little darker and longer (about 8 px) below.
- **Resize strip:** an invisible 7 px strip along the left edge.

**What is behind it.**
- **Light:** only the content area changes. It gets a strong blur of about 8–12 px and a slight lift toward white (about 3% brighter), with no tint. The blur makes text unreadable while block shapes stay recognisable.
- **Dark:** blur only, with no veil. The blurred chat stays at the dark page grey.

**Inside the card** (card px, with the origin at the card's outer top-left corner):

| Zone | y | Contents |
|---|---|---|
| Header | 1–53 (52 px) | **Left:** one switcher pill, 105×36 at (17, 9), fully rounded, with 8 px left padding: a 28 px avatar box with the head drawn at about 21×24 inside it, the name at 14 px regular from x 61, and an up-and-down chevron at x 97. No fill at rest.<br>**Right:** more (three **vertical** dots) and close: 32 px round white buttons with a hairline ring that is a little darker at the bottom and a 2–3 px drop shadow, at x 523 and 563, 8 px apart. Close sits 13 px from the outer edge. |
| Tab row | 53–105 (52 px) | Six text tabs. Each button is 36 tall, centred at y 81, with about 11–12 px side padding and 10 px between buttons. The first starts at x 17, in line with the switcher.<br>**Inactive:** 14 px regular, mid-grey, no icon.<br>**Active:** 14 px medium, near-black, with a 16 px line icon 6 px before the label, which makes the button 22 px wider and shifts the tabs after it.<br>**Underline:** 2 px, near-black, with near-square ends, exactly the active button's width (93 px under General, at x 17–110). It sits on the row's last 2 px and covers the 1 px tab hairline at y 104, which is about 5% darker than white. No count badges. |
| Hero | 105 to about 385 | **Wash:** edge to edge from the tab hairline, a pale wash of the companion's hue, almost flat (a touch deeper mid-hero), fading to the card colour over its last ~130 px. No border, radius or divider.<br>**Content box:** 558×265 at (25, 137), inset 24 px from the sides and 32 px below the hairline, with a **fixed** height whatever the card width.<br>**Pattern field:** full width, visible about y 165–345: the shared ambient field ([DS-85](#ds-85)), each cell holding one fixed glyph from a small dot to about 85% of the cell.<br>**Figure:** a 282×283 canvas at (163, 134); the figure is drawn 130 wide and 233 tall (y 166.5–399.5), centred on the card's midline (x 304). It is the same size at card widths of 608 and 1170, and stands in front of the field and the bottom fade.<br>**Floor:** a **flat**, solid grey ellipse of about 123×21 centred near (304, 393), about 11% darker than white, with a 1–2 px antialiased edge and no blur.<br>**Look pill:** 164×36 at (409, 131), its right edge 35 px from the outer edge. **Opaque** white with a hairline in the card border's tone; a 16 px glyph 16 px in, an 8 px gap and a 14 px regular label.<br>**Name row:** a 320×36 name field at (25, 346) with no visible box at rest; the text starts at x 39.5, about **28 px regular**, near-black, centred at y 364 (level with the figure's shins). On the right, the share pill: 173×36 at (400, 346), its right edge in line with the look pill, fully rounded, filled with the companion's deep body colour, with a white 13 px glyph 16 px in, a 10 px gap, a white 14 px medium label and 17 px right padding. |
| Summary group | 425–530 | 558 wide at x 25, 24 px below the hero box. Radius about 16, a hairline a bit darker at the bottom, and a 1–4 px shadow below. **Two** rows, 52 and 53 tall, with a full-width divider about 4% darker than white. Each row: a 16 px outline icon 21 px in, a **14 px semibold** label at x 71, a muted count followed by its noun right-aligned to x 541, and a chevron at x 552.5. |
| Instructions | 573 to the bottom | A muted 14 px label at (37, 573), 40 px below the group, with a 12 px info glyph 6 px after it. The text starts 24 px below the label, at (37, 615), 534 wide: plain 14 px regular near-black prose with no box, on a 23 px line box, with 12 px between paragraphs. It fills to the card bottom. |

**Spacing rhythm.**
- Insets: 24–25 px for boxed content (the hero box, the summary group), 37–40 px for free text (the name, the label, the prose), and 34–35 px from the right edge for the hero pills.
- Every vertical metric is fixed: the header 52, the tab row 52, the hero box 265 (460 in the editor), the figure 233 (312 in the editor), rows 52–54.
- Horizontally, the hero box, the group, search fields, rows and prose stretch. The name stays pinned left, the pills pinned right and the figure centred.

**List tabs** (Skills, Routines, Files, Memory and Models) share one template:
- **Section header** (y 125–161): the title at x 33, about 18–19 px semibold. On the right, ending at x 575: a 36 px round help button (20 px glyph, no ring), a 6 px gap, then a 36 px action pill with an ink fill, a white 14 px label, a leading 16 px plus and 12 px side padding (121 px wide for Skills, 142 for Routines). Memory uses a white hairline pill instead; Files an ink pill with a trailing arrow-out glyph; Models has the help button only.
- **Search row** (y 185–221): a 522×36 fully rounded field at x 21 with a hairline, a 16 px magnifier 12 px in and a 14 px muted placeholder; then, 8 px later, a 36 px round filter or sort button with a hairline ring, a 2 px shadow and a 14 px glyph, ending at x 587. Boxed row content sits 12 px further out than the title (x 21–587). The field takes focus on a tab switch.
- **Lists** start at y 229: rows 566×54 with 1 px dividers about 4% darker than white. A hovered row gets a light grey rounded fill (radius about 8). Empty states are a single muted 14 px line at x 33.
- **Skills rows:** a 16 px cube glyph at x 41; the slash-name label at x 77, 14 px, ending in an ellipsis at about 249 px; a muted 12–13 px last-used text at x 337; a 74×28 white pill with a hairline and a 1 px shadow at x 469; a 26 px round ⋯ button at x 549. The built-in group is a 192×28 disclosure (a chevron, a muted label, then a lighter count 6 px after it) that **sticks** just under the tab row (y 109) when scrolled.
- **Files:** the title is a breadcrumb, a 50×32 ghost button at x 27, outdented 6 px. Rows: a 20 px file or folder icon at x 39, the 14 px name at x 77, a muted 13 px type column at x 263, a relative time at x 452, the size at x 509 and a 24 px round ⋯ button at x 551.
- **Memory:**
  - An explainer strip, 542×72 at (33, 177): very light grey and rounded, with three columns of a 16 px glyph and three lines of 12–13 px muted text (16 px line height), and a 24 px dismiss × at the right.
  - A segmented control, 160×40 at (33, 281): a grey track with 32 px segments inset 4 px; the selected segment is white with a soft shadow.
  - A timeline from y 337: an 88 px date column right-aligned to x 121 (a bold 12–13 px day over a muted time); a 24 px rail at x 133 with 14 px round nodes (a dashed outline for upcoming, solid ink for past) joined by a dashed vertical line; and a 406 px content column from x 169 with a 14 px medium title and two lines of muted 13 px text.
- **Models:** 60 px rows from y 195, divided by dividers. Each has a 32 px rounded-square grey tile with an ink glyph at about x 33; a 14 px title at x 77 with a muted 12–13 px one-line description 19 px below; and a 200×32 white hairline pill ending at x 575, holding a provider glyph, the model label and a lock glyph. A footer holds a muted 13 px note and a 73×32 small ink pill.

**Menus.**
- **Switcher menu:** 224×99 at (17, 51), 6 px under the switcher and left-aligned with it. White, radius about 12, a hairline, a soft shadow and 5 px padding. Rows are 214×40, with a 28 px avatar 12 px in and the label at +48. The current companion's row has a light grey fill, a **semibold** label and a filled ink check circle of about 18 px at the right. Then a full-width hairline with 4 px margins, and a create row with a 28 px light grey rounded-square plus tile and a muted label. It is in-page and closes on Esc.
- **More menu:** 240 wide at (315, 47), 4 px under the more button and right-aligned to it (ending at x 555). 5 px padding; 230×36 rows with a 16 px glyph 12 px in and the label at +36. The destructive row is pale red and disabled while only one companion exists.

**Look editor.**
- **Card:** widens **to the left** to 900×829, at (562, 86), with the right edge fixed (+292 px). The header and tabs are unchanged, and General stays active.
- **Hero:** the box becomes 850×460 at (25, 137). The wash still runs edge to edge and fades out by about y 585. The pattern band moves to the **lower** hero (about y 240–460, behind the legs); the upper hero is plain wash.
- **Figure:** a 380×380 canvas at (260, 177), centred on the card (x 450). The figure is drawn at 176×312, and its feet move **down** with the taller hero, from y 399 to 534; it does not rise. The floor ellipse is about 160×27.
- **Toolbar:** a 318×40 white hairline pill at (35, 131), 10 px inside the hero box, with 4 px inner padding. It holds undo and redo (32 px round icon buttons with 16 px glyphs, 2 px apart, both disabled at rest), a 1 px vertical divider with 12 px margins, and four preset pills (51–66×32, white with a hairline, 14 px regular labels, 1–2 px apart). None is pressed at rest: they are one-shot presets, not a persistent choice.
- **Close pill:** 94×36 in the look pill's place, keeping its right edge (x 865), with a × glyph and a label.
- **Category bubbles:** eight 46 px white circles with a soft shadow, each showing a small preview of its part in the companion's colours.
  - They sit on a ring of radius about 204 px around the figure canvas's centre (450, 367), four per side: the inner pair at dx ±168, dy ±120, and the outer pair at dx ±198, dy ±42 (left arc at x 259, 229, 229, 259; right arc at x 595, 625, 625, 595; y 224, 302, 386, 464).
  - The categories on each arc are listed in [DS-118](#ds-118).
  - They behave as an accessible tab list. Hover shows a small white label chip above the bubble; the selected one gets a darker grey ring.
- **Option panels:** 184 wide, white, radius about 16, a soft shadow and 12 px padding, with a 13–14 px semibold title and a 24 px × button (14 px glyph) at the top-right.
  - A left-arc category opens its panel at the hero box's left edge, (25, 196); a right-arc one at its right edge, (691, 196).
  - **Colour:** a four-column grid of 37 px round swatches with 4 px gaps; each row runs through one hue in four tints. The current swatch has a thick dark ring and a 9 px ink check badge at its top-right. The panel is capped at about 389 px tall and scrolls inside.
  - **Shape:** a thumbnail grid, then a second card about 6 px below with two labelled sliders (an ink track left of the thumb, a light grey track right of it, and a white round thumb).
  - **Eyes:** a grid plus three sliders. **Mouth:** a row plus two sliders. **Brows:** three thumbnails plus three sliders. **Hat** and **hair:** a thumbnail grid of the options the head accepts, led by an empty-option tile; the panel's height fits its content. **Accessories:** two headed sub-groups (eye and ear accessories) plus two sliders.
- **Below the hero:** the summary group (850 wide, at y 621) and the instructions follow the new width.

**Full-tab variant.** The same component drawn as a whole tab, 1170 px wide: the same header, tab and hero heights, stretched horizontal elements and the same figure size. It is a page, not a card: no border, radius or backdrop.

**Neutral vs companion colour.**
- Only the hero wash (the companion's pale body hue), the figure, the share pill (its deep body colour), the avatar busts and the editor's previews carry the companion's colour.
- Everything else is neutral: ink for the underline, active label, check circles and action pills; mid grey for muted text, inactive tabs and counts; hairlines about 10% darker for the card, buttons and pills and 4–8% for dividers; light grey for hover, selected and track fills; pale red for the disabled destructive item. The profile hue never appears in the card.

**Borders vs shadows.**
- Hairlines: the card edge, the tab divider, the list group and its separator, the round header buttons, the look pill and every list-tab field and pill.
- Shadows: the card's halo, the list group's small shadow, the header buttons' drop shadow, the bubbles and the option panels. The hero has neither.

**Dark.**
- **Surfaces:** the card is the same grey as the page behind it (not raised). Hairlines are about 13% lighter than the card and the tab hairline about 7% lighter. The header buttons and look pill share the card's fill, with no shadow.
- **Text and underline:** the underline and active label are white, and muted text is mid grey.
- **Hero:** the ground is a few levels lighter than the card with a faint tint. The pattern field stays visible at low contrast ([Design choices: motion](#motion-design-choices)) and fades into the card at the bottom. The floor ellipse is only slightly darker than the card.
- **Share pill:** keeps the same deep companion colour with white text.
- **Pattern:** still drifts, at about a third of light mode's contrast.

### Behaviour and motion

**Opening and closing.**
- **Open:** the card and the backdrop fade in together over about 100–150 ms, ease-out. There is no slide or scale. The details panel crossfades away.
  - The hero pattern and pills show from the first frame. The 3D figure pops in within one frame, about 150 ms after the card is fully opaque, with no fade.
  - Focus moves into the card, and Tab cycles inside it.
- **Close:** the close button, Esc, or a click on the washed page.
  - Pending edits save first, and an open look editor closes through its own path, with no discard prompt.
  - It is a fade only, over about 150–200 ms, ease-in, and the backdrop un-blurs in step. Focus returns to the opener.
- **Scope:** the overlay covers only the content area, so the sidebar and toolbar stay usable.
- **Beside a chat:** when the chat sits beside a page, the card fills that chat's column instead of floating.
- **Entry points:** the message avatar, the details panel's companion row, and the start surface's figure. The composer chip does not open the card; it opens its menu upward.

**Resize.** The invisible strip resizes the card live, from a minimum up to nearly the full content width. There is no hover line. While the look editor is open, the card is wider.

**Switcher.**
- Hover gives the pill a light grey fill.
- A click opens the switcher menu (above), which scrolls if long.
- Picking another companion saves pending edits, keeps the current tab, and swaps the content in place with no crossfade. The hero rebuilds with the new tint and a freshly shuffled pattern, and the character appears a beat later.

**More menu.** Its items are listed in [DS-35](#ds-35). The destructive one is disabled while there is only one companion.

**Tabs.**
- **Switching:** a click, or Left and Right (which wrap, and both focus and activate).
- **Body:** it swaps immediately with no crossfade. List tabs show a brief skeleton (four rows of a square icon, a bar, a right bar and a round button), and their search field takes focus.
- **Underline:** it glides in position and width over about 150 ms, ease-out. Its first placement doesn't animate.
- **Icon:** the new tab's icon grows in and pushes its label right by 22 px, while the old tab's icon fades out at the same moment.
- **Labels:** weight changes cause no shift; only the icon moves later tabs. Inactive labels darken on hover, and keyboard focus shows a ring.
- **Overflow:** an overflowing row scrolls sideways with a hidden scrollbar, and the mouse wheel scrolls it horizontally.
- **Reduce Motion:** the icon appears instantly.

**Scrolling.**
- The header and tab row stay fixed.
- General scrolls as one block with a **hard clip** at the tab hairline: there is no fade.
- List tabs keep their group disclosure header **sticky** just under the tab row.
- Each tab has its own scroll position, starting at the top.

**Pattern field.**
- **Cells:** each cell's shape is fixed. Only its size animates, in place, without moving.
- **Drift:** one swell takes about 8 s, with no faster motion on top, so no single frame's change is noticeable.
- **Placement:** the band is placed relative to the hero: through the upper middle on General, behind the legs in the editor.
- **No reactions:** it ignores the pointer, the companion's mood, the chat state and typing.
- **Dark:** it keeps drifting, at very low contrast.
- **Lifecycle:**
  - It pauses when scrolled out of view or when the window is hidden.
  - It re-lays out (reshuffling) on resize and rebuilds on a theme change.
  - It caps its resolution on retina screens, and under Reduce Motion it shows one still frame.

**Hero companion.**
- It idles with a bob of about 1 px over about 1.5 s and small head motion.
- Blinks snap the eyes to closed arcs for about 130 ms every 2.5–5 s at random, sometimes twice in a row.
- Its head and pupils follow the pointer **anywhere in the window**, even outside the card, with a few frames of lag and no snapping.
- It shows no hover cue (an arrow cursor). A click plays the [CO-19](feature-spec.md#co-19) poke ([DS-70](#ds-70)). The shadow under its feet stays put.

**Look editing (in place).**
- **Opening** (about 650 ms in all):
  1. The look pill becomes the close pill at once, and the toolbar starts fading in.
  2. The card widens leftward over about 250 ms, ease-out, while the hero grows and the figure scales ×1.34, its feet moving down.
  3. The name row fades out within about 100 ms and becomes inert.
  4. The bubbles fade and scale in from about +100 ms and settle by about +450 ms.
  5. The figure's scale settles with an ease-out tail, by about +650 ms.
- **Category panel:** fades in over about 150 ms with no slide, and its bubble gains the selected ring.
- **Closing:** the pill swaps back at once. The panel, bubbles and toolbar fade within about 100 ms, and the name row and share pill fade back. The card narrows over about 300 ms, ease-in, and the figure settles for about 450 ms more.
- Edits save live.

**Big name.**
- It reads as plain text. Hover shows a faint border and fill, and a click turns it into a bordered field.
- On leaving the field, the text is trimmed, an empty name falls back to a default, and the length is capped.
- Changes autosave. A small save-status pill floats, centred, just under the header and fades out after confirming.

**Pills and buttons.**
- **Share pill:** darkens slightly (about 4%) on hover and more on press. For a companion shared with you, it becomes a static badge in the same colour.
- **Look pill:** on hover only its border darkens.
- **Header buttons:** a grey fill on hover, and the dark tooltip after about 1 s ([DS-95](#ds-95)).

**Summary rows:** a very light tint on hover. A click switches to that tab, and the underline glides there.

**Instructions:** the info glyph shows a tooltip after a short delay. Clicking the text edits it in place, with autosave.

**Effects on other surfaces.**
- Renaming or restyling updates the sidebar avatars, the chat's small faces, the composer chip and the start surface live.
- Using a skill closes the card and opens a chat.
- Opening a routine asks before leaving the card.

### Requirements

- <a id="ds-29"></a>**DS-29** `card` **Backdrop over the content area only.**
  - With the card open, the sidebar, toolbar, address pill and bookmarks bar stay pixel-identical: no blur, full contrast, and clickable.
  - Only the content area is blurred, at about 10 px, including the page still Apex shows while the native view is hidden.
  - **Light mode:** it is also lifted slightly (about 3% brighter) toward the page background, with no ink or purple tint. Text becomes unreadable while block shapes stay recognisable.
  - **Dark mode:** blur only, with no veil. The tone stays at the page grey.
  - **Reduce Transparency:** an opaque wash in the page tone replaces the blur, in both modes.
  - The same content-area placement serves other content-scoped overlays.
  - *Before:* a purple-grey scrim and a 6 px blur cover the whole window, including the chrome.
  - *Files:* `App.tsx`, `ui/Dialog.tsx` (a content-area `placement` for `Modal`), `ui/ui.css` (`.ui-modal__scrim`), `companion-card/Backdrop.tsx`, `styles.css` (`--scrim`, `--scrim-blur`; delete the purple scrim).
  - *Test:* a screenshot diff of the chrome with the card open and closed is zero.
  - *Supersedes:* the whole-window reading of "over a dimmed and blurred page" in ux-plan's companion card section.
- <a id="ds-30"></a>**DS-30** `card` **Card size and position.**
  - The card's top, right and bottom edges sit 8 px inside the content area, with the top below the bookmarks bar.
  - The default width is 52% of the content width (608 px at 1170). The clamp keeps at least about 360 px of page visible.
  - Radius about 24; a 1 px hairline about 10% darker than the card; a 6–8 px halo shadow, a little longer below. In dark mode it has a hairline and no shadow ([DS-47](#ds-47)).
  - It covers the chat's details panel while open.
  - *Before:* 760 px wide, spanning window y 16–884, so it overlaps the toolbar and bookmarks rows.
  - *Files:* `companion-card/card.css` (`.co-card`), `pages/CompanionCard.tsx`.
- <a id="ds-31"></a>**DS-31** `card` **Open and close are a fade only.**
  - **Open:** the card and the backdrop fade in together over about 140 ms, ease-out, with the blur ramping in the same frames. There is no movement.
  - **Figure:** the live figure mounts in a same-size empty placeholder and appears in one step when it is ready, about 150–250 ms after the card is opaque.
  - **Close:** Esc, close and a click on the backdrop all close it, saving pending edits first. It fades out over about 180 ms on an accelerating curve, and the blur starts clearing on the first frame.
  - Focus is trapped inside and returns to the opener. The exit plays fully before unmount ([DS-82](#ds-82)).
  - *Before:* it slides in from the right (`co-card-in`) and vanishes with no exit.
  - *Files:* `card.css` (remove the slide), `pages/CompanionCard.tsx`, `ui/Dialog.tsx`, `ui/overlay.ts`, `companion-card/Backdrop.tsx`.
- <a id="ds-32"></a>**DS-32** `card` **Resizable card.**
  - An invisible 7 px strip on the left edge resizes the card live, from a minimum up to nearly the full content width. It shows only the resize cursor. Arrow keys work when it is focused.
  - The width is remembered.
  - The look editor widens the card leftward by 292 px (608 → 900) with the right edge fixed, and restores it on close ([DS-43](#ds-43)).
  - *Files:* `pages/CompanionCard.tsx`, `card.css`, `ui/Seam.tsx` (reuse).
- <a id="ds-33"></a>**DS-33** `card` **One-row header, 52 px.**
  - **Left:** one content-sized switcher pill, 36 tall at (17, 9), with 8 px left padding, the [CO-18](feature-spec.md#co-18) face in a 28 px box, the name at 14 px regular, and an up-and-down chevron. No fill at rest; a grey pill fill on hover.
  - **Right:** only two 32 px round white buttons with a hairline ring and a tiny shadow, 8 px apart, with close 12 px from the inner edge: more (a **vertical** dots glyph) and close.
  - **Save status:** moves to a small floating pill centred under the header, which fades out after confirming.
  - **Removed from the header:** the 52 px figure, the bold inline name, the default badge, the arrows, the new-companion icon (`UserPlus`) and Export….
  - *Before:* all of the removed items were present.
  - *Files:* `companion-card/CardHeader.tsx`, `card.css`, `ui/SaveStatus.tsx`.
  - *Supersedes:* the header contents in [CO-02](feature-spec.md#co-02), the header placement of Export and Customize look in [CO-03](feature-spec.md#co-03), and ux-plan's card "header" bullets.
- <a id="ds-34"></a>**DS-34** `card` **Switcher menu.**
  - An in-page menu ([DS-94](#ds-94)) 224 wide, 6 px below the switcher and left-aligned with it. Radius about 12, a hairline, a soft shadow and 5 px padding.
  - 40 px rows: a 28 px face 12 px in and the label at +48. The current row has a **neutral** grey fill (never the companion's colour), a semibold label and an ink check circle at the right.
  - Then a divider with 4 px margins, the create row (a 28 px grey rounded-square plus tile and a muted label: New companion…), and Add from file… in the same style.
  - Choosing one saves pending edits, keeps the current tab, swaps the content in place without a crossfade, and reshuffles the hero pattern; the figure appears a beat later. Esc closes the menu. Keyboard cycling between companions stays as a shortcut.
  - *Files:* `CardHeader.tsx`, `companion-card/logic/cycle.ts`, `ui/Popover.tsx`, `ui/menu.ts`.
  - *Supersedes:* the previous and next arrows in [CO-02](feature-spec.md#co-02).
- <a id="ds-35"></a>**DS-35** `card` **The more menu holds the rarer actions.**
  - **Geometry:** an in-page menu 240 wide, right-aligned to the button and 4 px below it, with 36 px rows, a 16 px glyph 12 px in and the label at +36.
  - **Items:**
    - use for new chats;
    - duplicate (with an in-progress label);
    - hide or unhide;
    - reset;
    - delete, in the danger tone (disabled, and paler, for the last visible companion, with the reason, per [CO-04](feature-spec.md#co-04));
    - the Dock-icon toggle.

  *Files:* `pages/CompanionCard.tsx` (`openMenu`), `companion-card/GeneralTab.tsx`, `ui/Popover.tsx`. *Refines:* [CO-03](feature-spec.md#co-03).
- <a id="ds-36"></a>**DS-36** `card` **Tab row of 52 px with a gliding underline.**
  - **Buttons:** 36 tall, centred on the row, with about 12 px side padding and 10 px gaps; the first starts at x 17.
  - **Labels:** 14 px. Inactive ones are regular and muted; the active one is medium in full ink, with its 16 px icon 6 px before the label. Weight changes cause no shift; the icon pushes the later tabs by its width plus the gap. There are no count badges.
  - **Underline:** one 2 px line in full ink, with square ends, exactly the active button's width. It sits on the row's last 2 px, over a full-width 1 px hairline about 5% darker than the card.
  - **Switching:** the underline glides in position and width over about 150 ms, ease-out. The new icon grows in (width plus fade) while the old one collapses over the same time. The body swaps immediately, with no crossfade ([DS-106](#ds-106)), and list tabs focus their search field. The first paint doesn't animate, and Reduce Motion switches instantly.
  - **Overflow:** the wheel scrolls an overflowing row sideways.
  - *Before:* semibold 34 px tabs, count badges, a per-tab underline in the accent colour, an instant switch and no icons.
  - *Files:* `ui/TabList.tsx` (a gliding variant), `ui/ui.css`, `pages/CompanionCard.tsx`.
- <a id="ds-37"></a>**DS-37** `card` **Scrolling.**
  - The header and tab row stay fixed.
  - General scrolls as one block, with no side padding on the hero and a **hard clip** at the tab hairline: no fade.
  - List tabs keep their group disclosure headers sticky just under the tab row.
  - Switching tabs starts that tab at the top.
  - *Before:* the body padding keeps the hero inset.
  - *Files:* `card.css` (`.co-card__body`), `companion-card/SkillsTab.tsx`.
- <a id="ds-38"></a>**DS-38** `card` **Edge-to-edge hero.**
  - The wash touches the tab hairline and both card edges, with no border, radius or inset. It is nearly flat (slightly deeper mid-hero) and fades to the card colour over its last ~130 px, with no divider below. On General it reaches the card colour about 280 px below the hairline.
  - The content box inside is inset 24 px, starts 32 px below the hairline, and is a fixed 265 px tall (460 in the editor) whatever the card width.
  - *Before:* an inset, bordered, rounded box.
  - *Files:* `companion-card/GeneralTab.tsx`, `card.css` (`.co-hero`).
- <a id="ds-39"></a>**DS-39** `card` **Animated field behind the companion.**
  - The shared ambient field ([DS-85](#ds-85)) covers the hero's full width.
  - On General it is visible from about 60 px to about 240 px below the hairline: invisible at the top, strongest through the middle, and gone about 40 px above the name row. In the editor the band moves into the lower ~45% of the taller hero, behind the legs.
  - It pauses when scrolled out of view or when the window is hidden, rebuilds on resize, theme or companion change, and reshuffles on switch.
  - It keeps animating in dark mode, at a contrast that stays perceptible.
  - It is one still frame under Reduce Motion.
  - *Before:* a static dot grid, with a purple glow in dark mode.
  - *Files:* `GeneralTab.tsx`, `card.css`, `ui/AmbientField.tsx`.
- <a id="ds-40"></a>**DS-40** `card` **The hero companion is the live full-body character.**
  - **Size:** fixed, about 233 px of visible height (a canvas of about 282) whatever the card width. It does not scale with the card.
  - **Placement:** centred on the card's midline, its feet about 6 px above the hero box's bottom.
  - **Floor:** a **flat, solid** ellipse of about 123×21 in a neutral grey a step darker than the wash, with no blur.
  - **Editor:** it grows ×1.34 (about 312 px) and its feet move down with the taller hero ([DS-43](#ds-43)).
  - **Life:** it idles, blinks, and its head and eyes follow the pointer anywhere in the window ([CO-19](feature-spec.md#co-19)).
  - **Mood:** follows its own chats through the presence store ([DS-68](#ds-68)) instead of a fixed happy mood.
  - **Timing:** it appears in one step, about 150 ms after the card is opaque and after each switch, in a same-size placeholder so nothing jumps.
  - *Before:* a 210 px figure at the left, in a fixed happy mood with a greeting, and a barely visible shadow.
  - *Files:* `GeneralTab.tsx`, `companion/Companion.tsx`, `companion/view.ts`, `companion/stage.ts`.
- <a id="ds-41"></a>**DS-41** `card` **Look pill.**
  - At the hero's top-right: content-sized (about 164×36), its top 26 px below the tab hairline and its right edge 34 px from the card edge.
  - An **opaque** card-coloured fill with a 1 px hairline, a 16 px glyph 16 px in, an 8 px gap and a 14 px label. Hover darkens only the border.
  - It opens look editing in place ([DS-43](#ds-43)) and becomes the close pill.
  - *Files:* `GeneralTab.tsx`, `card.css`.
- <a id="ds-42"></a>**DS-42** `card` **Name row inside the hero,** level with the companion's shins.
  - **Left:** a 320×36 name field at (25, 346), with the text inset 14 px at about 28 px and no box at rest. It shows a faint border on hover and becomes a bordered field on focus. An empty value restores the previous name, the length is capped, and changes autosave.
  - **Right:** the primary pill (Export…), 36 tall and content-sized (about 173), its right edge aligned with the look pill. It is filled with the look's deepest colour, with a white 14 px medium label at a contrast of at least 4.5:1, 16 px left and 17 px right padding and a 10 px glyph gap. Hover darkens the fill by about 4%, and press darkens it more.
  - *Files:* `GeneralTab.tsx`, `card.css`, `CardHeader.tsx` (remove inline rename).
- <a id="ds-43"></a>**DS-43** `card` **Look editing happens in place.**
  - **Opening, in this order:**
    1. At t0 the look pill becomes a close pill with the same right edge, and the toolbar starts fading in.
    2. Over 0–250 ms, ease-out, the card widens leftward by 292 px with the right edge fixed, the hero grows from 265 to 460 px, and the figure scales ×1.34 while staying centred (its feet move down).
    3. Within 0–100 ms the name row fades out and becomes inert.
    4. From about 100 to 450 ms the category ring ([DS-118](#ds-118)) fades and scales in.
    5. Until about 650 ms the figure's scale settles.
  - **Closing:** the pill swaps back at once; the panel, bubbles and toolbar fade within about 100 ms; the name row returns; the card narrows over about 300 ms on an accelerating curve; and the figure settles for about 450 ms more. There is no discard prompt; edits are already saved.
  - **Toolbar:** a 40 px white hairline pill 10 px inside the hero's top-left. It holds undo and redo (32 px), a 1 px divider, and the four shuffle styles (`logic/shuffle.ts`) as one-shot 32 px pills.
  - **Panels:** a bubble opens its option panel ([DS-119](#ds-119)).
  - **Removed:** the separate view with its "Back" bar, the large studio side column and the preview-mood select.
  - *Files:* `pages/CompanionCard.tsx` (`LookView`), `pages/CompanionEditor.tsx` (`LookStudio`, `LookEditor`), `companion-card/logic/shuffle.ts`, `GeneralTab.tsx`, `card.css`.
  - *Refines:* [CO-11](feature-spec.md#co-11).
- <a id="ds-44"></a>**DS-44** `card` **Summary group.**
  - **Box:** inset 24 px, starting 24 px below the hero box, radius 16, a hairline a little darker at the bottom, and a 1–4 px shadow below.
  - **Rows:** exactly two ([DS-46](#ds-46)), 52 and 53 px tall. Each has a 16 px icon 21 px in, a 14 px **semibold** label at +46, a muted count followed by the item word right-aligned, and a chevron 30 px from the right. A full-width 1 px divider separates them.
  - **Behaviour:** a light grey hover fill. A click switches tab, and the underline glides there.
  - *Before:* 44 px rows, bare numbers, a small radius and no shadow.
  - *Files:* `card.css` (`.co-summary*`), `GeneralTab.tsx`.
- <a id="ds-45"></a>**DS-45** `card` **Instructions as prose.**
  - A muted 14 px label 40 px below the summary group, at the free-text inset (about x 37), with a 12 px info glyph 6 px after it. The glyph's tooltip carries what is now a hint paragraph.
  - The text starts 24 px below the label: 14 px regular paragraphs on a 23 px line box, with 12 px between paragraphs and no box. It fills to the card's bottom and is edited in place.
  - The counter shows only near the limit, and the empty-state prompt shows when the text is empty.
  - The save state uses the floating pill ([DS-33](#ds-33)).
  - *Before:* a bordered textarea, a long hint, an example placeholder and an always-visible counter.
  - *Files:* `GeneralTab.tsx` (`InstructionsField`), `ui/SaveStatus.tsx`.
  - *Supersedes:* the "free-text box" presentation in [CO-05](feature-spec.md#co-05). The behaviour (autosave, limit, new chats only) stays.
- <a id="ds-46"></a>**DS-46** `card` **Personality and Dock.**
  - The first tab has exactly this structure: the hero, a **two-row** summary, then the instructions.
  - The personality preset becomes a small ghost select pill at the right end of the instructions label row, replacing the large select. It does not become a summary row.
  - The Dock switch moves to the more menu ([DS-35](#ds-35)).
  - *Files:* `GeneralTab.tsx` (`PersonalityField`), `pages/CompanionEditor.tsx`.
  - *Supersedes:* "next to its personality preset" in [CO-05](feature-spec.md#co-05).
- <a id="ds-47"></a>**DS-47** `card` **Card dark mode.**
  - **Surface:** the dark panel colour, the same as the page behind it (not raised). A hairline edge about 13% lighter than the card, a tab hairline about 7% lighter, and no shadow.
  - **Controls:** the header buttons and the look pill take the card fill plus a hairline, with no shadow. The underline and active label use the light ink; muted text is mid grey.
  - **Hero:** the ground is a few levels lighter than the card with a hint of the companion's hue, fading into the card by the hero's end. The field keeps a visible drift ([DS-85](#ds-85)).
  - **Floor and pill:** the floor ellipse is a step darker than the card. Export keeps the look's deep colour.
  - **Backdrop:** blur only ([DS-29](#ds-29)).
  - The card is checked against `a0-shots/dark/companion-card-*.png`.
  - *Before:* purple-tinted surfaces and a purple-dotted grid.
  - *Files:* `card.css`, `styles.css`.
- <a id="ds-48"></a>**DS-48** `card` **Live links to other surfaces.**
  - Renaming or restyling updates every small avatar, the chat header, the composer chip and the start surface live.
  - A skill's Use action closes the card and opens the chat.
  - Opening a routine confirms before leaving the card.
  - When opened from a chat that sits beside a page (the side panel), the card fills that column instead of floating.
  - The chat header carries the CO-18 face, and it updates live too.
  - *Files:* `pages/CompanionCard.tsx`, `components/companionData.ts`, `components/AgentPanel.tsx`, `chat/ChatHeader.tsx`.
- <a id="ds-113"></a>**DS-113** `card` **List-tab template and loading.**
  - **Header:** every tab except General has the same header: the title, 18–19 px semibold, 32 px in; on the right, a 36 px round help button, a 6 px gap and a 36 px action pill (an ink fill with a white label in light mode, inverted in dark mode, per [DS-138](#ds-138)).
  - **Search row:** a fully rounded 36 px field from 20 px in to 8 px before a 36 px round filter or sort button with a hairline ring. It takes focus on a tab switch.
  - **Content:** starts 8 px below the search row. Rows are 54 px tall, 20 px in (12 px outside the title's inset), with 1 px dividers and a light grey rounded fill on hover.
  - **Empty states:** a single muted 14 px line.
  - **Loading:** a four-row skeleton (an icon square, a bar, a right bar and a round button), under the [DS-106](#ds-106) rule.
  - *Before:* the action button uses Apex's accent colour, there is no help button, and skills are separate bordered cards.
  - *Files:* `companion-card/SkillsTab.tsx`, `RoutinesTab.tsx`, `FilesTab.tsx`, `MemoryTab.tsx`, `ModelsTab.tsx`, `card.css` (`.co-tab*`, `.co-search`, `.co-list`), `ui/States.tsx`.
- <a id="ds-114"></a>**DS-114** `card` **Skills rows and the shared group.**
  - Each row: a 16 px glyph at +20, the name at +56 (with an ellipsis), a muted 12–13 px last-used column at about 56% of the row width, a 74×28 white hairline pill for the Use action, and a 26 px round ⋯ button.
  - The group of skills shared with every companion becomes a 28 px disclosure (a chevron, a muted label, then a lighter count) that sticks under the tab row while scrolling.
  - *Files:* `SkillsTab.tsx`, `card.css`.
  - *Refines:* [CO-06](feature-spec.md#co-06).
- <a id="ds-115"></a>**DS-115** `card` **Files rows.**
  - The title is a breadcrumb ghost button.
  - The action is an ink pill that opens the companion's files in Library, with a trailing arrow glyph.
  - The search field has a sort button.
  - Rows have five columns (a 20 px icon, the name, a muted type, a relative time and the size) plus a 24 px round ⋯ button.
  - *Files:* `FilesTab.tsx`, `companion-card/logic/files.ts`.
- <a id="ds-116"></a>**DS-116** `card` **Memory layout.**
  - A dismissible explainer strip (542×72, very light grey, rounded) with three glyph-and-text columns.
  - A 160×40 two-segment control for the two memory views.
  - A day-grouped timeline: an 88 px right-aligned date column, a 24 px rail with 14 px nodes and a dashed connector, and a content column with a medium title and muted text.
  - Apex fills it from its own note history (`logic/notes.ts`, `logic/history.ts`).
  - *Files:* `MemoryTab.tsx`, `card.css`.
- <a id="ds-117"></a>**DS-117** `card` **Models rows.**
  - Each setting (model, effort) becomes a 60 px row: a 32 px grey rounded tile with a glyph, a 14 px title over a muted one-line description, and a 200×32 hairline pill picker on the right.
  - A footer line holds a muted note and a small ink pill ("Open Model and key").
  - This replaces the stacked selects and the explanatory list.
  - *Files:* `ModelsTab.tsx`, `companion-card/logic/models.ts`.
- <a id="ds-118"></a>**DS-118** `card` **Editor stage: the category ring.**
  - Eight 46 px card-coloured circles with a soft shadow, each previewing its category in the look's colours.
  - They sit on a ring of radius about 204 px around the canvas centre: the inner pairs at (±168, ±120) and the outer pairs at (±198, ±42).
  - **Categories,** top to bottom:
    - left arc: Colours (tints and palettes), Shape (body, head, ears), Eyes, Mouth;
    - right arc: Brows, Hat, Hair, Accessories (glasses, earwear, prop).
  - Hover shows a small label chip above the bubble. The selected bubble shows a darker ring.
  - The bubbles form an arrow-key tab list.
  - *Files:* `pages/CompanionEditor.tsx` (a new `LookRing`, reusing `co-face-swatch` and the part thumbnails), `card.css`.
- <a id="ds-119"></a>**DS-119** `card` **Editor option panels.**
  - A floating 184 px card: radius about 16, a soft shadow, 12 px padding, a title and a 24 px close button.
  - It anchors to the hero's left edge for left-arc categories and its right edge for right-arc ones, about 59 px below the hero's top. It fades in over about 150 ms with no slide.
  - **Content:** a four-column grid of 37 px round tiles with 4 px gaps. The current tile has a thick ink ring and a check badge. The grid scrolls inside once it passes about 390 px. Accessories split into headed sub-groups. An optional slider card sits 6 px below ([DS-120](#ds-120)).
  - **Colours:** a tint chooser plus the swatch grid, with palettes as a row.
  - Edits save live and feed undo and redo.
  - *Files:* `pages/CompanionEditor.tsx` (`LookEditor`), `card.css`.
- <a id="ds-120"></a>**DS-120** `card` **Part adjustments (sliders).**
  - Add clamped numeric adjustments to the look:
    - head size and ear height;
    - eye size, spacing and height;
    - mouth size and height;
    - brow size, height and tilt;
    - accessory size and height.
  - They show as labelled sliders: an ink filled track left of the thumb, a light track to its right, and a round thumb.
  - The rig applies them. They stay backward-compatible in `.apexcompanion` export and import: missing values mean the defaults.
  - *Files:* `src/shared/companion.ts` (`CompanionLook.adjust`), `src/shared/companionLogic.ts` (`normalizeLook`), `companion/character.ts`, `companion/face.ts`, `companion-card/logic/share.ts`, `pages/CompanionEditor.tsx`.
  - *Test:* normalisation clamps the values, and an old file imports unchanged.
- <a id="ds-121"></a>**DS-121** `card` **Full-tab variant.**
  - An `apex://companion/<id>` tab renders the same component as a page filling the content area: no card border, radius or backdrop, and close closes the tab.
  - The vertical metrics are identical. Horizontal elements stretch, and the figure keeps its fixed size.
  - *Before:* the route opens the floating card over the page.
  - *Files:* `App.tsx` (`routeCard`), `pages/CompanionCard.tsx`, `pages/InternalPage.tsx`, `card.css`.
- <a id="ds-122"></a>**DS-122** `card` **Entry points.**
  - The card opens from:
    - the gutter face ([DS-52](#ds-52));
    - the companion row in the details panel ([DS-124](#ds-124)): a 20 px face, the name and a 14 px gear at the right, with a light grey 8 px-radius fill on hover;
    - the start surface's figure ([DS-74](#ds-74));
    - the face in All chats rows (30 px).
  - The composer chip opens the companion and mode menu ([DS-125](#ds-125)), never the card.
  - *Files:* `chat/ChatLog.tsx`, `chat/DetailsPanel.tsx`, `components/StartSurface.tsx`, `pages/AllChats.tsx`, `App.tsx` (`openCompanionCard`).

### Design choices: companion card

- **Hero wash.** The companion's skin or head colour mixed into the card surface, nearly flat, easing to the card colour over the hero's last ~130 px.
- **Primary pill.** The darkest look colour (outfit or hair), darkened automatically until white text passes 4.5:1. The label is "Export…", which writes the `.apexcompanion` file and the share image.
- **Neutrals.**
  - The underline and active label use `--text-primary`.
  - The backdrop is about a 10 px blur, plus, in light mode, a slight lift toward `--bg-base`.
  - The card's radius, hairline and shadow are `--radius-xl`, `--border-subtle` and a softened `--shadow-overlay` (no shadow in dark mode).
- **Avatar.** The [CO-18](feature-spec.md#co-18) floating head: no circle, disc, ring or background shape around it.
- **Icons (lucide).**
  - Tabs: `UserRound` for General, `WandSparkles` for Skills, `CalendarClock` for Routines, `Folder` for Files, `Brain` for Memory, `Cpu` for Models.
  - Header: `EllipsisVertical` for more and `X` for close. List tabs: `CircleHelp`, `ListFilter` and `ArrowUpDown`. Editor: `Undo2` and `Redo2`.
  - Pills: `Palette` for the look pill and `FileDown` for Export….
  - Switcher: `ChevronsUpDown`. Summary rows reuse their tab icons, and the personality pill uses `Smile`.
- **Editor previews.** The bubbles and tiles are renders of each part from the companion's look.
- **Wording.**
  - Look pill: "Customize look". Instructions label: "Standing instructions", with the explanation in the tooltip.
  - Empty state: "Tell ‹name› how you like things done."
  - Switcher items: "New companion…" and "Add from file…".
  - Toolbar presets: the names of the four shuffle styles.
  - Save pill: the existing saving, saved and couldn't-save states.
- **Big name.** About 28 px semibold.
- **Motion.** The card fades on `--motion-enter` (about 140 ms, ease-out) and `--motion-exit` (about 180 ms, accelerating). The underline glides on `--motion-glide` (about 150 ms). The editor widens on `--motion-medium` (about 250 ms) and narrows in about 300 ms on the exit curve.

---

## Chat page and panel

### Layout

Window px, with the details panel shown unless noted.

**Surface.**
- One near-white surface fills the content area, a hair darker than the composer's white. It has no pattern and no ambient motion.
- **Details-panel column:** x 1165–1470 (305 wide), full height, with no fill or divider of its own.
- **Reading column:** 640 wide. With the panel: x 413–1053, centred on 732.5 (the middle of 300–1165). Without it: x 565–1205, centred on 885.
- **Composer:** 641 wide (x 412–1053); its outer left edge sits 1 px left of the text.
- **Top and bottom:** the first transcript item starts 48 px below the content top, and the last ends about 63 px above the composer's top.

**Header.** No bar, background or divider; it floats over the chat.
- **Leading mark:** 22×22 at x 323 (23 px from the content's left edge), centred at y 105, 27 px below the content top. It holds the companion's [CO-18](feature-spec.md#co-18) face ([DS-48](#ds-48)).
- **Title:** starts at x 359, 14 px after the mark. About 14 px, semibold, near-black, on one line with an ellipsis after about 170 px of text. The rename target is 192×24 from x 350.
- **Halo:** a soft, page-coloured halo sits behind the mark and title and hides transcript text passing under them, with a feathered right edge about 20–30 px wide. Text to the right of it, in the same band, stays at full contrast.
- **Top fade:** transcript text fades out over the first ~22 px below the hairline and is fully legible from about y 103.
- **Right:** ⋯ (32×32 at x 1390) and the details-panel toggle (32×32 at x 1426), 4 px apart, with the toggle 12 px from the window's right edge and 18 px glyphs. Toggle on: a light grey rounded-square fill (radius about 8). Toggle off: no fill. There is no new-chat button in the header.

**Type and spacing.**
- Reply and bubble body: 16 px regular on a 25 px pitch, near-black.
- The question line, inline headings and the next-steps heading: 16–17 px semibold on about a 28 px line.
- The tool-group label: about 15–16 px semibold, plus a muted regular suffix. The caption above sub-agent tiles: about 15 px, muted.
- The duration line: 12–13 px regular, muted. Composer text and placeholder: 16 px. The composer chip label: about 15–16 px medium in the companion colour. Details-panel labels and rows: about 13 px. Tooltips: about 13 px.
- **Gaps:** about 16 px between paragraphs; about 19 px from text to a tool group and about 24 px from a tool group to text; about 44 px from a paragraph to the next question or heading block.
- **Bullets** hang: the marker sits at +10 and its text at +24.

**Assistant turn.** No bubbles.
- **Gutter avatar:** a 28×28 button at column −40 (x 373), with a 12 px gap to the text. The bust image is about 31 px and overflows its box slightly. Its centre sits about 5 px above the centre of the first line box.
  - It appears only on the first block of a turn and on a closing question block. The question block's avatar carries a small dark "?" mark at its top-right. Later blocks in the same turn have no avatar.
- **Tool group:**
  - A disclosure button in the gutter: a 24 px light grey circle with a chevron at column −38 (x 375), centred on the tiles.
  - Tiles of about 38–40×44: white, radius about 12, with a hairline and a soft shadow. Several tiles overlap, each offset about 36 px; the tile row's box is 48 tall.
  - The label starts 12 px after the last tile: a semibold activity plus a muted count of further actions.
- **Sub-agent block:** a muted caption, then a hairline across the full column, then a row of the same overlapping tiles, each holding a 24 px companion bust with a small positive check badge at its bottom-right. A semibold label follows, then another hairline.
- Intermediate text blocks have **no hover affordance**: no fill and no actions.

**User message.**
- Right-aligned, with its right edge on the column's right edge. At its widest it is about 607 px, about 95% of the column.
- A **neutral** light grey fill one step below the page, with no hue wash. Radius 22, padding 24 horizontally and 12 vertically, text 16/25.
- A small tail curls from the bottom-right corner and reaches about 8 px below the bubble.
- **Hover actions:** copy and edit, 24×24 buttons with 16 px glyphs and a 4 px gap, right-aligned to the bubble's right edge, 18 px below it, in a muted tone. The bubble itself doesn't change.
- About 32 px separate the actions row from the next turn's avatar.

**Final turn.**
- **Question block:** the question line, then its description (16/25). 16 px below sits the reply row:
  - **Voice pill:** 169×36, fully rounded, filled with the companion colour. A white 20 px glyph sits 12 px in, and a white semibold label of about 16 px starts 40 px in.
  - **Typed-reply button:** a borderless ghost button, 144×36, starting 7 px after the pill. A 16 px pen glyph sits 12 px in, with a muted label of about 16 px.
- **Next steps:** the heading sits about 51 px below the reply row. Rows are 40 tall on a 44 px pitch and span the column; the hover box bleeds 8 px left of it. Each marker is a 28 px white circle with a hairline, a soft shadow and a 14 px glyph, and the label starts at +40.
- **Duration line:** 31 px below the last row's bottom edge.
- **Action row:** 21 px below the duration text. 24×24 buttons with 16 px glyphs on a 28 px pitch, in a muted tone.
  - At rest: rate up, rate down and a memory glyph. The memory glyph is present only when the turn saved memories; its count is in the tooltip.
  - Hovering anywhere over the turn adds copy and ⋯ (details) at the end, so the row grows from three icons to five.

**Jump to bottom.** A 36 px white circle with a hairline, a soft shadow and a down arrow, centred on the column with its bottom 15.5 px above the composer's top. It shows only when you are scrolled away from the bottom. There is no bottom fade above the composer.

**Composer.** The chat page and the start surface use the same component.
- **Card:** 641 × 114.5, radius about 24, a white fill one step brighter than the page, a one-device-pixel **neutral** grey hairline, and a very soft, wide shadow, mostly below. On the chat page its top is at y 793 and its bottom 15.5 px above the window's bottom edge.
- **Text:** the text box starts 21 px from the card's left and 16 px from its top, at 16 px.
- **Control row:** 36 tall, with insets of 13 px left, 12 px right and 12.5 px bottom.
- **Add (+):** a 36 px circle at the left with a 20 px glyph. No fill at rest; a light grey circle on hover.
- **Right cluster,** 4 px gaps: the chip, then (only when text exists) a secondary mic, then the primary button.
- **Chip:** a 109×36 pill with no fill at rest: a 24 px avatar 8 px in, then a label and a 14 px chevron in the companion colour. It gets a light grey pill fill on hover and while its menu is open. On the start surface it has no avatar and is 80 wide.
- **Primary at rest:** the mic, a 36 px circle filled with the companion colour and a white 20 px glyph. Hover makes it paler.
- **With text:** the primary becomes send (the same circle with a white up arrow). A secondary mic appears to its left: a 36 px white circle with a hairline ring and a dark 18 px glyph. The chip moves 40 px left.
- **Hover and focus:** hover darkens the hairline one step. Focus changes nothing: no ring and no glow, the placeholder stays, and only the caret appears.

**Composer menus.** In-page cards, not native menus.
- **Shared style:** 240 wide, white, radius about 14, a hairline, a soft shadow and 5 px inner padding. Rows are 230×35–36; a hovered row gets a light grey rounded fill (radius about 8). Dividers are full-width hairlines with about 4 px of space on each side.
- **Chip menu** (240×236): it opens upward, its bottom 12 px above the chip and its right edge 14 px past the composer's right edge. Top to bottom:
  1. a search row: a muted placeholder with no visible box, text 14 px in;
  2. companion rows: a 22 px avatar 9 px in, the label 36 px in, and a filled dark check circle at the right on the current one;
  3. a divider;
  4. preset rows: a 12–14 px dark glyph 14 px in and the label 36 px in. An unavailable row is greyed and shows a lock at the right. The current row has the check;
  5. a muted label plus a small switch (off: a light grey track and a white knob).

  It is neutral except for the avatars.
- **Add menu** (240×310): it opens upward with its left edge on the + button and its bottom 11 px above it. Top to bottom:
  1. two attach rows: a 16 px glyph 12 px in, the label 36 px in;
  2. a divider;
  3. three submenu rows, each with a 14 px chevron 12 px from the right;
  4. a divider;
  5. up to three recent-tab rows: a favicon and the title, with an ellipsis.
- **Submenu:** it cascades to the right, about 3 px off the parent, with its top about 55 px above the parent's top. It has its own search row and a scrolling list of 35–36 px rows with 16 px glyphs, clipped at the bottom. The parent row stays filled while it's open.

**Details panel.**
- **Card:** x 1177–1450 (273 wide), 12 px in from the column's left edge and 20 px from the window's right edge. Its top is at y 134 (56 px below the content top) and its height follows its content. Radius about 14, white, a neutral hairline and a soft shadow.
- **Section header:** a full-width 273×32 button. The label is about 13 px, muted, 16 px in. A 12 px chevron sits 4 px after it, visible when the section is collapsed (pointing sideways). A collapsed section can show a count inline.
- **Rows:** 257×28–30 at 8 px in, on a 30 px pitch.
  - Leading: a 20 px avatar, or a 14 px glyph centred in a 20 px box, 8 px into the row.
  - Label: 13 px near-black, 34 px into the row, with an ellipsis.
  - Trailing, 8 px from the right: a 14 px gear, a stack of three overlapping 20 px app logos in white rings, or right-aligned muted status text.
  - Hover: a light grey rounded fill across the row. The companion row opens the companion card.
- **Rhythm:** the first header starts 8 px below the card's top. After a section's last row come 15 px, an inset hairline (16 px in from each side), 5 px, then the next header. After a collapsed header: 3 px, then the hairline. The last section ends 8 px above the card's bottom.
- **Below the card:** a 12 px gap, then a full-width 32 px pill in the accent role with a white label of about 14 px; 9 px below that, a two-line centred muted caption, 12–13 px on a 16 px pitch.
- **Sections:** companion and connectors; skills used; files (collapsed, with a count); sub-tasks (with a run time at the right); usage (collapsed, its count in the accent role, expanding to used, available and manage).

**Tooltip.** A near-black rounded rectangle (radius about 8) with a thin lighter edge and a white label of about 13 px, drawn in its own window so it can leave the page area. It appears about 1 s after the pointer rests: below header buttons (kept inside the window, right-aligned near the right edge), above composer controls, and above the figure on the start surface.

**Dark.**
- The page is a near-black neutral, with no purple cast. The composer, details card and menus are one grey step above it, with hairlines about two steps above them and no visible shadows.
- Text is white and a muted light grey. The user bubble and markers are raised greys with hairlines. The header toggle's on state is a lifted rounded square.
- Companion-coloured fills (the voice pill, mic and send) are identical to light mode. Only companion-coloured text, such as the chip's label, is lightened so it reads, on the start surface too ([DS-139](#ds-139)).
- The accent role is unchanged.

**Docked panel.**
- The same chat in a compact mode: the same floating title chip with no divider, the column filling the panel, neutral message surfaces, and its own empty-state hint about the page beside it.
- Controls: hide (the panel shortcut) and expand.

### Behaviour and motion

**Empty chat.**
- New chat opens the start surface itself ([New tab and start surface](#start-surface)): the live full-body companion ([DS-72](#ds-72)) stands 39 px above a centred 640 px composer, with the tray and the ideas card below. Nothing is created in the chat list until the first send.
- When the composer's text becomes non-empty, the figure's gaze swings to the composer over about 180 ms and holds there, with a double blink about 1.8 s later. Clearing returns it. The gaze also follows the caret on each keystroke ([DS-72](#ds-72)).

**Sending from the start surface.**
- A short opening status with a spinner shows inside the composer.
- The same tab becomes the chat page, and the composer glides as a shared element from its centred position to the chat's bottom.

**Primary button states:**

| State | Primary button | Mic |
|---|---|---|
| Empty and idle | Voice | Takes the main slot |
| Text present | Send | Moves to the small secondary slot |
| Sending or uploading | Spinner inside Send | Secondary |
| Running, nothing typed | Stop, in a distinct style | Secondary |
| Running, text typed | Send, which queues | Secondary |
| Editing a queued message | Save (check) | Secondary |
| Recording | Send the transcription | Secondary, shows stop |
| Transcribing, creating a chat, or waiting for a transcript | Disabled spinner | Hidden |

At rest the right side holds only the chip and the mic, and the secondary mic appears with text. The swap, the placeholder change and the chip's 40 px shift all happen in the same frame as the first character, with no transition, and clearing reverses them just as fast.

**Composer.**
- **Focus:** only the caret appears, blinking on a 500 ms period. Hover darkens the hairline one step.
- **Placeholders:** three base variants (empty page, empty panel, follow-up), then overrides for queue, interrupt, editing a queued item, an attached meeting and signed out.
- **Compact row:** when a request card docks on top of the composer and the text fits on one line, the composer collapses to a single row (text between + and the buttons). Its height animates and the text slides into place; under Reduce Motion it snaps.
- **Request cards:** an approval card grows up out of the composer (height and opacity together, clipped at the composer's top edge) and collapses back the same way.
- **Menus:** the chip and + menus appear whole within one frame and go on Escape. The chip shows its grey pill while its menu is open. Hovering a submenu row fills it and opens the cascade in under 0.45 s.
- **Chat-page avatars** (gutter and chip) don't react to typing.

**After sending.**
- A pending block appears at once: the gutter face and one muted status line with a live elapsed timer in tabular digits, ticking every second.
- A soft light band travels across the status text in a continuous loop. That band is the working indicator; there is no spinner.

**While working.**
- Tool steps fold into one line: the current activity in plain words, the timer, and a small overlapping stack of favicons (or a fallback glyph).
- Hovering the fold rolls the line to reveal a show-details control with a rotating chevron. A click expands the trace, which is inert while collapsed.
- Running group labels carry the same moving light band.

**Streaming.**
- Text updates in small batches a few times a second.
- Each new word fades in quickly on a staggered timeline, so sentences write themselves in a soft wave.
- Words already shown never animate again. A per-chat record of what has been revealed survives remounts and moves between surfaces.
- Reduce Motion turns the reveal off.

**Questions and next steps.**
- Requests stack above the composer, and the composer compacts.
- Hovering the typed-reply button previews an opening phrase in the composer as ghost text. A click inserts it and focuses the composer.
- Next-step rows preview their prompt on hover or focus. A click toggles a row into the draft: the marker fills with the companion's colour and shows a check, and the row tints.
- The list locks after your next send, and while a reply streams.

**Done.**
- The live status freezes into the duration line, and the footer appears.
- Elsewhere, a sound plays and the sidebar row gets a badge.

**Hover.**
- Hovering a user bubble fades its copy and edit buttons in over about 100 ms and out over 100–150 ms, opacity only, with no slide.
- Hovering anywhere over the final turn adds copy and ⋯ to its action row with the same fade.
- Hovering an intermediate reply block does nothing.

**Avatars.** The gutter face opens the companion card. It has **no hover effect**: the cursor stays an arrow, and there is no tooltip, name, time or motion. The header shows the companion's face ([DS-49](#ds-49)).

**Scrolling.**
- The view follows output while you are at the bottom.
- Any upward intent releases following at once: wheel up, ↑, Page Up, Home or ⇧Space. A short grace period stops it re-sticking straight away.
- Jumping to the newest from far away lands in one frame, and the jump button disappears in the same frame. It is always instant under Reduce Motion.
- A top fade of about 22 px shows under the header. There is no bottom fade.
- Wheeling at the very top loads older messages.

**Loading.** Placeholders pulse, and skeleton bars carry the same light sweep.

**Details panel.**
- It is a permanent, user-toggled part of the chat page (a 305 px column), and its toggle sits in the header. In narrow windows it overlays the chat instead of pushing it.
- **Hide:** the toggle loses its fill. The panel fades and slides right and is gone within about 100 ms. The column and composer glide right on `--motion-layout` (about 150 ms, `--ease-out`). The composer's width is unchanged.
- **Show:** the panel slides in from about +100 px while fading in, on `--motion-layout` (about 150 ms, `--ease-out`). The column glides left on the same curve, and the panel's content remounts.
- The toggle's tooltip appears after about 1 s.

**Connections.**
- **Expand from the docked panel:** the chat becomes the main view of the same tab and the page becomes its side pane. Hide collapses the docked chat.
- **Card open:** the whole chat area behind the companion card blurs and lightens while keeping its scroll position.

### Requirements

- <a id="ds-49"></a>**DS-49** `chat` **Floating header.**
  - **Face:** the [CO-18](feature-spec.md#co-18) face, 22 px, 23 px from the content's left edge, centred 27 px below the content top (y 105 at 1470×923).
  - **Title:** starts 14 px after the face, at about 14 px semibold, truncating with an ellipsis after about 170 px of text inside a 192 px rename target. It is renamable in place.
  - **Halo:** a page-coloured halo with a feathered right edge sits behind the face and title. The transcript fades over the top ~22 px of the content area.
  - **Right:** only ⋯ and the details-panel toggle ([DS-123](#ds-123)), each 32 px, 4 px apart, 12 px from the edge. On means a light grey rounded-square fill.
  - Remove the 52 px bar, the divider and the status dot. Move the routine pill and the tabs-used button into the details panel ([DS-124](#ds-124)).
  - *Before:* a 52 px bar with a divider, a 28 px still, an 18 px semibold title and a status dot.
  - *Files:* `chat/ChatHeader.tsx`, `chat/chat.css`, `pages/ChatPage.tsx`.
  - *Test:* at 1470×923, no horizontal line is drawn between the header and the transcript, and the face's centre is at (334, 105) ± 1.
  - *Supersedes:* the header actions in [CH-05](feature-spec.md#ch-05) (new chat leaves the header; the routine pill and tabs-used move to the details panel) and ux-plan "Chats as pages › Header".
- <a id="ds-50"></a>**DS-50** `chat` **One column, 640 px.**
  - The text column is fixed at 640 px, centred in the space left of the details panel.
  - Reply text, the working line, the footer glyphs, the user bubble's right edge and the composer share it. The composer's outer edge sits 1 px outside the column on each side (641).
  - *Before:* min(760, …), with the text and composer 16 px apart.
  - *Files:* `chat/chat.css`.
  - *Test:* the text's left edge minus the composer's left edge is 1 ± 1 px, with the panel both shown and hidden.
  - *Supersedes:* "about 760 px" in [CH-04](feature-spec.md#ch-04).
- <a id="ds-51"></a>**DS-51** `chat` **Markdown and type scale.**
  - Replies render sanitised Markdown: hanging-indent lists, headings, bold, links and code.
  - **Body:** 16 px on a 25 px line, for replies and bubbles.
  - **Gaps:** 16 px between paragraphs, 44 px between blocks, 19 px from text to a tool group and 24 px from a tool group to text.
  - Inline headings and the question line are semibold at 16–17 px. Bullets sit at +10 with their text at +24.
  - Chat has its own type tokens (before, everything was `--text-md`, 13 px).
  - *Before:* pre-wrapped plain text at about 14/20, with literal dashes and a 12 px gap.
  - *Files:* `styles.css` (new `--text-chat`, `--leading-chat`, `--text-ui` at 14, `--text-meta` at 13, `--text-caption` at 12), `chat/chat.css`, new `chat/Markdown.tsx`, `chat/ChatLog.tsx`.
  - *Test:* no raw "- " is visible in a reply that contains a list.
- <a id="ds-52"></a>**DS-52** `chat` **Gutter face.**
  - A 28 px button at column −40, with a 12 px gap to the text. The image may overflow its box by about 3 px. Its centre sits about 5 px above the centre of the first line box.
  - It shows only on a turn's first block and on a closing question block, which carries the [DS-67](#ds-67) question mark.
  - A click opens the companion card. **No hover effect:** drop the hover name, time and motion.
  - The newest reply's face shows the chat's live state.
  - *Before:* replies have no face.
  - *Files:* `chat/ChatLog.tsx`, `chat/CompanionAvatar.tsx`, `chat/logic/replies.ts` (which block gets the face).
- <a id="ds-53"></a>**DS-53** `chat` **User messages.**
  - Right-aligned to the column's edge, at most about 95% of the column.
  - A **neutral** fill one step below the page, with no accent and no hue. Radius 22, padding 24 by 12, plus a small bottom-right tail.
  - **Copy and edit** ([CH-09](feature-spec.md#ch-09)): 24 px buttons with 16 px glyphs and a 4 px gap, right-aligned 18 px below the bubble, fading in over about 100 ms. The bubble doesn't change on hover.
  - The side panel uses the same neutral fill.
  - *Before:* the same accent-soft bubble in both places.
  - *Files:* `chat/ChatLog.tsx` (`UserMessage`), `chat/chat.css`.
  - *Supersedes:* this document's earlier profile-hue tint on message surfaces.
- <a id="ds-54"></a>**DS-54** `chat` **Pending state.**
  - Within one frame of sending, a pending block shows the gutter face and one muted status line with an elapsed timer that ticks every second.
  - A looping light sweep crosses the status text, and there is no spinner.
  - Under Reduce Motion the sweep stops and the text stays fully readable.
  - *Before:* a spinner and a "working on it" line.
  - *Files:* `ChatLog.tsx`, `chat.css`.
- <a id="ds-55"></a>**DS-55** `chat` **Work fold.**
  - Consecutive tool steps collapse into one line: the current activity, the timer, and a small overlapping stack of tiles.
  - **Disclosure:** a 24 px light grey circle with a chevron in the gutter at column −38, centred on the tiles. Hover reveals the show-details control, and a click expands the trace.
  - **Tiles:** about 38–40×44 (glyphs or favicons), white, radius about 12, with a hairline and a soft shadow, each offset about 36 px.
  - **Label:** semibold, with a muted "+N more" suffix, 12 px after the stack.
  - **Sub-task block:** a muted caption, a hairline, overlapping avatar tiles with a status check, a label, then a closing hairline.
  - When the run ends, the line freezes into a still duration line above the footer.
  - *Before:* every step is listed with a pulsing dot.
  - *Files:* `ChatLog.tsx`, `chat.css`, `chat/logic/replies.ts`.
  - *Refines the visuals of:* [CH-19](feature-spec.md#ch-19) and [CH-20](feature-spec.md#ch-20).
- <a id="ds-56"></a>**DS-56** `chat` **Word reveal.**
  - Streamed text applies in batches a few times per second, and each new word fades in on a staggered timeline.
  - The revealed state is kept per chat in the store, so remounting, or moving the chat between the panel and the page, never replays words.
  - Reduce Motion turns the reveal off.
  - *Files:* `ChatLog.tsx`, `chat/store.ts`.
- <a id="ds-57"></a>**DS-57** `chat` **Duration line and quiet footer.**
  - The duration line is 12–13 px muted, 31 px below the last block.
  - The action row sits 21 px below it: 24 px buttons with 16 px glyphs on a 28 px pitch, in a muted tone.
  - **At rest:** helpful, not helpful, and a memory glyph button that shows only when the turn changed memory. Its count goes in the tooltip, and a click opens the memory menu. This replaces the memory text pill.
  - **On hover anywhere over the turn:** copy and ⋯ fade in after them ([DS-141](#ds-141)). ⋯ holds retry and details.
  - A rating still opens the [CH-11](feature-spec.md#ch-11) note.
  - *Before:* five always-visible icons, a memory text pill and no duration line.
  - *Files:* `chat/ChatLog.tsx` (`ReplyFooter`, `Reply`), `chat/chat.css`.
  - *Refines:* [CH-10](feature-spec.md#ch-10). *Supersedes:* this document's earlier "copy always visible; memory marker behind ⋯".
- <a id="ds-58"></a>**DS-58** `chat` **Composer shell.**
  - **Size:** 641 × about 114, radius 24.
  - **Edge:** a white fill (raised grey in dark mode), a **neutral** one-device-pixel hairline, and a very soft, wide shadow (none in dark mode). It has no profile-hue tint.
  - **Position:** on the chat page, 15–16 px above the window's bottom edge, with about 63 px of clearance above it.
  - **Text:** starts 21 px from the left and 16 px from the top, at 16 px.
  - **Control row:** 36 tall, with insets of 13 px left, 12 px right and 12.5 px bottom.
  - **Left:** a + button: a 36 px circle with no fill at rest and a grey circle on hover. [DS-126](#ds-126) fills its menu.
  - **Right:** the chip (moved from the bottom-left), then the mic slot, then the primary button, with 4 px gaps.
  - **States:** hover darkens the hairline one step. **Remove the focus ring and halo**: focus shows only the caret.
  - *Before:* about 94 px tall, with a strong border, an accent focus ring, the chip at the bottom-left, a grey send button, and no + or mic.
  - *Files:* `chat/Composer.tsx`, `chat/chat.css`.
  - *Test:* the computed box-shadow and border are identical with and without focus.
- <a id="ds-59"></a>**DS-59** `chat` **Primary button state machine.**
  - **At rest, with an empty field:** the primary button is the voice button (companion fill, white glyph).
  - **With text:** the primary becomes send (the same circle with an up arrow). A secondary 36 px white circle with a hairline ring and a dark glyph appears to its left, and the chip moves 40 px left. The swap is instant, with no transition, and clearing reverses it instantly.
  - The running, queue, edit and transcribing states follow the table above: send with a spinner while sending, stop when running and empty, send-to-queue when running with text, save while editing a queued item, and a disabled spinner while a chat is being created.
  - *Files:* `chat/logic/composer.ts` (a pure `composerButtons(state)`, with unit tests), `chat/Composer.tsx`.
- <a id="ds-60"></a>**DS-60** `chat` **Placeholder variants.** Distinct hints for an empty page, an empty panel (about the page beside it) and a follow-up, plus the existing overrides. The start surface addresses the companion, the follow-up differs, and the placeholder stays visible on focus. *Files:* `chat/logic/composer.ts`. *Refines:* [CH-06](feature-spec.md#ch-06).
- <a id="ds-61"></a>**DS-61** `chat` **Scroll rules.**
  - Following releases on wheel up, ↑, Page Up, Home or ⇧Space, with a short grace period.
  - **Jump button:** a 36 px white circle with a hairline, a shadow and a down arrow, centred on the column with its bottom 15.5 px above the composer. The new-output dot may sit on it. It replaces the "Jump to newest" pill.
  - **Jump:** from far away it lands in one frame, and the button hides in the same frame. Near the bottom it may scroll smoothly. It is always instant under Reduce Motion.
  - **Fades:** a top fade of about 22 px, only when content is hidden under the header and the chat has messages. No bottom fade.
  - **Padding:** 48 px at the top, so the first item clears the header row.
  - *Before:* a 48 px distance threshold, no intent detection and no fades.
  - *Files:* `ChatLog.tsx` (`useReadingPosition`), `chat/logic/view.ts` (with tests), `chat/chat.css`.
  - *Refines:* [CH-12](feature-spec.md#ch-12).
- <a id="ds-62"></a>**DS-62** `chat` **Docked requests.**
  - Approvals and questions dock above the composer ([CH-38](feature-spec.md#ch-38)). Each grows up out of the composer (height and opacity, clipped at its top edge) and collapses back the same way.
  - With a request docked and one-line text, the composer animates into a single row and back.
  - Reduce Motion snaps both.
  - *Before:* approvals sit inline in the log with an endless attention pulse.
  - *Files:* `Composer.tsx`, `ChatLog.tsx`, `chat.css`.
  - *Supersedes:* "items pulse until answered" in [CH-38](feature-spec.md#ch-38). There is no looping pulse; attention comes from the entrance, the dot on the avatar and the notification.
- <a id="ds-63"></a>**DS-63** `chat` **Question and next-step blocks.** When the agent asks or suggests through tools ([CH-44](feature-spec.md#ch-44), [CH-27](feature-spec.md#ch-27)):
  - **Question block:** the face with the question mark ([DS-67](#ds-67)), a semibold question, then its description. 16 px below, the reply row:
    - a voice pill, 169×36, fully rounded, in the companion's colour, with its glyph 12 px in and a white semibold label 40 px in;
    - a ghost typed-reply button, 36 tall, 7 px after the pill.
  - **Next steps:** a heading 51 px below the reply row, then rows of 40 px on a 44 px pitch spanning the column (the hover box bleeds 8 px left). The marker is a 28 px white circle with a hairline, a soft shadow and a 14 px glyph; Numbered and check markers use this size. The label starts at +40.
  - **Behaviour:** hover or focus previews the text in the composer, a click inserts or toggles it, and the block locks after send.
  - *Files:* `ChatLog.tsx`, `Composer.tsx`, `chat/chat.css`.
- <a id="ds-64"></a>**DS-64** `chat` **Panel header and compact mode.**
  - The side panel uses the same floating chip header (CO-18 face, title and a status word) with no divider, plus switch, expand, ⋯ and hide.
  - The column fills the panel.
  - *Before:* a 56 px bar with a divider, a 40 px full figure, a "Ready" line and four buttons.
  - *Files:* `components/AgentPanel.tsx`, `chat.css`.
- <a id="ds-65"></a>**DS-65** `chat` **Expand hands the chat over.**
  - Expanding from the panel closes the panel. The same tab becomes the chat page, with the page the panel sat beside shown as its side pane ([CH-04](feature-spec.md#ch-04)), and a control collapses it back into the panel.
  - The draft, the scroll position and the revealed-word record carry over.
  - The change runs on the layout timeline ([DS-84](#ds-84)).
  - *Before:* expand opens a new chat-page tab while the panel stays open on the same chat.
  - *Files:* `App.tsx`, `AgentPanel.tsx`, `chat/surfaces.ts`, `src/main/tabs.ts`.
  - *Supersedes:* "an expand button that opens the same chat as a page" in [CH-03](feature-spec.md#ch-03).
- <a id="ds-66"></a>**DS-66** `chat` **Loading.** Chat skeleton rows pulse gently and carry the same light sweep as the working status, which is off under Reduce Motion. *Files:* `ChatLog.tsx`, `ui/States.tsx`. *Refines:* [SS-04](feature-spec.md#ss-04).
- <a id="ds-123"></a>**DS-123** `chat` **Details panel: shell and toggle.**
  - **Column:** a 305 px right column on the chat page, full height, with no fill or divider.
  - **Card:** 12 px from the column's left edge and 20 px from its right edge, its top 56 px below the content top. Radius 14, white (raised in dark mode), with a hairline and a soft shadow.
  - **Toggle:** the header toggle shows and hides it, and the choice is remembered per window. Its tooltip appears after about 1 s.
  - **Motion:** the reading column and composer re-centre on the layout timeline ([DS-84](#ds-84)). The panel fades and slides by about 100 px.
  - **Below the card:** room for an optional full-width 32 px action pill and a two-line centred muted caption. The slot holds usage or API-key prompts.
  - *Files:* new `chat/DetailsPanel.tsx`, `pages/ChatPage.tsx`, `chat/ChatHeader.tsx`, `chat/chat.css`, `chat/store.ts` (open state).
  - *Refines:* the shell of [CH-35](feature-spec.md#ch-35).
- <a id="ds-124"></a>**DS-124** `chat` **Details panel: sections and rows.**
  - **Section header:** a full-width 32 px button. The label is 13 px muted, 16 px in. A 12 px chevron shows when collapsed, and a count may sit inline. The collapse state is remembered.
  - **Rows:** 28–30 px tall on a 30 px pitch, 8 px in: a 20 px leading box, a 13 px label 34 px in with an ellipsis, and a trailing slot holding a gear, a logo stack or muted status. Hover gives a grey rounded fill.
  - **Rhythm:** the first header 8 px below the card's top; after a section, 15 px, an inset hairline (16 px in from each side), then 5 px; 3 px after a collapsed header.
  - **Content, in order:**
    1. the companion row, which opens the card, with a gear for its settings;
    2. connectors, with a logo stack;
    3. skills used;
    4. files, collapsed with a count;
    5. the routine and the tabs used, moved from the header;
    6. sub-tasks, with a run time at the right;
    7. tokens and cost, collapsed with a tabular count.
  - *Files:* `chat/DetailsPanel.tsx`, new `chat/logic/details.ts` (a pure section model, with tests), `chat/hooks.ts`.
  - *Refines:* the sections of [CH-35](feature-spec.md#ch-35) and the tabs list of [CH-33](feature-spec.md#ch-33).
- <a id="ds-125"></a>**DS-125** `chat` **Composer chip and its menu.**
  - **Chip:** a 36 px-tall pill with no fill at rest: a 24 px face (none in the start variant), a short label in the companion colour at about 15–16 px medium, and a chevron in the companion colour. Hover and open give a grey pill fill.
  - **Menu** ([DS-94](#ds-94)):
    1. search companions;
    2. companion rows with a 22 px face and a check on the current one;
    3. a divider;
    4. model or effort preset rows with a check; rows that are unavailable or fixed show a lock;
    5. a switch row for an option (for example, advanced settings).
  - **Position:** its bottom edge 12 px above the chip; its right edge may extend about 14 px past the composer.
  - The current logic stays: switching companion mid-chat confirms and continues in a new chat.
  - *Files:* `chat/Composer.tsx` (`openChip`), `chat/chat.css`, `chat/logic/composer.ts`.
  - *Refines:* [CH-07](feature-spec.md#ch-07).
- <a id="ds-126"></a>**DS-126** `chat` **Composer + menu.**
  - **Position:** it opens upward, left-aligned with +, its bottom 11 px above it.
  - **Groups** ([DS-94](#ds-94)):
    1. attach rows (file, folder);
    2. a divider;
    3. submenus for skills, connectors and tabs, each with its own search;
    4. a divider;
    5. up to three recent tabs (a favicon and the title).
  - Skills submenu rows insert `/skill`, using the existing skill logic.
  - Actions that aren't built yet show their empty states, not hidden rows.
  - *Files:* `chat/Composer.tsx` (the `attach` slot), new `chat/AddMenu.tsx`, `chat/hooks.ts`.
  - *Refines:* the shell of [CH-21](feature-spec.md#ch-21).
- <a id="ds-127"></a>**DS-127** `chat` **Hover scope.**
  - Intermediate assistant blocks have no hover affordance.
  - The final turn's reveal triggers on hover anywhere in that turn. User-message actions trigger on the bubble's area.
  - Reveals are opacity only ([DS-141](#ds-141)).
  - *Files:* `chat/ChatLog.tsx`, `chat/chat.css`.
  - *Test:* hovering a mid-turn paragraph changes zero pixels.

### Design choices: chat

- **Working sweep.** A narrow band in the companion's colour at low strength, moving left to right with a short rest between passes (for example about 1.6 s per pass).
  - Status wording: "Pip is on it · 0:12", "Reading 3 pages · 0:41".
  - When finished: "Took 3 min 45 s".
- **Word reveal.** Each word fades in and rises 2 px over about 160 ms, staggered about 10 ms per word with a cap per batch, on `--ease-out`.
- **Edge fades.** About 22 px at the top, from the surface tokens, and none at the bottom.
- **Question block.**
  - A small speech-bubble glyph at the face's top-right, with no chip behind it.
  - Replies: "Answer by voice" (a mic pill in the companion's colour) and "Write an answer" (a ghost button with a pen).
  - Hover preview, for example "About that: …".
- **Next steps.**
  - Numbers (1, 2, 3) inside the 28 px white circles. A picked row's marker fills with the companion's colour and shows a check.
  - The heading comes from the agent, with the fallback "Where we could go from here".
- **Gutter face.** The CO-18 floating head in a 28 px box (no disc or ring), with no hover effect.
- **Header.**
  - The CO-18 face at about 22 px, and the title at about 14 px semibold.
  - A tertiary status word follows the title while something is happening ("thinking", "needs you"), in the status-dot colours.
- **Composer.**
  - **Shape:** radius 24, a raised fill in dark mode, a one-device-pixel neutral ring (`--hairline`), and a soft shadow of about 24 px blur at low opacity in light mode only.
  - **Buttons:** voice, Send and Stop filled in the companion's colour, with `Mic`, `ArrowUp` and `Square`; + is `Plus`.
  - **Placeholders:** "What should Pip do? Type / for skills", "Ask Pip about this page", "Reply to Pip".
- **Jump to newest.** A 36 px circle with `ArrowDown`, plus a dot in the companion's colour when new output arrives.
- **Footer icons (lucide):** `ThumbsUp`, `ThumbsDown` and `Brain` (memory) at rest; `Copy` and `Ellipsis` on hover.
- **Details panel.** The slot under the card shows "Add API key" or this chat's spend.

---

## Settings

### Layout

**Frame.**
- Settings fill the content area inside the normal chrome. In light mode the page is pure white, a hair lighter than the chat page.
- **Nav column:** x 300–588 (288 wide, including an 8 px resize splitter at 580–588). It is the page's colour, with a 1 px neutral hairline at its right edge.

**Nav.**
- **Header:** 56 tall (y 78–134). The title is about 18 px semibold, 24 px into the nav. A 36×36 collapse button (a double chevron) sits 8 px from the nav's right edge. A hairline under the header appears only while the list is scrolled beneath it. The list scrolls on its own.
- **Rows:** 264×36, inset 12 px on both sides, on a 38 px pitch. A 16 px solid glyph sits 18 px into the row. The label is about 14 px regular, muted at rest, 36 px into the row.
- **Group labels:** about 14 px semibold, muted, and darker than the row labels, 24 px into the nav. Each sits about 31 px above its first row. From the last row of one group to the first row of the next is 55 px.
- **Final row:** after a full-width hairline, with 10 px above and below it.
- **States:** hover gives a very light grey fill (radius about 10), with the glyph and label going near-black. Selected has the same fill, with the glyph and label in the accent role. The companion colour is never used here.

**Content.**
- An 800 px column centred in the remaining width (41 px gutters at this size).
- **Title:** about 18 px semibold in a 28 px line box, 64 px below the content top. **Subtitle:** muted, about 14–15 px, about 6 px below the title. The first card sits about 25 px below the subtitle. An optional text link with an outward arrow can sit right-aligned, level with the title.
- **Sections:** a heading of about 15–16 px semibold, an optional muted description, then the card 12–16 px below. About 48 px from one card's bottom to the next heading.

**Cards.**
- White, a neutral hairline, radius about 16 and a very soft shadow, with full-width hairline separators between rows.
- **Rows:** 54 px for a title only; 67–68 px for a title plus a description. 24 px padding on each side. An optional 20 px leading line glyph sits 24 px in, with the text 56 px in.
- **Text:** the title about 15 px semibold near-black; the description about 13 px muted.
- **Controls:** right-aligned, 24 px from the card's right edge.

**Controls.**
- **Switch:** 40×20. On is a saturated positive colour, off is a very light grey track, and the knob is white.
- **Segmented control:** a light grey track with a white raised selected segment (124×32, with an icon and label).
- **Selection tiles:** 185×128, with a radio at the top-right. The selected tile has a 2 px near-black border.
- **Radio rows:** the current option is marked at the right.
- **Pills (32 tall):** secondary is white with a hairline; primary is near-black with a white label; destructive is pale red with a red label.
- **Compact selects:** 25–26 tall with a chevron.
- **Search field:** full width and fully rounded.

**Dark.**
- The nav and content share one near-black surface, split by a 1 px divider. Cards sit one step up, with a hairline.
- The selected nav row is a lighter grey pill with its label in the accent role.
- The selected segment is the card's own colour with a hairline, on a lighter track; never white. The selected tile's border is light.
- Primary pills invert to white with dark text.

### Behaviour and motion

- **Nav click:** the content swaps in one frame and starts at its top. The row takes the selected style in the same frame. The nav doesn't move.
- **Theme change:** the whole window flips in one frame. The segmented thumb then glides to its new position over about 150–200 ms, decelerating. The nav keeps its scroll position.

### Requirements

- <a id="ds-128"></a>**DS-128** `shell` **Settings nav geometry.**
  - **Width:** 288 px, resizable through an 8 px splitter. Keep the narrow-width rail. The background matches the page, with a 1 px hairline on the right instead of the `--bg-subtle` fill.
  - **Header:** 56 tall, with the title at about 18 px semibold, 24 px in, and a 36 px collapse button 8 px from the edge. A hairline shows only while the list is scrolled under the header. The header doesn't scroll.
  - **Rows:** 36 tall on a 38 px pitch, 12 px inset, with a 16 px glyph at +18 and a label of about 14 px regular at +36, muted at rest.
  - **Group labels:** about 14 px semibold, muted (darker than rows), about 31 px above their first row, with 55 px from row to row across a label.
  - **About row:** below a full-width hairline with 10 px on each side.
  - *Before:* a 236 px tinted nav with 32 px rows and 13 px weight-500 labels.
  - *Files:* `settings/SettingsNav.tsx`, `settings/settings.css`, `pages/Settings.tsx`, `settings/logic/nav.ts` (width preference).
- <a id="ds-129"></a>**DS-129** `shell` **Nav states and colour roles.**
  - **Hover:** a very light grey fill (radius about 10), with near-black text and glyph.
  - **Selected:** the same fill, with the text and glyph in the profile hue (the one non-companion accent, as for the update capsule in [DS-18](#ds-18)). Never `--accent` or the companion colour.
  - **Activation:** the content swaps in one frame ([DS-106](#ds-106)). The new page starts at its top, and the nav doesn't move.
  - *Before:* the selected row uses the companion accent.
  - *Files:* `settings/settings.css`, `settings/SettingsNav.tsx`.
  - *Test:* switching companion changes no pixel in the settings nav.
- <a id="ds-130"></a>**DS-130** `shell` **Settings page template.**
  - An 800 px column centred in the remaining width.
  - **Title:** about 18 px semibold in a 28 px line box, 64 px below the content top. A muted subtitle of about 14–15 px follows, and the first card sits about 25 px lower.
  - **Remove the 40 px accent icon tile.** An optional external-link text action sits level with the title.
  - **Sections:** a heading of about 15–16 px semibold, an optional muted description, then the card 12–16 px below, with 48 px between sections.
  - *Before:* a 24 px title with an accent icon tile and a 720 px column.
  - *Files:* `settings/kit.tsx` (`PageHeader`, `Section`), `settings/settings.css`, all `settings/pages/*.tsx`.
- <a id="ds-131"></a>**DS-131** `shell` **Settings cards and rows.**
  - **Cards:** radius 16, white (raised in dark mode), a hairline and a very soft shadow, with full-width hairline separators.
  - **Row heights:** 54 px for a title only; 67–68 px for a title plus a description.
  - **Padding:** 24 px on each side. An optional 20 px glyph at +24, with the text at +56.
  - **Text:** the title about 15 px semibold; the description about 13 px muted. Controls are right-aligned 24 px from the edge.
  - *Before:* a 56 px minimum height, 12 by 16 px padding, and a 13 px weight-550 title.
  - *Files:* `settings/kit.tsx` (`Card`, `Row`), `settings/settings.css`.
- <a id="ds-132"></a>**DS-132** `shell` **Control vocabulary.**
  - **Switch:** 40×20. On uses one fixed positive colour, never the companion accent.
  - **Segmented control:** a grey track with a raised selected segment of about 124×32 (icon and label). The thumb glides to a new choice over about 180 ms, decelerating, which is also the only motion during a theme change ([DS-88](#ds-88)).
  - **Selection tiles:** a radio at the top-right; the selected tile has a 2 px strong border (light in dark mode).
  - **Pills (32 tall):** secondary white with a hairline; primary near-black, inverted to white in dark mode ([DS-138](#ds-138)); destructive pale red.
  - **Compact selects:** 25–26 tall.
  - *Before:* accent-coloured switches and a lighter raised thumb with a shadow in dark mode.
  - *Files:* `ui/ui.css` (`.ui-switch`, `.ui-segmented`, buttons), `ui/controls.tsx`, `settings/settings.css`.
- <a id="ds-133"></a>**DS-133** `shell` **Settings in dark mode.**
  - The nav and content share one near-black neutral surface with a 1 px divider. Cards sit one step up, with a hairline.
  - The selected nav row is a lifted grey pill with its label in the profile hue.
  - The segmented thumb equals the surface it sits on, plus a hairline and no shadow (in light mode it has a soft shadow instead), on a lighter track. It is never white.
  - Primary pills invert.
  - A theme change applies in one frame, and the nav keeps its scroll position.
  - *Before:* purple-cast dark tokens and a lighter raised thumb with a shadow.
  - *Files:* `styles.css` (neutral dark tokens without the purple cast), `settings/settings.css`, `settings/SettingsNav.tsx`, `settings/kit.tsx`, `ui/controls.tsx`, `ui/ui.css` (`--bg-thumb`), `theme.ts`.

### Design choices: settings

- **Pages and words.** The nav keeps its existing pages, groups and words. The collapse button uses `ChevronsLeft`.
- **Switch colour.** One fixed positive green token (`--positive`).
- **Selection.** The selected nav row uses the profile hue, the single non-companion accent.

---

## Companion presence

This section covers how the companion appears and behaves across every surface: small avatars, live figures, the start surface, the empty chat and welcome.

### Layout

**Small images.**
- **Sizes:**

  | Place | Box (px) |
  |---|---|
  | Sidebar chat rows | 20, at x 18 |
  | Details-panel companion and sub-agent rows | 20 |
  | Composer chip | 24, inside a 109×36 pill |
  | Card switcher and switcher menu | 28 |
  | Message avatar | a 28 px button with an image of about 31 px |
  | All chats rows | 30 |
  | Start-surface switcher pill | 30 |

- **Crop:** one flat still of the [CO-18](feature-spec.md#co-18) floating head. The head fills most of the box; the eyes glance sideways and the mouth has a small smile.
- **Frame:** no disc, border or background. The image is bottom-anchored and fills about 78% of the box's width and 88% of its height; the message image overflows its button.
- **The same image everywhere:** the active and inactive sidebar rows use an identical image.
- **State marks,** placed beside the head, never on it ([DS-67](#ds-67)):
  - working: a small stepped spinner;
  - done: a small check badge (also on finished sub-agent tiles);
  - stopped: a small icon;
  - needs input or unread: a tiny dot;
  - a closing question: a small bare dark mark, with no chip.
- **Chat header:** the CO-18 face ([DS-49](#ds-49)).

**Live vs still.**
- **Live 3D:** the card hero and the look editor (full body), the start surface's selected companion (sized by [DS-72](#ds-72)), the create preview, preset details, onboarding (full body or bust) and the voice overlay.
- **Pre-rendered stills:** every small avatar, and the companions on the new-tab floor. Floor companions also get a blink frame, gentle breathing and simulated motion.
- **No reaction in stills:** small faces never react to typing; the transcript region shows zero pixel change while typing.
- **Typing clip:** an off-screen renderer also records a short transparent typing loop, deferred while a chat loads.

**Animation set.**
- Clips: a resting loop, an entrance, a bow, a celebration, and activity loops for reading, thinking and typing.
- Face and gaze: single and paired blinks, closed eyes, a smiling or neutral mouth, a head and pupils that follow the pointer within limits, and a straight-ahead gaze when stills are rendered.

**New tab: two modes, with a remembered toggle that is on by default.**
- **Floor mode** (with one companion: the static floor, the switcher pill at the top centre, and the floor toggle and notifications as round buttons at the top right; see [New tab and start surface](#start-surface)). From back to front:
  1. A round floor seen at a low angle, made of faint concentric rings ([Design choices: presence](#presence-design-choices)). It fades out at its centre and rim.
  2. The arrival effect, only while a companion arrives. The rest of the floor dims around it.
  3. A drop highlight over the composer, only while you drag a companion, tinted in that companion's colour.
  4. Every visible companion as a full-body still standing on the floor. Each has a contact shadow, a name tag, blink frames and breathing, and is smaller toward the back. Companions that aren't focused fade toward the background.
  5. Speech bubbles above companions.
  6. The selected companion, live and in 3D, standing above the composer.
- **Picker mode:** a pill row of companions with the active one wider, and the selected live companion above the composer with a speech bubble offering help.

**Onboarding.**
- **Background:** a radial wash in the companion's colour, two layers of the pattern field (fine and coarse) that crossfade by step, and a light gradient rising from the bottom.
- **Intro stage:** a staged reveal of the Apex mark and the companion ([Design choices: presence](#presence-design-choices)).
- **Steps:** one persistent companion moves between placements (centred or beside the content) and switches between full body and bust. Speech bubbles with tails carry its lines.

### Behaviour and motion

**Live companion.**
- **Idle:** a smooth bob of about 1 px with a period of about 1.5 s, and small head motion. Blinks snap the eyes to closed arcs for about 130 ms every 2.5–5 s at random, sometimes doubled. Between blinks the pupils hold a sideways glance, with occasional shifts.
- **Pointer:** in the card, the head and pupils follow the pointer anywhere in the window with a lag of a few frames. On the start surface, hover dims the figure slightly.
- **Click:** in the card, a click plays the CO-19 poke ([DS-70](#ds-70)). On the start surface, a click opens the card.
- **Typing:** only live views react, and they react when the text becomes non-empty, not on focus. A quick blink or squint comes first, then the gaze swings to the composer over about 180 ms and holds while text exists. A double blink follows about 1.8 s later. When the field empties, the gaze eases back to the sideways glance over about 180 ms, and a blink follows about 2 s later.

**Reactions.**
- **Click on the floor:** a small reaction bubble and a hop, and the companion becomes selected. Neighbours turn to look, and may show a surprise or question bubble.
- **Stroking the head:** moving the pointer back and forth over the head triggers a pat reaction, and follow-up pats come more easily.
- **Drag on the floor:** the companion is picked up with an alarm bubble and dangles, and neighbours react. Releasing it throws it with momentum: it tumbles, lands and squashes.
- **Selecting:** the companion flies in an arc to the composer and stands there, with the arrival effect lighting the landing. The previous one is bumped back to the floor in the opposite direction, and a brief coloured streak trails a companion zipping to the composer.
- **Idle life:**
  - random turns and blinks;
  - occasional naps with a sleep bubble;
  - long wanders and short strolls;
  - pairs or small groups that gather and swap topic bubbles: a site you visited (favicon), another companion (its face), you, a teammate, or a reaction symbol.

**Agent states.**
- **Working:** the activity mark beside the avatar ([DS-67](#ds-67)), an inner glow on the controlled page with a pointer showing where the companion acts, a draggable notice, the tab marked as controlled, the control listing the chat's open pages glowing, and in chat a live timer, rotating tips and a moving light band over the status.
- **Approval:** the card grows from the composer, a needs-input mark appears beside the avatar, and the window flashes, notifies and plays a sound.
- **Done:** a check pops beside the avatar and a sound plays. Adding a companion plays a celebration ([DS-79](#ds-79)).

**Floor motion.**
- The floor reveals outward from its centre when turned on and conceals inward when turned off.
- Companions pop in one after another, each with its shadow, and leave staggered.
- Physics: velocity and gravity, squash and stretch on landing, tumbling, and spin when knocked. Flights arc, with height and duration growing with distance.

**Onboarding motion.**
- The mark appears, a short pause follows, then the companion is revealed.
- The intro's effects settle when the stage completes.
- Sound cues are timed to these beats, with a fallback if the 3D companion is late.

**Reduce Motion.** Floor companions don't walk, hop, fly or drop in. They appear in place, take their spot instantly, and chat only with near neighbours. Bubbles appear instantly, and the intro takes a reduced path.

### Requirements

[CO-18](feature-spec.md#co-18), [CO-19](feature-spec.md#co-19) and [CO-20](feature-spec.md#co-20) stand as written: face-only small avatars, always-alive large companions, and the companion waiting in a new chat. The items below add detail to them.

- <a id="ds-67"></a>**DS-67** `companion` **Chat state beside the floating head, never on it** (adds to CO-18).
  - The small head is drawn whole and free: no mask, notch, cut-away, ring or badge on or over it, and nothing layered on top of it.
  - The chat's state shows as its own small mark placed next to the head, side by side, in the row's flow (for sidebar chat rows: directly to the right of the head, before the title, with a small gap; in the tab list and All chats the same order):
    - working: a small moving activity mark;
    - needs approval or input, or a closing question: an attention mark;
    - unread: an accent dot;
    - done: a positive check that pops once;
    - error: an error mark;
    - a routine run: a small routine glyph.
  - The face's expression carries the same state as well.
  - When there is no state, the mark's space collapses so titles line up with other rows.
  - The separate dot at the end of sidebar rows is removed (the side-by-side mark replaces it).
  - Under Reduce Motion the marks are static.
  - *Test:* a 20 px sidebar head and a 16 px tab badge show no body, are not clipped, nothing overlaps their bounds, and the state mark sits beside them.
  - *Files:* `companion/render.ts`, `components/companionData.ts`, `chat/CompanionAvatar.tsx`, `components/sidebar/CompanionAvatar.tsx`, `ChatsSection.tsx`, `TabsSection.tsx`, `pages/AllChats.tsx`, `settings/pages/CompanionsPage.tsx`, `sidebar.css`.
- <a id="ds-68"></a>**DS-68** `companion` **One presence store.**
  - There is one store per companion and per chat.
  - **Inputs:**
    - composer focus, keystrokes (with a short decay) and send, from every composer: the new-tab field, the chat page, the side panel and quick ask;
    - agent events, approvals, completion and errors;
    - user idle time.
  - Every live view and small face of that companion or chat subscribes to it, replacing one mood hook per view and the hard-coded moods in the card, header and welcome.
  - *Files:* new `companion/presence.ts` (a pure reducer, with tests); refactor `companion/useCompanionMood.ts`; wire up `chat/Composer.tsx`, `components/NewTabPage.tsx`, `chat/ChatView.tsx`, `components/AgentPanel.tsx`, `companion-card/GeneralTab.tsx` and `companion-card/CardHeader.tsx`.
- <a id="ds-69"></a>**DS-69** `companion` **Mood rules** (adds to CO-19).
  - **Listening:** live figures go to listening when the composer's text becomes non-empty, not on focus; focus only nudges the glance. They hold it while text exists and return to idle when the text is cleared, sent, or the field loses focus.
  - **Small faces** (the gutter face, the chip, panel rows and sidebar rows) don't react to typing. Per CO-18 they follow only the chat's state.
  - Send switches to thinking at once, without waiting for the first agent event.
  - Streamed text switches to talking, and tool use to working.
  - Approval switches to asking.
  - Done plays a happy one-shot, then idle. An error is briefly sad.
  - *Test:* unit tests of the reducer, plus an end-to-end typing check that focus alone doesn't change the mood.
  - *Files:* `companion/presence.ts`, `companion/animator.ts`, `companion/useCompanionMood.ts`, `components/NewTabPage.tsx` (`setListening` was called on focus), `chat/Composer.tsx` (`onFocusChange` becomes `onTextPresenceChange`).
- <a id="ds-70"></a>**DS-70** `companion` **Interaction on every live companion** (adds to CO-19).
  - The gaze follows the pointer anywhere in the window, including outside the card. After `POINTER_REST_MS` it holds the last direction rather than snapping to the centre.
  - A click plays a poke, as CO-19 asks.
  - Stroking back and forth over the head plays a pat reaction, and repeat pats trigger more easily.
  - Long idle leads to looking around, then a nap shared by every view of that companion, which wakes on any input.
  - *Files:* `companion/Companion.tsx`, `companion/view.ts`, `companion/face.ts`, `companion/presence.ts`.
- <a id="ds-71"></a>**DS-71** `companion` **Live-view budget.**
  - WebGL is used only at about 100 px and up, with a cap on simultaneous contexts.
  - Over the cap, or off-screen, a companion falls back to a still with a blink frame and breathing, and swaps back without a flash.
  - A new live view shows its still first, then swaps into the live figure.
  - *Test:* opening the card, the new tab, two empty chats and welcome together never loses a context.
  - *Files:* `companion/view.ts`, `companion/Companion.tsx`, `companion/render.ts`.
- <a id="ds-72"></a>**DS-72** `companion` **Waiting in an empty chat** (adds to CO-20).
  - **Composition:** the empty chat page uses the start surface ([DS-107](#ds-107)): the live companion stands above a centred composer, with the tray and the ideas card below. Nothing is created in the chat list until the first send.
  - **Size:** the figure is large, as CO-20 asks, and sized to the room between the switcher pill and the composer: up to about 200 px on the page and about 140 px in the panel. The feet stay about 40 px above the composer, and the hit area stays square around the figure.
  - **Life:** it greets once (a one-time speech bubble beside the figure, [DS-80](#ds-80)), then idles ([DS-135](#ds-135)), and its head follows the pointer.
  - **Typing:** per [DS-69](#ds-69): the gaze swings to the composer when text appears and holds. The gaze also follows the caret on each keystroke, and moving the mouse more than a few pixels hands the gaze back to the pointer.
  - **Send:** the first send moves it into thinking and plays the [DS-73](#ds-73) handoff.
  - **Below it:** the starter suggestions, as the ideas card ([DS-109](#ds-109)).
  - *Before:* a still avatar (72 px on the page, 56 px in the panel), a headline and three bordered starter cards.
  - *Files:* `chat/ChatView.tsx` (empty branch), `chat.css`, `companion/Companion.tsx` (framing and look-target props), `components/StartSurface.tsx`.
- <a id="ds-72b"></a>**DS-72b** `shell` **Nothing joins Chats before its first send** (adds to [DS-72](#ds-72)).
  - The sidebar's Chats section lists saved chats only. An empty chat open as a page shows under Your tabs until its first send, then moves to Chats; a draft never gets a row of its own.
  - *Files:* `components/sidebar/logic/chatRows.ts`, `components/sidebar/Sidebar.tsx`, `components/sidebar/ChatsSection.tsx`.
- <a id="ds-73"></a>**DS-73** `companion` **First-send handoff.**
  - On the first send from the start surface, the composer glides from its centred position to the chat's bottom position ([DS-74](#ds-74)).
  - At the same time, the standing companion shrinks and travels along a gentle arc into the first reply's gutter face while the pending line appears.
  - Under Reduce Motion it crossfades.
  - *Files:* `chat/ChatView.tsx`, `ChatLog.tsx`, `components/StartSurface.tsx`.
- <a id="ds-74"></a>**DS-74** `companion` **The start surface uses the real composer and a live figure.**
  - **Composer:** replace the single-line ask field and the Ask button with the shared `Composer` in its start variant (640×114; +, a chip without a face, and the mic), plus the tray ([DS-108](#ds-108)) and the ideas card ([DS-109](#ds-109)).
  - **Figure:** live, in a square button centred above the composer, with a small round pencil badge of 15–20 px at its lower right. Hover dims the figure slightly, darkens the badge and shows a tooltip above. A click opens the card. It shows its still first, then swaps into the live figure ([DS-71](#ds-71)).
  - **Typing:** per [DS-69](#ds-69) and [DS-72](#ds-72).
  - **Send:** a short opening status shows inside the composer. The same tab becomes the chat page, and the composer glides from the start position (its top at 40% of the content height) to the chat position as a shared element. Under Reduce Motion it crossfades.
  - **Removed:** the greeting heading, the shortcut tiles, the key-hint line, and the arrows and dots. The hint belongs in the address pill ([DS-110](#ds-110)).
  - *Before:* a 150 px figure between ‹ › arrows with page dots, and a single-line ask field.
  - *Files:* `components/NewTabPage.tsx`, `components/StartSurface.tsx`, `chat/Composer.tsx` (`variant="start"`), `pages/ChatPage.tsx`, `App.tsx`, `styles.css`.
- <a id="ds-75"></a>**DS-75** `companion` **New-tab companion floor,** on by default, with a remembered toggle in the top-right round button ([DS-107](#ds-107)).
  - **Static at rest:** nothing in the floor drifts or loops ([DS-28](#ds-28)). It fades in with the staged arrival (about 200–250 ms), reveals outward when turned on and conceals inward when turned off.
  - **Tone:** very low contrast, denser toward the edges and fading toward the centre. In light mode it is a step darker than the page; in dark mode a step lighter. Remove the accent radial glow.
  - Every visible companion stands on the floor ([Design choices: presence](#presence-design-choices)). Companions pop in one after another with their shadows, and leave staggered. Companions that aren't focused fade toward the background.
  - The switcher pill stays at the top centre in floor mode too ([DS-77](#ds-77)).
  - With the toggle off, the new tab uses the picker mode (a row of companions with the active one wider, plus the selected live companion and a speech bubble offering help).
  - *Files:* `components/NewTabPage.tsx`, new `components/newtab/Floor.tsx` and `components/newtab/floorSim.ts` (a pure simulation, with tests), `styles.css` (`.newtab` glow).
  - *Supersedes:* [CO-13](feature-spec.md#co-13), where previous and next controls are the only picker. The ← and → keys and the add entry stay.
- <a id="ds-75b"></a>**DS-75b** `companion` **Companions on New Tab, per profile** (adds to [DS-75](#ds-75)).
  - The floor toggle is the profile setting `companionFloor` ("Companions on New Tab", on by default), also in Settings › Appearance. Every start surface (new tabs and empty chats) follows it: a change from any of them reaches the others at once.
  - A window that still remembers an older per-window "off" hands it to the setting once and forgets it.
  - *Files:* `components/newtab/useCompanionFloor.ts`, `components/newtab/newtabLogic.ts`, `components/NewTabPage.tsx`, `settings/pages/AppearancePage.tsx`, `src/shared/settingsRegistry.ts`.
- <a id="ds-76"></a>**DS-76** `companion` **Floor life.**
  - **Idle:** blink, turn, wander, stroll and nap.
  - **Groups:** pairs or groups gather and swap topic bubbles: recent tab favicons, other companions' faces, or your initial.
  - **Click:** a bubble and a hop.
  - **Drag:** picks a companion up; you can throw it, it lands with a squash, and its neighbours react.
  - **Rendering:** floor companions are stills with blink frames, and only the selected companion is WebGL.
  - **Reduce Motion:** no walking, flights or hops.
  - *Files:* `components/newtab/floorSim.ts`, `Floor.tsx`.
- <a id="ds-77"></a>**DS-77** `companion` **Choosing who takes the next chat.**
  - **Switcher pill,** in both modes, at the top centre: a grey track with the selected companion's segment (white, a 30 px face, the name in the companion colour, lifted in dark mode per [DS-139](#ds-139)) and an add segment (an 18 px plus and a muted label). The selected segment opens a companion menu ([DS-94](#ds-94)). ← and → cycle companions while the composer is empty.
  - **Floor mode:** choosing another companion (a click, the arrow keys, or a drag onto the composer, which highlights in the dragged companion's colour) arcs it to its place above the composer. The previous companion is bumped back to the floor, the arrival effect plays, and the others glance over.
  - *Files:* `NewTabPage.tsx`, `components/newtab/Floor.tsx`, `components/StartSurface.tsx`.
- <a id="ds-78"></a>**DS-78** `companion` **One persistent welcome companion.**
  - A single live companion glides between placements and re-frames between full body and bust, instead of remounting on each step.
  - Steps slide forward on Next and backward on Back.
  - A staged intro opens the flow ([ON-02](feature-spec.md#on-02)).
  - *Before:* each step remounts a new WebGL view and flashes the fallback.
  - *Files:* `pages/Welcome.tsx`, `styles.css`.
- <a id="ds-79"></a>**DS-79** `companion` **Celebration when a companion is added.** Creating, importing or adding a preset plays a one-shot celebration in the sheet, then the companion arrives on the new tab. *Files:* `companion-card/sheets.tsx`, `NewTabPage.tsx`, `companion/animator.ts`.
- <a id="ds-80"></a>**DS-80** `companion` **Speech bubbles.**
  - One bubble component serves the floor, picker mode and welcome.
  - It rises from below on the companion's side and scales up slightly from its tail. Its text appears after a short beat, and inline icons arrive staggered.
  - Reduce Motion shows it at once.
  - *Files:* new `companion/Bubble.tsx`, `styles.css`.
- <a id="ds-134"></a>**DS-134** `companion` **Small-face sizes per placement** (adds to CO-18; frameless floating heads per CO-18, no disc).

  | Place | Size | Before |
  |---|---|---|
  | Sidebar chat rows | 20 | 18 |
  | Details-panel rows | 20 | n/a |
  | Composer chip (a 24 px face in a 36 px pill) | 24 | 18 |
  | Card switcher and its menu | 28 | a 52 px figure |
  | Gutter face | 28 | none |
  | All chats rows | 30 | 28 |
  | Start-surface switcher pill | 30 | n/a |

  - Every place uses the same render, and active and inactive rows are identical.
  - *Files:* `components/sidebar/ChatsSection.tsx`, `components/sidebar/TabsSection.tsx`, `chat/Composer.tsx`, `pages/AllChats.tsx`, `chat/DetailsPanel.tsx`, `companion-card/CardHeader.tsx`, `components/sidebar/CompanionAvatar.tsx`, `chat/CompanionAvatar.tsx`.
- <a id="ds-135"></a>**DS-135** `companion` **Live-companion cadence** (adds to CO-19, [DS-69](#ds-69) and [DS-72](#ds-72)).
  - **Idle:** a breathing bob of about 1 px on a period of about 1.5 s; snap blinks of about 130 ms every 2.5–5 s at random, sometimes doubled (two blinks about 400 ms apart); a held sideways glance with occasional shifts.
  - **Text present:** an eased gaze swing toward the composer over about 180 ms, held there, with a double blink about 1.8 s later.
  - **Cleared:** an eased return to the glance, then a blink about 2 s later.
  - **Pointer:** tracking with a lag of a few frames. The pointer-follow from CO-19 may override the idle glance.
  - **Reduce Motion:** no bob, sway or pointer tracking; blinks are allowed, and gaze changes snap.
  - *Files:* `companion/face.ts`, `companion/animator.ts`, `companion/view.ts` (replace the `timeScale` 0.5 calm mode), `companion/presence.ts`, `chat/ChatView.tsx`.
  - *Test:* a reducer test for the text-present and cleared transitions.

### <a id="presence-design-choices"></a>Design choices: presence

- **Small faces.** The CO-18 floating head with no disc, ring or background shape.
- **State marks.**
  - Working: two small dots orbiting a corner in the companion's colour.
  - Approval or question: a small bare speech-bubble glyph at the top-right, with no chip, matching the chat's question block. Done: a green check that pops once. Error: a red bar. Unread: an accent dot.
- **Sleep and pat.**
  - Sleep shows a small crescent moon.
  - A pat squints the eyes, adds a cheek blush and plays a short shimmy.
- **The floor, "the Lounge."**
  - A pond seen at an angle: dotted elliptical rings, **static at rest**. Footsteps and landings spawn small one-shot ripples that settle back to stillness.
  - It reveals by tracing the rings' dots around from the centre.
  - The setting is called "Companions on New Tab".
- **Arrival, a "ring rise."** A light ring expands on the floor and a short column of the existing sparkles (`companion/stage.ts`) rises.
- **Empty chat.**
  - The companion stands on a soft contact shadow faintly tinted with its own colour, softened in dark mode.
  - Greeting, as a one-time speech bubble: "Hey, it's Pip. What are we tackling?"
  - Starters live in the ideas card ([DS-109](#ds-109)).
- **Welcome intro, a "dawn."** A horizon glow rises from below and the Apex mark draws itself. The companion pops up through a floor ring and waves, using the existing wave clip, while small accent sparkles drift upward.
- **Celebration.** A wave plus a ring of sparkles.
- **Speech bubbles.** A rounded rectangle with a two-dot thought tail and a word-by-word fade. Topic glyphs come from lucide.
- **Handoff.** The figure morphs into the gutter face along a gentle arc, in about 460 ms with deceleration.

---

## Theme and dark mode

The layout is identical in dark mode. What changes is the plane order and the tone ladder.

### Layout

**Geometry is theme-independent.** No size, padding, radius, weight or line box changes between light and dark.

**Plane order and tone ladder.** Steps are relative, in levels on a 0–255 grey scale, counted from the sheet unless noted. Dark token values follow these signs and sizes.

| Element | Light | Dark | Rule |
|---|---|---|---|
| **Ground** (sidebar, profile-tinted) | About 16 below the sheet, with a faint profile tint | About 14 **above** the sheet, slightly more tinted | The ground is darker than the sheet in light mode and lighter in dark mode |
| **Sheet** (toolbar, bookmarks bar, chat page, start surface, destination pages) | One plane | One plane, the darkest | |
| **Panel surface** (settings, the companion card) | White, neutral | A hair darker than the chat page, and not raised | |
| **Raised** (composer, details card, settings cards, the address field while editing) | About +4 | About +7 over the sheet, +8 over a panel | |
| **Recessed** (the tray, the switcher track, page-level tab tracks) | −7 to −10 | −5 to −6 | Darker in both modes |
| **Filled control** (the pill at rest, filter chips, the ideas card, a segmented track inside a card) | −11 to −24 | +11 to +16 | **Polarity flips** |
| **Hover on the ground** | −11 | +11 | |
| **Hover or selected on a panel** (settings nav row) | −6 | +8 | |
| **Active chip on the ground** | About +12, a bright one-device-pixel edge, about 5 px of soft shadow below | About +43, an edge about +21, a short shadow | In dark mode the active chip is much brighter than hover |
| **Dividers and rings** | The bar hairline about −23; the composer ring about −40; the details card about −35; settings cards about −16 | About +23, +33, +33 and +25 | Separation comes from hairlines in dark mode; shadows disappear |
| **Selected-option outline** (2 px) | Near-black | Near-white | Inverted |
| **Text** | Strong near-black, a mid-grey secondary, a light tertiary | Strong near-white, a light-grey secondary, a dim tertiary | The pill's prefix is secondary and its title tertiary in both modes |
| **Neutral primary pill** | An ink fill with a paper label | A paper fill with an ink label | Inverted |
| **Secondary pill** | White plus a hairline | The surface colour plus a hairline | |
| **Segmented thumb** | The surface colour plus a soft shadow, on a darker track | The surface colour plus a 1 px hairline and no shadow, on a lighter track inside a card (darker on a page) | The thumb always equals the surface it sits on |
| **Seam between sidebar and sheet** | About 3 px of inner shade on the sidebar's right edge | Almost none; the tone step does the work | |

**Hairline weights** (both modes).
- One device pixel (0.5 CSS px on 2× screens): the bar hairline at y 77, the composer ring, the details-card ring and the active chip's highlight edge.
- 1 CSS px: the companion card edge, settings cards, the settings nav divider and segmented thumb borders.
- 2 px: selected-option outlines and the address field's focus ring.

**Colour roles in dark mode.**
- **Identical in both modes:** the companion fills (the voice pill, mic and send, and the card's share pill); the accent role (links, the selected settings label, the usage ring); the positive switch track; avatars and the 3D figure.
- **Slightly changed:** the update capsule is a little deeper; the start-surface switcher name and mode label are lifted ([DS-139](#ds-139)); the address field's focus ring keeps its hue at much lower luminance.
- **Neutral in both modes:** the composer fill and ring, and the user bubble. There is no profile-hue tint on the chat page.

**Per surface.** The shell, start surface, card, chat page, destinations and settings each describe their dark mode in their own sections. The backdrop behind the card is blurred and lightened in light mode and blurred only in dark mode.

### Behaviour and motion

- **Theme switch:** every region (sidebar, toolbar, settings nav, content) repaints in **one frame**, in both directions. There is no crossfade.
- **Settling afterwards:** the segmented thumb glides to its new position over about 150–200 ms, ease-out, in both directions.
- The settings nav keeps its scroll position across the switch.

### Requirements

- <a id="ds-136"></a>**DS-136** `shell` **Neutral dark ladder.**
  - Rebuild the dark tokens on the neutral ladder in the table above: the sheet; a panel a hair darker; raised about +7; recessed about −6; filled controls about +12; hover ±11; hairlines +23 to +33; selected outlines near-white.
  - Text: strong near-white, then a secondary and a tertiary step.
  - Dark shadows become effectively invisible; separation comes from hairlines.
  - The chat page, start surface and settings use the same near-black neutral, with no purple cast.
  - *Before:* purple-cast dark tokens (`--bg-base`, `--bg-card`, `--bg-raised`, `--border-*`, `--text-*`); the sidebar is about the same tone as the content and the toolbar is a third, lighter plane; `CHROME_BACKGROUND.dark` is purple.
  - *Files:* `styles.css` (`--bg-*`, `--border-*`, `--text-*`, `--shadow-*`), `src/shared/accent.ts` (`SURFACES`), `src/shared/theme.ts`, `chat/chat.css`, `theme.ts`.
  - *Test:* sample dark-mode screenshots and check each delta's sign and rough size against the table.
- <a id="ds-137"></a>**DS-137** `shell` **Polarity rules.**
  - **Flip between modes:** the address pill, filter chips, the ideas card, hover fills, dividers, selected-option outlines, and the segmented track inside cards.
  - **Recessed in both modes:** the tray and page-level tab tracks.
  - *Files:* `styles.css`, `components/StartSurface.tsx`, `ui/ui.css`, `settings/settings.css`.
- <a id="ds-138"></a>**DS-138** `shell` **Neutral primary and secondary buttons.**
  - On destination, settings and list pages (including the card's list tabs), the primary button is an ink pill with a paper label in light mode, inverted in dark mode. The secondary is the surface colour plus a hairline.
  - The companion colour is reserved for companion actions (the voice pill, mic, send and the card's share pill). The profile hue is never a button fill outside the main menu's one button.
  - *Before:* the primary button is accent-filled.
  - *Files:* `ui/Button.tsx` (an `ink` variant), `ui/ui.css` (`.ui-btn--primary`).
- <a id="ds-139"></a>**DS-139** `companion` **Readable companion text in dark mode.**
  - Companion-coloured **fills** stay identical in both modes.
  - Companion-coloured **text** (the composer chip's label, the switcher pill's name, the mode selector) uses a lifted variant with at least 4.5:1 contrast on the raised dark surface.
  - *Files:* `src/shared/accent.ts`, `chat/chat.css`, `components/StartSurface.tsx`.
  - *Test:* a contrast check for every preset look's text variant on the dark raised surface.
- <a id="ds-140"></a>**DS-140** `shell` **Hairline weights.**
  - The bar hairline, the composer ring and the details-card ring are one device pixel. Cards and settings borders are 1 CSS px. Selected outlines and the focus ring are 2 px.
  - Add a `--hairline` token (0.5 px on 2× screens, 1 px on 1×).
  - *Files:* `styles.css`, `chat/chat.css`, `components/sidebar/sidebar.css`.

### Design choices: theme

- **Warm neutrals.** The dark ladder is warm-neutral, in the Stone family, with the steps and signs in the table above.
- **Tokens.** `--hairline` for one-device-pixel lines and `--bg-thumb` for the segmented thumb, which always resolves to the surface it sits on.

---

## Motion and ambient animation

### Layout

**Pattern field.** The one ambient background, used behind the card hero, the create-companion sheet, preset details and both onboarding layers.
- **Grid:** a lattice in which every cell holds one fixed glyph, from a small dot (about 10% of the cell) to about 85% of the cell. The lattice, glyphs and colours are in [Design choices: motion](#motion-design-choices).
- **Light and dark:** the glyphs sit over the companion wash in both modes, at about a third of light mode's contrast in dark mode.
- **Masking:** the field is invisible across a top strip, full strength through the middle, and washed out by a background-coloured gradient at the bottom. Its owner places the band (upper-middle on General, behind the legs in the editor). It is wider than its container and clipped.

**Where the life is.**
- At rest, only the live companions and the card's pattern field move (plus the caret's 500 ms blink), in both modes.
- The chrome, the chat page, settings, destination pages and the new-tab floor are static.
- Floor companions, the onboarding intro's effects and the light sweep over working status also move.

### Behaviour and motion

**Pattern field.**
- Sizes swell and shrink with one smooth, slow wave (one swell takes about 8 s), with no short repeat. Shapes vanish below one threshold and cap at full size above another, leaving calm gaps and dense bands.
- It keeps drifting in dark mode, at about a third of light mode's contrast.
- Apex uses only this one wave.
- It pauses when off-screen, when the window is hidden, or when its owner pauses it (an onboarding layer that isn't showing). It caps pixel density.
- Under Reduce Motion it shows one still frame ([DS-85](#ds-85)).

**Motion vocabulary** (timing classes):

| Class | Timing | Members |
|---|---|---|
| **Instant** | Within one frame (50 ms or less), with no exit | The theme repaint; every in-window menu and popover (the composer menus, the overflow dropdown, sidebar options, the main menu) and the palette, opening and closing; the address editor's entry and exit; the composer's send and mic swap and its placeholder; jumping to the bottom from far away; settings, destination and card-tab body swaps; clearing the content on a new chat |
| **Quick** | About 100 ms, opacity, roughly linear | Message hover actions (in about 100 ms, out 100–150 ms); the address focus ring growing in; the details panel leaving; a closing tab row folding while the active chip jumps; a hover card fading out; the start-surface figure's fade |
| **Short** | About 150 ms, up to 200, strongly decelerating, no overshoot | Sidebar collapse and expand (a rigid block, the same duration whatever the distance); the details panel entering; the reading column's glide; chats collapse and expand; a new tab row opening; the card's fade in and out, with the backdrop blur in the same frames; the card's underline glide and tab icon; the segmented thumb; the look-option panel fade |
| **Medium** | About 250–350 ms, with a settle tail to about 600 ms, decelerating | The look editor widening (narrowing accelerates); the start surface's background and ideas card fading in (200–250 ms) |
| **Long** | About 450 ms, ease-in-out | Carousel paging: the strip moves one pitch, the centre card grows, and the edge cards fade |
| **Late pop** | One step, about 150 ms after the card is opaque | The card's 3D figure |
| **Staged build** | 0 to about 1 s | The new tab and a new chat ([DS-111](#ds-111)) |
| **Delayed hover** | Tooltips after about 0.5–1 s; row cards after about 1 s (Routines under 0.45 s); idea previews after about 0.9 s | Each appears at once after its delay |
| **Ambient** | Multi-second continuous loops | The live companion and the card's field only |

Further motion classes:

| Kind | Speed | Motion |
|---|---|---|
| Hover and press | Fast | Colour and brightness shifts; filled pills dip in brightness on press |
| Dialogs (other than the card) | Short | Fade and scale |
| Tab hover card | Short | Glides on a decelerating curve to the next row instead of reopening |
| Layout changes beside a chat (side chat, split, pane close) | Short | Chrome frames and native page views move on one shared timeline. The page frame morphs into an inset card when a chat opens beside it, and a closing pane wipes away horizontally. |
| Approval card | Short to medium | Grows up out of the composer and collapses back |
| Speech bubbles | Medium | Rise and scale from the tail; text after a beat; a swapped word rolls vertically |
| Activity rows | Medium | Title revealed with a coloured pass, then a glint |
| Download | Long | A file icon flies along a curve to the downloads button and ends in a small bounce |
| Floor physics | Springy | Gravity, squash and stretch, tumbling; arcs scale with distance |

**Theme.** A theme change applies live and repaints the whole window in one frame, with no crossfade. Only the segmented thumb glides afterwards. Pattern fields and filters rebuild per theme, and standalone windows open in the current theme.

**Reduce Motion:**

| Surface | Behaviour under Reduce Motion |
|---|---|
| Most transitions | Zero duration |
| Stepped spinners | Stop |
| Peek | No scale |
| Download flight | Skipped |
| Approval card | Snaps instead of growing |
| Bubbles | Appear instantly |
| Intro | Reduced path |
| Floor | No walking, hopping, flying or dropping in |
| Pattern field | One still frame ([DS-85](#ds-85)) |

### Requirements

- <a id="ds-81"></a>**DS-81** `motion` **Motion tokens and one switch.**
  - **Durations:** pop (60 ms or less, for menus and popovers), quick (about 100 ms), short or layout (about 150 ms), medium (about 300 ms, with a settle of about 600 ms) and long (about 450 ms).
  - **Curves:** one strong decelerate curve for nearly everything; an accelerating exit curve for the card close and the editor narrowing; ease-in-out only for paging; and one JS spring preset only for floor physics (hops, perching, throws).
  - **Specific values:** the card in about 140 ms ease-out and out in about 180 ms accelerating; the underline glide and tab icon in about 150 ms; the editor widening in about 250 ms and narrowing in about 300 ms; the figure's scale settling in about 400–600 ms; option panels fading in about 150 ms.
  - **Switch:** a single `useMotion()` reads the OS setting OR an Apex setting (Settings › Appearance › Reduce motion).
  - *Test:* with either one on, every token and the spring resolve to instant.
  - *Files:* `styles.css` (`--dur-*`, `--motion-*`), new `ui/motion.ts`, `ui/hooks.ts`, `settings/pages/BrowsingPages.tsx` (Appearance), `src/shared/ipc.ts` (setting).
- <a id="ds-82"></a>**DS-82** `motion` **Exit animations.**
  - Exits play only for the card (about 180 ms), the side and details panels (about 100 ms), closing rows, dialogs, sheets, toasts and peek. These stay mounted until their short exit finishes.
  - Menus, popovers, the palette, tooltips and the address editor close within one frame, with no exit animation.
  - A safety timeout removes a stuck layer, and Reduce Motion removes it at once.
  - *Before:* layers animate in but vanish on close.
  - *Files:* `ui/overlay.ts`, `ui/layers.ts`, `ui/Dialog.tsx`, `ui/Toast.tsx`, `ui/UiHost.tsx`, `ui/menu.ts`, `ui/ui.css`, `companion-card/*`.
  - *Refines:* [OV-02](feature-spec.md#ov-02) for layers drawn in the chrome renderer. *Supersedes:* OV-02's 150–250 ms exit for menus and the command bar.
- <a id="ds-83"></a>**DS-83** `motion` **Menus and popovers appear at once.**
  - Every in-window menu and popover, and the palette, reaches full size and opacity within one frame: at most an opacity fade of 60 ms or less, with no zoom and no slide.
  - They close with no exit animation.
  - *Before:* a fade, a zoom and a slide in (`@keyframes side-pop` and the `ui` menu keyframes), at 140 ms in and 110 ms out.
  - *Files:* `ui/ui.css`, `ui/overlay.ts`, `ui/menu.ts`, `components/sidebar/sidebar.css` (`@keyframes side-pop`), `styles.css` (motion tokens).
  - *Test:* in a 60 fps recording, a menu is at full opacity by the fourth frame after the click and gone in the first frame after Escape.
- <a id="ds-84"></a>**DS-84** `motion` **One layout timeline.**
  - Sidebar show and hide ([DS-19](#ds-19)), the side panel opening or closing ([DS-02](#ds-02)), the details panel ([DS-123](#ds-123)), expand ([DS-65](#ds-65)), split changes and closing a pane all animate the chrome frames and the native page-view bounds together.
  - The timeline is about 150 ms, strongly decelerating, with no overshoot, and the same duration whatever the distance.
  - **Details panel:** the panel fades and slides by about 100 px, and the column and composer re-centre on `--motion-layout` (about 150 ms, `--ease-out`).
  - The page frame morphs into the inset card, and a removed pane wipes away.
  - Reduce Motion makes all of it instant.
  - *Test:* intermediate bounds are visible mid-transition; the chrome and the page view never drift apart by more than a frame; when the transition ends the column and composer sit exactly at their end positions and do not drift afterwards; and Reduce Motion is instant.
  - *Files:* `src/main/tabs.ts` (tween the bounds), `src/main/ipc.ts`, `App.tsx`, `components/AgentPanel.tsx`, `pages/ChatPage.tsx`, `chat/chat.css`, `ui/motion.ts`, `styles.css`.
- <a id="ds-84b"></a>**DS-84b** `motion` **A closed split wipes away** (adds to [DS-84](#ds-84)).
  - Closing a split keeps the removed pane for one layout beat: it wipes away, its gap with it, while the other pane widens on the same timeline. Reduce Motion makes it instant.
  - *Files:* `App.tsx` (the leaving pane), `styles.css` (`.pane--split-leaving`).
- <a id="ds-85"></a>**DS-85** `motion` **Ambient field component.**
  - **Drawing:** a canvas lattice of glyphs whose sizes swell and shrink with a slow travelling wave and whose cells can drop to nothing. It takes an optional top-fade and bottom-fade mask, and its owner sets the band's position and height.
  - **Lifecycle:** it pauses when off-screen, when the window is hidden, or when its owner pauses it, and caps pixel density.
  - **Dark mode:** the drift stays perceptible, at about a third of light mode's contrast or more.
  - **Reduce Motion:** exactly one still frame.
  - **Colour changes:** it re-tints within a frame when the theme or companion colour changes, with no remount flash.
  - Shapes run from about 10% to 85% of the cell, on the lattice and glyphs in [Design choices: motion](#motion-design-choices).
  - *Files:* new `ui/AmbientField.tsx`, with the pure wave maths in `ui/logic/ambient.ts` and unit tests.
- <a id="ds-86"></a>**DS-86** `motion` **Use the field everywhere Apex has ambient life.**
  - Behind: the card hero ([DS-39](#ds-39)), the new-companion sheet, the import review hero and the editor stage.
  - Welcome: two layers (fine and coarse) that crossfade by step, with the hidden layer paused.
  - Preset thumbnails: one still frame each.
  - Remove the static dot grid and the welcome blobs.
  - *Files:* `companion-card/card.css`, `companion-card/sheets.tsx`, `pages/CompanionEditor.tsx`, `pages/Welcome.tsx`, `styles.css`.
- <a id="ds-87"></a>**DS-87** `motion` **Reduce Motion everywhere.** The reduced behaviours in the table above apply, plus these:

  | Class | Under Reduce Motion |
  |---|---|
  | Instant | Unchanged |
  | Quick, short and medium transitions (slides, glides, collapse, the card fade, the editor reshape, staged fades) | Instant: the final state applies in one frame |
  | Paging | An instant page swap |
  | Theme switch | Unchanged; the segmented thumb jumps |
  | Ambient field | One still frame |
  | Live companion | No bob, sway, hops or pointer tracking; blinks allowed; gaze changes snap |
  | Floor companions | Stay in place |
  | Flights, word reveal, sweeps, the arrival cue | Skipped |
  | Reduce Transparency | The backdrop blur becomes an opaque wash in the page tone, in both modes |

  - *Test:* with the Apex switch on, record the new tab, the card and a running chat in both modes: nothing moves except the caret, text and blinks.
  - *Files:* `ui/motion.ts`, `companion/view.ts` (replace `timeScale` 0.5 with no bob or tracking), `ui/AmbientField.tsx`, `components/newtab/floorSim.ts`.
- <a id="ds-88"></a>**DS-88** `motion` **Theme and colour apply live, in one frame.**
  - **Chrome:** `applyTheme` sets `data-theme-switching` and suppresses transitions for two animation frames, so every region repaints at once with no crossfade. The segmented thumb (`.ui-segmented__thumb`) is exempt and glides in about 180 ms.
  - **Native and pages:** `window.setBackgroundColor` and the page-view backgrounds update in the same tick.
  - **State:** no remount, and every scroll position is kept, the settings nav's included.
  - A theme or companion-colour change also updates the fields, the floor, washes, outlines and shadows, following the [colour roles](#colour-roles). Standalone windows open in the current theme.
  - *Test:* frame N is light and frame N+1 is fully dark in every region, and the settings nav's `scrollTop` is unchanged.
  - *Files:* `theme.ts`, `styles.css`, `ui/AmbientField.tsx`, `companion/stage.ts`, `src/main/theme.ts`, `src/main/window.ts`, `src/main/tabs.ts`.
- <a id="ds-141"></a>**DS-141** `motion` **Hover reveals are opacity only.**
  - About 100 ms in and out, with no slide or scale: message actions, the final turn's extra footer icons, the chats header actions ([DS-12](#ds-12)) and the idea-row dismiss.
  - Reduce Motion shows and hides them at once.
  - *Files:* `chat/chat.css`, `chat/ChatLog.tsx`, `components/sidebar/sidebar.css`, `components/newtab/IdeasCard.tsx`.
- <a id="ds-142"></a>**DS-142** `motion` **Paged strips.**
  - The ideas card, the companion picker and any other carousel page in about 450 ms, ease-in-out: the strip moves one pitch, the centre item grows and the edge items fade.
  - The previous control is disabled at the start, and the next at the end.
  - Reduce Motion swaps the page instantly.
  - *Files:* `components/newtab/IdeasCard.tsx`, `components/NewTabPage.tsx`, `ui/ui.css`.

### <a id="motion-design-choices"></a>Design choices: motion

- **The field, a "tide weave."**
  - **Lattice:** an offset (honeycomb) lattice of about 22 px.
  - **Glyphs:** a rounded plus, a ring, a short capsule and a four-point sparkle.
  - **Motion:** the wave rolls out from the companion's feet in slow concentric swells (from the stage centre where no companion stands). A poke, a greeting or a finished task sends one extra ripple outward. Otherwise it stays calm and steady.
  - **Colour:** in light mode, glyphs are a deeper tint of the companion's colour than the wash, so darker than their background; in dark mode, they glow faintly lighter than the background, at a contrast that stays visible.
- **Motion numbers** (the token values for the timing classes above):
  - menus, popovers and the palette: an opacity fade of 60 ms or less in, and an instant exit;
  - quick: about 90 ms (hover reveals, row closes, the focus ring, hover-card exits);
  - layout: about 150 ms on a strong decelerate (the sidebar, chats collapse, the details panel, the column glide, row inserts);
  - the card: about 140 ms in (ease-out) and about 180 ms out (accelerating); the underline glide about 150 ms;
  - the editor: about 250 ms widening, about 300 ms narrowing (accelerating), and about 600 ms for the figure to settle;
  - paging: about 450 ms, ease-in-out;
  - one tide swell: about 8 s;
  - flights: about 450–750 ms, scaled by distance;
  - one spring with a slight overshoot, only for floor hops and perching (never in the chrome or layout).
- **Token names:** `--motion-pop`, `--motion-quick`, `--motion-layout`, `--motion-enter`, `--motion-exit`, `--motion-glide`, `--motion-medium`, `--motion-settle` and `--motion-page`, alongside the existing `--dur-*` and `--ease-*`.
- **Status sweep:** the companion-coloured sweep from the chat section, reused for skeletons.

---

## Spec items superseded or refined

This document wins where it conflicts with [feature-spec.md](feature-spec.md) or [ux-plan.md](ux-plan.md). The tables below list each case.

**Superseded (the spec text changes):**

| Spec item | What changes | Items |
|---|---|---|
| [SH-02](feature-spec.md#sh-02) | Window controls hide with the collapsed sidebar (on the slide's first frame) instead of moving to a toolbar inset | DS-19 |
| [SH-03](feature-spec.md#sh-03) | Default sidebar width 300 instead of 260 | DS-04 |
| [SH-07](feature-spec.md#sh-07) | All chats shows dots, not counts. Destinations open on a window-level surface instead of reusing one tab each, and never appear in the Tabs list. The overflow row is always present. | DS-09, DS-89, DS-99 |
| [SH-08](feature-spec.md#sh-08) | New Tab sits at the top, under the pinned grid and above the destinations (the top-of-list insertion stays) | DS-06, DS-97 |
| [SH-32](feature-spec.md#sh-32) | The right cluster is contextual; downloads moves to the sidebar header; the toolbar companion button and avatar are removed; internal tab pages get at most one utility button | DS-05, DS-24 |
| [SH-35](feature-spec.md#sh-35) (in part) | ⌘L and ⌘T edit the pill in place, with suggestions below it in the overlay layer; the centred palette opens from sidebar search | DS-23, DS-90, DS-110 |
| [ST-24](feature-spec.md#st-24) (in part) | The accent no longer tints the chrome | DS-03 |
| [ST-26](feature-spec.md#st-26) | The sidebar tint is a flat profile hue only, never the companion accent | DS-03 |
| [CH-03](feature-spec.md#ch-03) (expand) | Expand turns the same tab into the chat page with the page as its side pane, and closes the panel | DS-65 |
| [CH-04](feature-spec.md#ch-04) | The column is a fixed 640 px instead of about 760, centred left of the details panel | DS-50 |
| [CH-05](feature-spec.md#ch-05) | The header holds only ⋯ and the details toggle; new chat leaves it, and the routine pill and tabs-used move to the details panel | DS-49, DS-124 |
| [CH-38](feature-spec.md#ch-38) (pulse) | Requests grow out of the composer; no looping pulse | DS-62 |
| [CO-02](feature-spec.md#co-02) | Header: a face switcher with a dropdown, only more and close, a floating save pill; the name is edited in the hero | DS-33, DS-34, DS-42 |
| [CO-03](feature-spec.md#co-03) | Export… and Customize look move into the hero; the more menu gains use-for-new-chats and the Dock toggle | DS-33, DS-35, DS-41, DS-42 |
| [CO-05](feature-spec.md#co-05) | Instructions are prose edited in place; personality becomes a ghost select pill on the instructions label row | DS-45, DS-46 |
| [CO-13](feature-spec.md#co-13) | The new tab defaults to the companion floor, with the switcher pill at the top centre in both modes; the previous and next arrows are removed | DS-75, DS-77 |
| [OV-02](feature-spec.md#ov-02) (in part) | Menus, popovers, the command bar and tooltips close within one frame; only the card, panels, rows, dialogs, sheets and toasts play exits | DS-82, DS-83 |
| ux-plan: Sidebar › Header | No toolbar inset for the window controls | DS-19 |
| ux-plan: New Tab row | Moves to the top of the sidebar | DS-06 |
| ux-plan: Size and visibility | Width 300 | DS-04 |
| ux-plan: Toolbar › Actions on the right | Contextual cluster; no companion button or avatar | DS-24 |
| ux-plan: Light and dark › Tokens | The tint is a profile hue only; dark surfaces are neutral, with the ground lighter than the sheet | DS-03, DS-136 |
| ux-plan: Content | One flush sheet instead of one rounded card; no lavender accent in the chrome | DS-01, DS-03 |
| ux-plan: Chats as pages › Header | Only ⋯ and the details toggle; no bar | DS-49 |
| ux-plan: New tab page | The start surface: switcher pill, live figure, the shared composer, tray and ideas card | DS-74, DS-107 |
| ux-plan: Companion profile card | Washes only the content area; new header; hero holds the name, Export… and Customize look | DS-29, DS-33, DS-42 |

**Refined (the spec stays; this document adds detail):** [SH-09](feature-spec.md#sh-09), [SH-10](feature-spec.md#sh-10), [SH-11](feature-spec.md#sh-11), [SH-13](feature-spec.md#sh-13), [SH-16](feature-spec.md#sh-16), [SH-31](feature-spec.md#sh-31), [SH-36](feature-spec.md#sh-36), [SH-47](feature-spec.md#sh-47), [CH-06](feature-spec.md#ch-06), [CH-07](feature-spec.md#ch-07), [CH-10](feature-spec.md#ch-10), [CH-12](feature-spec.md#ch-12), [CH-19](feature-spec.md#ch-19), [CH-20](feature-spec.md#ch-20), [CH-45](feature-spec.md#ch-45), [CO-06](feature-spec.md#co-06), [CO-11](feature-spec.md#co-11), [ON-02](feature-spec.md#on-02) and [SS-04](feature-spec.md#ss-04).

**Feature items this document implements:** [OV-01](feature-spec.md#ov-01) (the overlay layer, DS-96), [OV-02](feature-spec.md#ov-02) (exits for chrome-drawn layers, DS-82), [CH-21](feature-spec.md#ch-21) (the + menu's shell, DS-126), [CH-33](feature-spec.md#ch-33) (the tabs-used list, in the details panel, DS-124) and [CH-35](feature-spec.md#ch-35) (the details panel, DS-123 and DS-124).

**Items that stand as written:**
- [CO-18](feature-spec.md#co-18), [CO-19](feature-spec.md#co-19) and [CO-20](feature-spec.md#co-20).
- A new chat shows the live companion waiting above the composer, as CO-20 asks ([DS-72](#ds-72)). CO-20's larger size and greeting stand; the greeting shows as a one-time speech bubble and the starters as the ideas card.
- CO-19's click reaction stays on every live companion, the card's included ([DS-70](#ds-70)).
- CO-18's toolbar-avatar entry lapses because DS-24 removes that control. CO-18's face also stays in the chat header ([DS-48](#ds-48)).

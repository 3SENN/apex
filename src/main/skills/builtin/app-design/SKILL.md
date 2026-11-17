---
name: app-design
description: Build an app that looks and feels like {brand}, with {brand} UI's tokens and components, every state designed and nothing generic.
version: 2
---

Use this when you build or change an app with build_app (or an app in a pack). {brand} puts its own interface kit, {brand} UI, first in every app it serves: the same colours, type, spacing and controls as the browser, in light and dark, in the colour of the companion who made it. Build with it and the app belongs in {brand}. Your own CSS always wins over it, so add only what the kit doesn't have.

## How an app looks in {brand}

Calm, quiet and exact. Paper-coloured page, ink text, a few hairlines, one main action. Colour means something (the companion's accent marks what's selected; green, amber and red mark state), never decoration. Space does the grouping: generous between groups, tight inside them. Left-aligned, one column at a readable width. Small, steady type in one family (Inter). Motion is short and only shows a change.

## Tokens

Write every colour, space and size as a token, so the app switches between light and dark by itself and stays in step with {brand}.

- Surfaces: `--bg-page` (the page), `--bg-raised` (a group lifted off the page), `--bg-subtle`, `--bg-muted` (quiet fills, a track, a code block), `--bg-hover`, `--bg-active`, `--bg-selected`.
- Text: `--text-primary`, `--text-secondary` (supporting text), `--text-tertiary` (hints, placeholders), `--text-disabled`.
- Lines: `--border-subtle` (between rows), `--border-default`, `--border-strong` (around controls).
- The companion's colour: `--accent`, `--accent-soft`, `--accent-text`. Only for the selected thing and for the companion doing something.
- State: `--status-success`, `--status-needs-input` (a warning), `--status-error`, `--status-working`, each with `-soft` for a background; `--positive` for an on switch.
- Space (4 px steps): `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-10` 40, `--space-12` 48.
- Radius: `--radius-sm` 8, `--radius-control` 9 (controls), `--radius-md` 12, `--radius-card` 14, `--radius-lg` 18, `--radius-pill`.
- Type: `--text-sm` 12, `--text-md` 13 (controls, dense lists), `--text-ui` 14 (body), `--text-lg` 15, `--text-xl` 18, `--text-2xl` 24. `--font` is Inter (already on the page; set no font-family), `--font-mono` for code.
- Depth: `--shadow-xs`, `--shadow-sm`, `--shadow-md`. Motion: `--dur-fast`, `--dur-base`, `--ease-standard`, `--ease-out`.

## Components

```html
<main class="ax-app">
  <header class="ax-header">
    <div>
      <h1 class="ax-title">Tip splitter</h1>
      <p class="ax-subtitle">Split a bill and the tip between friends.</p>
    </div>
    <button class="ax-btn ax-btn--ghost ax-btn--sm" type="button">Reset</button>
  </header>

  <section class="ax-section">
    <h2 class="ax-section__title">The bill</h2>
    <div class="ax-stack">
      <div class="ax-field">
        <label class="ax-label" for="total">Total</label>
        <input class="ax-input ax-input--num" id="total" inputmode="decimal" autocomplete="off">
        <p class="ax-hint">Before the tip.</p>
      </div>
      <div class="ax-field">
        <span class="ax-label" id="tip-label">Tip</span>
        <div class="ax-segmented" role="radiogroup" aria-labelledby="tip-label">
          <button type="button" role="radio" aria-checked="false">10%</button>
          <button type="button" role="radio" aria-checked="true">15%</button>
          <button type="button" role="radio" aria-checked="false">20%</button>
        </div>
      </div>
    </div>
  </section>

  <section class="ax-section">
    <h2 class="ax-section__title">Each person pays</h2>
    <dl class="ax-pairs ax-pairs--total" aria-live="polite">
      <div><dt>Tip</dt><dd>€ 9,00</dd></div>
      <div><dt>Per person</dt><dd>€ 23,00</dd></div>
    </dl>
  </section>
</main>
```

- Page: `.ax-app` is the column (720 px); `.ax-app--wide` (1040 px) for tables and boards; `.ax-app--full` for a canvas or game that fills the window.
- Header: `.ax-header` with `.ax-title`, `.ax-subtitle` and, at the end, a small action.
- Sections: `.ax-section` with `.ax-section__title` (and `.ax-section__hint`). Sections, not boxes, are how most content is grouped.
- `.ax-card`: one raised group that belongs together (a form in a sheet, a settings group). Not one card per item, never cards inside cards.
- Buttons: `.ax-btn` (a plain button), `--primary` (the one main action on a screen: ink, inverted in dark), `--accent` (the companion acting: "Ask your companion", "Generate"), `--ghost` (quiet actions), `--danger` (only to confirm a destructive step), `--sm`, `--lg`, `--icon` (square, needs aria-label), `--full`.
- Fields: `.ax-field` > `.ax-label` + `.ax-input` / `.ax-select` / `.ax-textarea` + `.ax-hint` or `.ax-error`; `aria-invalid="true"` on the control with the error, and `aria-describedby` to the message. `.ax-input--num` right-aligns figures.
- Choices: `.ax-segmented` for two to five options; `<input type="checkbox" role="switch" class="ax-switch">` for on and off (in a `<label class="ax-check">` with its text); plain checkboxes and radios take the accent by themselves.
- Lists: `<ul class="ax-list">` with `<li class="ax-row">`: `.ax-row__main` (`.ax-row__title`, `.ax-row__meta`) and `.ax-row__end` (a figure, a badge, a ghost icon button). `.ax-list--divided` adds hairlines. `aria-selected="true"` marks the chosen row.
- Results: `<dl class="ax-pairs">` for label and value pairs; `--total` makes the last value larger. `.ax-table` for real tables.
- State: `.ax-empty` (an icon, `.ax-empty__title`, one sentence, the first action), `.ax-badge` (`--success`, `--warning`, `--danger`, `--accent`), `.ax-notice` (same tones) for a message in the page, `<progress class="ax-progress">`.
- `<dialog class="ax-dialog">` with `.ax-dialog__actions` for a confirmation, opened with showModal().
- Layout: `.ax-stack` (a column, `--gap` to change the space), `.ax-cluster` (a wrapping row), `.ax-grid` (`--min` for the column width), `.ax-spacer`.
- Text: `.ax-muted`, `.ax-small`, `.ax-num` (tabular figures), `.ax-kbd`, `.ax-sr-only`.
- Icons: `<svg class="ax-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="…"/></svg>`: 16 px line icons in the text's colour, one stroke weight. Draw simple ones (plus, check, x, chevron, trash, clock); a button with only an icon needs aria-label.

## Every state

- Empty: what this is for and the first thing to do, with that action as a button. Not "No data".
- Working: say what's happening ("Reading the file…") and keep the layout still; disable the button that started it.
- Errors: next to what caused them, saying what went wrong and how to fix it, in plain words and without apologising. Keep what the person typed.
- Done: show the result where they're looking, and announce changes with aria-live="polite".
- Destructive: ask in an ax-dialog naming exactly what goes, or offer Undo.
- Many items: lists stay readable at 3 and at 300 (search or filter once a list gets long).

## Words

Sentence case everywhere. Buttons say what happens ("Add expense", "Start the timer"), never "Submit" or "OK". Labels are short nouns; hints are one sentence. Write numbers with Intl.NumberFormat and dates with Intl.DateTimeFormat in the person's locale (navigator.language), money with its currency, and a non-breaking space between a number and its unit.

## Keyboard and access

Real elements (button, a label for every input, lists as ul or ol), a visible focus ({brand} UI draws it; never remove an outline without a :focus-visible style), Enter submits a form, Escape closes a dialog, arrow keys move inside a segmented control. Targets at least 24 px. Never colour alone for meaning: add a word or an icon. Contrast is handled by the tokens; check anything you colour yourself.

## Motion

Only to show a change: an item arriving, a panel opening, progress. 90 to 250 ms with var(--ease-standard), on opacity and transform. No entrance choreography, no bouncing, no hover lift on every card. {brand} UI stops CSS motion when the person asks for reduced motion; stop your own requestAnimationFrame animation too (matchMedia('(prefers-reduced-motion: reduce)')).

## What makes an app look generic (leave it out)

- Gradients (backgrounds, buttons, text), glows, neon and frosted glass.
- Purple or blue as decoration: colour is the companion's accent, and only for state.
- Emoji as icons or in headings.
- A card around every item, cards inside cards, the same rounded box repeated down the page.
- A thick coloured stripe along the left edge of a box.
- Small all-caps labels above headings, numbered 01 / 02 / 03 steps that aren't steps.
- A huge number over a tiny label as the centre of the page.
- Everything centred; a hero section in a tool.
- Fonts of your own, or a monospace font to look technical.
- Arrows tacked onto button labels, "✨" for anything the companion does.

## Before you say it's done

build_app returns the draft in light and dark, plus the design problems and console errors it found. Look at both pictures: is anything cut off, cramped, misaligned, low in contrast or empty without explanation? Does it still look like {brand} in dark? Fix it and build again with the same appId, then tell the person what it does and how to use it in two or three sentences.

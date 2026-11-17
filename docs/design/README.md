# Design docs

These are Atelier's product and design specifications: what each surface does, how it looks and moves, and how the pieces fit together. They describe the browser as built, and new work starts by adding or changing an item here.

| File | Covers |
|---|---|
| [feature-spec.md](feature-spec.md) | The behaviour of every surface, item by item: shell, chat, companions, skills and routines, meetings and voice, settings, overlays, states, onboarding, updates and the full keyboard shortcut table. |
| [design-spec.md](design-spec.md) | Layout, measurements, colour roles, motion and dark mode, as testable requirements with the files they touch. It wins where it disagrees with the other two, and its last section lists each such case. |
| [ux-plan.md](ux-plan.md) | A shorter overview of the layout and UX structure: which surfaces exist, where they sit and how the flows work. |

Packs, apps and the companion system have their own docs one level up ([packs.md](../packs.md), [apps.md](../apps.md), [companion-system.md](../companion-system.md)).

**Ids.** Every requirement has a stable id with an anchor, such as [CH-22](feature-spec.md#ch-22) or [DS-40](design-spec.md#ds-40). The prefix names the area: `SH` shell, `CH` chat, `CO` companions, `SK` skills, routines and connectors, `ST` settings, `OV` overlays and dialogs, `SS` states, `MV` meetings and voice, `ON` onboarding, `PK` packs, `DG` diagnostics, `DS` design, and so on. Code comments and test names cite these ids (for example `// OV-24, DS-24` or `describe('the auto-approval countdown (CH-42)')`), so you can search the codebase for an id to find where it is built and tested, and follow an id in the code back to the requirement. Keep ids stable: a new item takes the next free number or a letter suffix (`MV-08a`) rather than renumbering others.

**Status markers** in feature-spec.md:
- ✅ done
- ◐ partial: the item says what is still missing
- ○ missing

An item counts as done only when it works in both light and dark mode.

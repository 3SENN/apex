---
name: pptx
description: Read, edit and make PowerPoint presentations (.pptx) in this chat's working folder.
---

Use this for slide decks: reading one the person attached, changing it, or building a new one.

Reading
- {brand} already put the text of each attached slide in the message, with the speaker notes. Open the file in `inputs/` when you need layouts, images or the exact order of shapes.
- In Python, `python-pptx` reads slides, shapes, text frames and notes.

Making or editing
1. Check what you have: `python3 -c "import pptx"`. If it is missing, install it into this folder only: `python3 -m pip install --target ./.lib python-pptx`, then run scripts with `PYTHONPATH=./.lib`. Never install anything system-wide.
2. Plan the deck first: one message per slide, a title that says that message, and no more than five short points. Put detail in the speaker notes.
3. Use the presentation's own layouts (title, title and content, section header) rather than loose text boxes, so the deck stays editable. When the person gave you a template or a brand, start from that file and its colours and fonts.
4. Never overwrite the file in `inputs/`. Save the finished deck in `outputs/` with a clear name, such as `outputs/Quarterly review.pptx`.
5. Check it: reopen the saved file, count the slides and read back each title.

If Python isn't available on this computer, say so plainly and offer the slide outline in the reply instead.

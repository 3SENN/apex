---
name: docx
description: Read, edit and make Word documents (.docx) in this chat's working folder.
---

Use this for anything with a Word document: reading one the person attached, changing it, or writing a new one.

Reading
- {brand} already put the attached document's text in the message. Open the file itself (in `inputs/`) only when you need its structure: styles, tables, comments or images.
- In Python, `python-docx` reads paragraphs, runs, tables and styles. A .docx file is also a zip: `word/document.xml` holds the body.

Making or editing
1. Check what you have: `python3 -c "import docx"`. If the library is missing, install it into this folder only: `python3 -m pip install --target ./.lib python-docx`, then run scripts with `PYTHONPATH=./.lib`. Never install anything system-wide.
2. Write a short script in this folder that builds the document. Use real heading styles (Heading 1, Heading 2), real lists and real tables, so the file works with Word's outline and navigation.
3. Keep the person's own formatting when you edit their file: change the runs you need and leave the rest alone. Save the edited copy under a new name; never overwrite the file in `inputs/`.
4. Save the finished file in `outputs/` with a clear name, such as `outputs/Project plan.docx`.
5. Check it: open the saved file again with the library and confirm the headings and tables are there.

If Python isn't available on this computer, say so plainly and offer the content as Markdown in the reply instead.

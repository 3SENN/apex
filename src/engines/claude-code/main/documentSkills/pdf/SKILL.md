---
name: pdf
description: Read, fill, combine and make PDF files in this chat's working folder.
---

Use this for PDFs: pulling text or tables out of one, filling a form, combining or splitting files, or making a new PDF.

Reading
- {brand} already sent the attached PDF itself, or its text when it was very long. Open the file in `inputs/` when you need its form fields, its exact layout or its pages as separate files.
- In Python, `pypdf` reads text, form fields and pages, and can merge, split and rotate them.

Making or editing
1. Check what you have: `python3 -c "import pypdf"`, or `import reportlab` to draw a new PDF. If one is missing, install it into this folder only: `python3 -m pip install --target ./.lib pypdf reportlab`, then run scripts with `PYTHONPATH=./.lib`. Never install anything system-wide.
2. To make a PDF from writing, a simple route is to build it with reportlab (headings, paragraphs, tables). On a Mac, `textutil` and `cupsfilter` can also turn a .docx or HTML file into a PDF.
3. To fill a form, read its field names first, fill them by name, and keep the original untouched.
4. Never overwrite the file in `inputs/`. Save the finished PDF in `outputs/` with a clear name, such as `outputs/Signed form.pdf`.
5. Check it: reopen the saved file and confirm the page count and the text you added.

If Python isn't available on this computer, say so plainly and offer the content in the reply instead.

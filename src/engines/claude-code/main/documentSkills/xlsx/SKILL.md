---
name: xlsx
description: Read, analyse and make Excel workbooks (.xlsx) in this chat's working folder.
---

Use this for spreadsheets: reading a workbook the person attached, working out numbers from it, or making a new one.

Reading
- {brand} already put the attached workbook's cell values in the message, sheet by sheet, and says when it shortened a big sheet. Open the file in `inputs/` when you need every row, the formulas or the formatting.
- In Python, `openpyxl` reads values and formulas (`load_workbook(path, data_only=False)` keeps formulas; `data_only=True` gives the last saved values). For analysis, `pandas.read_excel` is quicker when it is installed.

Making or editing
1. Check what you have: `python3 -c "import openpyxl"`. If it is missing, install it into this folder only: `python3 -m pip install --target ./.lib openpyxl`, then run scripts with `PYTHONPATH=./.lib`. Never install anything system-wide.
2. Put inputs and assumptions in their own cells and use formulas for totals and results, so the person can change a number and see the effect. Don't paste computed values where a formula belongs.
3. Give each sheet a short name, a header row, sensible column widths and number formats (currency, percentages, dates).
4. Never overwrite the file in `inputs/`. Save the finished workbook in `outputs/` with a clear name, such as `outputs/Budget 2027.xlsx`.
5. Check it: reopen the saved file and confirm the sheets, headers and formulas.

If Python isn't available on this computer, say so plainly and offer a CSV file in `outputs/` or a table in the reply instead.

/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fixture files for the file intake's unit tests and smoke checks, built in code so no
// binary fixtures are checked in: small PDFs (plain, encrypted, broken) and
// an Office Open XML zip. Pure, with no Electron imports.
import { strToU8, zipSync } from 'fflate'

/** A PDF with `pages` pages of Helvetica text ("Page n"); `encrypted` adds a standard security handler with an unknown password. */
export function buildPdf(pages: number, options: { encrypted?: boolean } = {}): Uint8Array {
  const objects: string[] = []
  const add = (body: string): number => objects.push(body)
  const catalog = add('')
  const pageTree = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 24 Tf 72 720 Td (Page ${n} of the fixture) Tj ET`
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`
  const hex = (byte: string): string => byte.repeat(32)
  const encrypt = options.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /O <${hex('a1')}> /U <${hex('b2')}> /P -4 >>`) : 0

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`
  const id = `<${hex('c3').slice(0, 32)}>`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R /ID [${id} ${id}]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(out)
}

/** Looks like a PDF to the sniffer, but has no readable structure. */
export function brokenPdf(): Uint8Array {
  return strToU8('%PDF-1.7\nthis is not a real document\n%%EOF\n')
}

/** A minimal .docx-shaped zip (its entry names are what make it one). */
export function buildDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'),
  })
}

/** The first bytes of a Mach-O executable, whatever the file is called. */
export function executableBytes(): Uint8Array {
  return Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, ...new Array<number>(56).fill(0)])
}

export const SVG_FIXTURE = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>window.ran = true</script><rect width="40" height="20" fill="#3a7"/></svg>'

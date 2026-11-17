/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { CsvStreamParser, csvField, csvValueType, detectDelimiter, detectHeader, parseCsv, toCsv, widenType, type CsvValueType } from '../src/shared/csv'

// The shared RFC 4180 reader: the password import and the tables both use it.

describe('parseCsv', () => {
  it('reads plain rows and drops a trailing empty line', () => {
    expect(parseCsv('a,b,c\n1,2,3\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('strips a byte order mark', () => {
    expect(parseCsv('﻿Title,URL\nx,y').rows[0]).toEqual(['Title', 'URL'])
  })

  it('handles CRLF, LF and lone CR line ends', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4\n5,6').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
  })

  it('keeps delimiters, doubled quotes and newlines inside quoted fields', () => {
    const { rows } = parseCsv('name,note\r\n"a, b","say ""hi""\r\nsecond line"\r\n')
    expect(rows).toEqual([
      ['name', 'note'],
      ['a, b', 'say "hi"\r\nsecond line'],
    ])
  })

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c,\n').rows).toEqual([['a', '', 'c', '']])
    expect(parseCsv('"",x').rows).toEqual([['', 'x']])
  })

  it('stops after maxRows for a preview', () => {
    expect(parseCsv('a\nb\nc\nd', { maxRows: 2 }).rows).toEqual([['a'], ['b']])
  })

  it('detects semicolons and tabs, and prefers commas on a tie', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
    expect(detectDelimiter('a,b;c')).toBe(',')
    expect(detectDelimiter('"x;y;z",b')).toBe(',')
    expect(parseCsv('a;b\n1;2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('reads an empty file as no rows', () => {
    expect(parseCsv('').rows).toEqual([])
    expect(parseCsv('﻿').rows).toEqual([])
  })
})

describe('writing CSV', () => {
  it('quotes only when needed and round-trips', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('a;b', ';')).toBe('"a;b"')
    const rows = [
      ['h1', 'h2'],
      ['multi\nline', 'q"uote'],
    ]
    expect(parseCsv(toCsv(rows)).rows).toEqual(rows)
  })
})


function streamAll(text: string, delimiter: ',' | ';' | '\t', size: number): string[][] {
  const parser = new CsvStreamParser(delimiter)
  const rows: string[][] = []
  for (let i = 0; i < text.length; i += size) rows.push(...parser.push(text.slice(i, i + size)))
  rows.push(...parser.end())
  return rows
}

describe('CsvStreamParser', () => {
  const tricky = '\uFEFFname;note\r\n"a; b";"say ""hi""\r\nagain"\r\nplain;\r\n'

  it('gives the same rows as parseCsv, whatever the chunk size', () => {
    const expected = parseCsv(tricky, { delimiter: ';' }).rows
    for (const size of [1, 2, 3, 5, 7, 64]) expect(streamAll(tricky, ';', size)).toEqual(expected)
  })

  it('splits a doubled quote and a CRLF across chunks correctly', () => {
    expect(streamAll('"x""', ',', 4).concat()).toEqual([['x"']])
    const parser = new CsvStreamParser(',')
    expect(parser.push('a,"b""')).toEqual([])
    expect(parser.push('c"\r')).toEqual([['a', 'b"c']])
    expect(parser.push('\nd')).toEqual([])
    expect(parser.end()).toEqual([['d']])
  })

  it('reads tabs and keeps an unterminated last row', () => {
    expect(streamAll('a\tb\n1\t2', '\t', 3)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns nothing for an empty file', () => {
    expect(streamAll('', ',', 4)).toEqual([])
    expect(streamAll('\uFEFF', ',', 4)).toEqual([])
  })
})

describe('column types', () => {
  it('infers INTEGER, REAL or TEXT from one value', () => {
    expect(csvValueType('42')).toBe('INTEGER')
    expect(csvValueType('-7')).toBe('INTEGER')
    expect(csvValueType(' 3 ')).toBe('INTEGER')
    expect(csvValueType('0')).toBe('INTEGER')
    expect(csvValueType('3.5')).toBe('REAL')
    expect(csvValueType('.5')).toBe('REAL')
    expect(csvValueType('0.25')).toBe('REAL')
    expect(csvValueType('1e3')).toBe('REAL')
    expect(csvValueType('12345678901234567890')).toBe('REAL')
    expect(csvValueType('007')).toBe('TEXT')
    expect(csvValueType('00.5')).toBe('TEXT')
    expect(csvValueType('1,5')).toBe('TEXT')
    expect(csvValueType('2026-10-29')).toBe('TEXT')
    expect(csvValueType('abc')).toBe('TEXT')
  })

  it('widens a column INTEGER → REAL → TEXT and ignores empty cells', () => {
    const column = (values: string[]): CsvValueType | null => values.reduce<CsvValueType | null>((t, v) => widenType(t, v), null)
    expect(column(['1', '2', ''])).toBe('INTEGER')
    expect(column(['1', '2.5'])).toBe('REAL')
    expect(column(['2.5', '1'])).toBe('REAL')
    expect(column(['1', 'x', '2'])).toBe('TEXT')
    expect(column(['', ' '])).toBeNull()
  })
})

describe('detectHeader', () => {
  it('takes a row of distinct words as names', () => {
    expect(detectHeader([['name', 'price'], ['tea', '3']])).toBe(true)
  })

  it('refuses numbers, blanks and repeats', () => {
    expect(detectHeader([['2024', 'total']])).toBe(false)
    expect(detectHeader([['name', '']])).toBe(false)
    expect(detectHeader([['a', 'A']])).toBe(false)
    expect(detectHeader([])).toBe(false)
  })
})

describe('detectDelimiter for tables', () => {
  it('sniffs each delimiter from the first lines', () => {
    expect(detectDelimiter('city;pop\nGhent;260000\nBruges;118000')).toBe(';')
    expect(detectDelimiter('city\tpop\nGhent\t260000')).toBe('\t')
    expect(detectDelimiter('city,pop\nGhent,260000')).toBe(',')
  })
})

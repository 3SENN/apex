/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { apex, call } from '../api'
import { t } from '../i18n/useT'
import { copyText } from './actions'
import { cx, toast } from '../ui'
import { AppWindow } from 'lucide-react'
import { TAB_LINK, parseMarkdown, type Block, type Inline } from './logic/markdown'
import { splitWords, wordDelay, type RevealRecord } from './logic/reveal'

// Renders a reply's Markdown as React elements (never as HTML). While a reply
// streams, words past the settled part fade in on a staggered timeline.


/**
 * A link goes to the tab already showing its page, in whichever window holds
 * it, or opens in a new tab beside the chat; ⌘-click (Ctrl-click) keeps the
 * chat in front and opens it in the background; ⇧-click shows it in Peek
 *. A tab link (`tab:<id>`) goes to that tab, or reopens it when it was
 * closed. Mail links go to the mail app through main.
 */
export function openLink(href: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void {
  const tabId = TAB_LINK.exec(href)?.[1]
  if (tabId) {
    void call('tabs', 'reveal', tabId).then(
      (outcome) => outcome === 'gone' && toast.show({ message: t('chat.tabLink.gone') }),
      () => undefined,
    )
    return
  }
  const web = /^https?:/i.test(href)
  if (e.shiftKey && web) {
    void call('peek', 'open', href).catch(() => void apex.tabs.create(href).catch(() => undefined))
    return
  }
  if (e.metaKey || e.ctrlKey || !web) {
    void apex.tabs.create(href, e.metaKey || e.ctrlKey ? { background: true } : undefined).catch(() => undefined)
    return
  }
  void call('tabs', 'revealUrl', href).then(
    (shown) => shown || void apex.tabs.create(href).catch(() => undefined),
    () => void apex.tabs.create(href).catch(() => undefined),
  )
}

function CodeCopy({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={cx('md-code-copy', copied && 'md-code-copy--done')}
      aria-label={copied ? t('chat.code.copied') : t('chat.code.copy')}
      title={copied ? t('chat.code.copied') : t('chat.code.copy')}
      onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <span className="md-code-copy__label" aria-hidden="true">{copied ? t('chat.code.copied') : t('chat.code.copy')}</span>
    </button>
  )
}

export interface MarkdownReveal {
  record: RevealRecord
  /** When this view mounted: words from earlier batches continue their fade instead of restarting. */
  mountedAt: number
}

export interface MarkdownProps {
  text: string
  reveal?: MarkdownReveal | null
  className?: string
}

export function Markdown({ text, reveal = null, className }: MarkdownProps): ReactElement {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const ctx: Ctx = { n: 0, reveal }
  return <div className={cx('md', className)}>{renderBlocks(blocks, ctx)}</div>
}

/** Parses once for callers that also need the word count (the reveal record). */
export function useMarkdownBlocks(text: string): Block[] {
  return useMemo(() => parseMarkdown(text), [text])
}

export function MarkdownBlocks({ blocks, reveal = null, className }: { blocks: Block[]; reveal?: MarkdownReveal | null; className?: string }): ReactElement {
  const ctx: Ctx = { n: 0, reveal }
  return <div className={cx('md', className)}>{renderBlocks(blocks, ctx)}</div>
}

interface Ctx {
  /** The next word's index, in drawing order (matches countMarkdownWords). */
  n: number
  reveal: MarkdownReveal | null
}

/** The fade delay for the next unit, or null when it is settled. */
function nextDelay(ctx: Ctx): number | null {
  const index = ctx.n++
  return ctx.reveal ? wordDelay(ctx.reveal.record, index, ctx.reveal.mountedAt) : null
}

const fadeStyle = (delay: number): CSSProperties => ({ animationDelay: `${Math.round(delay)}ms` })

function renderBlocks(blocks: readonly Block[], ctx: Ctx): ReactNode[] {
  return blocks.map((block, i) => renderBlock(block, ctx, i))
}

function renderBlock(block: Block, ctx: Ctx, key: number): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, ctx)}</p>
    case 'heading': {
      const Tag = (['h3', 'h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h4'
      return <Tag key={key} className={`md-h md-h--${block.level}`}>{renderInline(block.children, ctx)}</Tag>
    }
    case 'code': {
      const delay = nextDelay(ctx)
      // Fenced code carries a copy button.
      return (
        <div key={key} className={cx('md-code-block', delay !== null && 'md-word')} style={delay !== null ? fadeStyle(delay) : undefined}>
          <pre className="md-pre" data-lang={block.lang || undefined}>
            <code>{block.text}</code>
          </pre>
          <CodeCopy text={block.text} />
        </div>
      )
    }
    case 'quote':
      return <blockquote key={key}>{renderBlocks(block.children, ctx)}</blockquote>
    case 'rule':
      return <hr key={key} />
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked !== null ? 'md-task' : undefined}>
          {item.checked !== null && <span className={cx('md-task__box', item.checked && 'md-task__box--done')} aria-label={item.checked ? t('chat.markdown.done') : t('chat.markdown.notDone')} role="img" />}
          {renderListItem(item.children, ctx)}
        </li>
      ))
      return block.ordered ? <ol key={key} start={block.start !== 1 ? block.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'table':
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>{block.head.map((cell, i) => <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>{renderInline(cell, ctx)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, i) => <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>{renderInline(cell, ctx)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** A tight list item (one paragraph) draws its text without a <p>, so bullets hang on the text line. */
function renderListItem(blocks: readonly Block[], ctx: Ctx): ReactNode {
  const [first, ...rest] = blocks
  if (first?.kind === 'paragraph') return [<span key="lead">{renderInline(first.children, ctx)}</span>, ...rest.map((b, i) => renderBlock(b, ctx, i + 1))]
  return renderBlocks(blocks, ctx)
}

function renderInline(nodes: readonly Inline[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = []
  nodes.forEach((node, i) => {
    switch (node.kind) {
      case 'text':
        out.push(...renderText(node.text, ctx))
        break
      case 'code': {
        const delay = nextDelay(ctx)
        out.push(<code key={`c${i}`} className={cx('md-code', delay !== null && 'md-word')} style={delay !== null ? fadeStyle(delay) : undefined}>{node.text}</code>)
        break
      }
      case 'strong':
        out.push(<strong key={`s${i}`}>{renderInline(node.children, ctx)}</strong>)
        break
      case 'em':
        out.push(<em key={`e${i}`}>{renderInline(node.children, ctx)}</em>)
        break
      case 'del':
        out.push(<del key={`d${i}`}>{renderInline(node.children, ctx)}</del>)
        break
      case 'br':
        out.push(<br key={`b${i}`} />)
        break
      case 'link': {
        const tabLink = TAB_LINK.test(node.href)
        out.push(
          <a
            key={`a${i}`}
            href={node.href}
            title={tabLink ? t('chat.tabLink.title') : node.href}
            className={tabLink ? 'md-tab-link' : undefined}
            onClick={(e) => {
              e.preventDefault()
              openLink(node.href, e)
            }}
            onAuxClick={(e) => {
              // A middle click opens it in the background (a tab link just goes to its tab).
              if (e.button !== 1) return
              e.preventDefault()
              if (tabLink) openLink(node.href, e)
              else void apex.tabs.create(node.href, { background: true }).catch(() => undefined)
            }}
          >
            {tabLink && <AppWindow className="md-tab-link__icon" size={13} aria-hidden="true" />}
            {renderInline(node.children, ctx)}
          </a>,
        )
        break
      }
    }
  })
  return out
}

/** Plain runs stay strings; words still fading in get their own span keyed by index, so re-renders never restart them. */
function renderText(text: string, ctx: Ctx): ReactNode[] {
  if (!ctx.reveal) {
    ctx.n += splitWords(text).filter((p) => p.word).length
    return [text]
  }
  const out: ReactNode[] = []
  let plain = ''
  for (const part of splitWords(text)) {
    if (!part.word) {
      plain += part.text
      continue
    }
    const index = ctx.n
    const delay = nextDelay(ctx)
    if (delay === null) {
      plain += part.text
      continue
    }
    if (plain) out.push(plain)
    plain = ''
    out.push(<span key={`w${index}`} className="md-word" style={fadeStyle(delay)}>{part.text}</span>)
  }
  if (plain) out.push(plain)
  return out
}

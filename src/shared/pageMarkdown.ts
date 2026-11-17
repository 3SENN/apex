/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// "Copy page as Markdown" (OV-05). The converter runs inside the page, in an
// isolated world of its own, so it is kept as plain JavaScript source: a
// bundler can't add helpers to a string, and the page's scripts never see
// it. Tests evaluate the same source against a small fake DOM.

/** function (root, title, url) → Markdown. Uses only nodeType, nodeValue, tagName, childNodes and getAttribute. */
export const MARKDOWN_FN_SOURCE = String.raw`function (root, title, url) {
  var TICK = String.fromCharCode(96);
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, HEAD: 1, NAV: 1, BUTTON: 1, SELECT: 1, INPUT: 1, TEXTAREA: 1, FORM: 1, DIALOG: 1 };
  var BLOCK = { P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FIGURE: 1, FIGCAPTION: 1, ADDRESS: 1, DETAILS: 1, SUMMARY: 1, DL: 1, DT: 1, DD: 1 };
  var MAX = 400000;
  function tag(n) { return n.tagName ? String(n.tagName).toUpperCase() : ''; }
  function attr(n, name) { return n.getAttribute ? n.getAttribute(name) : null; }
  function hidden(n) { return attr(n, 'hidden') !== null || attr(n, 'aria-hidden') === 'true'; }
  function abs(href) { try { return new URL(href, url).href; } catch (e) { return href; } }
  function esc(text) { return text.replace(/([\\*_\[\]])/g, '\\$1'); }
  function inline(n, inPre) {
    var out = '';
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) out += inlineNode(kids[i], inPre);
    return out;
  }
  function inlineNode(n, inPre) {
    if (n.nodeType === 3) return inPre ? n.nodeValue : esc(n.nodeValue.replace(/\s+/g, ' '));
    if (n.nodeType !== 1 || SKIP[tag(n)] || hidden(n)) return '';
    var t = tag(n);
    var body;
    switch (t) {
      case 'BR': return '\n';
      case 'STRONG': case 'B': body = inline(n).trim(); return body ? '**' + body + '**' : '';
      case 'EM': case 'I': body = inline(n).trim(); return body ? '*' + body + '*' : '';
      case 'DEL': case 'S': body = inline(n).trim(); return body ? '~~' + body + '~~' : '';
      case 'CODE': body = textOf(n); return body ? TICK + body.replace(new RegExp(TICK, 'g'), "'") + TICK : '';
      case 'A':
        body = inline(n).trim();
        var href = attr(n, 'href');
        if (!href || /^javascript:/i.test(href)) return body;
        if (href.charAt(0) === '#') return body;
        return '[' + (body || abs(href)) + '](' + abs(href).replace(/\)/g, '%29').replace(/ /g, '%20') + ')';
      case 'IMG':
        var src = attr(n, 'src');
        return src ? '![' + esc(attr(n, 'alt') || '') + '](' + abs(src).replace(/\)/g, '%29') + ')' : '';
      default: return inline(n, inPre);
    }
  }
  function textOf(n) {
    if (n.nodeType === 3) return n.nodeValue;
    var out = '';
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) out += textOf(kids[i]);
    return out;
  }
  function list(n, depth, ordered) {
    var out = [];
    var kids = n.childNodes || [];
    var index = 1;
    for (var i = 0; i < kids.length; i++) {
      var li = kids[i];
      if (li.nodeType !== 1 || tag(li) !== 'LI' || hidden(li)) continue;
      var text = '';
      var nested = [];
      var parts = li.childNodes || [];
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        var pt = tag(p);
        if (pt === 'UL' || pt === 'OL') nested.push(list(p, depth + 1, pt === 'OL'));
        else if (p.nodeType === 1 && (BLOCK[pt] || pt === 'P')) text += ' ' + inline(p);
        else text += inlineNode(p);
      }
      var pad = new Array(depth + 1).join('  ');
      out.push(pad + (ordered ? (index++) + '. ' : '- ') + text.replace(/\s+/g, ' ').trim());
      for (var k = 0; k < nested.length; k++) if (nested[k]) out.push(nested[k]);
    }
    return out.join('\n');
  }
  function table(n) {
    var rows = [];
    (function collect(x) {
      var kids = x.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType !== 1) continue;
        if (tag(c) === 'TR') rows.push(c);
        else if (tag(c) !== 'TABLE') collect(c);
      }
    })(n);
    if (!rows.length) return '';
    var cells = rows.map(function (r) {
      var out = [];
      var kids = r.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var t = tag(kids[i]);
        if (t === 'TD' || t === 'TH') out.push(inline(kids[i]).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      }
      return out;
    });
    var width = cells.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    if (!width) return '';
    function line(r) { var x = []; for (var i = 0; i < width; i++) x.push(r[i] || ''); return '| ' + x.join(' | ') + ' |'; }
    var sep = []; for (var i = 0; i < width; i++) sep.push('---');
    return [line(cells[0]), '| ' + sep.join(' | ') + ' |'].concat(cells.slice(1).map(line)).join('\n');
  }
  function blocks(n, out) {
    var kids = n.childNodes || [];
    var run = '';
    function flush() { var t = run.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); if (t) out.push(t); run = ''; }
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) { run += inlineNode(c); continue; }
      if (c.nodeType !== 1 || SKIP[tag(c)] || hidden(c)) continue;
      var t = tag(c);
      var h = /^H([1-6])$/.exec(t);
      if (h) { flush(); var ht = inline(c).replace(/\s+/g, ' ').trim(); if (ht) out.push(new Array(+h[1] + 1).join('#') + ' ' + ht); continue; }
      if (t === 'UL' || t === 'OL') { flush(); var l = list(c, 0, t === 'OL'); if (l) out.push(l); continue; }
      if (t === 'PRE') {
        flush();
        var codeEl = null; var pk = c.childNodes || [];
        for (var j = 0; j < pk.length; j++) if (tag(pk[j]) === 'CODE') codeEl = pk[j];
        var lang = ((codeEl && attr(codeEl, 'class')) || attr(c, 'class') || '').match(/language-([\w+-]+)/);
        var code = textOf(c).replace(/\n$/, '');
        var fence = code.indexOf(TICK + TICK + TICK) >= 0 ? '~~~' : TICK + TICK + TICK;
        out.push(fence + (lang ? lang[1] : '') + '\n' + code + '\n' + fence);
        continue;
      }
      if (t === 'BLOCKQUOTE') { flush(); var inner = []; blocks(c, inner); if (inner.length) out.push(inner.join('\n\n').split('\n').map(function (x) { return '> ' + x; }).join('\n')); continue; }
      if (t === 'HR') { flush(); out.push('---'); continue; }
      if (t === 'TABLE') { flush(); var tb = table(c); if (tb) out.push(tb); continue; }
      if (BLOCK[t] || t === 'LI' || t === 'BODY') { flush(); blocks(c, out); continue; }
      run += inlineNode(c);
    }
    flush();
  }
  var parts = [];
  if (title) parts.push('# ' + String(title).replace(/\s+/g, ' ').trim());
  if (url) parts.push('<' + url + '>');
  blocks(root, parts);
  var md = parts.join('\n\n');
  return md.length > MAX ? md.slice(0, MAX) + '\n\n…' : md;
}`

/** The isolated-world expression that converts the page: its main content, else the body. */
export const PAGE_MARKDOWN_EXPRESSION = `(${MARKDOWN_FN_SOURCE})(document.querySelector('main, article, [role="main"]') || document.body, document.title, location.href)`

/** [title](url), with brackets in the title and parentheses in the address escaped. */
export function markdownLink(title: string, url: string): string {
  const text = (title.trim() || url).replace(/\s+/g, ' ').replace(/([\\[\]])/g, '\\$1')
  return `[${text}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})`
}

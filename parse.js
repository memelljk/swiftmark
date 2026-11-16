// SwiftMark — a CommonMark 0.31.2 + GFM 0.29 parser whose output matches
// marked 18.1.3 with default options byte for byte. Written from scratch
// (spec knowledge + differential testing against marked); dependency-free.
//
// Architecture: block parser builds a small tree of block nodes (link
// reference definitions are collected document-wide first), then a renderer
// walks the tree and runs the inline parser (delimiter-stack emphasis,
// links, autolinks) on each text-bearing block.

/* ---------------- helpers: escaping, entities, urls ---------------- */

const ESC_FULL_RE = /[&<>"']/g;
const ESC_TEXT_RE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const NUMREF_RE = /&(?:#([0-9]{1,7})|#[Xx]([0-9A-Fa-f]{1,6}));/g;

function escFull(s) {
  return s.replace(ESC_FULL_RE, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Text escaping: < > " ' are always escaped; & is escaped unless it starts
// a character reference (numeric or named-looking), which is left alone.
function escText(s) {
  return s.replace(ESC_TEXT_RE, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Decode a numeric character reference starting at `s[i]` ('&'). Returns
// [decodedChar, lengthConsumed] or null when it is not a valid numeric ref.
function decodeNumRefAt(s, i) {
  if (s[i] !== '&' || s[i + 1] !== '#') return null;
  let j = i + 2, hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  let cp = 0, digits = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    const d = hex
      ? (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1)
      : (c >= 48 && c <= 57 ? c - 48 : -1);
    if (d < 0) break;
    cp = cp * (hex ? 16 : 10) + d;
    digits++; j++;
    if (digits > (hex ? 6 : 7)) return null;
  }
  if (digits === 0 || j >= s.length || s[j] !== ';') return null;
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return [String.fromCodePoint(cp), j + 1 - i];
}

// marked does not decode named entities at all; only numeric refs are
// decoded (in text and link text, never inside code spans/blocks).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Link label normalisation: fold line endings / runs of whitespace to one
// space, trim, Unicode case-fold (including ß -> ss and ligatures).
function normLabel(s) {
  return s.replace(/[\s]+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st');
}

function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpaceOrTab(c) { return c === ' ' || c === '\t'; }
function isUnicodePunct(ch) {
  // CommonMark punctuation = ASCII punctuation + Unicode P/S categories.
  return isAsciiPunct(ch.charCodeAt(0)) || /[\p{P}\p{S}]/u.test(ch);
}
function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0';
}

/* ---------------- column / tab helpers (lines keep their \n) ---------------- */

// Split source (already \n-normalised) into lines, each keeping its trailing
// '\n' except possibly the last line.
function splitLines(src) {
  if (src === '') return [];
  const parts = src.split('\n');
  const lines = [];
  for (let k = 0; k < parts.length - 1; k++) lines.push(parts[k] + '\n');
  const last = parts[parts.length - 1];
  if (last !== '') lines.push(last);
  return lines;
}

function body(line) {
  return line.charCodeAt(line.length - 1) === 10 ? line.slice(0, -1) : line;
}
function hasNL(line) { return line.charCodeAt(line.length - 1) === 10; }
function isBlank(line) {
  const b = body(line);
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Columns of leading whitespace (tab advances to the next multiple of 4).
function indentCols(b) {
  let col = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `n` columns of leading whitespace. A tab straddling the boundary
// leaves spaces for its remainder, and any further leading tabs are
// expanded to spaces using their ORIGINAL columns (tab stops are relative
// to the line start, so re-basing them would corrupt the indent).
function stripCols(b, n) {
  let col = 0, i = 0;
  while (i < b.length && col < n) {
    const c = b[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else {
        let out = ' '.repeat(col + w - n);
        let cc = col + w; // original column just past this tab
        let j = i + 1;
        while (j < b.length && (b[j] === ' ' || b[j] === '\t')) {
          if (b[j] === ' ') { out += ' '; cc++; j++; }
          else { const w2 = 4 - (cc % 4); out += ' '.repeat(w2); cc += w2; j++; }
        }
        return out + b.slice(j);
      }
    } else break;
  }
  return b.slice(i);
}

// Expand leading tabs of `s` to spaces, tracking columns from `col`.
function expandLeadingTabs(s, col) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else if (c === ' ') { out += ' '; col++; i++; }
    else break;
  }
  return out + s.slice(i);
}

/* ---------------- inline parser ---------------- */

const BR = { k: 2 }; // hard break

// Delimiter nodes double as text nodes: {k:'d', s, ch, n, open, close,
// active, link, image}. Plain text is a bare string.
// marked's <a>-tag inLink leak: an opening <a...> tag parsed as INLINE
// HTML (in a paragraph — a lone <a> on its own line is an HTML block and
// does NOT trigger this) sets a document-persistent state that suppresses
// extended autolinks (www/scheme/email) in all following inline content,
// across paragraphs, until a closing </a> appears. Bracket autolinks
// <...>, bracket emails and inline links are NOT suppressed. Reset per
// document in parse(). inRawBlock is marked's other inline state: inside
// <pre>/<code>/<kbd>/<script> text, character references are NOT decoded
// and text is emitted raw (unescaped). Also reset per document.
let inLink = false;
let inRawBlock = false;

// For a tag's text, the raw-block tag name when the tag is a
// <pre>/<code>/<kbd>/<script> opener or closer whose name is followed by
// whitespace or '>' (marked's start/endPreScriptTag tests), with a leading
// '/' for closers; null otherwise. <pre/> and <codex> do not count.
function rawBlockTagName(t) {
  let j = 1, close = false;
  if (t[j] === '/') { close = true; j++; }
  let k = j;
  while (k < t.length && ((t[k] >= 'a' && t[k] <= 'z') || (t[k] >= 'A' && t[k] <= 'Z'))) k++;
  const name = t.slice(j, k).toLowerCase();
  if (name !== 'pre' && name !== 'code' && name !== 'kbd' && name !== 'script') return null;
  const after = t[k];
  if (after !== '>' && !isWhitespace(after)) return null;
  return (close ? '/' : '') + name;
}

function parseInline(text, refs) {
  const nodes = [];
  const delims = [];
  let buf = '';
  // Text runs accumulated while inRawBlock is on are emitted as raw nodes
  // (k:9, rendered verbatim — no entity decoding, no escaping), matching
  // marked's inRawBlock text tokens. A flush always happens at a tag
  // boundary, so a run never straddles the raw-block edge.
  const flush = () => { if (buf !== '') { nodes.push(inRawBlock ? { k: 9, s: buf, raw: buf } : buf); buf = ''; } };
  const n = text.length;
  let i = 0;

  // Flanking info for a delimiter run starting at `i` with length `len`.
  // punctFn defaults to isUnicodePunct; '~' runs use a punct test that
  // excludes '~' (GFM strikethrough flanking treats '~' as neither
  // punctuation nor a word character).
  function flanking(i, len, punctFn) {
    const punct = punctFn || isUnicodePunct;
    const prev = i === 0 ? '' : text[i - 1];
    const next = i + len >= n ? '' : text[i + len];
    const prevWs = prev === '' || isWhitespace(prev);
    const nextWs = next === '' || isWhitespace(next);
    const prevPunct = prev !== '' && punct(prev);
    const nextPunct = next !== '' && punct(next);
    const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
    const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
    return [leftFlank, rightFlank, prev, next];
  }

  while (i < n) {
    const ch = text[i];

    // --- backslash escapes and backslash-newline hard break ---
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush(); nodes.push(BR); i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        // a backslash-escaped '&' is a literal ampersand, never the start
        // of an entity: pre-escape it so the renderer leaves it escaped.
        // Inside a raw block the text is emitted verbatim, so every
        // escapable character is pre-escaped here instead.
        if (inRawBlock) {
          buf += nx === '&' ? '&amp;' : nx === '<' ? '&lt;' : nx === '>' ? '&gt;' : nx === '"' ? '&quot;' : nx === "'" ? '&#39;' : nx;
        } else {
          buf += nx === '&' ? '&amp;' : nx;
        }
        i += 2; continue;
      }
      buf += '\\'; i++; continue;
    }

    // --- code span ---
    if (ch === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      // find a matching run of exactly `run` backticks — but stop at a
      // ']' that would close an active link opener: the link regex
      // consumes the backticks as a label chunk first, so the code span
      // must not swallow that ']' (a code span whose closer really is
      // past the ']' only forms when the link cannot form)
      let j = i + run, found = -1, abort = false;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && text[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else if (text[j] === ']' && (text[j + 1] === '(' || text[j + 1] === '[' || j + 1 >= n)) {
          if (wouldFormLink(text, j, delims, refs)) { abort = true; break; }
          j++;
        } else j++;
      }
      if (found < 0 || abort) { buf += '`'.repeat(run); i += run; continue; }
      let content = text.slice(i + run, found).replace(/\n/g, ' ');
      // an empty code span is literal text, not a code node
      if (content === '') { buf += '`'.repeat(run) + '`'.repeat(run); i = found + run; continue; }
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ k: 0, s: content });
      i = found + run;
      continue;
    }

    // --- '<': autolink <...> or raw HTML ---
    if (ch === '<') {
      const auto = tryBracketAutolink(text, i);
      if (auto) { flush(); nodes.push(auto.node); i = auto.next; continue; }
      const tag = tryHtmlTag(text, i);
      if (tag) {
        flush(); nodes.push({ k: 1, s: tag.text });
        // marked's tag state, exactly as its startATag/endATag and
        // start/endPreScriptTag tests: an <a> opens inLink only when the
        // char after the 'a' is a SPACE (<a> and <a/> and <a\t...> do
        // not; a self-closing <a /> DOES), and only an exact </a> closes
        // it (</a > does not). A <pre>/<code>/<kbd>/<script> opener
        // (name followed by whitespace or '>') turns inRawBlock on, and
        // any of the four closers turns it off again.
        const t = tag.text;
        if (!inLink && t.length >= 3 && (t[1] === 'a' || t[1] === 'A') && t[2] === ' ') inLink = true;
        else if (inLink && t.length === 4 && t[1] === '/' && (t[2] === 'a' || t[2] === 'A') && t[3] === '>') inLink = false;
        const rawName = rawBlockTagName(t);
        if (rawName) {
          if (!inRawBlock && rawName[0] !== '/') inRawBlock = true;
          else if (inRawBlock && rawName[0] === '/') inRawBlock = false;
        }
        i = tag.next; continue;
      }
      // literal '<': escaped here directly — except inside a raw block,
      // where text is emitted verbatim
      buf += inRawBlock ? '<' : '&lt;'; i++; continue;
    }

    // --- '&': numeric character reference (named entities stay literal) ---
    // Inside a raw block, references are NOT decoded: the '&' is literal.
    if (ch === '&') {
      const dec = inRawBlock ? null : decodeNumRefAt(text, i);
      if (dec) {
        // a decoded '&' is a literal ampersand, never an entity start
        buf += dec[0] === '&' ? '&amp;' : dec[0];
        i += dec[1]; continue;
      }
      buf += '&'; i++; continue;
    }

    // --- emphasis / strikethrough delimiter runs ---
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && text[i + run] === ch) run++;
      // a '~' run of 3+ is literal text, never a strikethrough delimiter
      if (ch === '~' && run >= 3) { buf += '~'.repeat(run); i += run; continue; }
      const [leftFlank, rightFlank] = ch === '~'
        ? flanking(i, run, (c) => isUnicodePunct(c) && c !== '~')
        : flanking(i, run);
      let open, close;
      if (ch === '_') {
        open = leftFlank && (!rightFlank || (i > 0 && isUnicodePunct(text[i - 1])));
        close = rightFlank && (!leftFlank || (i + run < n && isUnicodePunct(text[i + run])));
      } else {
        open = leftFlank; close = rightFlank;
      }
      flush();
      const d = { k: 'd', s: ch.repeat(run), ch, n: run, open, close, active: true, link: false, image: false, pos: i };
      nodes.push(d); delims.push(d);
      i += run;
      continue;
    }

    // --- '[' / '![' link openers ---
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const image = ch === '!';
      flush();
      const d = { k: 'd', s: image ? '![' : '[', ch: '[', n: 1, open: false, close: false, active: true, link: true, image, pos: image ? i + 1 : i };
      nodes.push(d); delims.push(d);
      i += image ? 2 : 1;
      continue;
    }

    // --- ']' : try to resolve a link ---
    if (ch === ']') {
      flush();
      const made = tryCloseBracket(text, i, nodes, delims, refs);
      if (made) { i = made.next; continue; }
      // No link formed: when the '[label](dest)' still matches marked's
      // blockSkip `link` pattern (label valid per the Ot-masked grammar,
      // balanced-paren destination), the label's delimiters are invisible
      // to the outer emphasis scan — mask them so processEmphasis never
      // pairs them. (A label whose code span holds a backtick fails
      // validLabel, so the link does not form, yet the mask still hides
      // the label: doc-16/doc-20 `[at _node `` a ` b ``_](...)`.)
      if (text[i + 1] === '(' && blockSkipDestEnd(text, i + 1) >= 0) {
        for (let d = delims.length - 1; d >= 0; d--) {
          if (!delims[d].link || !delims[d].active) continue;
          const opener = delims[d];
          const rawLabel = text.slice(opener.pos + 1, i);
          if (!blockSkipLabelOk(rawLabel)) break;
          const oiStack = delims.indexOf(opener);
          for (let m = oiStack + 1; m < delims.length; m++) {
            if (!delims[m].link) delims[m].masked = true;
          }
          break;
        }
      }
      // literal ']': deactivate the nearest active LINK opener (an image
      // opener stays active so an outer image can still form at a later
      // ']' — cm-520; a dead link opener must not keep suppressing the
      // extended autolinks after it, doc-32)
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].link && !delims[d].image && delims[d].active) { delims[d].active = false; break; }
      }
      buf += ']'; i++; continue;
    }

    // --- line ending: soft break, or hard break after 2+ spaces ---
    if (ch === '\n') {
      let spaces = 0;
      for (let k = buf.length - 1; k >= 0 && buf[k] === ' '; k--) spaces++;
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush(); nodes.push(BR); i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        buf += '\n'; i++;
      }
      continue;
    }

    // --- extended autolinks (GFM): www. / scheme:// / email / mailto: / xmpp: ---
    // forward matching from the word start, so a '_' inside an email
    // local part never becomes an emphasis delimiter first (gfm-632).
    // Extended autolinks do not form inside link text, but that is decided
    // when the link forms (unlinkExtAutolinks turns them back into plain
    // text), NOT by scanning the openers here: an UNRESOLVED '[' must not
    // suppress autolinks after it (marked only suppresses them inside a
    // resolved link's text). A raw <a> tag does suppress them (inLink).
    // www. needs a word start: whitespace, '(', '*', '_', '~', or the end
    // of a previous token (an HTML tag, code span, link, ... — after such
    // a token, marked's url tokenizer is tried at the fresh position).
    if (ch === 'w' && !inLink && text.startsWith('www.', i)) {
      const prev = i === 0 ? '' : text[i - 1];
      // a delimiter node (k:'d') is not a token: after '[' the www. must
      // still be rejected (prev is '['), only real tokens count
      const lastNd = nodes.length > 0 ? nodes[nodes.length - 1] : null;
      const atTokenBoundary = buf === '' && lastNd !== null && typeof lastNd !== 'string' && lastNd.k !== 'd';
      if (prev === '' || isWhitespace(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~' || atTokenBoundary) {
        const m = matchExtendedAutolink(text, i, 'www', delims);
        if (m) { flush(); nodes.push(m.node); i = m.next; continue; }
      }
    }
    if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && !inLink) {
      const m = matchExtendedAutolink(text, i, 'scheme', delims);
      if (m) { flush(); nodes.push(m.node); i = m.next; continue; }
    }
    // mailto:/xmpp: (lowercase only) at the start or after a non-alphanumeric
    if ((ch === 'm' || ch === 'x') && !inLink && (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i))) {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || !/[A-Za-z0-9]/.test(prev)) {
        const m = matchEmailAt(text, i, delims);
        if (m) { flush(); nodes.push(m.node); i = m.next; continue; }
      }
    }
    // plain email: current char is a local char and the previous one is not
    if (/[A-Za-z0-9._+-]/.test(ch) && !inLink) {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || !/[A-Za-z0-9._+-]/.test(prev)) {
        const m = matchEmailAt(text, i, delims);
        if (m) { flush(); nodes.push(m.node); i = m.next; continue; }
      }
    }

    buf += ch; i++;
  }
  flush();
  // Delimiters inside a blockSkip-masked range are invisible to the outer
  // emphasis scan (marked's emStrong mask): the Ot mask pairs a backtick
  // run with a later same-length run and neutralises the backticks
  // between them, then blockSkip swallows the whole span — so a stray
  // backtick in a link label can hide emphasis far past the link
  // (doc-09/doc-28/doc-35). Delimiters consumed by a link that formed
  // are already gone from the stack, so only unformed labels and stray
  // spans are hit here.
  if (delims.length > 0) {
    const ranges = blockSkipRanges(text);
    if (ranges.length > 0) {
      let ri = 0;
      for (const d of delims) {
        if (d.link || d.masked) continue;
        while (ri < ranges.length && ranges[ri][1] <= d.pos) ri++;
        if (ri < ranges.length && d.pos >= ranges[ri][0] && d.pos < ranges[ri][1]) d.masked = true;
      }
    }
  }
  processEmphasis(nodes, delims, 0);
  return renderNodes(nodes);
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') { out += escText(nd); continue; }
    switch (nd.k) {
      case 0: out += '<code>' + escFull(nd.s) + '</code>'; break;
      case 1: out += nd.s; break;
      case 2: out += '<br>'; break;
      case 3: out += '<em>' + renderNodes(nd.c) + '</em>'; break;
      case 4: out += '<strong>' + renderNodes(nd.c) + '</strong>'; break;
      case 5: out += '<del>' + renderNodes(nd.c) + '</del>'; break;
      case 6: {
        out += '<a href="' + nd.href + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + nd.title + '"';
        out += '>' + renderNodes(nd.c) + '</a>';
        break;
      }
      case 7: {
        out += '<img src="' + nd.src + '" alt="' + nd.alt + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + nd.title + '"';
        out += '>';
        break;
      }
      case 8: out += nd.s; break; // pre-escaped text (autolink text)
      case 9: out += nd.s; break; // raw-block text (verbatim, unescaped)
      case 'd': out += escText(nd.s); break;
    }
  }
  return out;
}

// Strip tags (used for image alt text): render children, drop <...>.
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

/* ---------------- emphasis (delimiter stack) ---------------- */

// Process emphasis/strikethrough closers left to right, oldest first.
// fromStack: only delimiters at or after this stack index may open/close.
function processEmphasis(nodes, delims, fromStack) {
  let ci = fromStack;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.active || closer.masked || closer.ch === '[' || !closer.close) { ci++; continue; }
    // nearest preceding opener of the same char that can open
    let oi = ci - 1, opener = null;
    while (oi >= fromStack) {
      const d = delims[oi];
      if (d.masked) { oi--; continue; }
      if (d.ch === closer.ch && d.open && d.active) {
        // strikethrough openers and closers must have EQUAL lengths
        if (closer.ch === '~' && d.n !== closer.n) { oi--; continue; }
        // rule of three: skip unless both counts are multiples of 3
        if ((d.close || closer.open) && ((d.n + closer.n) % 3 === 0) && !(d.n % 3 === 0 && closer.n % 3 === 0)) {
          oi--; continue;
        }
        opener = d; break;
      }
      oi--;
    }
    if (!opener) { ci++; continue; }
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = closer.ch === '~' ? 5 : (use === 2 ? 4 : 3);
    const ni = nodes.indexOf(opener), nj = nodes.indexOf(closer);
    const children = nodes.slice(ni + 1, nj);
    const wrap = { k: tag, c: children };
    opener.s = opener.s.slice(0, opener.s.length - use); opener.n -= use;
    closer.s = closer.s.slice(use); closer.n -= use;
    if (opener.n === 0) opener.active = false;
    if (closer.n === 0) closer.active = false;
    nodes.splice(ni + 1, nj - ni - 1, wrap);
    // delimiters between opener and closer are now inside the wrap
    const oiStack = delims.indexOf(opener), ciStack = delims.indexOf(closer);
    delims.splice(oiStack + 1, ciStack - oiStack - 1);
    ci = delims.indexOf(closer);
    if (closer.n === 0) ci++;
    // (closer with remaining delims is re-processed against earlier openers)
  }
}

/* ---------------- link resolution ---------------- */

// Parse an inline link destination + optional title starting at `i`
// (which must be '('). Returns {dest, title, next} or null.
function parseInlineLink(text, i) {
  const n = text.length;
  if (text[i] !== '(') return null;
  let j = i + 1;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < n && text[k] !== '\n' && text[k] !== '>') {
      if (text[k] === '\\' && k + 1 < n && isAsciiPunct(text.charCodeAt(k + 1))) { dest += text[k + 1]; k += 2; }
      else { dest += text[k]; k++; }
    }
    if (k >= n || text[k] !== '>') return null;
    j = k + 1;
  } else {
    let depth = 0;
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      dest += c; j++;
    }
  }
  // optional whitespace, optional title, optional whitespace, ')'
  // (a title must be preceded by whitespace — otherwise, e.g. after an
  // angle-bracket destination, the quote belongs to the destination)
  let k = j;
  while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  let title = null;
  if (k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    if (k === j) return null; // no whitespace before the title
    const q = text[k];
    const close = q === '(' ? ')' : q;
    let t = '', m = k + 1, ok = false;
    while (m < n) {
      const c = text[m];
      if (c === '\\' && m + 1 < n && isAsciiPunct(text.charCodeAt(m + 1))) { t += text[m + 1]; m += 2; continue; }
      if (c === close) { ok = true; break; }
      if (c === '\n') {
        // a newline inside a title is allowed only when the same line also
        // has content after it is closed later; keep it verbatim
        t += '\n'; m++; continue;
      }
      t += c; m++;
    }
    if (!ok) return null;
    title = t;
    k = m + 1;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  }
  if (k >= n || text[k] !== ')') return null;
  return { dest, title, next: k + 1 };
}

// Parse a bracketed label starting at `i` ('['). Returns {label, next} or
// null. Labels do not nest (an unescaped '[' inside is invalid) and end
// at the first unescaped ']'; backslashes are kept verbatim in the label.
// A newline is allowed unless followed by a blank line.
function parseLabel(text, i) {
  const n = text.length;
  if (text[i] !== '[') return null;
  let j = i + 1, label = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { label += c + text[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label, next: j + 1 };
    if (c === '\n') {
      let k = j + 1;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k < n && text[k] === '\n') return null;
      label += '\n'; j++;
      continue;
    }
    label += c; j++;
  }
  return null;
}

// True when any node in `children` (recursively) is a link node.
// True when the children contain a bracket-formed link (autolinks do
// not count: a bracket autolink <...> may appear inside link text, and
// an extended autolink is unlinked below when the outer link forms).
function containsLink(children) {
  for (const nd of children) {
    if (typeof nd === 'string') continue;
    if (nd.k === 6 && !nd.auto) return true;
    if (nd.k === 3 || nd.k === 4 || nd.k === 5 || nd.k === 6) {
      if (containsLink(nd.c)) return true;
    }
  }
  return false;
}

// Extended autolinks (www./scheme://email) do not form inside link
// text. The inline parser meets them before it knows a link is forming,
// so when a link does form, turn any extended autolink in its children
// back into plain text (bracket autolinks <...> stay links).
function unlinkExtAutolinks(children) {
  const out = [];
  for (const nd of children) {
    if (typeof nd === 'string') { out.push(nd); continue; }
    if (nd.k === 6 && nd.auto === 'ext') {
      let raw = '';
      for (const ch of nd.c) raw += typeof ch === 'string' ? ch : (ch.raw !== undefined ? ch.raw : ch.s);
      out.push(raw);
      continue;
    }
    if ((nd.k === 3 || nd.k === 4 || nd.k === 5 || nd.k === 6) && nd.c) {
      out.push({ ...nd, c: unlinkExtAutolinks(nd.c) });
      continue;
    }
    out.push(nd);
  }
  return out;
}

// Plain text of inline children, for image alt text: inner images
// contribute their alt, links contribute their text, raw HTML and hard
// breaks contribute nothing, code contributes its text.
function altTextOf(children) {
  let s = '';
  for (const nd of children) {
    if (typeof nd === 'string') s += nd;
    else if (nd.k === 0) s += nd.s;
    else if (nd.k === 1 || nd.k === 2) { /* raw HTML / hard break: nothing */ }
    else if (nd.k === 8) s += nd.raw !== undefined ? nd.raw : nd.s;
    else if (nd.k === 9) s += nd.s;
    else if (nd.k === 'd') s += nd.s;
    else if (nd.k === 3 || nd.k === 4 || nd.k === 5 || nd.k === 6) s += altTextOf(nd.c);
    else if (nd.k === 7) s += nd.alt;
  }
  return s;
}

// --- link-label validation (marked's link/reflink label pattern) ---
// A label is valid when its whole raw text is consumable by these chunks
// (a hand-written scanner for the same grammar, no regex copy):
//   [ ... ]  a nested bracket group (inner brackets are one level deep)
//   \x       an escaped character
//   `...`    a code-span chunk: a maximal backtick run, non-backtick
//            middle, a maximal backtick run (the first backtick run after
//            the opener is the closer — the middle cannot hold backticks)
//   ``+      a run of 2+ backticks immediately before the closing ']'
//   x        any other single character (not '[', ']', '\', '`')
// A shortcut reference does NOT use this pattern (its label may hold
// backticks freely), so this is only applied to inline links and
// full/collapsed references.
function validLabel(raw) {
  const n = raw.length;
  let pos = 0;
  while (pos < n) {
    const c = raw[pos];
    if (c === '[') {
      const end = matchLabelBracket(raw, pos);
      if (end < 0) return false;
      pos = end;
    } else if (c === '\\') {
      if (pos + 1 >= n) return false;
      pos += 2;
    } else if (c === '`') {
      // a run of 2+ backticks reaching the end of the label
      let k = pos;
      while (k < n && raw[k] === '`') k++;
      if (k === n && k - pos >= 2) return true;
      const end = matchLabelCodeSpan(raw, pos);
      if (end < 0) return false;
      pos = end;
    } else if (c === ']') {
      return false;
    } else {
      pos++;
    }
  }
  return true;
}

// Nested bracket group: '[' + (inner bracket | escaped char |
// non-bracket char)* + ']'. Returns the index after ']' or -1.
function matchLabelBracket(s, pos) {
  let k = pos + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '[') {
      const inner = matchLabelBracketLe(s, k);
      if (inner < 0) return -1;
      k = inner;
    } else if (c === '\\') {
      if (k + 1 >= s.length) return -1;
      k += 2;
    } else if (c === ']') {
      return k + 1;
    } else {
      k++;
    }
  }
  return -1;
}

// One-level bracket group (marked's `brackets`): '[' + (escaped char |
// non-bracket char)* + ']'. Returns the index after ']' or -1.
function matchLabelBracketLe(s, pos) {
  let k = pos + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\') {
      if (k + 1 >= s.length) return -1;
      k += 2;
    } else if (c === ']') {
      return k + 1;
    } else if (c === '[') {
      return -1;
    } else {
      k++;
    }
  }
  return -1;
}

// Code-span chunk: a maximal backtick run, then non-backtick chars, then
// the first backtick run after it (also maximal). Returns the index after
// the closing run, or -1 when there is no closing run.
function matchLabelCodeSpan(s, pos) {
  const n = s.length;
  let open = pos;
  while (open < n && s[open] === '`') open++;
  let m = open;
  while (m < n && s[m] !== '`') m++;
  if (m >= n) return -1;
  let close = m;
  while (close < n && s[close] === '`') close++;
  return close;
}

// Ot code span (marked's anyPunctuationOutsideCode code-span alternative):
// an opening backtick run, content that starts and ends with a non-backtick
// character (it may hold shorter backtick runs inside — those are what the
// Ot mask replaces with '+'), and a closing run of the same length not
// followed by another backtick. Returns the index after the closing run,
// or -1. This is the code-span grammar the blockSkip mask sees, after the
// Ot mask has neutralised the inner backticks.
function matchOtCodeSpan(s, pos) {
  const n = s.length;
  let open = pos;
  while (open < n && s[open] === '`') open++;
  const L = open - pos;
  if (L === 0 || open >= n || s[open] === '`') return -1;
  let k = open;
  while (k < n) {
    if (s[k] !== '`') { k++; continue; }
    let r = k;
    while (r < n && s[r] === '`') r++;
    if (r - k === L) return r;
    k = r;
  }
  return -1;
}

// True when a label matches marked's blockSkip `link` label grammar (the
// grammar the emStrong mask sees, on the Ot-masked text): no '[' or ']'
// inside (the class is [^\[\]] — a nested bracket rejects the whole
// match), escaped characters, and code spans per matchOtCodeSpan. A label
// that passes here but fails validLabel (its code span holds a backtick)
// still masks the emphasis inside it — the link does not form, yet the
// outer emStrong scan never sees the label's delimiters.
function blockSkipLabelOk(raw) {
  const n = raw.length;
  let pos = 0;
  while (pos < n) {
    const c = raw[pos];
    if (c === '[' || c === ']') return false;
    if (c === '\\') { if (pos + 1 >= n) return false; pos += 2; continue; }
    if (c === '`') {
      const end = matchOtCodeSpan(raw, pos);
      if (end < 0) return false;
      pos = end;
      continue;
    }
    pos++;
  }
  return true;
}

// Balanced-paren destination after ']( ' (marked's blockSkip `link` dest:
// one nesting level). text[p] must be '('. Returns the index after the
// closing ')' or -1.
function blockSkipDestEnd(text, p) {
  const n = text.length;
  let k = p + 1, depth = 0;
  while (k < n) {
    const c = text[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') { if (depth > 0) return -1; depth++; k++; continue; }
    if (c === ')') {
      if (depth === 0) return k + 1;
      depth--; k++; continue;
    }
    k++;
  }
  return -1;
}

// The Ot mask (marked's anyPunctuationOutsideCode), length-preserving:
// a code span keeps its delimiter backticks but has the backticks inside
// its content replaced with '+'; a backslash-escaped punctuation character
// is replaced with '++'. Positions in the result match the original text,
// so the blockSkip scan below can run on it directly.
function otMaskedText(text) {
  const chars = text.split('');
  const n = chars.length;
  let i = 0;
  while (i < n) {
    if (text[i] === '\\' && i + 1 < n && isAsciiPunct(text.charCodeAt(i + 1))) {
      chars[i] = '+'; chars[i + 1] = '+'; i += 2; continue;
    }
    if (text[i] === '`') {
      const end = matchOtCodeSpan(text, i);
      if (end >= 0) {
        let open = i;
        while (open < n && text[open] === '`') open++;
        const L = open - i;
        for (let k = open; k < end - L; k++) if (chars[k] === '`') chars[k] = '+';
        i = end; continue;
      }
      let j = i;
      while (j < n && text[j] === '`') j++;
      i = j; continue;
    }
    i++;
  }
  return chars.join('');
}

// A blockSkip code-span chunk on the masked text: a maximal backtick run,
// non-backtick content, and a closing run of the same length (not followed
// by another backtick — the run is maximal, so that is automatic).
// Returns the index after the closing run, or -1.
function matchBlockSkipCodeSpan(s, pos) {
  const n = s.length;
  let open = pos;
  while (open < n && s[open] === '`') open++;
  const L = open - pos;
  if (L === 0) return -1;
  let k = open;
  while (k < n && s[k] !== '`') k++;
  if (k === open || k >= n) return -1;
  let r = k;
  while (r < n && s[r] === '`') r++;
  if (r - k !== L) return -1;
  return r;
}

// A blockSkip `link` match starting at `pos` (s[pos] === '[') on the
// masked text: '[' + label + '](' + dest + ')'. The label holds no '['
// or ']' (the class is [^\[\]]) — a ']' that is not followed by '(' and
// a valid destination rejects the whole match. Returns the index after
// the closing ')' or -1.
function matchBlockSkipLink(s, pos) {
  const n = s.length;
  let k = pos + 1;
  while (k < n) {
    if (s[k] === '\\') { k += 2; continue; }
    if (s[k] === '`') {
      const end = matchBlockSkipCodeSpan(s, k);
      if (end < 0) return -1;
      k = end; continue;
    }
    if (s[k] === '[' || s[k] === ']') {
      if (s[k] === ']' && s[k + 1] === '(') {
        const destEnd = blockSkipDestEnd(s, k + 1);
        if (destEnd >= 0) return destEnd;
      }
      return -1;
    }
    k++;
  }
  return -1;
}

// Ranges of the text that marked's emStrong mask replaces (blockSkip:
// `[label](dest)` links, code spans, HTML tags) — computed on the
// Ot-masked text, so the ranges are positions in the original text.
// Delimiters inside these ranges are invisible to the outer emphasis
// scan (they are re-lexed only inside a link that actually forms).
function blockSkipRanges(text) {
  const s = otMaskedText(text);
  const n = s.length;
  const ranges = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '[') {
      const end = matchBlockSkipLink(s, i);
      if (end >= 0) { ranges.push([i, end]); i = end; continue; }
      i++; continue;
    }
    if (c === '`') {
      if (i > 0 && s[i - 1] === '`') { i++; continue; }
      const end = matchBlockSkipCodeSpan(s, i);
      if (end >= 0) { ranges.push([i, end]); i = end; continue; }
      i++; continue;
    }
    if (c === '<') {
      if (s[i + 1] !== ' ') {
        let k = i + 1;
        while (k < n && s[k] !== '>' && s[k] !== '<') k++;
        if (k < n && s[k] === '>') { ranges.push([i, k + 1]); i = k + 1; continue; }
      }
      i++; continue;
    }
    if (c === '\\') { i += 2; continue; }
    i++;
  }
  return ranges;
}

// marked's Be(): true when the label (raw text between `start` and `end`
// in `text`) contains a '<' that starts an HTML tag or autolink extending
// past the end of the label. Such a label rejects the link outright
// (inline, reference, and shortcut alike). A '<' inside a code span does
// not count, and a tag/autolink fully inside the label is skipped.
function labelHasRunawayTag(text, start, end) {
  const label = text.slice(start, end);
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const close = matchLabelCodeSpan(label, s);
      if (close >= 0) { s = close - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const pos = start + s;
    const tag = tryHtmlTag(text, pos);
    const auto = tag ? null : tryBracketAutolink(text, pos);
    const len = tag ? tag.next - pos : auto ? auto.next - pos : 0;
    if (len > 0) {
      if (len > end - pos) return true;
      s += len - 1;
    }
  }
  return false;
}

// Would a link form at the ']' at position `j`? Mirrors
// tryCloseBracketOpener's decision without mutating anything: the nearest
// active opener, bracket balance, a valid label, and a resolvable
// destination/reference. Used to stop a code span from swallowing the
// ']' (the link regex consumes the backticks as a label chunk first).
function wouldFormLink(text, j, delims, refs) {
  let opener = null;
  for (let d = delims.length - 1; d >= 0; d--) {
    if (delims[d].link && delims[d].active) { opener = delims[d]; break; }
  }
  if (!opener) return false;
  // bracket balance in the raw text between the opener and this ']'
  let open = 0, close = 0;
  for (let k = opener.pos + 1; k < j; k++) {
    if (text[k] === '[') {
      let bs = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) bs++;
      if (bs % 2 === 0) open++;
    } else if (text[k] === ']') {
      let bs = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) bs++;
      if (bs % 2 === 0) close++;
    }
  }
  if (open !== close) return false;
  const rawLabel = text.slice(opener.pos + 1, j);
  if (labelHasRunawayTag(text, opener.pos + 1, j)) return false;
  if (text[j + 1] === '(') {
    if (!validLabel(rawLabel)) {
      // an inline link with an invalid label falls back to a shortcut
      return refs.has(normLabel(rawLabel));
    }
    if (parseInlineLink(text, j + 1)) return true;
    return refs.has(normLabel(rawLabel));
  }
  if (text[j + 1] === '[') {
    if (!validLabel(rawLabel)) return false;
    const lab = parseLabel(text, j + 1);
    if (!lab) return false;
    const key = normLabel(lab.label === '' ? rawLabel : lab.label);
    return refs.has(key);
  }
  // shortcut reference (no label-pattern check: backticks are free here)
  return refs.has(normLabel(rawLabel));
}

// Attempt to form a link/image at the ']' at position `i`.
// Returns {next} when a link was formed (nodes/delims updated), else null.
function tryCloseBracket(text, i, nodes, delims, refs) {
  // try every active link opener, nearest first: the ']' closes the
  // opener whose brackets balance with it (the nearest opener may be
  // an inner '[' that is only part of the outer link's text, e.g.
  // cm-512 [link [foo [bar]]](/uri) closes the OUTER '[')
  const n = text.length;
  for (let di = delims.length - 1; di >= 0; di--) {
    if (!delims[di].link || !delims[di].active) continue;
    const opener = delims[di];
    const ni = nodes.indexOf(opener);
    // the ']' only closes the opener when the brackets balance: every
    // unmatched '[' inside must be matched by a literal ']' inside, so a
    // ']' that sits inside a nested bracket pair does not close the outer
    // one (cm-520: the middle ']' of ![[[foo](uri1)](uri2)](uri3) fails,
    // the last one forms the image with alt '[foo](uri2)')
    let open = 0, close = 0;
    for (let k = ni + 1; k < nodes.length; k++) {
      const nd = nodes[k];
      if (typeof nd === 'string') {
        for (let c = 0; c < nd.length; c++) if (nd[c] === ']') close++;
      } else if (nd.k === 'd' && nd.link) {
        open++;
      }
    }
    // a ']' produced by a backslash escape (\]) lands in a string node
    // but is NOT a bracket, so it must not count as a close (cm-194:
    // [Foo*bar\]] has one escaped ']' in its label)
    for (let k = opener.pos + 1; k < i; k++) {
      if (text[k] !== ']') continue;
      let bs = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) bs++;
      if (bs % 2 === 1) close--;
    }
    if (open !== close) continue;
    // a link may not contain another link (an image may contain one)
    if (!opener.image && containsLink(nodes.slice(ni + 1))) continue;
    const made = tryCloseBracketOpener(text, i, nodes, delims, opener, refs);
    if (made) return made;
  }
  return null;
}

// Resolve a ']' against one specific opener: inline link, full/collapsed
// reference, or shortcut reference. Returns the formed node or null.
// A label holding a '<' that starts a tag/autolink running past the ']'
// rejects the link outright (marked's Be). An inline link or a full /
// collapsed reference also needs its label to match the label pattern
// (validLabel); a shortcut reference does not.
function tryCloseBracketOpener(text, i, nodes, delims, opener, refs) {
  const ni = nodes.indexOf(opener);
  const rawLabel = text.slice(opener.pos + 1, i);
  if (labelHasRunawayTag(text, opener.pos + 1, i)) return null;
  let dest = null, title = null, next = i + 1;
  if (text[i + 1] === '(') {
    const res = parseInlineLink(text, i + 1);
    if (res && validLabel(rawLabel)) {
      dest = res.dest; title = res.title; next = res.next;
    } else {
      // an inline link that fails falls back to a shortcut reference
      const key = normLabel(rawLabel);
      const ref = refs.get(key);
      if (!ref) return null;
      dest = ref.href; title = ref.title;
    }
  } else if (text[i + 1] === '[') {
    if (!validLabel(rawLabel)) return null;
    const lab = parseLabel(text, i + 1);
    if (!lab) return null;
    const label = lab.label === '' ? null : lab.label;
    // a collapsed reference [] uses the link text as its label — the RAW
    // source text (backslashes kept), not the resolved inline text
    const key = normLabel(label === null ? rawLabel : label);
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.href; title = ref.title; next = lab.next;
  } else {
    // a shortcut reference uses the RAW link text as its label
    const key = normLabel(rawLabel);
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.href; title = ref.title;
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  // emphasis inside the link text is resolved before wrapping
  processEmphasis(nodes, delims, delims.indexOf(opener) + 1);
  const ni2 = nodes.indexOf(opener);
  let children = nodes.slice(ni2 + 1);
  // extended autolinks do not form inside link text
  if (!opener.image) children = unlinkExtAutolinks(children);
  let node;
  if (opener.image) {
    const alt = altTextOf(children);
    node = { k: 7, src: escText(href), title: title === null ? null : escText(title), alt: escText(alt) };
  } else {
    node = { k: 6, href: escText(href), title: title === null ? null : escText(title), c: children };
  }
  nodes.splice(ni2, nodes.length - ni2, node);
  // remove opener and everything after it from the delimiter stack
  const oiStack = delims.indexOf(opener);
  delims.splice(oiStack);
  if (!opener.image) {
    // links cannot nest: deactivate earlier LINK openers (image openers
    // stay active so an outer image can still form)
    for (const d of delims) if (d.link && !d.image) d.active = false;
  }
  return { next };
}

// Raw text of the link text between `opener` and the end of `nodes`
// (numeric refs decoded, escapes resolved — used for reference labels).
function nodesTextBetween(nodes, opener) {
  const ni = nodes.indexOf(opener);
  let s = '';
  for (let k = ni + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (typeof nd === 'string') s += nd;
    else if (nd.k === 0) s += nd.s;
    else if (nd.k === 1) s += nd.s;
    else if (nd.k === 8) s += nd.raw !== undefined ? nd.raw : nd.s;
    else if (nd.k === 'd') s += nd.s;
    else if (nd.k === 3 || nd.k === 4 || nd.k === 5 || nd.k === 6) s += nodesTextOf(nd.c);
    else if (nd.k === 7) s += nd.alt;
  }
  return s;
}
function nodesTextOf(children) {
  let s = '';
  for (const nd of children) {
    if (typeof nd === 'string') s += nd;
    else if (nd.k === 0 || nd.k === 1) s += nd.s;
    else if (nd.k === 8) s += nd.raw !== undefined ? nd.raw : nd.s;
    else if (nd.k === 9) s += nd.s;
    else if (nd.k === 'd') s += nd.s;
    else if (nd.k === 3 || nd.k === 4 || nd.k === 5 || nd.k === 6) s += nodesTextOf(nd.c);
    else if (nd.k === 7) s += nd.alt;
  }
  return s;
}

/* ---------------- autolinks ---------------- */

// Bracketed autolink <scheme:...> or <email>; returns {node, next} or null.
function tryBracketAutolink(text, i) {
  const n = text.length;
  let j = i + 1;
  let content = '';
  while (j < n && text[j] !== '>' && text[j] !== ' ' && text[j] !== '\n' && text[j] !== '<') {
    content += text[j]; j++;
  }
  if (j >= n || text[j] !== '>') return null;
  // scheme autolink: scheme 2..32 chars, first letter, then : and anything
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(content);
  if (scheme) {
    const href = cleanUrl(content);
    if (href === null) return null;
    return { node: { k: 6, auto: 'bracket', href: escFull(href), title: null, c: [{ k: 8, s: escFull(content), raw: content }] }, next: j + 1 };
  }
  // email autolink
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.exec(content);
  if (email) {
    return { node: { k: 6, auto: 'bracket', href: 'mailto:' + escFull(content), title: null, c: [{ k: 8, s: escFull(content), raw: content }] }, next: j + 1 };
  }
  return null;
}

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const EMAIL_DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;

// Extended email autolink triggered at '@' (position `i`), with the current
// text run in `buf`. Returns {node, next, takeFromBuf} or null.
// Extended email autolink matched FORWARD from position `i` (the start of
// the local part, or of a lowercase 'mailto:'/'xmpp:' protocol).
// Local [A-Za-z0-9._+-]+, '@', domain [a-zA-Z0-9-_]+
// (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+ with a (?![\w-]) lookahead, so a
// trailing '-' or '_' kills the match (gfm-632) and a trailing '.' is
// left as literal text. xmpp: takes one optional /segment of
// [A-Za-z0-9@.]+ (gfm-634/635). Returns {node, next} or null.
// (Manual scanning, no text.slice: this runs at every word start.)
// `delims` is the live delimiter stack: marked tokenizes emphasis BEFORE
// autolinks, so an email inside _..._ / __...__ is matched as if the
// closing '_' run were not there. When a domain segment (or the email
// itself) ends in a '_' run and the nearest '_' delimiter is an unmatched
// opener, that run is treated as the emphasis closer, not as part of the
// email — but only when the run is right-flanking (followed by the end,
// whitespace, or punctuation), so a '_' run followed by a word char
// (which would be an opener, not a closer) still kills the match.
function matchEmailAt(text, i, delims) {
  const n = text.length;
  let proto = null, j = i;
  if (text.startsWith('mailto:', i)) { proto = 'mailto:'; j = i + 7; }
  else if (text.startsWith('xmpp:', i)) { proto = 'xmpp:'; j = i + 5; }
  // local part: [A-Za-z0-9._+-]+
  const ls = j;
  while (j < n && isEmailLocal(text[j])) j++;
  if (j === ls) return null;
  const local = text.slice(ls, j);
  if (text[j] !== '@') return null;
  // domain: [a-zA-Z0-9-_]+ (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+
  let k = j + 1;
  const ds = k;
  while (k < n && isDomainChar(text[k])) k++;
  if (k === ds) return null;
  let end = k, hasDot = false;
  // lazily computed (only when a trailing '_' run is actually met):
  // is the nearest '_' delimiter an unmatched opener?
  let usOpener = null;
  const hasUsOpener = () => {
    if (usOpener === null) {
      usOpener = false;
      if (delims) for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '_') { usOpener = delims[d].open && delims[d].active; break; }
      }
    }
    return usOpener;
  };
  // is the '_' run starting at `p` a plausible emphasis closer? The char
  // before it is a domain char (alnum), so right-flanking is decided by
  // the char after the run alone.
  const usRunIsCloser = (p) => {
    let q = p;
    while (q < n && text[q] === '_') q++;
    const after = q >= n ? '' : text[q];
    return after === '' || isWhitespace(after) || isUnicodePunct(after);
  };
  while (k < n && text[k] === '.') {
    let m = k + 1;
    while (m < n && isDomainChar(text[m])) m++;
    // the segment after the dot must end in an alphanumeric — unless it
    // ends in a '_' run that closes an unmatched '_' opener, in which
    // case the run belongs to the emphasis, not the domain
    if (m > k + 1 && !isAlnum(text[m - 1])) {
      let t = m;
      while (t > k + 1 && text[t - 1] === '_') t--;
      if (t > k + 1 && isAlnum(text[t - 1]) && hasUsOpener() && usRunIsCloser(t)) m = t;
      else break;
    }
    if (m === k + 1 || !isAlnum(text[m - 1])) break;
    end = m; k = m; hasDot = true;
  }
  if (!hasDot) return null;
  const domain = text.slice(ds, end);
  const after = text[end];
  // the (?![\w-]) lookahead: a trailing alnum or '-' kills the match; a
  // trailing '_' kills it too — unless that '_' run closes an unmatched
  // '_' opener (the email sits inside emphasis)
  if (after !== undefined && (isAlnum(after) || after === '-' || (after === '_' && !(hasUsOpener() && usRunIsCloser(end))))) return null;
  const email = local + '@' + domain;
  let full = (proto || '') + email;
  let next = end;
  if (proto === 'xmpp:' && text[next] === '/') {
    let m = next + 1;
    while (m < n && (isAlnum(text[m]) || text[m] === '@' || text[m] === '.')) m++;
    if (m > next + 1) { full += text.slice(next, m); next = m; }
  }
  const href = proto === 'xmpp:' ? escText(full) : 'mailto:' + escText(email);
  return { node: { k: 6, auto: 'ext', href, title: null, c: [{ k: 8, s: escFull(full), raw: full }] }, next };
}

function isEmailLocal(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-';
}
function isDomainChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_';
}
function isAlnum(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

// GFM extended-autolink backpedal, as a hand-written chunk scanner.
// A URL candidate is trimmed to the longest prefix covered by these
// chunks, and the scan repeats until the result is stable:
//   A: a run of chars outside ?!.,:;*_'\"~()&
//   B: a (...) group with no ')' inside it
//   C: an '&' that does NOT start a character reference running to the
//      end of the string ([A-Za-z0-9]+; at the end)
//   D: a run of ?!.,:;*_'\"~) that does NOT reach the end of the string
// (A paren group whose ')' is the LAST char is dropped, while a group
// like (./d) after a stray ')' is kept whole.)
const BACKPEDAL_A_STOP = "?!.,:;*_'\"~()&";
const BACKPEDAL_D_SET = "?!.,:;*_'\"~)";

function backpedalUrl(s) {
  for (;;) {
    let m = 0;
    const n = s.length;
    while (m < n) {
      const c = s[m];
      if (!BACKPEDAL_A_STOP.includes(c)) {
        while (m < n && !BACKPEDAL_A_STOP.includes(s[m])) m++;
      } else if (c === '(') {
        let k = m + 1;
        while (k < n && s[k] !== ')') k++;
        if (k < n) m = k + 1;
        else break;
      } else if (c === '&') {
        let k = m + 1;
        while (k < n && isAlnum(s[k])) k++;
        if (k > m + 1 && k < n && s[k] === ';' && k + 1 === n) break;
        m++;
      } else if (BACKPEDAL_D_SET.includes(c)) {
        let k = m;
        while (k < n && BACKPEDAL_D_SET.includes(s[k])) k++;
        if (k < n) m = k;
        else break;
      } else break;
    }
    if (m === n) return s;
    s = s.slice(0, m);
    if (s === '') return '';
  }
}

// Extended www./scheme:// autolink at position `i`. Returns {node, next} or null.
// `delims` is the live delimiter stack: a link that starts before the
// autolink has priority over it (marked tries the link tokenizer at the
// '[' first), so the maximal run stops at a ']' that would close an
// active link opener — one followed by '(' (inline link), '[' (full or
// collapsed reference), or only whitespace to the end of the text
// (shortcut reference at the end of the paragraph).
function matchExtendedAutolink(text, i, kind, delims) {
  const n = text.length;
  let prefix = '';
  if (kind === 'www') {
    if (!text.startsWith('www.', i)) return null;
    prefix = 'http://';
  } else {
    const low = text.slice(i, i + 9).toLowerCase();
    if (low.startsWith('http://') || low.startsWith('https://') || low.startsWith('ftp://')) {
      prefix = '';
    } else return null;
  }
  // maximal run of non-space, non-'<' chars ('>' is part of the URL:
  // marked's url regex only stops at whitespace and '<')
  let j = i;
  while (j < n && text[j] !== ' ' && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '<') {
    if (text[j] === ']' && delims) {
      const nx = text[j + 1];
      if (nx === '(' || nx === '[' || nx === undefined || nx === ' ' || nx === '\t' || nx === '\n') {
        let linkClose = false;
        if (nx === '(' || nx === '[') {
          linkClose = delims.some((d) => d.link && d.active);
        } else {
          // only whitespace to the end of the text
          let k = j + 1;
          while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
          linkClose = k >= n && delims.some((d) => d.link && d.active);
        }
        if (linkClose) break;
      }
    }
    j++;
  }
  let match = backpedalUrl(text.slice(i, j));
  if (match === '') return null;
  // minimal validity: www. needs something after the dot; scheme needs the ://
  if (kind === 'www' && match.length <= 4) return null;
  const href = cleanUrl(prefix + match);
  if (href === null) return null;
  // the href is fully escaped (an '&amp;' in the URL becomes '&amp;amp;'
  // in the href); the visible text is escaped the same way
  return { node: { k: 6, auto: 'ext', href: escFull(href), title: null, c: [{ k: 8, s: escFull(match), raw: match }] }, next: i + match.length };
}

// Inline HTML tag at position `i` (which is '<'). Returns {text, next} or
// null. Strict grammar per marked's tag regex: tag names are letters +
// alnum/hyphen, attribute names are [A-Za-z_:][\w.:-]*, each attribute is
// preceded by whitespace (newlines allowed), quoted values may contain
// '<', '>' and newlines, unquoted values may not contain space "'=<>\`.
// Comments are <!--> / <!---> / <!--...--> (the latter may run to the
// end of the text); <?...?>, <!A-Z ...> and <![CDATA[...]]> are tags.
function tryHtmlTag(text, i) {
  const n = text.length;
  if (text[i] !== '<') return null;
  let j = i + 1;
  // comment: <!--> | <!---> | <!-- ... --> (or to the end of the text)
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return { text: text.slice(i, i + 5), next: i + 5 };
    if (text.startsWith('<!--->', i)) return { text: text.slice(i, i + 6), next: i + 6 };
    const end = text.indexOf('-->', i + 4);
    if (end < 0) return { text: text.slice(i), next: n };
    return { text: text.slice(i, end + 3), next: end + 3 };
  }
  // processing instruction <? ... ?>
  if (text[j] === '?') {
    const end = text.indexOf('?>', j + 1);
    if (end < 0) return null;
    return { text: text.slice(i, end + 2), next: end + 2 };
  }
  // declaration <!A-Z ...> or CDATA
  if (text[j] === '!') {
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) return null;
      return { text: text.slice(i, end + 3), next: end + 3 };
    }
    if (j + 1 < n && /[A-Za-z]/.test(text[j + 1])) {
      const end = text.indexOf('>', j + 1);
      if (end < 0) return null;
      return { text: text.slice(i, end + 1), next: end + 1 };
    }
    return null;
  }
  // closing tag </name>
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(text[j])) return null;
  while (j < n && /[A-Za-z0-9-]/.test(text[j])) j++;
  if (closing) {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j < n && text[j] === '>') return { text: text.slice(i, j + 1), next: j + 1 };
    return null;
  }
  // open tag: attributes, each preceded by whitespace (newlines allowed)
  while (j < n) {
    if (text[j] === '>') return { text: text.slice(i, j + 1), next: j + 1 };
    if (text[j] === '/' && text[j + 1] === '>') return { text: text.slice(i, j + 2), next: j + 2 };
    if (text[j] !== ' ' && text[j] !== '\t' && text[j] !== '\n') return null;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j >= n) return null;
    if (text[j] === '>') return { text: text.slice(i, j + 1), next: j + 1 };
    if (text[j] === '/' && text[j + 1] === '>') return { text: text.slice(i, j + 2), next: j + 2 };
    // attribute name
    if (!/[A-Za-z_:]/.test(text[j])) return null;
    j++;
    while (j < n && /[\w.:-]/.test(text[j])) j++;
    // optional = value (whitespace allowed around '=')
    let k = j;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    if (text[k] === '=') {
      k++;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        k++;
        while (k < n && text[k] !== q) k++;
        if (k >= n) return null;
        k++;
      } else {
        const start = k;
        while (k < n && !/[ \t\n"'=<>\`]/.test(text[k])) k++;
        if (k === start) return null;
      }
      j = k;
    }
    // else: no value; the separator whitespace is consumed by the loop
  }
  return null;
}

/* ---------------- block parser ---------------- */

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Parse blocks in lines[start..end). Returns {blocks, blankBetween,
// lastKind ('para'|'table'|other), lastNonBlank}. When stripAtEnd is true
// (inner content of a blockquote/list item), an HTML block running to the
// end of the range loses its trailing newline.
function parseBlocks(lines, start, end, refs, tight, stripAtEnd, inList) {
  const blocks = [];
  let blankBetween = false;
  let i = start;
  let pendingBlank = false;
  while (i < end) {
    if (isBlank(lines[i])) { pendingBlank = true; i++; continue; }
    if (pendingBlank && blocks.length > 0) blankBetween = true;
    pendingBlank = false;
    const b = body(lines[i]);
    // fenced code
    const fen = matchFencedStart(b);
    if (fen) { const r = parseFenced(lines, i, end, fen); blocks.push(r.block); i = r.next; continue; }
    // ATX heading
    const atx = matchATX(b);
    if (atx) { blocks.push({ t: 'head', level: atx.level, text: atx.content }); i++; continue; }
    // thematic break (before list, since --- is both)
    if (isThematicBreak(b)) { blocks.push({ t: 'hr' }); i++; continue; }
    // HTML block
    const htmlType = htmlBlockType(b);
    if (htmlType > 0) {
      const r = parseHTML(lines, i, end, htmlType, stripAtEnd);
      if (r.block) { blocks.push(r.block); i = r.next; continue; }
      // not really an HTML block after all — fall through to paragraph
    }
    // blockquote
    if (stripQuote(lines[i]) !== null) { const r = parseBlockquote(lines, i, end, refs); blocks.push(r.block); i = r.next; continue; }
    // list
    const lst = matchListStart(b);
    if (lst) { const r = parseList(lines, i, end, refs); blocks.push(r.block); i = r.next; continue; }
    // indented code (cannot interrupt a paragraph — but here we are at a
    // block start, so it is code)
    if (indentCols(b) >= 4) { const r = parseIndentedCode(lines, i, end); blocks.push(r.block); i = r.next; continue; }
    // paragraph / table / link-reference definitions
    const r = parseParagraph(lines, i, end, refs, stripAtEnd, inList);
    if (r.block) blocks.push(r.block);
    i = r.next;
  }
  const last = blocks[blocks.length - 1];
  const lastNonBlank = end > start && !isBlank(lines[end - 1]);
  return {
    blocks, blankBetween,
    lastKind: last ? last.t : null,
    lastNonBlank,
  };
}

function joinParaLines(ls) {
  const s = ls.join('');
  return s.charCodeAt(s.length - 1) === 10 ? s.slice(0, -1) : s;
}

/* --- headings, thematic breaks, fenced code --- */

function matchATX(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  let hashes = 0;
  while (i + hashes < b.length && b[i + hashes] === '#') hashes++;
  if (hashes < 1 || hashes > 6) return null;
  const after = b[i + hashes];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let content = b.slice(i + hashes);
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // a closing sequence of #s (preceded by a space), or a content made
  // entirely of #s, leaves an empty heading
  if (/^#+$/.test(content)) content = '';
  else {
    const m = /[ \t]+#+$/.exec(content);
    if (m) content = content.slice(0, m.index).replace(/[ \t]+$/, '');
  }
  return { level: hashes, content };
}

function isThematicBreak(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  const ch = b[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return null;
  let count = 0, j = i;
  while (j < b.length) {
    const c = b[j];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return null;
    j++;
  }
  return count >= 3;
}

function matchFencedStart(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  const ch = b[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i + len < b.length && b[i + len] === ch) len++;
  if (len < 3) return null;
  const info = b.slice(i + len);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, indent: i, info };
}

function matchFencedClose(b, ch, minLen) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  if (b[i] !== ch) return false;
  let len = 0;
  while (i + len < b.length && b[i + len] === ch) len++;
  if (len < minLen) return false;
  let j = i + len;
  while (j < b.length && (b[j] === ' ' || b[j] === '\t')) j++;
  return j === b.length;
}

function parseFenced(lines, i, end, fen) {
  const content = [];
  let j = i + 1, closed = false;
  while (j < end) {
    const b = body(lines[j]);
    if (matchFencedClose(b, fen.ch, fen.len)) { closed = true; break; }
    // stripCols handles a partially-stripped tab by turning its
    // remainder into spaces (a tab at column 0 with fence indent 1
    // becomes 3 spaces; with indent 0 it stays a tab)
    content.push(stripCols(b, fen.indent) + (hasNL(lines[j]) ? '\n' : ''));
    j++;
  }
  const info = fen.info.trim();
  const lang = info === '' ? null : unescapeBackslashes(info.split(/\s+/)[0]);
  // fenced code text is the joined content minus one trailing '\n'
  let text = content.join('');
  if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
  return { block: { t: 'code', lang, text }, next: closed ? j + 1 : j };
}

// Resolve backslash escapes (ASCII punctuation only) in a string.
function unescapeBackslashes(s) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && k + 1 < s.length && isAsciiPunct(s.charCodeAt(k + 1))) { out += s[k + 1]; k++; }
    else out += s[k];
  }
  return out;
}

/* --- indented code --- */

function parseIndentedCode(lines, i, end) {
  const content = [];
  let j = i;
  while (j < end) {
    const b = body(lines[j]);
    if (isBlank(lines[j])) {
      let k = j + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && indentCols(body(lines[k])) >= 4) {
        // a blank line keeps its spaces past the 4-column code indent
        content.push(stripCols(body(lines[j]), 4) + (hasNL(lines[j]) ? '\n' : ''));
        j++;
        continue;
      }
      break;
    }
    if (indentCols(b) >= 4) {
      content.push(stripCols(b, 4) + (hasNL(lines[j]) ? '\n' : ''));
      j++;
      continue;
    }
    break;
  }
  while (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
  return { block: { t: 'code', lang: null, text: content.join('') }, next: j };
}

/* --- HTML blocks (types 1-7) --- */

// Returns 1..7 for a line starting an HTML block, else 0. `inPara` means
// the line is inside a paragraph (type 7 cannot interrupt).
function htmlBlockType(b, inPara) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  if (b[i] !== '<') return 0;
  const rest = b.slice(i + 1);
  const low = rest.toLowerCase();
  if (/^(script|pre|style|textarea)([\s>\/]|$)/.test(low)) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest[0] === '!' && rest[1] !== undefined && /[A-Za-z]/.test(rest[1])) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  // type 6: block-level tag
  {
    const m = /^\/?([A-Za-z][A-Za-z0-9-]*)([\s>\/]|$)/.exec(rest);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  }
  if (!inPara) {
    // type 7: a complete open/closing tag alone on the line
    if (isCompleteTag(b)) return 7;
  }
  return 0;
}

// True when the line is (up to 3 spaces +) one complete open or closing
// tag and nothing else. Uses the strict inline tag grammar (tryHtmlTag),
// so <m:abc> or <a href='bar'title=title> are NOT complete tags.
function isCompleteTag(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  if (b[i] !== '<') return false;
  const tag = tryHtmlTag(b, i);
  return tag !== null && tag.next === b.length;
}

function htmlBlockEndMarker(type) {
  return type === 2 ? '-->' : type === 3 ? '?>' : type === 4 ? '>' : type === 5 ? ']]>' : null;
}

// Join lines[i..j) as block text; strip one trailing '\n' when the next
// line (lines[j]) is blank, or when the block runs to the end of an inner
// (container) range. For block types 1-5 (pre/script/comment/processing
// instruction/declaration/CDATA) marked keeps the trailing newline when
// the following blank line is whitespace-only (only a truly EMPTY blank
// line strips it); types 6-7 strip on any blank line. `stripWsBlank`
// selects the types 6-7 behaviour.
function htmlText(lines, i, j, end, stripAtEnd, stripWsBlank) {
  let s = '';
  for (let k = i; k < j; k++) s += lines[k];
  if (j < end && s.charCodeAt(s.length - 1) === 10 && (stripWsBlank ? isBlank(lines[j]) : lines[j] === '\n' || lines[j] === '')) s = s.slice(0, -1);
  else if (j >= end && stripAtEnd && s.charCodeAt(s.length - 1) === 10) s = s.slice(0, -1);
  return s;
}

function parseHTML(lines, i, end, type, stripAtEnd) {
  const b = body(lines[i]);
  if (type === 1) {
    const m = /^ {0,3}<(script|pre|style|textarea)([\s>\/]|$)/i.exec(b);
    const tag = m[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
    for (let j = i; j < end; j++) {
      if (closeRe.test(body(lines[j]))) {
        return { block: { t: 'html', text: htmlText(lines, i, j + 1, end, stripAtEnd) }, next: j + 1 };
      }
    }
    // no closing tag: a type-1 block runs to the end of the document
    return { block: { t: 'html', text: htmlText(lines, i, end, end, stripAtEnd) }, next: end };
  }
  if (type >= 2 && type <= 5) {
    const marker = htmlBlockEndMarker(type);
    for (let j = i; j < end; j++) {
      if (body(lines[j]).includes(marker)) {
        return { block: { t: 'html', text: htmlText(lines, i, j + 1, end, stripAtEnd) }, next: j + 1 };
      }
    }
    return { block: { t: 'html', text: htmlText(lines, i, end, end, stripAtEnd) }, next: end };
  }
  // types 6 and 7: consume until a blank line
  let j = i + 1;
  while (j < end && !isBlank(lines[j])) j++;
  return { block: { t: 'html', text: htmlText(lines, i, j, end, stripAtEnd, true) }, next: j };
}

/* --- lazy continuation lines (blockquote / list item) --- */

// A lazy continuation line is appended to the container's inner lines
// UNSTRIPPED and re-parsed; the paragraph text is then fixed up so the
// line reads as marked computes it (container indent stripped, then 4
// more columns when the remainder is indented >= 4 — the indented-code
// merge). A lazy setext-looking line is prefixed with 4 spaces so it
// stays paragraph text instead of becoming a heading.
function lazyAppendBody(b, ci) {
  const ind = indentCols(b);
  let stripped = b;
  if (ind >= ci) stripped = stripCols(b, ci);
  if (indentCols(stripped) >= 4) stripped = stripCols(stripped, 4);
  if (/^ {0,3}(=+|-+) *$/.test(stripped)) {
    const guarded = '    ' + stripped.trim();
    return { body: guarded, fix: { appended: guarded, fixed: stripped.trim() } };
  }
  if (stripped !== b) return { body: b, fix: { appended: b, fixed: stripped } };
  return { body: b, fix: null };
}

// Re-apply the recorded lazy-line fix-ups to the last paragraph block
// (re-parsing rebuilds the blocks from scratch, so the fix-ups must be
// re-applied after every re-parse).
function applyLazyFixups(res, fixups) {
  if (fixups.length === 0) return;
  const last = res.blocks[res.blocks.length - 1];
  if (!last || last.t !== 'para') return;
  const lines = last.text.split('\n');
  let fi = 0;
  for (let li = 0; li < lines.length && fi < fixups.length; li++) {
    if (lines[li] === fixups[fi].appended) { lines[li] = fixups[fi].fixed; fi++; }
  }
  last.text = lines.join('\n');
}

// True when the innermost last block (descending into a trailing
// blockquote or list) is a paragraph or table — a lazy line can extend it.
function deepLastParaTable(blocks) {
  const last = blocks[blocks.length - 1];
  if (!last) return false;
  if (last.t === 'para' || last.t === 'table') return true;
  if (last.t === 'quote') return deepLastParaTable(last.children);
  if (last.t === 'list') {
    const li = last.items[last.items.length - 1];
    return li ? deepLastParaTable(li) : false;
  }
  return false;
}

/* --- blockquote --- */

// Strip one blockquote marker from a line; returns the content (without
// trailing \n handling — caller re-adds it) or null when not a quote line.
// After '>' + one optional space column, leading tabs expand to spaces
// per their original columns.
function stripQuote(line) {
  const b = body(line);
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  if (b[i] !== '>') return null;
  let j = i + 1, col = i + 1;
  if (b[j] === ' ') { j++; col++; return expandLeadingTabs(b.slice(j), col); }
  if (b[j] === '\t') {
    const w = 4 - (col % 4);
    return ' '.repeat(w - 1) + expandLeadingTabs(b.slice(j + 1), col + w);
  }
  return expandLeadingTabs(b.slice(j), col);
}

function parseBlockquote(lines, i, end, refs) {
  const inner = [];
  let j = i;
  while (j < end) {
    const stripped = stripQuote(lines[j]);
    if (stripped === null) break;
    inner.push(stripped + (hasNL(lines[j]) ? '\n' : ''));
    j++;
  }
  const fixups = [];
  let res = null;
  let chunkStart = true; // the first lazy line starts a new chunk
  const ensureParsed = () => {
    if (!res) { res = parseBlocks(inner, 0, inner.length, refs, false, true); applyLazyFixups(res, fixups); }
    return res;
  };
  // lazy continuation lines, and quote lines that follow them (a blank
  // line ends the blockquote, even when followed by a quote line)
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    const stripped = stripQuote(line);
    if (stripped !== null) {
      inner.push(stripped + (hasNL(line) ? '\n' : ''));
      j++;
      res = null;
      chunkStart = true;
      continue;
    }
    if (isLazyCandidate(line, j, lines, end)) {
      const r = ensureParsed();
      if (r.lastNonBlank && deepLastParaTable(r.blocks)) {
        const last = r.blocks[r.blocks.length - 1];
        if (last.t === 'para' || last.t === 'table') {
          // direct: a lazy line starting a new chunk is dedented (the
          // indented-code merge); inside a chunk the paragraph regex
          // swallows it whole, spaces included
          const app = lazyAppendBody(body(line), 0);
          if (app.fix && chunkStart) fixups.push(app.fix);
          inner.push(app.body + (hasNL(line) ? '\n' : ''));
        } else {
          // nested blockquote/list: pass the line down unstripped; the
          // nested level applies its own stripping
          inner.push(line);
        }
        j++;
        res = null;
        chunkStart = false;
        continue;
      }
    }
    break;
  }
  res = ensureParsed();
  return { block: { t: 'quote', children: res.blocks }, next: j };
}

// A line may lazily continue a paragraph when it is non-blank and does not
// start an interrupting block (ATX, fence, thematic break, HTML 1-6,
// blockquote, list). Setext underlines and table rows are continuations.
function isLazyCandidate(line, k, lines, end) {
  const b = body(line);
  if (isBlank(line)) return false;
  if (matchATX(b)) return false;
  if (matchFencedStart(b)) return false;
  if (isThematicBreak(b)) return false;
  if (htmlBlockType(b, true) > 0) return false;
  if (stripQuote(line) !== null) return false;
  const lst = matchListStart(b);
  if (lst && listInterruptsPara(lst, b)) return false;
  return true;
}

/* --- lists --- */

// Match a list marker at the start of a (body) line. Returns null or
// {ordered, bullet, num, delim, markerEndCol, markerEndIdx, contentIndent}.
function matchListStart(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  let ordered = false, bullet = null, num = null, delim = null;
  if (b[i] === '-' || b[i] === '+' || b[i] === '*') {
    bullet = b[i];
    i++;
  } else if (/[0-9]/.test(b[i])) {
    let j = i;
    while (j < b.length && /[0-9]/.test(b[j])) j++;
    if (j - i > 9) return null;
    const d = b[j];
    if (d !== '.' && d !== ')') return null;
    ordered = true; num = parseInt(b.slice(i, j), 10); delim = d;
    i = j + 1;
  } else return null;
  // the marker must be followed by a space, a tab, or the end of the line
  const after = b[i];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // content indent: marker column + 1..4 columns of whitespace, else +1
  let col = i, j = i;
  while (j < b.length && (b[j] === ' ' || b[j] === '\t')) {
    if (b[j] === ' ') col++;
    else col += 4 - (col % 4);
    j++;
  }
  const wsCols = col - i;
  const contentIndent = (j >= b.length || wsCols < 1 || wsCols > 4) ? i + 1 : col;
  return { ordered, bullet, num, delim, markerEndCol: i, markerEndIdx: i, contentIndent };
}

// Does this list item interrupt a paragraph? Bullets always; ordered only
// when the start number is 1 — except inside a list item's content, where
// any list marker starts a nested list (marked: '- foo\n  49. Uses' makes
// a nested <ol start="49">, while a blockquote or top-level paragraph
// keeps '49.' as text). An empty item never interrupts.
function listInterruptsPara(lst, b, inList) {
  if (lst.ordered && lst.num !== 1 && !inList) return false;
  // empty item: nothing but whitespace after the marker
  let j = lst.markerEndIdx;
  while (j < b.length && (b[j] === ' ' || b[j] === '\t')) j++;
  return j < b.length;
}

function sameList(a, lst) {
  if (a.ordered !== lst.ordered) return false;
  if (a.ordered) return a.delim === lst.delim;
  return a.bullet === lst.bullet;
}

// Strip the marker + whitespace from an item's first line, leaving the
// content (a tab straddling the content indent leaves spaces, and further
// leading tabs expand per their original columns).
function stripItemMarker(b, lst) {
  let col = lst.markerEndCol, idx = lst.markerEndIdx;
  while (col < lst.contentIndent && idx < b.length) {
    const c = b[idx];
    if (c === ' ') { col++; idx++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= lst.contentIndent) { col += w; idx++; }
      else {
        let out = ' '.repeat(col + w - lst.contentIndent);
        let cc = col + w;
        let j = idx + 1;
        while (j < b.length && (b[j] === ' ' || b[j] === '\t')) {
          if (b[j] === ' ') { out += ' '; cc++; j++; }
          else { const w2 = 4 - (cc % 4); out += ' '.repeat(w2); cc += w2; j++; }
        }
        return out + b.slice(j);
      }
    } else break;
  }
  return b.slice(idx);
}

// Scan stripped item lines for an unclosed fenced code block. A fenced
// code block inside a list item captures every line until its closing
// fence, even lines with less indent than the item's content indent
// (e.g. a `function f(a, b) {` line at column 0 inside a ``` fence).
// Returns the open fence {ch, len} or null.
function openFenceIn(itemLines) {
  let fence = null;
  for (const l of itemLines) {
    const b = body(l);
    if (fence) {
      if (matchFencedClose(b, fence.ch, fence.len)) fence = null;
    } else {
      const fen = matchFencedStart(b);
      if (fen) fence = fen;
    }
  }
  return fence;
}

function parseList(lines, i, end, refs) {
  const first = matchListStart(body(lines[i]));
  const ordered = first.ordered;
  const items = [];
  let loose = false;
  let j = i;
  let lastContentIndent = first.contentIndent;
  while (j < end) {
    // find the next non-blank line; blank lines are only consumed when a
    // new item follows (otherwise parseBlocks must see them, so a blank
    // line after the last item still marks the list/item loose)
    let k = j;
    while (k < end && isBlank(lines[k])) k++;
    if (k >= end) break;
    const b = body(lines[k]);
    const m = matchListStart(b);
    const ind = indentCols(b);
    // a marker is a new item of this list iff same type, indent <= 3 and
    // indent < the previous item's content indent
    if (!m || !sameList(m, first) || ind > 3 || ind >= lastContentIndent) break;
    if (isThematicBreak(b)) break; // e.g. "* * *" ends the list
    if (k > j && items.length > 0) loose = true;
    j = k;
    const contentIndent = m.contentIndent;
    const itemLines = [stripItemMarker(b, m) + (hasNL(lines[j]) ? '\n' : '')];
    j++;
    const fixups = [];
    let res = null;
    const ensureParsed = () => {
      if (!res) { res = parseBlocks(itemLines, 0, itemLines.length, refs, false, true, true); applyLazyFixups(res, fixups); }
      return res;
    };
    while (j < end) {
      const line = lines[j];
      if (isBlank(line)) {
        // a blank line inside an open fence is fence content, whatever
        // its indent (a fence captures lines until its closer)
        if (openFenceIn(itemLines)) {
          itemLines.push(line);
          j++; res = null; continue;
        }
        // an empty item followed by a blank line ends the item
        if (!itemLines.some((l) => !isBlank(l))) break;
        let k = j + 1;
        while (k < end && isBlank(lines[k])) k++;
        if (k < end) {
          const kb = body(lines[k]);
          const km = matchListStart(kb);
          if (km && sameList(km, first) && indentCols(kb) <= 3 && indentCols(kb) < contentIndent) break;
          if (indentCols(kb) >= contentIndent) {
            for (; j < k; j++) itemLines.push(lines[j]);
            res = null;
            continue;
          }
        }
        break;
      }
      const lb = body(line);
      const km = matchListStart(lb);
      // any list marker at indent < content indent ends the item (a
      // different bullet/delimiter starts a new list, not a lazy line)
      if (km && indentCols(lb) < contentIndent) break;
      if (indentCols(lb) >= contentIndent) {
        itemLines.push(stripCols(expandLeadingTabs(lb, 0), contentIndent) + (hasNL(line) ? '\n' : ''));
        j++;
        res = null;
        continue;
      }
      // a line with less indent than the content indent still belongs
      // to the item when it is inside an open fenced code block
      if (openFenceIn(itemLines)) {
        itemLines.push(line);
        j++;
        res = null;
        continue;
      }
      // lazy continuation: extends an open paragraph/table in the item
      if (isLazyCandidate(line, j, lines, end)) {
        const r = ensureParsed();
        if (r.lastNonBlank && deepLastParaTable(r.blocks)) {
          const last = r.blocks[r.blocks.length - 1];
          if (last.t === 'para' || last.t === 'table') {
            // a list item's text is lexed line by line, so a lazy line
            // is always dedented (the indented-code merge)
            const app = lazyAppendBody(lb, contentIndent);
            if (app.fix) fixups.push(app.fix);
            itemLines.push(app.body + (hasNL(line) ? '\n' : ''));
          } else {
            // nested blockquote/list: pass the line down unstripped
            itemLines.push(line);
          }
          j++;
          res = null;
          continue;
        }
      }
      break;
    }
    res = ensureParsed();
    if (res.blankBetween) loose = true;
    items.push(res.blocks);
    lastContentIndent = contentIndent;
  }
  return { block: { t: 'list', ordered, start: ordered ? first.num : null, tight: !loose, items }, next: j };
}

/* --- tables (GFM) --- */

// Split a table row line into cells. A '|' preceded by an ODD number of
// backslashes is an escaped literal pipe; an even number means the pipe
// splits the row. Leading/trailing pipes are dropped (same parity rule).
function splitTableRow(b) {
  let s = b.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    let n = 0;
    for (let k = s.length - 2; k >= 0 && s[k] === '\\'; k--) n++;
    if (n % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') {
      let n = 0;
      while (k + n < s.length && s[k + n] === '\\') n++;
      if (k + n < s.length && s[k + n] === '|') {
        if (n % 2 === 1) { cur += '\\'.repeat(n - 1) + '|'; k += n; continue; }
        cur += '\\'.repeat(n); k += n - 1; continue;
      }
      cur += '\\'.repeat(n); k += n - 1; continue;
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a delimiter row; returns the alignment array or null.
function parseDelimiterRow(b) {
  const cells = splitTableRow(b);
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] === ':' && m[2] === ':' ? 'center' : m[1] === ':' ? 'left' : m[2] === ':' ? 'right' : null);
  }
  return aligns;
}

// Does b1 + b2 match the table regex's header+delimiter pattern (no cell
// count or delimiter-content check — that is what the paragraph lookahead
// uses, so a bare '---' delimiter still stops a paragraph).
function isTableCandidate(b1, b2) {
  if (b1.trim() === '') return false;
  const cells = splitTableRow(b2);
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return false;
  }
  return true;
}

// A table actually starts here: header+delimiter pattern, the delimiter
// row contains ':' or '|' (marked's tableDelimiter), and the cell counts
// match.
function isTableHeader(b1, b2) {
  if (!isTableCandidate(b1, b2)) return false;
  if (!/[:|]/.test(b2)) return false;
  const head = splitTableRow(b1);
  const aligns = parseDelimiterRow(b2);
  return aligns !== null && aligns.length === head.length;
}

// Whitespace-only line that marked's table-body regex still consumes as
// an (empty) row: its blank check is ` *\n` (spaces only — a tab does not
// match), and its indented-code check needs a character after the indent,
// so a line of <=3 spaces + a trailing tab is a row, not a table end.
function isTableBlankRow(b) {
  if (!b) return false;
  let sp = 0;
  while (sp < b.length && b[sp] === ' ') sp++;
  if (sp === b.length) return false; // spaces-only: blank
  if (sp >= 4) return false; // 4-space indent: code
  return sp + 1 === b.length; // tab must be the last character
}

function parseTable(lines, i, end) {
  const head = splitTableRow(body(lines[i]));
  const aligns = parseDelimiterRow(body(lines[i + 1]));
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      if (isTableBlankRow(body(line))) { rows.push(splitTableRow(body(line))); j++; continue; }
      break;
    }
    const b = body(line);
    if (indentCols(b) >= 4) break;
    if (matchATX(b) || matchFencedStart(b) || isThematicBreak(b)) break;
    if (htmlBlockType(b, true) > 0) break;
    if (stripQuote(line) !== null) break;
    const lst = matchListStart(b);
    if (lst && listInterruptsPara(lst, b)) break;
    rows.push(splitTableRow(b));
    j++;
  }
  for (const row of rows) {
    while (row.length < head.length) row.push('');
    if (row.length > head.length) row.length = head.length;
  }
  return { block: { t: 'table', align: aligns, head, rows }, next: j };
}

/* --- paragraph, setext, link-reference definitions --- */

function setextLevel(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  if (i >= b.length) return 0;
  const ch = b[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (j < b.length && b[j] === ch) j++;
  while (j < b.length && (b[j] === ' ' || b[j] === '\t')) j++;
  if (j !== b.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Try to parse a link-reference definition starting at lines[i].
// Returns {label, href, title, next} or null. The label may span lines;
// the destination and title may be on following lines; a definition
// never spans a blank line.
function tryDef(lines, i, end) {
  // join the following non-blank lines into one string to parse
  const parts = [];
  let k = i;
  while (k < end && !isBlank(lines[k]) && parts.length < 50) { parts.push(body(lines[k])); k++; }
  if (parts.length === 0) return null;
  const s = parts.join('\n');
  const lineStart = [0];
  for (let m = 0; m < parts.length; m++) lineStart.push(lineStart[m] + parts[m].length + 1);
  const lineOf = (off) => {
    let m = 0;
    while (m + 1 < lineStart.length && lineStart[m + 1] <= off) m++;
    return m;
  };
  let p = 0;
  while (p < s.length && s[p] === ' ' && p < 3) p++;
  if (s[p] !== '[') return null;
  const lab = parseLabel(s, p);
  if (!lab) return null;
  const label = lab.label;
  if (label === '' || normLabel(label) === '') return null;
  let j = lab.next;
  // ']' must be followed immediately by ':' (no whitespace between)
  if (s[j] !== ':') return null;
  j++;
  // spaces only (no tab) before the destination; it may be on the next
  // line (newline + spaces/tabs)
  while (j < s.length && s[j] === ' ') j++;
  if (j < s.length && s[j] === '\n') {
    j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  }
  if (j >= s.length) return null;
  let dest = '';
  if (s[j] === '<') {
    let m = j + 1;
    while (m < s.length && s[m] !== '\n' && s[m] !== '>') {
      if (s[m] === '\\' && m + 1 < s.length && isAsciiPunct(s.charCodeAt(m + 1))) { dest += s[m + 1]; m += 2; }
      else { dest += s[m]; m++; }
    }
    if (m >= s.length || s[m] !== '>') return null;
    j = m + 1;
  } else {
    let m = j, depth = 0;
    while (m < s.length) {
      const c = s[m];
      if (c === '\\' && m + 1 < s.length && isAsciiPunct(s.charCodeAt(m + 1))) { dest += s[m + 1]; m += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      dest += c; m++;
    }
    if (dest === '' || depth !== 0) return null;
    j = m;
  }
  // optional title (must be preceded by whitespace)
  let title = null;
  let tj = j, sawWs = false;
  while (tj < s.length && (s[tj] === ' ' || s[tj] === '\t')) { tj++; sawWs = true; }
  if (tj < s.length && s[tj] === '\n') {
    tj++;
    while (tj < s.length && (s[tj] === ' ' || s[tj] === '\t')) tj++;
    sawWs = true;
  }
  if (sawWs && tj < s.length && (s[tj] === '"' || s[tj] === "'" || s[tj] === '(')) {
    const q = s[tj];
    const close = q === '(' ? ')' : q;
    let t = '', m = tj + 1, ok = false;
    while (m < s.length) {
      const c = s[m];
      if (c === '\\' && m + 1 < s.length && isAsciiPunct(s.charCodeAt(m + 1))) { t += s[m + 1]; m += 2; continue; }
      if (c === close) { ok = true; break; }
      t += c; m++;
    }
    if (ok) {
      // only whitespace may follow the closing quote on its line
      let e = m + 1;
      while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
      if (e >= s.length || s[e] === '\n') { title = t; j = e; }
    }
  }
  // after dest/title, only spaces may remain, then a newline or the end
  let e = j;
  while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
  if (e < s.length && s[e] !== '\n') return null;
  return { label, href: dest, title, next: i + lineOf(e) + 1 };
}

// True when a setext heading may not form over lines[j..k): some content
// line after the first starts a block construct (marked's lheading content
// restriction). The table pattern here requires a pipe — a bare '---'
// delimiter line does not block.
function setextBlocked(lines, j, k) {
  for (let m = j + 1; m < k; m++) {
    const b = body(lines[m]);
    if (matchATX(b) || matchFencedStart(b) || isThematicBreak(b)) return true;
    if (/^ {0,3}<[^\n>]+>/.test(b)) return true;
    if (stripQuoteText(b) !== null) return true;
    if (indentCols(b) >= 4) return true;
    // a list marker followed by a space (any bullet / any ordered number)
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(b)) return true;
    // a table-delimiter-like line containing a pipe
    if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(b)) return true;
  }
  return false;
}

function parseParagraph(lines, i, end, refs, inner, inList) {
  let j = i;
  // leading link-reference definitions
  while (j < end) {
    const def = tryDef(lines, j, end);
    if (!def) break;
    if (!refs.has(normLabel(def.label))) refs.set(normLabel(def.label), { href: def.href, title: def.title });
    j = def.next;
  }
  if (j >= end || isBlank(lines[j])) return { block: null, next: j };
  const firstB = body(lines[j]);
  // a table may start the paragraph position
  if (j + 1 < end && isTableHeader(firstB, body(lines[j + 1]))) {
    const t = parseTable(lines, j, end);
    return { block: t.block, next: t.next };
  }
  if (startsInterruptBlock(firstB, inList)) return { block: null, next: j };
  const paraLines = [];
  let k = j;
  while (k < end) {
    const b = body(lines[k]);
    if (isBlank(lines[k])) {
      // a whitespace-only line is a continuation only when it is the last
      // line of the range and has no trailing newline (an inner/container
      // range's text has no trailing newline, so its last line qualifies).
      // A truly empty line never counts.
      if (k === end - 1 && paraLines.length > 0 && body(lines[k]) !== '' && (!hasNL(lines[k]) || inner)) {
        paraLines.push(lines[k]);
        k++;
      }
      break;
    }
    if (paraLines.length > 0) {
      const st = setextLevel(b);
      if (st && !setextBlocked(lines, j, k)) {
        // a setext heading's content is the paragraph text trimmed
        const txt = joinParaLines(paraLines).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        return { block: { t: 'head', level: st, text: txt }, next: k + 1 };
      }
      if (k + 1 < end && isTableCandidate(b, body(lines[k + 1]))) {
        // a table header candidate stops the paragraph — unless the
        // delimiter line is a setext underline for the paragraph
        // including this line
        const nb = body(lines[k + 1]);
        if (setextLevel(nb) > 0 && !setextBlocked(lines, j, k + 1)) {
          paraLines.push(lines[k]);
          k++;
          continue;
        }
        break;
      }
      if (startsInterruptBlock(b, inList)) break;
    }
    paraLines.push(lines[k]);
    k++;
  }
  return { block: { t: 'para', text: joinParaLines(paraLines) }, next: k };
}

// True when the line starts a block that interrupts a paragraph.
function startsInterruptBlock(b, inList) {
  if (matchATX(b)) return true;
  if (matchFencedStart(b)) return true;
  if (isThematicBreak(b)) return true;
  if (htmlBlockType(b, true) > 0) return true;
  if (stripQuoteText(b) !== null) return true;
  const lst = matchListStart(b);
  if (lst && listInterruptsPara(lst, b, inList)) return true;
  return false;
}

function stripQuoteText(b) {
  let i = 0;
  while (i < b.length && b[i] === ' ' && i < 3) i++;
  return b[i] === '>' ? b.slice(i + 1) : null;
}

/* ---------------- rendering ---------------- */

function renderBlocks(blocks, refs, tight) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'para': {
        const html = renderParaText(b.text, refs);
        out += tight ? html : '<p>' + html + '</p>\n';
        break;
      }
      case 'head':
        out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
        break;
      case 'code': {
        // code text renders with exactly one trailing '\n' (none when empty)
        const ct = b.text === '' ? '' : (b.text.charCodeAt(b.text.length - 1) === 10 ? b.text.slice(0, -1) : b.text) + '\n';
        out += b.lang !== null
          ? '<pre><code class="language-' + escText(b.lang) + '">' + escFull(ct) + '</code></pre>\n'
          : '<pre><code>' + escFull(ct) + '</code></pre>\n';
        break;
      }
      case 'html':
        out += b.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'quote':
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const item of b.items) out += renderListItem(item, refs, b.tight);
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < b.head.length; c++) {
          out += b.align[c] ? '<th align="' + b.align[c] + '">' + parseInline(b.head[c], refs) + '</th>\n'
            : '<th>' + parseInline(b.head[c], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let c = 0; c < b.head.length; c++) {
              const cell = row[c] !== undefined ? row[c] : '';
              out += b.align[c] ? '<td align="' + b.align[c] + '">' + parseInline(cell, refs) + '</td>\n'
                : '<td>' + parseInline(cell, refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        break;
      }
    }
  }
  return out;
}

// A paragraph inside a tight list item renders as bare inline text (+ \n);
// elsewhere it is wrapped in <p>...</p>. Task-list checkboxes are detected
// on the item's first paragraph here.
function renderParaText(text, refs) {
  return parseInline(text, refs);
}

function renderListItem(item, refs, tight) {
  let out = '<li>';
  if (item.length > 0 && item[0].t === 'para') {
    const m = /^\[( |x|X)\]([ \t]|$)/.exec(item[0].text);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      const rest = item[0].text.slice(3);
      const checkbox = checked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      if (tight) out += checkbox + parseInline(rest, refs);
      else out += '<p>' + checkbox + parseInline(rest, refs) + '</p>\n';
      out += renderBlocks(item.slice(1), refs, tight);
      out += '</li>\n';
      return out;
    }
  }
  out += renderBlocks(item, refs, tight);
  out += '</li>\n';
  return out;
}

/* ---------------- entry point ---------------- */

export function parse(markdown) {
  inLink = false;
  inRawBlock = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = splitLines(src);
  const refs = new Map();
  const { blocks } = parseBlocks(lines, 0, lines.length, refs, false);
  return renderBlocks(blocks, refs, false);
}

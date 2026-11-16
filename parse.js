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

// Normalising a link label: collapse every whitespace run to a single
// space, trim the ends, fold case, and expand the few ligatures / sharp-s
// forms that Unicode case folding maps to plain ASCII letters.
const LABEL_EXPANSIONS = [
  ['ß', 'ss'], ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'],
];
function normLabel(s) {
  let out = s.replace(/[\s]+/g, ' ').trim().toLowerCase();
  for (const [from, to] of LABEL_EXPANSIONS) out = out.split(from).join(to);
  return out;
}

function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Single-character class tests by code point. parseInline sits on these in
// its hottest loops, so they are plain comparisons — no regex per char.
// Email local part: letters, digits, '.', '_', '+', '-'.
function isEmailLocalCode(c) {
  if (c === 46 || c === 95 || c === 43 || c === 45) return true;
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCode(c) {
  if (c >= 97) return c <= 122;
  if (c >= 65) return c <= 90;
  return c >= 48 && c <= 57;
}
function isLetterCode(c) { // [A-Za-z]
  if (c >= 97) return c <= 122;
  return c >= 65 && c <= 90;
}
function isTagNameCode(c) { // [A-Za-z0-9-]
  if (c === 45) return true;
  return isAlnumCode(c);
}
function isAttrNameCode(c) { // [\w.:-] = [A-Za-z0-9_.:-]
  if (c === 95 || c === 46 || c === 58 || c === 45) return true;
  return isAlnumCode(c);
}
function isUnquotedAttrCode(c) { // not [ \t\n"'=<>\`]
  switch (c) {
    case 32: case 9: case 10: case 34: case 39:
    case 61: case 60: case 62: case 96:
      return false;
    default:
      return true;
  }
}
// Characters that always need per-character handling inside parseInline.
const INLINE_SPECIAL = new Uint8Array(128);
for (const code of [10, 33, 38, 42, 60, 91, 92, 93, 95, 96, 126]) INLINE_SPECIAL[code] = 1; // \n ! & * < [ \ ] _ ` ~
// Letters that can begin an extended autolink: www. / scheme / mailto: / xmpp:.
const TRIGGER_LETTER = new Uint8Array(128);
for (const code of [72, 70, 102, 104, 109, 119, 120]) TRIGGER_LETTER[code] = 1; // H F f h m w x
function isTriggerLetterCode(c) {
  return c < 128 && TRIGGER_LETTER[c] === 1;
}
function isSpaceOrTab(c) { return c === ' ' || c === '\t'; }
function isUnicodePunct(ch) {
  // CommonMark punctuation is ASCII punctuation plus the Unicode P and S
  // categories. ASCII input (nearly everything) is decided by the cheap
  // code check alone; the Unicode regex only runs for non-ASCII chars.
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiPunct(code);
  return /[\p{P}\p{S}]/u.test(ch);
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
// marked carries two pieces of inline state across a whole document.
// First, the <a> leak: an opening <a ...> tag met as INLINE html inside a
// paragraph (a lone <a> on its own line forms an HTML block instead and
// does not count) switches off extended autolinks — www., schemes, email —
// for every later inline run, across paragraphs, until an exact </a>
// shows up. Bracket autolinks <...>, bracket emails and inline links are
// unaffected. Second, the raw-text state: while inside <pre>, <code>,
// <kbd> or <script>, character references stay undecoded and text goes out
// verbatim. Both flags reset for each document in parse().
let inLink = false;
let inRawBlock = false;

// Which raw-content tag a tag string is, if any: 'pre' / 'code' / 'kbd' /
// 'script' for an opener, '/pre' etc. for a closer. Counts only when the
// name is followed by whitespace or '>' (marked's start/endPreScriptTag
// rule), so <pre/> and <codex> return null.
function rawBlockTagName(t) {
  let p = 1;
  const closing = t.charCodeAt(p) === 47; // '/'
  if (closing) p++;
  const nameStart = p;
  while (p < t.length) {
    const code = t.charCodeAt(p);
    if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90)) p++;
    else break;
  }
  const name = t.slice(nameStart, p).toLowerCase();
  if (name !== 'pre' && name !== 'code' && name !== 'kbd' && name !== 'script') return null;
  const after = t[p];
  if (after !== '>' && !isWhitespace(after)) return null;
  return closing ? '/' + name : name;
}

function parseInline(text, refs) {
  const nodes = [];
  const delims = [];
  let buf = '';
  // While inRawBlock is on, buffered text is emitted as a raw node (k:9 —
  // rendered verbatim, no entity decoding, no escaping), mirroring
  // marked's inRawBlock text tokens. A flush always lands on a tag edge,
  // so no run ever straddles the raw-block boundary.
  function flush() {
    if (buf === '') return;
    nodes.push(inRawBlock ? { k: 9, s: buf, raw: buf } : buf);
    buf = '';
  }
  const n = text.length;
  let i = 0;

  // Flanking facts for a delimiter run at `pos` of length `len`.
  // punctFn defaults to isUnicodePunct; '~' runs pass a test that treats
  // '~' as neither punctuation nor a word character (GFM strikethrough
  // flanking rule).
  function flanking(pos, len, punctFn) {
    const testPunct = punctFn || isUnicodePunct;
    const before = pos === 0 ? '' : text[pos - 1];
    const after = pos + len >= n ? '' : text[pos + len];
    const beforeWs = before === '' || isWhitespace(before);
    const afterWs = after === '' || isWhitespace(after);
    const beforePunct = before !== '' && testPunct(before);
    const afterPunct = after !== '' && testPunct(after);
    const canOpen = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const canClose = !beforeWs && (!beforePunct || afterWs || afterPunct);
    return [canOpen, canClose, before, after];
  }

  while (i < n) {
    // Plain-text run, taken in one slice instead of a char at a time. A
    // run ends at any special character, at a trigger letter that begins
    // a word (an extended autolink might start there), and at the start
    // of the word before an '@' (an email might start there). Nothing
    // inside a run needs per-character dispatch.
    {
      const first = text.charCodeAt(i);
      const wordStart = !(i > 0 && isEmailLocalCode(text.charCodeAt(i - 1)));
      if (!INLINE_SPECIAL[first] && !(wordStart && isEmailLocalCode(first))) {
        let scan = i + 1;
        let prevIsLocal = isEmailLocalCode(first);
        while (scan < n) {
          const code = text.charCodeAt(scan);
          if (INLINE_SPECIAL[code]) break;
          if (code === 64) { // '@': back up to the start of its word
            let w = scan - 1;
            while (w >= i && isEmailLocalCode(text.charCodeAt(w))) w--;
            if (w + 1 > i) { scan = w + 1; break; }
            // the word began at or before i, so the email check there
            // already ran and this '@' is ordinary text
            prevIsLocal = false; scan++; continue;
          }
          if (!prevIsLocal && isTriggerLetterCode(code)) break;
          prevIsLocal = isEmailLocalCode(code);
          scan++;
        }
        if (scan > i) { buf += text.slice(i, scan); i = scan; }
        continue;
      }
    }
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
        // An escaped '&' is a literal ampersand, never an entity start,
        // so it is pre-escaped and the renderer leaves it alone. Inside
        // a raw block the text goes out verbatim, so every escapable
        // character is pre-escaped here instead.
        if (inRawBlock) {
          buf += nx === '<' ? '&lt;' : nx === '>' ? '&gt;' : nx === '"' ? '&quot;' : nx === "'" ? '&#39;' : nx === '&' ? '&amp;' : nx;
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
      // Hunt for a closing run of exactly `run` backticks — but stop at
      // a ']' that would close a live link opener, because the link
      // pattern eats the backticks as label text first; the code span
      // must not swallow that ']' (a span whose closer really lies past
      // the ']' only forms when the link cannot form at all).
      let scan = i + run, closer = -1, cutShort = false;
      while (scan < n) {
        if (text[scan] === '`') {
          let r2 = 0;
          while (scan + r2 < n && text[scan + r2] === '`') r2++;
          if (r2 === run) { closer = scan; break; }
          scan += r2;
        } else if (text[scan] === ']' && (text[scan + 1] === '(' || text[scan + 1] === '[' || scan + 1 >= n)) {
          if (wouldFormLink(text, scan, delims, refs)) { cutShort = true; break; }
          scan++;
        } else scan++;
      }
      if (closer < 0 || cutShort) { buf += '`'.repeat(run); i += run; continue; }
      let content = text.slice(i + run, closer).replace(/\n/g, ' ');
      // an empty code span stays literal text rather than a code node
      if (content === '') { buf += '`'.repeat(run * 2); i = closer + run; continue; }
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ k: 0, s: content });
      i = closer + run;
      continue;
    }

    // --- '<': autolink <...> or raw HTML ---
    if (ch === '<') {
      const auto = tryBracketAutolink(text, i);
      if (auto) { flush(); nodes.push(auto.node); i = auto.next; continue; }
      const tag = tryHtmlTag(text, i);
      if (tag) {
        flush(); nodes.push({ k: 1, s: tag.text });
        // Update marked's tag state, following its startATag/endATag and
        // start/endPreScriptTag rules: an <a> opens inLink only when a
        // SPACE follows the 'a' (<a>, <a/> and <a\t...> do not; a
        // self-closing <a /> DOES), and only an exact </a> closes it
        // (</a > does not). A <pre>/<code>/<kbd>/<script> opener (name
        // followed by whitespace or '>') switches inRawBlock on, and any
        // of the four closers switches it off again.
        const t = tag.text;
        const second = t[1];
        if (!inLink && t.length >= 3 && (second === 'a' || second === 'A') && t[2] === ' ') inLink = true;
        else if (inLink && t.length === 4 && second === '/' && (t[2] === 'a' || t[2] === 'A') && t[3] === '>') inLink = false;
        const rawName = rawBlockTagName(t);
        if (rawName) {
          const closingTag = rawName[0] === '/';
          if (!closingTag && !inRawBlock) inRawBlock = true;
          else if (closingTag && inRawBlock) inRawBlock = false;
        }
        i = tag.next; continue;
      }
      // a literal '<' is escaped here directly — except inside a raw
      // block, where text goes out verbatim
      buf += inRawBlock ? '<' : '&lt;'; i++; continue;
    }

    // --- '&': numeric character reference (named entities stay literal) ---
    // Inside a raw block references are NOT decoded: the '&' is literal.
    if (ch === '&') {
      const decoded = inRawBlock ? null : decodeNumRefAt(text, i);
      if (decoded) {
        // a decoded '&' is a literal ampersand, never an entity start
        buf += decoded[0] === '&' ? '&amp;' : decoded[0];
        i += decoded[1]; continue;
      }
      buf += '&'; i++; continue;
    }

    // --- emphasis / strikethrough delimiter runs ---
    if (ch === '*' || ch === '_' || ch === '~') {
      let len = 0;
      while (i + len < n && text[i + len] === ch) len++;
      // a '~' run of 3 or more is literal text, never a strikethrough delimiter
      if (ch === '~' && len >= 3) { buf += '~'.repeat(len); i += len; continue; }
      const [canOpen, canClose] = ch === '~'
        ? flanking(i, len, (c) => isUnicodePunct(c) && c !== '~')
        : flanking(i, len);
      let mayOpen, mayClose;
      if (ch === '_') {
        mayOpen = canOpen && (!canClose || (i > 0 && isUnicodePunct(text[i - 1])));
        mayClose = canClose && (!canOpen || (i + len < n && isUnicodePunct(text[i + len])));
      } else {
        mayOpen = canOpen; mayClose = canClose;
      }
      flush();
      const d = { k: 'd', s: ch.repeat(len), ch, n: len, on: len, open: mayOpen, close: mayClose, active: true, link: false, image: false, pos: i };
      nodes.push(d); delims.push(d);
      i += len;
      continue;
    }

    // --- '[' / '![' link openers ---
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const isImage = ch === '!';
      flush();
      const opener = { k: 'd', s: isImage ? '![' : '[', ch: '[', n: 1, open: false, close: false, active: true, link: true, image: isImage, pos: isImage ? i + 1 : i };
      nodes.push(opener); delims.push(opener);
      i += isImage ? 2 : 1;
      continue;
    }

    // --- ']' : try to resolve a link ---
    if (ch === ']') {
      flush();
      const made = tryCloseBracket(text, i, nodes, delims, refs);
      if (made) { i = made.next; continue; }
      // No link formed: when '[label](dest)' still matches marked's
      // blockSkip `link` pattern (label valid under the Ot-masked
      // grammar, balanced-paren destination), the label's delimiters
      // are invisible to the outer emphasis scan — mask them so
      // processEmphasis never pairs them. (A label whose code span
      // holds a backtick fails validLabel, so the link does not form,
      // yet the mask still hides the label: doc-16/doc-20
      // `[at _node `` a ` b ``_](...)`.)
      if (text[i + 1] === '(' && blockSkipDestEnd(text, i + 1) >= 0) {
        for (let d = delims.length - 1; d >= 0; d--) {
          const cand = delims[d];
          if (!cand.link || !cand.active) continue;
          if (!blockSkipLabelOk(text.slice(cand.pos + 1, i))) break;
          for (let m = d + 1; m < delims.length; m++) {
            if (!delims[m].link) delims[m].masked = true;
          }
          break;
        }
      }
      // literal ']': deactivate the nearest active LINK opener (an image
      // opener stays active so an outer image can still form at a later
      // ']' — cm-520; a dead link opener must not keep suppressing the
      // extended autolinks after it, doc-32)
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].link && !delims[k].image && delims[k].active) { delims[k].active = false; break; }
      }
      buf += ']'; i++; continue;
    }

    // --- line ending: soft break, or hard break after 2+ spaces ---
    if (ch === '\n') {
      let trailing = 0;
      for (let k = buf.length - 1; k >= 0 && buf[k] === ' '; k--) trailing++;
      if (trailing >= 2) {
        buf = buf.slice(0, buf.length - trailing);
        flush(); nodes.push(BR); i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        buf += '\n'; i++;
      }
      continue;
    }

    // --- extended autolinks (GFM): www. / scheme:// / email / mailto: / xmpp: ---
    // Matching runs forward from the word start, so a '_' inside an
    // email local part never becomes an emphasis delimiter first
    // (gfm-632). Extended autolinks do not form inside link text, but
    // that is decided when the link forms (unlinkExtAutolinks turns
    // them back into plain text), NOT by scanning the openers here: an
    // UNRESOLVED '[' must not suppress autolinks after it (marked only
    // suppresses them inside a resolved link's text). A raw <a> tag
    // does suppress them (inLink). www. needs a word start: whitespace,
    // '(', '*', '_', '~', or the end of a previous token (an HTML tag,
    // code span, link, ... — after such a token, marked's url tokenizer
    // is tried at the fresh position).
    if (ch === 'w' && !inLink && text.startsWith('www.', i)) {
      const prev = i === 0 ? '' : text[i - 1];
      // a delimiter node (k:'d') is not a token: after '[' the www.
      // must still be rejected (prev is '['); only real tokens count
      const lastNd = nodes.length > 0 ? nodes[nodes.length - 1] : null;
      const afterToken = buf === '' && lastNd !== null && typeof lastNd !== 'string' && lastNd.k !== 'd';
      if (prev === '' || isWhitespace(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~' || afterToken) {
        const hit = matchExtendedAutolink(text, i, 'www', delims);
        if (hit) { flush(); nodes.push(hit.node); i = hit.next; continue; }
      }
    }
    if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && !inLink) {
      const hit = matchExtendedAutolink(text, i, 'scheme', delims);
      if (hit) { flush(); nodes.push(hit.node); i = hit.next; continue; }
    }
    // mailto:/xmpp: (lowercase only) at the start or after a non-alphanumeric
    if ((ch === 'm' || ch === 'x') && !inLink && (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i))) {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || !isAlnumCode(prev.charCodeAt(0))) {
        const hit = matchEmailAt(text, i, delims);
        if (hit) { flush(); nodes.push(hit.node); i = hit.next; continue; }
      }
    }
    // plain email: current char is a local char and the previous one is not
    if (!inLink && isEmailLocalCode(ch.charCodeAt(0))) {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || !isAlnumCode(prev.charCodeAt(0))) {
        const hit = matchEmailAt(text, i, delims);
        if (hit) { flush(); nodes.push(hit.node); i = hit.next; continue; }
      }
    }

    buf += ch; i++;
  }
  flush();
  // Delimiters inside a blockSkip-masked span are invisible to the outer
  // emphasis scan (marked's emStrong mask): the Ot mask pairs a backtick
  // run with a later same-length run and neutralises the backticks
  // between them, then blockSkip swallows the whole span — so a stray
  // backtick in a link label can hide emphasis far past the link
  // (doc-09/doc-28/doc-35). Delimiters eaten by a link that formed are
  // already gone from the stack, so only unformed labels and stray
  // spans are hit here.
  if (delims.length > 0) {
    const spans = blockSkipRanges(text);
    let si = 0;
    for (const delim of delims) {
      if (delim.link || delim.masked) continue;
      while (si < spans.length && spans[si][1] <= delim.pos) si++;
      if (si < spans.length && delim.pos >= spans[si][0] && delim.pos < spans[si][1]) delim.masked = true;
    }
  }
  processEmphasis(nodes, delims, 0, text);
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
      case 8: // pre-escaped text (autolink text)
      case 9: // raw-block text, emitted verbatim
        out += nd.s;
        break;
      case 'd': out += escText(nd.s); break;
    }
  }
  return out;
}

// Strip tags (used for image alt text): render children, drop <...>.
function stripTags(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) { out += html.slice(lt); break; }
    i = gt + 1;
  }
  return out;
}

/* ---------------- emphasis (delimiter stack) ---------------- */

// Marked's emStrong forward scan, walking the delimiter stack from
// opener O the way marked's RDelim patterns classify the runs after it,
// and reporting where the scan stops. Totals use original run lengths
// (on): in marked's left-to-right order the scan runs before any pair
// inside O's range forms, so runs in between count at full length even
// when our closer-first loop already folded them into an inner pair.
// Returns { stop, m, f, b }: stop = stack index where the running total
// m reached <= 0 (-1 when the scan runs out), m = the total after
// subtracting the stop run, f = total length of runs the rule of three
// passed over as mid delimiters, b = original length of the stop run.
// Marked sizes the closer it consumes as min(b, b + m + f), so m and f
// matter to whoever forms the pair.
function markedScan(delims, oi, text) {
  const op = delims[oi];
  const ch = op.ch;
  let total = op.n, skipped = 0;
  const openLen = op.on;
  // R flag (marked emStrong): the opener can open and the char before it
  // is non-whitespace — then a pure closer is also run through the rule
  // of three instead of always closing
  const beforeCh = op.pos > 0 ? text[op.pos - 1] : '';
  const afterCh = op.pos + op.on < text.length ? text[op.pos + op.on] : '';
  const afterIsPunct = afterCh !== '' && isUnicodePunct(afterCh);
  const beforeIsDelim = beforeCh === '*' || beforeCh === '_' || (beforeCh !== '' && isUnicodePunct(beforeCh));
  const useRuleOfThree = beforeCh !== '' && !isWhitespace(beforeCh) && (afterIsPunct || (ch === '*' && !beforeIsDelim));
  for (let k = oi + 1; k < delims.length; k++) {
    const run = delims[k];
    if (run.ch !== ch || run.link || run.masked) continue;
    // a run inside a pair of the opposite char is invisible to this
    // scan (marked's emStrongRDelim skip alternative); a run inside a
    // same-char pair still counts at its original length
    if (run.inPairCh !== undefined && run.inPairCh !== ch) continue;
    if (!run.open && !run.close) continue; // neither-flanking: invisible
    const b = run.on;
    if (run.open && !run.close) { total += b; continue; } // pure opener
    if ((run.open && run.close) || useRuleOfThree) {
      // both-flanking (or R): rule of three decides opener vs closer
      if (openLen % 3 !== 0 && (openLen + b) % 3 === 0) { skipped += b; continue; }
    }
    total -= b;
    if (total > 0) continue;
    return { stop: k, m: total, f: skipped, b };
  }
  return { stop: -1, m: total, f: skipped, b: 0 }; // scan ran out: no pair
}

// Stack index where marked's scan from opener oi stops, or -1.
function markedScanStopIndex(delims, oi, text) {
  const scan = markedScan(delims, oi, text);
  return scan.stop;
}

// True when marked's forward scan from opener oi stops exactly at ci.
function markedScanPairs(delims, oi, ci, text) {
  const stopAt = markedScanStopIndex(delims, oi, text);
  return stopAt === ci;
}

// True when some fresh opener before stack index oi (but at or after
// fromStack) would claim closer ci under marked's opener-first order:
// same char, still able to open at full original length, itself
// eligible against this closer under the rule of three, and its
// forward scan stops exactly at ci. One exception: when the claim
// would spend MORE closer chars than the pair uses on its tags
// (min(on, on + m + f) > use), the surplus lands inside the pair and
// can itself close an inner opener — marked pairs `*foo *bar**` as
// nested ems that way — so the inner candidate must not stand down.
function earlierOpenerClaims(delims, oi, ci, fromStack, text) {
  const closeRun = delims[ci];
  if (closeRun.n !== closeRun.on) return false;
  for (let j = oi - 1; j >= fromStack; j--) {
    const cand = delims[j];
    if (!cand.active || cand.masked || cand.ch !== closeRun.ch || !cand.open) continue;
    if (cand.n !== cand.on) continue; // only a fresh, untouched opener claims
    if ((cand.close || closeRun.open) && ((cand.n + closeRun.n) % 3 === 0) && !(cand.n % 3 === 0 && closeRun.n % 3 === 0)) continue;
    const scan = markedScan(delims, j, text);
    if (scan.stop !== ci) continue;
    const spent = Math.min(closeRun.on, closeRun.on + scan.m + scan.f);
    const pairUse = (cand.n >= 2 && closeRun.n >= 2) ? 2 : 1;
    if (spent <= pairUse) return true;
  }
  return false;
}

// Walk the closers left to right, oldest first, pairing each with the
// nearest earlier opener that can open. fromStack: only delimiters at or
// after this stack index may open or close.
function processEmphasis(nodes, delims, fromStack, text) {
  let ci = fromStack;
  while (ci < delims.length) {
    const closeRun = delims[ci];
    if (!closeRun.active || closeRun.masked || closeRun.ch === '[' || !closeRun.close) { ci++; continue; }
    // nearest preceding opener of the same char that can open
    let oi = -1, opener = null;
    for (let j = ci - 1; j >= fromStack; j--) {
      const cand = delims[j];
      if (cand.masked) continue;
      if (cand.ch !== closeRun.ch || !cand.open || !cand.active) continue;
      // strikethrough openers and closers must have EQUAL lengths
      if (closeRun.ch === '~' && cand.n !== closeRun.n) continue;
      // rule of three: skip unless both counts are multiples of 3
      if ((cand.close || closeRun.open) && ((cand.n + closeRun.n) % 3 === 0) && !(cand.n % 3 === 0 && closeRun.n % 3 === 0)) continue;
      // marked's emStrong scan, single-char openers only: a lone `*`
      // or `_` opener pairs with this closer only when marked's
      // forward scan stops here. (Multi-char openers stay on the
      // older logic: a failed full-length scan is retried by marked
      // as a shorter run, so the scan must not reject them — that
      // retry is what forms cm-408/413/442/444/445.)
      if (closeRun.ch !== '~' && cand.n === 1 && cand.on === 1 && !markedScanPairs(delims, j, ci, text)) continue;
      // Don't let a single-char closer steal chars from a TWO-char
      // opener when that opener pairs with a later multi-char closer
      // at full length: the strong forms first in marked, and the
      // single closer is then literal inside it (doc-01/11/26).
      // (An opener with 3+ chars can spare one: the single closer
      // pairs first and the leftover still forms the strong — cm-430
      // `***foo* bar**` — so the block is only for n === 2.)
      if (closeRun.ch !== '~' && closeRun.n === 1 && cand.n === 2) {
        const stop = markedScanStopIndex(delims, j, text);
        if (stop > ci && delims[stop].n >= 2) continue;
      }
      // Opener priority, marked style: marked's tokenizer works
      // opener-first, so when an EARLIER fresh opener's forward scan
      // stops exactly at this closer, that opener claims the closer
      // and this candidate must stand down — even when this
      // candidate's own scan would also stop here. Without this, a
      // lone inner `*` steals the closing `**` of a strong that
      // marked forms around it (`**a *b **c**d* e**` keeps its
      // inner `*`s literal and closes with the final `**`).
      if (closeRun.ch !== '~' && earlierOpenerClaims(delims, j, ci, fromStack, text)) continue;
      oi = j; opener = cand; break;
    }
    if (!opener) { ci++; continue; }
    const take = (opener.n >= 2 && closeRun.n >= 2) ? 2 : 1;
    // Marked closer accounting: when marked's forward scan from this
    // opener stops at this closer, the closer chars it consumes are
    // min(on, on + m + f) — runs the rule of three skipped as mids
    // (total f) let the closer contribute MORE chars than the pair
    // spends on its tags, and marked renders the surplus INSIDE the
    // pair, at the end of its content. Example: in
    // `**by command *tool*one***` the scan skips the `*` after "tool"
    // as a mid, so all three closing chars are consumed and one
    // stays inside the strong. Apply only when both runs are still
    // untouched and the opener spends its whole run on the pair, so
    // the surplus can only land inside, never before the opener.
    let eat = take, tailText = '';
    if (closeRun.ch !== '~' && opener.n === opener.on && closeRun.n === closeRun.on && opener.on === take) {
      // The scan can only enlarge the closer's contribution when a
      // rule-of-three mid skip is possible between the pair: a
      // both-flanking run of the same char in between, or the R flag
      // (which runs even pure closers through the rule of three).
      // Skip the scan entirely when neither can occur.
      let midExists = false;
      const charBefore = opener.pos > 0 ? text[opener.pos - 1] : '';
      const charAfter = opener.pos + opener.on < text.length ? text[opener.pos + opener.on] : '';
      if (charBefore !== '' && !isWhitespace(charBefore) &&
          ((charAfter !== '' && isUnicodePunct(charAfter)) ||
           (closeRun.ch === '*' && charBefore !== '*' && charBefore !== '_' && !isUnicodePunct(charBefore)))) {
        midExists = true;
      }
      for (let k = oi + 1; !midExists && k < ci; k++) {
        const run = delims[k];
        if (run.ch === closeRun.ch && run.open && run.close && !run.masked && !run.link &&
            !(run.inPairCh !== undefined && run.inPairCh !== closeRun.ch)) midExists = true;
      }
      if (midExists) {
        const scan = markedScan(delims, oi, text);
        if (scan.stop === ci) {
          const spent = Math.min(closeRun.on, closeRun.on + scan.m + scan.f);
          if (spent > take) { eat = spent; tailText = closeRun.ch.repeat(spent - take); }
        }
      }
    }
    const tag = closeRun.ch === '~' ? 5 : (take === 2 ? 4 : 3);
    const ai = nodes.indexOf(opener), aj = nodes.indexOf(closeRun);
    const children = nodes.slice(ai + 1, aj);
    if (tailText !== '') children.push(tailText);
    const wrap = { k: tag, c: children };
    opener.s = opener.s.slice(0, opener.s.length - take); opener.n -= take;
    closeRun.s = closeRun.s.slice(eat); closeRun.n -= eat;
    if (opener.n === 0) opener.active = false;
    if (closeRun.n === 0) closeRun.active = false;
    nodes.splice(ai + 1, aj - ai - 1, wrap);
    // delimiters between opener and closer are now inside the wrap
    const oiPos = delims.indexOf(opener), ciPos = delims.indexOf(closeRun);
    // keep the delimiters between opener and closer in the stack
    // (marked inactive) so a later outer opener's marked-scan can
    // still see them with their original lengths — splicing them out
    // would make the scan undercount and pair runs marked leaves
    // literal. Record the innermost pair's char: a run inside a pair
    // of the OPPOSITE char is invisible to the outer scan (marked's
    // emStrongRDelim skip alternative jumps over __...*...__ spans),
    // while a run inside a same-char pair still counts.
    for (let k = oiPos + 1; k < ciPos; k++) {
      if (delims[k].inPairCh === undefined) delims[k].inPairCh = closeRun.ch;
      delims[k].active = false;
    }
    ci = ciPos;
    if (closeRun.n === 0) ci++;
    // (a closer with remaining delims is re-processed against earlier openers)
  }
}

/* ---------------- link resolution ---------------- */

// Read an inline link destination plus an optional title starting at `i`
// (which must be '('). Returns {dest, title, next} or null.
function parseInlineLink(text, i) {
  const n = text.length;
  if (text[i] !== '(') return null;
  const skipWs = (p) => {
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
    return p;
  };
  let p = skipWs(i + 1);
  if (p >= n) return null;
  let dest = '';
  if (text[p] === '<') {
    let q = p + 1;
    while (q < n && text[q] !== '\n' && text[q] !== '>') {
      if (text[q] === '\\' && q + 1 < n && isAsciiPunct(text.charCodeAt(q + 1))) { dest += text[q + 1]; q += 2; }
      else { dest += text[q]; q++; }
    }
    if (q >= n || text[q] !== '>') return null;
    p = q + 1;
  } else {
    let depth = 0;
    while (p < n) {
      const c = text[p];
      if (c === '\\' && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { dest += text[p + 1]; p += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      dest += c; p++;
    }
  }
  // optional whitespace, optional title, optional whitespace, ')'
  // (a title must be preceded by whitespace — otherwise, e.g. after an
  // angle-bracket destination, the quote belongs to the destination)
  let q = skipWs(p);
  let title = null;
  if (q < n && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
    if (q === p) return null; // no whitespace before the title
    const quote = text[q];
    const close = quote === '(' ? ')' : quote;
    let titleText = '', r = q + 1, ok = false;
    while (r < n) {
      const c = text[r];
      if (c === '\\' && r + 1 < n && isAsciiPunct(text.charCodeAt(r + 1))) { titleText += text[r + 1]; r += 2; continue; }
      if (c === close) { ok = true; break; }
      if (c === '\n') {
        // a newline inside a title is allowed only when the same line also
        // has content after it is closed later; keep it verbatim
        titleText += '\n'; r++; continue;
      }
      titleText += c; r++;
    }
    if (!ok) return null;
    title = titleText;
    q = skipWs(r + 1);
  }
  if (q >= n || text[q] !== ')') return null;
  return { dest, title, next: q + 1 };
}

// Read a bracketed label starting at `i` ('['). Returns {label, next} or
// null. Labels do not nest (an unescaped '[' inside is invalid) and end
// at the first unescaped ']'; backslashes stay verbatim in the label.
// A newline is allowed unless followed by a blank line.
function parseLabel(text, i) {
  const n = text.length;
  if (text[i] !== '[') return null;
  let p = i + 1, label = '';
  while (p < n) {
    const c = text[p];
    if (c === '\\' && p + 1 < n) { label += c + text[p + 1]; p += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label, next: p + 1 };
    if (c === '\n') {
      let q = p + 1;
      while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
      if (q < n && text[q] === '\n') return null;
      label += '\n'; p++;
      continue;
    }
    label += c; p++;
  }
  return null;
}

// True when the children hold a bracket-formed link anywhere inside.
// Autolinks do not count: a bracket autolink <...> may appear inside
// link text, and an extended autolink is unlinked below when the outer
// link forms.
function containsLink(children) {
  for (let idx = 0; idx < children.length; idx++) {
    const node = children[idx];
    if (typeof node === 'string' || node.k === undefined) continue;
    if (node.k === 6 && !node.auto) return true;
    if (node.k >= 3 && node.k <= 6 && node.c && containsLink(node.c)) return true;
  }
  return false;
}

// Extended autolinks (www./scheme://email) do not form inside link
// text. The inline parser meets them before it knows a link is forming,
// so when a link does form, turn any extended autolink in its children
// back into plain text (bracket autolinks <...> stay links).
function unlinkExtAutolinks(children) {
  const out = [];
  for (const node of children) {
    if (typeof node === 'string') { out.push(node); continue; }
    if (node.k === 6 && node.auto === 'ext') {
      let raw = '';
      for (const part of node.c) {
        if (typeof part === 'string') raw += part;
        else if (part.raw !== undefined) raw += part.raw;
        else raw += part.s;
      }
      out.push(raw);
      continue;
    }
    if ((node.k === 3 || node.k === 4 || node.k === 5 || node.k === 6) && node.c) {
      out.push({ ...node, c: unlinkExtAutolinks(node.c) });
      continue;
    }
    out.push(node);
  }
  return out;
}

// Plain text of inline children, for image alt text: inner images
// contribute their alt, links contribute their text, raw HTML and hard
// breaks contribute nothing, code contributes its text.
function altTextOf(children) {
  let text = '';
  for (const node of children) {
    if (typeof node === 'string') { text += node; continue; }
    switch (node.k) {
      case 0: text += node.s; break;
      case 1: case 2: break; // raw HTML / hard break: nothing
      case 8: text += node.raw !== undefined ? node.raw : node.s; break;
      case 9: text += node.s; break;
      case 'd': text += node.s; break;
      case 3: case 4: case 5: case 6: text += altTextOf(node.c); break;
      case 7: text += node.alt; break;
    }
  }
  return text;
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
  let p = 0;
  while (p < n) {
    const c = raw[p];
    if (c === '[') {
      const after = matchLabelBracket(raw, p);
      if (after < 0) return false;
      p = after;
    } else if (c === '\\') {
      if (p + 1 >= n) return false;
      p += 2;
    } else if (c === '`') {
      // a run of 2+ backticks reaching the end of the label
      let q = p;
      while (q < n && raw[q] === '`') q++;
      if (q === n && q - p >= 2) return true;
      const after = matchLabelCodeSpan(raw, p);
      if (after < 0) return false;
      p = after;
    } else if (c === ']') {
      return false;
    } else {
      p++;
    }
  }
  return true;
}

// Nested bracket group: '[' + (inner bracket | escaped char |
// non-bracket char)* + ']'. Returns the index after ']' or -1.
function matchLabelBracket(s, pos) {
  let q = pos + 1;
  while (q < s.length) {
    const c = s[q];
    if (c === '[') {
      const afterInner = matchLabelBracketLe(s, q);
      if (afterInner < 0) return -1;
      q = afterInner;
    } else if (c === '\\') {
      if (q + 1 >= s.length) return -1;
      q += 2;
    } else if (c === ']') {
      return q + 1;
    } else {
      q++;
    }
  }
  return -1;
}

// One-level bracket group (marked's `brackets`): '[' + (escaped char |
// non-bracket char)* + ']'. Returns the index after ']' or -1.
function matchLabelBracketLe(s, pos) {
  let q = pos + 1;
  while (q < s.length) {
    const c = s[q];
    if (c === '\\') {
      if (q + 1 >= s.length) return -1;
      q += 2;
    } else if (c === ']') {
      return q + 1;
    } else if (c === '[') {
      return -1;
    } else {
      q++;
    }
  }
  return -1;
}

// Code-span chunk: a maximal backtick run, then non-backtick chars, then
// the first backtick run after it (also maximal). Returns the index after
// the closing run, or -1 when there is no closing run.
function matchLabelCodeSpan(s, pos) {
  const n = s.length;
  let op = pos;
  while (op < n && s[op] === '`') op++;
  let mid = op;
  while (mid < n && s[mid] !== '`') mid++;
  if (mid >= n) return -1;
  let cl = mid;
  while (cl < n && s[cl] === '`') cl++;
  return cl;
}

// Ot code span (marked's anyPunctuationOutsideCode code-span alternative):
// an opening backtick run, content that starts and ends with a
// non-backtick character (it may hold shorter backtick runs inside —
// those are what the Ot mask replaces with '+'), and a closing run of
// the same length not followed by another backtick. Returns the index
// after the closing run, or -1. This is the code-span grammar the
// blockSkip mask sees, after the Ot mask has neutralised the inner
// backticks.
function matchOtCodeSpan(s, pos) {
  const n = s.length;
  let op = pos;
  while (op < n && s[op] === '`') op++;
  const len = op - pos;
  if (len === 0 || op >= n || s[op] === '`') return -1;
  let q = op;
  while (q < n) {
    if (s[q] !== '`') { q++; continue; }
    let runEnd = q;
    while (runEnd < n && s[runEnd] === '`') runEnd++;
    if (runEnd - q === len) return runEnd;
    q = runEnd;
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
  let p = 0;
  while (p < n) {
    const c = raw[p];
    if (c === '[' || c === ']') return false;
    if (c === '\\') { if (p + 1 >= n) return false; p += 2; continue; }
    if (c === '`') {
      const after = matchOtCodeSpan(raw, p);
      if (after < 0) return false;
      p = after;
      continue;
    }
    p++;
  }
  return true;
}

// Balanced-paren destination after ']( ' (marked's blockSkip `link`
// dest: one nesting level). text[p] must be '('. Returns the index
// after the closing ')' or -1.
function blockSkipDestEnd(text, p) {
  const n = text.length;
  let q = p + 1, depth = 0;
  while (q < n) {
    const c = text[q];
    if (c === '\\') { q += 2; continue; }
    if (c === '(') { if (depth > 0) return -1; depth++; q++; continue; }
    if (c === ')') {
      if (depth === 0) return q + 1;
      depth--; q++; continue;
    }
    q++;
  }
  return -1;
}

// The Ot mask (marked's anyPunctuationOutsideCode), length-preserving:
// a code span keeps its delimiter backticks but has the backticks inside
// its content replaced with '+'; a backslash-escaped punctuation
// character is replaced with '++'. Positions in the result match the
// original text, so the blockSkip scan below can run on it directly.
function otMaskedText(text) {
  // Fast path: the Ot mask only changes backslash-escaped punctuation
  // and backticks inside code spans. With neither present it is the
  // identity — skip the split/join entirely.
  if (!text.includes('`') && !text.includes('\\')) return text;
  const out = text.split('');
  const n = out.length;
  let p = 0;
  while (p < n) {
    if (text[p] === '\\' && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) {
      out[p] = '+'; out[p + 1] = '+'; p += 2; continue;
    }
    if (text[p] === '`') {
      const end = matchOtCodeSpan(text, p);
      if (end >= 0) {
        let op = p;
        while (op < n && text[op] === '`') op++;
        const len = op - p;
        for (let q = op; q < end - len; q++) if (out[q] === '`') out[q] = '+';
        p = end; continue;
      }
      let q = p;
      while (q < n && text[q] === '`') q++;
      p = q; continue;
    }
    p++;
  }
  return out.join('');
}

// A blockSkip code-span chunk on the masked text: a maximal backtick run,
// non-backtick content, and a closing run of the same length (not
// followed by another backtick — the run is maximal, so that is
// automatic). Returns the index after the closing run, or -1.
function matchBlockSkipCodeSpan(s, pos) {
  const n = s.length;
  let op = pos;
  while (op < n && s[op] === '`') op++;
  const len = op - pos;
  if (len === 0) return -1;
  let q = op;
  while (q < n && s[q] !== '`') q++;
  if (q === op || q >= n) return -1;
  let runEnd = q;
  while (runEnd < n && s[runEnd] === '`') runEnd++;
  if (runEnd - q !== len) return -1;
  return runEnd;
}

// A blockSkip `link` match starting at `pos` (s[pos] === '[') on the
// masked text: '[' + label + '](' + dest + ')'. The label holds no '['
// or ']' (the class is [^\[\]]) — a ']' that is not followed by '(' and
// a valid destination rejects the whole match. Returns the index after
// the closing ')' or -1.
function matchBlockSkipLink(s, pos) {
  const n = s.length;
  let q = pos + 1;
  while (q < n) {
    if (s[q] === '\\') { q += 2; continue; }
    if (s[q] === '`') {
      const after = matchBlockSkipCodeSpan(s, q);
      if (after < 0) return -1;
      q = after; continue;
    }
    if (s[q] === '[' || s[q] === ']') {
      if (s[q] === ']' && s[q + 1] === '(') {
        const afterDest = blockSkipDestEnd(s, q + 1);
        if (afterDest >= 0) return afterDest;
      }
      return -1;
    }
    q++;
  }
  return -1;
}

// Ranges of the text that marked's emStrong mask replaces (blockSkip:
// `[label](dest)` links, code spans, HTML tags) — computed on the
// Ot-masked text, so the ranges are positions in the original text.
// Delimiters inside these ranges are invisible to the outer emphasis
// scan (they are re-lexed only inside a link that actually forms).
function blockSkipRanges(text) {
  const masked = otMaskedText(text);
  const n = masked.length;
  const spans = [];
  let p = 0;
  while (p < n) {
    const c = masked[p];
    if (c === '[') {
      const after = matchBlockSkipLink(masked, p);
      if (after >= 0) { spans.push([p, after]); p = after; continue; }
      p++; continue;
    }
    if (c === '`') {
      if (p > 0 && masked[p - 1] === '`') { p++; continue; }
      const after = matchBlockSkipCodeSpan(masked, p);
      if (after >= 0) { spans.push([p, after]); p = after; continue; }
      p++; continue;
    }
    if (c === '<') {
      if (masked[p + 1] !== ' ') {
        let q = p + 1;
        while (q < n && masked[q] !== '>' && masked[q] !== '<') q++;
        if (q < n && masked[q] === '>') { spans.push([p, q + 1]); p = q + 1; continue; }
      }
      p++; continue;
    }
    if (c === '\\') { p += 2; continue; }
    p++;
  }
  return spans;
}

// marked's Be(): true when the label (raw text between `start` and `end`
// in `text`) contains a '<' that starts an HTML tag or autolink
// extending past the end of the label. Such a label rejects the link
// outright (inline, reference, and shortcut alike). A '<' inside a code
// span does not count, and a tag/autolink fully inside the label is
// skipped.
function labelHasRunawayTag(text, start, end) {
  const raw = text.slice(start, end);
  if (!raw.includes('<')) return false;
  for (let q = 0; q < raw.length; q++) {
    if (raw[q] === '\\') { q++; continue; }
    if (raw[q] === '`') {
      const after = matchLabelCodeSpan(raw, q);
      if (after >= 0) { q = after - 1; continue; }
    }
    if (raw[q] !== '<') continue;
    const at = start + q;
    const tagHit = tryHtmlTag(text, at);
    const autoHit = tagHit ? null : tryBracketAutolink(text, at);
    const spanLen = tagHit ? tagHit.next - at : autoHit ? autoHit.next - at : 0;
    if (spanLen > 0) {
      if (spanLen > end - at) return true;
      q += spanLen - 1;
    }
  }
  return false;
}

// Would a link form at the ']' at position `j`? Mirrors
// tryCloseBracketOpener's decision without mutating anything: the
// nearest active opener, bracket balance, a valid label, and a
// resolvable destination/reference. Used to stop a code span from
// swallowing the ']' (the link regex consumes the backticks as a label
// chunk first).
function wouldFormLink(text, j, delims, refs) {
  let opener = null;
  for (let d = delims.length - 1; d >= 0; d--) {
    if (delims[d].link && delims[d].active) { opener = delims[d]; break; }
  }
  if (!opener) return false;
  // bracket balance in the raw text between the opener and this ']':
  // count unescaped occurrences of one bracket char at a time
  const countUnescaped = (ch) => {
    let total = 0;
    for (let k = opener.pos + 1; k < j; k++) {
      if (text[k] !== ch) continue;
      let slashes = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) slashes++;
      if (slashes % 2 === 0) total++;
    }
    return total;
  };
  if (countUnescaped('[') !== countUnescaped(']')) return false;
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
  for (let d = delims.length - 1; d >= 0; d--) {
    if (!delims[d].link || !delims[d].active) continue;
    const opener = delims[d];
    const ai = nodes.indexOf(opener);
    // the ']' only closes the opener when the brackets balance: every
    // unmatched '[' inside must be matched by a literal ']' inside, so
    // a ']' that sits inside a nested bracket pair does not close the
    // outer one (cm-520: the middle ']' of ![[[foo](uri1)](uri2)](uri3)
    // fails, the last one forms the image with alt '[foo](uri2)')
    let open = 0, close = 0;
    for (let k = ai + 1; k < nodes.length; k++) {
      const node = nodes[k];
      if (typeof node === 'string') {
        for (let q = 0; q < node.length; q++) if (node[q] === ']') close++;
      } else if (node.k === 'd' && node.link) {
        open++;
      }
    }
    // a ']' produced by a backslash escape (\]) lands in a string node
    // but is NOT a bracket, so it must not count as a close (cm-194:
    // [Foo*bar\]] has one escaped ']' in its label)
    for (let k = opener.pos + 1; k < i; k++) {
      if (text[k] !== ']') continue;
      let slashes = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) slashes++;
      if (slashes % 2 === 1) close--;
    }
    if (open !== close) continue;
    // a link may not contain another link (an image may contain one)
    if (!opener.image && containsLink(nodes.slice(ai + 1))) continue;
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
  const ai = nodes.indexOf(opener);
  const rawLabel = text.slice(opener.pos + 1, i);
  if (labelHasRunawayTag(text, opener.pos + 1, i)) return null;
  let dest = null, title = null, next = i + 1;
  if (text[i + 1] === '(') {
    const parsed = parseInlineLink(text, i + 1);
    if (parsed && validLabel(rawLabel)) {
      dest = parsed.dest; title = parsed.title; next = parsed.next;
    } else {
      // an inline link that fails falls back to a shortcut reference
      const key = normLabel(rawLabel);
      const ref = refs.get(key);
      if (!ref) return null;
      dest = ref.href; title = ref.title;
    }
  } else if (text[i + 1] === '[') {
    if (!validLabel(rawLabel)) return null;
    const labelRef = parseLabel(text, i + 1);
    if (!labelRef) return null;
    const refLabel = labelRef.label === '' ? null : labelRef.label;
    // a collapsed reference [] uses the link text as its label — the RAW
    // source text (backslashes kept), not the resolved inline text
    const key = normLabel(refLabel === null ? rawLabel : refLabel);
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.href; title = ref.title; next = labelRef.next;
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
  processEmphasis(nodes, delims, delims.indexOf(opener) + 1, text);
  const ai2 = nodes.indexOf(opener);
  let children = nodes.slice(ai2 + 1);
  // extended autolinks do not form inside link text
  if (!opener.image) children = unlinkExtAutolinks(children);
  let node;
  if (opener.image) {
    const alt = altTextOf(children);
    node = { k: 7, src: escText(href), title: title === null ? null : escText(title), alt: escText(alt) };
  } else {
    node = { k: 6, href: escText(href), title: title === null ? null : escText(title), c: children };
  }
  nodes.splice(ai2, nodes.length - ai2, node);
  // remove opener and everything after it from the delimiter stack
  const oiPos = delims.indexOf(opener);
  delims.splice(oiPos);
  if (!opener.image) {
    // links cannot nest: deactivate earlier LINK openers (image openers
    // stay active so an outer image can still form)
    for (const cand of delims) if (cand.link && !cand.image) cand.active = false;
  }
  return { next };
}

// Raw text of the link text between `opener` and the end of `nodes`
// (numeric refs decoded, escapes resolved — used for reference labels).
function nodesTextBetween(nodes, opener) {
  const ai = nodes.indexOf(opener);
  let s = '';
  for (let k = ai + 1; k < nodes.length; k++) {
    const node = nodes[k];
    if (typeof node === 'string') { s += node; continue; }
    switch (node.k) {
      case 0: case 1: s += node.s; break;
      case 8: s += node.raw !== undefined ? node.raw : node.s; break;
      case 'd': s += node.s; break;
      case 3: case 4: case 5: case 6: s += nodesTextOf(node.c); break;
      case 7: s += node.alt; break;
    }
  }
  return s;
}
function nodesTextOf(children) {
  let s = '';
  for (const node of children) {
    if (typeof node === 'string') { s += node; continue; }
    switch (node.k) {
      case 0: case 1: s += node.s; break;
      case 8: s += node.raw !== undefined ? node.raw : node.s; break;
      case 9: s += node.s; break;
      case 'd': s += node.s; break;
      case 3: case 4: case 5: case 6: s += nodesTextOf(node.c); break;
      case 7: s += node.alt; break;
    }
  }
  return s;
}

/* ---------------- autolinks ---------------- */

// Bracketed autolink <scheme:...> or <email>; returns {node, next} or null.
function tryBracketAutolink(text, i) {
  const n = text.length;
  let p = i + 1;
  let inner = '';
  while (p < n && text[p] !== '>' && text[p] !== ' ' && text[p] !== '\n' && text[p] !== '<') {
    inner += text[p]; p++;
  }
  if (p >= n || text[p] !== '>') return null;
  // scheme autolink: scheme 2..32 chars, first letter, then : and anything
  const schemeHit = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(inner);
  if (schemeHit) {
    const href = cleanUrl(inner);
    if (href === null) return null;
    return { node: { k: 6, auto: 'bracket', href: escFull(href), title: null, c: [{ k: 8, s: escFull(inner), raw: inner }] }, next: p + 1 };
  }
  // email autolink
  const emailHit = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.exec(inner);
  if (emailHit) {
    return { node: { k: 6, auto: 'bracket', href: 'mailto:' + escFull(inner), title: null, c: [{ k: 8, s: escFull(inner), raw: inner }] }, next: p + 1 };
  }
  return null;
}

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const EMAIL_DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;

// Extended email autolink, matched FORWARD from position `i` — the start
// of the local part, or of a lowercase 'mailto:'/'xmpp:' protocol.
// Local [A-Za-z0-9._+-]+, '@', domain [a-zA-Z0-9-_]+
// (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+ with a (?![\w-]) lookahead, so a
// trailing '-' or '_' kills the match (gfm-632) and a trailing '.' is
// left as literal text. xmpp: takes one optional /segment of
// [A-Za-z0-9@.]+ (gfm-634/635). Returns {node, next} or null.
// (Hand-scanned, no text.slice on the hot path: this runs at every word
// start.) `delims` is the live delimiter stack: marked tokenizes
// emphasis BEFORE autolinks, so an email inside _..._ / __...__ is
// matched as if the closing '_' run were not there. When a domain
// segment (or the email itself) ends in a '_' run and the nearest '_'
// delimiter is an unmatched opener, that run is treated as the emphasis
// closer, not as part of the email — but only when the run is
// right-flanking (followed by the end, whitespace, or punctuation), so
// a '_' run followed by a word char (which would be an opener, not a
// closer) still kills the match.
function matchEmailAt(text, i, delims) {
  const n = text.length;
  let scheme = null, p = i;
  if (text.startsWith('mailto:', i)) { scheme = 'mailto:'; p = i + 7; }
  else if (text.startsWith('xmpp:', i)) { scheme = 'xmpp:'; p = i + 5; }
  // local part: [A-Za-z0-9._+-]+
  const localStart = p;
  while (p < n && isEmailLocal(text[p])) p++;
  if (p === localStart) return null;
  const local = text.slice(localStart, p);
  if (text[p] !== '@') return null;
  // domain: [a-zA-Z0-9-_]+ (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+
  let q = p + 1;
  const domainStart = q;
  while (q < n && isDomainChar(text[q])) q++;
  if (q === domainStart) return null;
  let domainEnd = q, hasDot = false;
  // lazily computed (only when a trailing '_' run is actually met):
  // is the nearest '_' delimiter an unmatched opener?
  let usOpen = null;
  const nearestUsOpener = () => {
    if (usOpen === null) {
      usOpen = false;
      if (delims) for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '_') { usOpen = delims[d].open && delims[d].active; break; }
      }
    }
    return usOpen;
  };
  // is the '_' run starting at `p` a plausible emphasis closer? The char
  // before it is a domain char (alnum), so right-flanking is decided by
  // the char after the run alone.
  const usRunCloses = (p) => {
    let q = p;
    while (q < n && text[q] === '_') q++;
    const after = q >= n ? '' : text[q];
    return after === '' || isWhitespace(after) || isUnicodePunct(after);
  };
  while (q < n && text[q] === '.') {
    let r = q + 1;
    while (r < n && isDomainChar(text[r])) r++;
    // the segment after the dot must end in an alphanumeric — unless it
    // ends in a '_' run that closes an unmatched '_' opener, in which
    // case the run belongs to the emphasis, not the domain
    if (r > q + 1 && !isAlnum(text[r - 1])) {
      let back = r;
      while (back > q + 1 && text[back - 1] === '_') back--;
      if (back > q + 1 && isAlnum(text[back - 1]) && nearestUsOpener() && usRunCloses(back)) r = back;
      else break;
    }
    if (r === q + 1 || !isAlnum(text[r - 1])) break;
    domainEnd = r; q = r; hasDot = true;
  }
  if (!hasDot) return null;
  const domain = text.slice(domainStart, domainEnd);
  const nextCh = text[domainEnd];
  // the (?![\w-]) lookahead: a trailing alnum or '-' kills the match; a
  // trailing '_' kills it too — unless that '_' run closes an unmatched
  // '_' opener (the email sits inside emphasis)
  if (nextCh !== undefined && (isAlnum(nextCh) || nextCh === '-' || (nextCh === '_' && !(nearestUsOpener() && usRunCloses(domainEnd))))) return null;
  const email = local + '@' + domain;
  let full = (scheme || '') + email;
  let next = domainEnd;
  if (scheme === 'xmpp:' && text[next] === '/') {
    let r = next + 1;
    while (r < n && (isAlnum(text[r]) || text[r] === '@' || text[r] === '.')) r++;
    if (r > next + 1) { full += text.slice(next, r); next = r; }
  }
  const href = scheme === 'xmpp:' ? escText(full) : 'mailto:' + escText(email);
  return { node: { k: 6, auto: 'ext', href, title: null, c: [{ k: 8, s: escFull(full), raw: full }] }, next };
}

function isEmailLocal(c) {
  return c === '.' || c === '_' || c === '+' || c === '-' ||
    (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}
function isDomainChar(c) {
  return c === '-' || c === '_' ||
    (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}
function isAlnum(c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
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
    let cut = 0;
    const n = s.length;
    while (cut < n) {
      const c = s[cut];
      if (!BACKPEDAL_A_STOP.includes(c)) {
        while (cut < n && !BACKPEDAL_A_STOP.includes(s[cut])) cut++;
      } else if (c === '(') {
        let q = cut + 1;
        while (q < n && s[q] !== ')') q++;
        if (q < n) cut = q + 1;
        else break;
      } else if (c === '&') {
        let q = cut + 1;
        while (q < n && isAlnum(s[q])) q++;
        if (q > cut + 1 && q < n && s[q] === ';' && q + 1 === n) break;
        cut++;
      } else if (BACKPEDAL_D_SET.includes(c)) {
        let q = cut;
        while (q < n && BACKPEDAL_D_SET.includes(s[q])) q++;
        if (q < n) cut = q;
        else break;
      } else break;
    }
    if (cut === n) return s;
    s = s.slice(0, cut);
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
  let p = i;
  while (p < n && text[p] !== ' ' && text[p] !== '\t' && text[p] !== '\n' && text[p] !== '<') {
    if (text[p] === ']' && delims) {
      const nextCh = text[p + 1];
      if (nextCh === '(' || nextCh === '[' || nextCh === undefined || nextCh === ' ' || nextCh === '\t' || nextCh === '\n') {
        let closesLink = false;
        if (nextCh === '(' || nextCh === '[') {
          closesLink = delims.some((d) => d.link && d.active);
        } else {
          // only whitespace to the end of the text
          let q = p + 1;
          while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) q++;
          closesLink = q >= n && delims.some((d) => d.link && d.active);
        }
        if (closesLink) break;
      }
    }
    p++;
  }
  let url = backpedalUrl(text.slice(i, p));
  if (url === '') return null;
  // minimal validity: www. needs something after the dot; scheme needs the ://
  if (kind === 'www' && url.length <= 4) return null;
  const href = cleanUrl(prefix + url);
  if (href === null) return null;
  // the href is fully escaped (an '&amp;' in the URL becomes '&amp;amp;'
  // in the href); the visible text is escaped the same way
  return { node: { k: 6, auto: 'ext', href: escFull(href), title: null, c: [{ k: 8, s: escFull(url), raw: url }] }, next: i + url.length };
}

// Inline HTML tag at position `i` (which is '<'). Returns {text, next}
// or null. Strict grammar per marked's tag regex: tag names are letters
// + alnum/hyphen, attribute names are [A-Za-z_:][\w.:-]*, each attribute
// is preceded by whitespace (newlines allowed), quoted values may hold
// '<', '>' and newlines, unquoted values may not contain space "'=<>\`.
// Comments are <!--> / <!---> / <!--...--> (the latter may run to the
// end of the text); <?...?>, <!A-Z ...> and <![CDATA[...]]> are tags.
function tryHtmlTag(text, i) {
  const n = text.length;
  if (text[i] !== '<') return null;
  let p = i + 1;
  const skipWs = (q) => {
    while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) q++;
    return q;
  };
  // comment: <!--> | <!---> | <!-- ... --> (or to the end of the text)
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return { text: text.slice(i, i + 5), next: i + 5 };
    if (text.startsWith('<!--->', i)) return { text: text.slice(i, i + 6), next: i + 6 };
    const closeAt = text.indexOf('-->', i + 4);
    if (closeAt < 0) return { text: text.slice(i), next: n };
    return { text: text.slice(i, closeAt + 3), next: closeAt + 3 };
  }
  // processing instruction <? ... ?>
  if (text[p] === '?') {
    const closeAt = text.indexOf('?>', p + 1);
    if (closeAt < 0) return null;
    return { text: text.slice(i, closeAt + 2), next: closeAt + 2 };
  }
  // declaration <!A-Z ...> or CDATA
  if (text[p] === '!') {
    if (text.startsWith('<![CDATA[', i)) {
      const closeAt = text.indexOf(']]>', i + 9);
      if (closeAt < 0) return null;
      return { text: text.slice(i, closeAt + 3), next: closeAt + 3 };
    }
    if (p + 1 < n && isLetterCode(text.charCodeAt(p + 1))) {
      const closeAt = text.indexOf('>', p + 1);
      if (closeAt < 0) return null;
      return { text: text.slice(i, closeAt + 1), next: closeAt + 1 };
    }
    return null;
  }
  // closing tag </name>
  let isClosing = false;
  if (text[p] === '/') { isClosing = true; p++; }
  if (p >= n || !isLetterCode(text.charCodeAt(p))) return null;
  while (p < n && isTagNameCode(text.charCodeAt(p))) p++;
  if (isClosing) {
    p = skipWs(p);
    if (p < n && text[p] === '>') return { text: text.slice(i, p + 1), next: p + 1 };
    return null;
  }
  // open tag: attributes, each preceded by whitespace (newlines allowed)
  while (p < n) {
    if (text[p] === '>') return { text: text.slice(i, p + 1), next: p + 1 };
    if (text[p] === '/' && text[p + 1] === '>') return { text: text.slice(i, p + 2), next: p + 2 };
    if (text[p] !== ' ' && text[p] !== '\t' && text[p] !== '\n') return null;
    p = skipWs(p);
    if (p >= n) return null;
    if (text[p] === '>') return { text: text.slice(i, p + 1), next: p + 1 };
    if (text[p] === '/' && text[p + 1] === '>') return { text: text.slice(i, p + 2), next: p + 2 };
    // attribute name
    if (!isAttrNameCode(text.charCodeAt(p))) return null;
    p++;
    while (p < n && isAttrNameCode(text.charCodeAt(p))) p++;
    // optional = value (whitespace allowed around '=')
    let q = skipWs(p);
    if (text[q] === '=') {
      q++;
      q = skipWs(q);
      const quote = text[q];
      if (quote === '"' || quote === "'") {
        q++;
        while (q < n && text[q] !== quote) q++;
        if (q >= n) return null;
        q++;
      } else {
        const valStart = q;
        while (q < n && isUnquotedAttrCode(text.charCodeAt(q))) q++;
        if (q === valStart) return null;
      }
      p = q;
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
  let p = 0;
  while (p < b.length && b[p] === ' ' && p < 3) p++;
  if (b[p] !== ch) return false;
  let len = 0;
  while (p + len < b.length && b[p + len] === ch) len++;
  if (len < minLen) return false;
  let q = p + len;
  while (q < b.length && (b[q] === ' ' || b[q] === '\t')) q++;
  return q === b.length;
}

// Strip up to n leading whitespace characters from a fenced code
// content line. Marked's Dt is character-based, so a leading tab counts
// as one character and is removed whole (not expanded to 4 columns).
function stripFenceIndent(b, n) {
  if (n <= 0) return b;
  let i = 0;
  while (i < b.length && i < n && (b[i] === ' ' || b[i] === '\t')) i++;
  return b.slice(i);
}

function parseFenced(lines, i, end, fen) {
  const content = [];
  let j = i + 1, closed = false;
  while (j < end) {
    const b = body(lines[j]);
    if (matchFencedClose(b, fen.ch, fen.len)) { closed = true; break; }
    // marked's Dt only compensates the opening fence's indent for
    // backtick fences (its regex looks for ```); a tilde fence keeps
    // its content indentation verbatim
    content.push((fen.ch === '`' ? stripFenceIndent(b, fen.indent) : b) + (hasNL(lines[j]) ? '\n' : ''));
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
  let p = 0;
  while (p < b.length && b[p] === ' ' && p < 3) p++;
  if (b[p] !== '<') return 0;
  const rest = b.slice(p + 1);
  const low = rest.toLowerCase();
  // type 1: script/pre/style/textarea openers
  for (const name of ['script', 'pre', 'style', 'textarea']) {
    if (low.startsWith(name)) {
      const after = low[name.length];
      if (after === undefined || /[\s>\/]/.test(after)) return 1;
    }
  }
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest[0] === '!' && rest[1] !== undefined && /[A-Za-z]/.test(rest[1])) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  // type 6: block-level tag
  {
    let q = 0;
    if (rest[q] === '/') q++;
    const nameStart = q;
    if (q < rest.length && isLetterCode(rest.charCodeAt(q))) {
      q++;
      while (q < rest.length && isTagNameCode(rest.charCodeAt(q))) q++;
      const after = rest[q];
      if ((after === undefined || /[\s>\/]/.test(after)) &&
          BLOCK_TAGS.has(rest.slice(nameStart, q).toLowerCase())) return 6;
    }
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

const HTML_END_MARKERS = { 2: '-->', 3: '?>', 4: '>', 5: ']]>' };

function htmlBlockEndMarker(type) {
  return HTML_END_MARKERS[type] ?? null;
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
    const openMatch = /^ {0,3}<(script|pre|style|textarea)([\s>\/]|$)/i.exec(b);
    const tagName = openMatch[1].toLowerCase();
    const closePattern = new RegExp('</' + tagName + '\\s*>', 'i');
    for (let q = i; q < end; q++) {
      if (closePattern.test(body(lines[q]))) {
        return { block: { t: 'html', text: htmlText(lines, i, q + 1, end, stripAtEnd) }, next: q + 1 };
      }
    }
    // no closing tag: a type-1 block runs to the end of the document
    return { block: { t: 'html', text: htmlText(lines, i, end, end, stripAtEnd) }, next: end };
  }
  if (type >= 2 && type <= 5) {
    const marker = htmlBlockEndMarker(type);
    for (let q = i; q < end; q++) {
      if (body(lines[q]).includes(marker)) {
        return { block: { t: 'html', text: htmlText(lines, i, q + 1, end, stripAtEnd) }, next: q + 1 };
      }
    }
    return { block: { t: 'html', text: htmlText(lines, i, end, end, stripAtEnd) }, next: end };
  }
  // types 6 and 7: consume until a blank line
  let q = i + 1;
  while (q < end && !isBlank(lines[q])) q++;
  return { block: { t: 'html', text: htmlText(lines, i, q, end, stripAtEnd, true) }, next: q };
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
  let q = i;
  while (q < end) {
    const content = stripQuote(lines[q]);
    if (content === null) break;
    inner.push(content + (hasNL(lines[q]) ? '\n' : ''));
    q++;
  }
  const fixups = [];
  let res = null;
  let newChunk = true; // the first lazy line starts a new chunk
  const ensure = () => {
    if (!res) { res = parseBlocks(inner, 0, inner.length, refs, false, true); applyLazyFixups(res, fixups); }
    return res;
  };
  // lazy continuation lines, and quote lines that follow them (a blank
  // line ends the blockquote, even when followed by a quote line)
  while (q < end) {
    const line = lines[q];
    if (isBlank(line)) break;
    const content = stripQuote(line);
    if (content !== null) {
      inner.push(content + (hasNL(line) ? '\n' : ''));
      q++;
      res = null;
      newChunk = true;
      continue;
    }
    if (isLazyCandidate(line, q, lines, end)) {
      const r = ensure();
      if (r.lastNonBlank && deepLastParaTable(r.blocks)) {
        const tail = r.blocks[r.blocks.length - 1];
        if (tail.t === 'para' || tail.t === 'table') {
          // direct: a lazy line starting a new chunk is dedented (the
          // indented-code merge); inside a chunk the paragraph regex
          // swallows it whole, spaces included
          const appended = lazyAppendBody(body(line), 0);
          if (appended.fix && newChunk) fixups.push(appended.fix);
          inner.push(appended.body + (hasNL(line) ? '\n' : ''));
        } else {
          // nested blockquote/list: pass the line down unstripped; the
          // nested level applies its own stripping
          inner.push(line);
        }
        q++;
        res = null;
        newChunk = false;
        continue;
      }
    }
    break;
  }
  res = ensure();
  return { block: { t: 'quote', children: res.blocks }, next: q };
}

// A line may lazily continue a paragraph when it is non-blank and does
// not start an interrupting block (ATX, fence, thematic break, HTML 1-6,
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
  let p = 0;
  while (p < b.length && b[p] === ' ' && p < 3) p++;
  let ordered = false, bullet = null, num = null, delim = null;
  if (b[p] === '-' || b[p] === '+' || b[p] === '*') {
    bullet = b[p];
    p++;
  } else if (b[p] >= '0' && b[p] <= '9') {
    let q = p;
    while (q < b.length && b[q] >= '0' && b[q] <= '9') q++;
    if (q - p > 9) return null;
    const d = b[q];
    if (d !== '.' && d !== ')') return null;
    ordered = true; num = parseInt(b.slice(p, q), 10); delim = d;
    p = q + 1;
  } else return null;
  // the marker must be followed by a space, a tab, or the end of the line
  const after = b[p];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // content indent: marker column + 1..4 columns of whitespace, else +1
  let col = p, q = p;
  while (q < b.length && (b[q] === ' ' || b[q] === '\t')) {
    if (b[q] === ' ') col++;
    else col += 4 - (col % 4);
    q++;
  }
  const wsWidth = col - p;
  const contentIndent = (q >= b.length || wsWidth < 1 || wsWidth > 4) ? p + 1 : col;
  return { ordered, bullet, num, delim, markerEndCol: p, markerEndIdx: p, contentIndent };
}

// Does this list item interrupt a paragraph? Bullets always; ordered only
// when the start number is 1 — except inside a list item's content,
// where any list marker starts a nested list (marked: '- foo\n  49. Uses'
// makes a nested <ol start="49">, while a blockquote or top-level
// paragraph keeps '49.' as text). An empty item never interrupts.
function listInterruptsPara(lst, b, inList) {
  if (lst.ordered && lst.num !== 1 && !inList) return false;
  // empty item: nothing but whitespace after the marker
  let q = lst.markerEndIdx;
  while (q < b.length && (b[q] === ' ' || b[q] === '\t')) q++;
  return q < b.length;
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
  let column = lst.markerEndCol, p = lst.markerEndIdx;
  while (column < lst.contentIndent && p < b.length) {
    const c = b[p];
    if (c === ' ') { column++; p++; }
    else if (c === '\t') {
      const width = 4 - (column % 4);
      if (column + width <= lst.contentIndent) { column += width; p++; }
      else {
        let out = ' '.repeat(column + width - lst.contentIndent);
        let col2 = column + width;
        let q = p + 1;
        while (q < b.length && (b[q] === ' ' || b[q] === '\t')) {
          if (b[q] === ' ') { out += ' '; col2++; q++; }
          else { const width2 = 4 - (col2 % 4); out += ' '.repeat(width2); col2 += width2; q++; }
        }
        return out + b.slice(q);
      }
    } else break;
  }
  return b.slice(p);
}

// Scan stripped item lines for an unclosed fenced code block. A fenced
// code block inside a list item captures every line until its closing
// fence, even lines with less indent than the item's content indent
// (e.g. a `function f(a, b) {` line at column 0 inside a ``` fence).
// Returns the open fence {ch, len} or null.
function openFenceIn(itemLines) {
  let open = null;
  for (const line of itemLines) {
    const bodyText = body(line);
    if (open) {
      if (matchFencedClose(bodyText, open.ch, open.len)) open = null;
    } else {
      const start = matchFencedStart(bodyText);
      if (start) open = start;
    }
  }
  return open;
}

// Whether an under-indented line is fence content inside a list item.
// Mirrors marked's list tokenizer: the line must not itself start a
// block that interrupts the item (fence, ATX heading, HTML block,
// blockquote, list marker, thematic break); the previous item line must
// not be blank (a blank line ends the fence's capture); and the previous
// item line's stripped content must not start a fence/heading/html/hr
// (so a column-0 line right after the opening fence is NOT captured —
// the fence only begins once an indented content line precedes it).
function fenceContentLine(line, itemLines) {
  const lineBody = body(line);
  if (matchFencedStart(lineBody) || matchATX(lineBody) || htmlBlockType(lineBody, false) > 0 ||
      stripQuote(line) !== null || matchListStart(lineBody) || isThematicBreak(lineBody)) return false;
  const prevLine = itemLines[itemLines.length - 1];
  if (prevLine === undefined || isBlank(prevLine)) return false;
  const prevTrimmed = body(prevLine).trimStart();
  if (matchFencedStart(prevTrimmed) || matchATX(prevTrimmed) || htmlBlockType(prevTrimmed, false) > 0 || isThematicBreak(prevTrimmed)) return false;
  return true;
}

function parseList(lines, i, end, refs) {
  const first = matchListStart(body(lines[i]));
  const ordered = first.ordered;
  const items = [];
  let loose = false;
  let q = i;
  let prevItemIndent = first.contentIndent;
  while (q < end) {
    // find the next non-blank line; blank lines are only consumed when a
    // new item follows (otherwise parseBlocks must see them, so a blank
    // line after the last item still marks the list/item loose)
    let r = q;
    while (r < end && isBlank(lines[r])) r++;
    if (r >= end) break;
    const b = body(lines[r]);
    const marker = matchListStart(b);
    const indent = indentCols(b);
    // a marker is a new item of this list iff same type, indent <= 3 and
    // indent < the previous item's content indent
    if (!marker || !sameList(marker, first) || indent > 3 || indent >= prevItemIndent) break;
    if (isThematicBreak(b)) break; // e.g. "* * *" ends the list
    if (r > q && items.length > 0) loose = true;
    q = r;
    const itemIndent = marker.contentIndent;
    const itemLines = [stripItemMarker(b, marker) + (hasNL(lines[q]) ? '\n' : '')];
    q++;
    const fixups = [];
    let res = null;
    const ensure = () => {
      if (!res) { res = parseBlocks(itemLines, 0, itemLines.length, refs, false, true, true); applyLazyFixups(res, fixups); }
      return res;
    };
    while (q < end) {
      const line = lines[q];
      if (isBlank(line)) {
        // a blank line inside an open fence is fence content, whatever
        // its indent (a fence captures lines until its closer)
        if (openFenceIn(itemLines)) {
          itemLines.push(line);
          q++; res = null; continue;
        }
        // an empty item followed by a blank line ends the item
        if (!itemLines.some((l) => !isBlank(l))) break;
        let r2 = q + 1;
        while (r2 < end && isBlank(lines[r2])) r2++;
        if (r2 < end) {
          const nextBody = body(lines[r2]);
          const nextMarker = matchListStart(nextBody);
          if (nextMarker && sameList(nextMarker, first) && indentCols(nextBody) <= 3 && indentCols(nextBody) < itemIndent) break;
          if (indentCols(nextBody) >= itemIndent) {
            for (; q < r2; q++) itemLines.push(lines[q]);
            res = null;
            continue;
          }
        }
        break;
      }
      const lineBody = body(line);
      const lineMarker = matchListStart(lineBody);
      // any list marker at indent < content indent ends the item (a
      // different bullet/delimiter starts a new list, not a lazy line)
      if (lineMarker && indentCols(lineBody) < itemIndent) break;
      if (indentCols(lineBody) >= itemIndent) {
        itemLines.push(stripCols(expandLeadingTabs(lineBody, 0), itemIndent) + (hasNL(line) ? '\n' : ''));
        q++;
        res = null;
        continue;
      }
      // an under-indented line still belongs to the item when it is
      // fence content (see fenceContentLine): the fence has already
      // begun with an indented content line, the line does not start a
      // new block, and the previous line was not blank
      if (openFenceIn(itemLines) && fenceContentLine(line, itemLines)) {
        itemLines.push(line);
        q++;
        res = null;
        continue;
      }
      // lazy continuation: extends an open paragraph/table in the item
      if (isLazyCandidate(line, q, lines, end)) {
        const r = ensure();
        if (r.lastNonBlank && deepLastParaTable(r.blocks)) {
          const tail = r.blocks[r.blocks.length - 1];
          if (tail.t === 'para' || tail.t === 'table') {
            // a list item's text is lexed line by line, so a lazy line
            // is always dedented (the indented-code merge)
            const appended = lazyAppendBody(lineBody, itemIndent);
            if (appended.fix) fixups.push(appended.fix);
            itemLines.push(appended.body + (hasNL(line) ? '\n' : ''));
          } else {
            // nested blockquote/list: pass the line down unstripped
            itemLines.push(line);
          }
          q++;
          res = null;
          continue;
        }
      }
      break;
    }
    res = ensure();
    if (res.blankBetween) loose = true;
    items.push(res.blocks);
    prevItemIndent = itemIndent;
  }
  return { block: { t: 'list', ordered, start: ordered ? first.num : null, tight: !loose, items }, next: q };
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

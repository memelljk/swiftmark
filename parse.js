// swiftmark — a from-scratch Markdown engine (CommonMark 0.31.2 plus the
// GFM 0.29 extensions) tuned so that parse() reproduces, byte for byte,
// the HTML that marked 18.1.3 produces under its default options. It has
// no dependencies and imports nothing.
//
// How it is put together: a block-level pass turns the source lines into
// a tree of block nodes while gathering every link reference definition
// in the document; a rendering walk then feeds the text of each block
// through the inline engine (delimiter-stack emphasis, links, autolinks,
// code spans, raw HTML) and concatenates the resulting HTML.

/* ============ small utilities: escaping, numeric refs, URLs ============ */

// Both escapers share one replacement table; they differ only in which
// characters their patterns pick out.
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_EVERYWHERE = /[&<>"']/g;
// In running text the quote/bracket characters always escape, while an
// ampersand escapes only when it does NOT open a character reference
// (numeric, or named-looking) — references pass through untouched.
const ESCAPE_IN_TEXT = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const NUMREF_RE = /&(?:#([0-9]{1,7})|#[Xx]([0-9A-Fa-f]{1,6}));/g;

function escFull(s) {
  return s.replace(ESCAPE_EVERYWHERE, (ch) => ESCAPE_MAP[ch]);
}

function escText(s) {
  return s.replace(ESCAPE_IN_TEXT, (ch) => ESCAPE_MAP[ch]);
}

// Value of one digit character in base 10 or 16; -1 when not a digit.
function digitValue(code, hex) {
  if (code >= 48 && code <= 57) return code - 48;
  if (!hex) return -1;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

// When s[i] opens a numeric character reference (&#...; or &#x...;),
// return [the decoded string, how many characters it spans]; otherwise
// return null. Overlong digit runs, a missing semicolon and an empty
// digit run are all rejected; NUL, surrogates and out-of-range points
// decode to U+FFFD, matching the HTML rules marked follows.
function decodeNumRefAt(s, i) {
  if (s.charCodeAt(i) !== 38 || s.charCodeAt(i + 1) !== 35) return null;
  let pos = i + 2;
  let hex = false;
  if (s[pos] === 'x' || s[pos] === 'X') { hex = true; pos += 1; }
  const base = hex ? 16 : 10;
  const maxDigits = hex ? 6 : 7;
  let value = 0;
  let seen = 0;
  while (pos < s.length) {
    const d = digitValue(s.charCodeAt(pos), hex);
    if (d < 0) break;
    value = value * base + d;
    seen += 1;
    pos += 1;
    if (seen > maxDigits) return null;
  }
  if (seen === 0 || pos >= s.length || s[pos] !== ';') return null;
  if (value === 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) value = 0xFFFD;
  return [String.fromCodePoint(value), pos + 1 - i];
}

// Named entities are never decoded by marked; numeric references are
// (in text and in link text — but not inside code spans or code blocks).
// cleanUrl percent-encodes a link destination the way marked does and
// reports failure (null) for strings encodeURI cannot handle.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (err) {
    return null;
  }
}

// Link labels are compared after normalisation: whitespace runs collapse
// to one space, the ends are trimmed, case is folded, and the handful of
// ligature / sharp-s characters that Unicode case folding expands into
// ASCII letters are expanded by hand.
const LABEL_FOLD_EXPANSIONS = {
  'ß': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl',
  'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st',
};
function normLabel(s) {
  let folded = s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const src of Object.keys(LABEL_FOLD_EXPANSIONS)) {
    if (folded.includes(src)) folded = folded.split(src).join(LABEL_FOLD_EXPANSIONS[src]);
  }
  return folded;
}

// One-character classification by char code. The inline engine leans on
// these inside its tightest scans, so each is a handful of comparisons —
// never a regular expression per character.
function isAsciiPunct(c) {
  // The four ASCII punctuation ranges: !"#$%&'()*+,-./  :;<=>?@  [\]^_`  {|}~
  if (c < 33 || c > 126) return false;
  return c <= 47 || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || c >= 123;
}
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isLetterCode(c) { // A-Z or a-z
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Characters allowed in the local part of an email autolink beyond the
// alphanumerics: . _ + -
function isEmailLocalCode(c) {
  return isAlnumCode(c) || c === 46 || c === 95 || c === 43 || c === 45;
}
function isTagNameCode(c) { // letters, digits and '-'
  return c === 45 || isAlnumCode(c);
}
function isAttrNameCode(c) { // \w plus . : -
  return isAlnumCode(c) || c === 95 || c === 46 || c === 58 || c === 45;
}
function isUnquotedAttrCode(c) {
  // An unquoted attribute value stops at whitespace, quotes, '=', '<',
  // '>' and backtick; everything else is value text.
  return !(c === 32 || c === 9 || c === 10 || c === 34 || c === 39 ||
           c === 61 || c === 60 || c === 62 || c === 96);
}
// Lookup tables for the two hottest dispatch questions in parseInline:
// does this character need individual handling, and can this letter open
// an extended autolink (www. / a scheme / mailto: / xmpp:)?
const INLINE_SPECIAL = new Uint8Array(128);
for (const ch of '\n!&*<[\\]_`~') INLINE_SPECIAL[ch.charCodeAt(0)] = 1;
const TRIGGER_LETTER = new Uint8Array(128);
for (const ch of 'HFfhmwx') TRIGGER_LETTER[ch.charCodeAt(0)] = 1;
function isTriggerLetterCode(c) {
  return c < 128 && TRIGGER_LETTER[c] !== 0;
}
function isSpaceOrTab(c) { return c === 32 || c === 9; }
function isUnicodePunct(ch) {
  // CommonMark counts ASCII punctuation plus the Unicode P and S
  // categories as punctuation. ASCII (the overwhelming majority) is
  // settled by the cheap range test; only non-ASCII reaches the regex.
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiPunct(code);
  return /[\p{P}\p{S}]/u.test(ch);
}
const WHITESPACE_CHARS = ' \t\n\r\f\v\u00a0';
function isWhitespace(ch) {
  return WHITESPACE_CHARS.indexOf(ch) !== -1;
}

/* ============ line and column bookkeeping ============ */
// The block engine works on physical lines. Every line keeps its own
// trailing '\n' (the final line of the document may not have one), and
// indentation is always measured in columns, where a tab advances to
// the next multiple of four.

// Cut a normalised source into its lines, terminators included.
function splitLines(src) {
  const lines = [];
  let from = 0;
  for (;;) {
    const nl = src.indexOf('\n', from);
    if (nl === -1) break;
    lines.push(src.slice(from, nl + 1));
    from = nl + 1;
  }
  if (from < src.length) lines.push(src.slice(from));
  return lines;
}

// A line without its terminator.
function body(line) {
  return hasNL(line) ? line.slice(0, -1) : line;
}
function hasNL(line) { return line.charCodeAt(line.length - 1) === 10; }
// Blank = nothing but spaces and tabs before the terminator.
function isBlank(line) {
  const b = body(line);
  for (let i = 0; i < b.length; i++) {
    const code = b.charCodeAt(i);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

// Width in columns of the whitespace run at the start of `b`.
function indentCols(b) {
  let col = 0;
  let i = 0;
  while (i < b.length) {
    const code = b.charCodeAt(i);
    if (code === 32) col += 1;
    else if (code === 9) col += 4 - (col % 4);
    else break;
    i += 1;
  }
  return col;
}

// Drop `n` columns of leading whitespace from `b`. When a tab straddles
// the cut, the part of the tab past the cut survives as spaces; any
// whitespace after it is expanded too, but measured from the ORIGINAL
// line start — tab stops belong to the line, so re-basing them after
// the cut would shift the indent.
function stripCols(b, n) {
  let col = 0;
  let i = 0;
  while (i < b.length && col < n) {
    const ch = b[i];
    if (ch === ' ') { col += 1; i += 1; continue; }
    if (ch !== '\t') break;
    const width = 4 - (col % 4);
    if (col + width <= n) { col += width; i += 1; continue; }
    // Straddling tab: emit its remainder, then expand the rest of the
    // leading whitespace run at its original columns.
    let out = ' '.repeat(col + width - n);
    let origCol = col + width;
    let j = i + 1;
    while (j < b.length && (b[j] === ' ' || b[j] === '\t')) {
      if (b[j] === ' ') { out += ' '; origCol += 1; j += 1; }
      else { const w2 = 4 - (origCol % 4); out += ' '.repeat(w2); origCol += w2; j += 1; }
    }
    return out + b.slice(j);
  }
  return b.slice(i);
}

// Rewrite the leading whitespace of `s` with every tab expanded to
// spaces, counting columns from `col`.
function expandLeadingTabs(s, col) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; col += 1; i += 1; continue; }
    if (ch !== '\t') break;
    const width = 4 - (col % 4);
    out += ' '.repeat(width);
    col += width;
    i += 1;
  }
  return out + s.slice(i);
}

/* ---------------- inline parser ---------------- */

const BR = { k: 2 }; // hard break

// Node shapes used by the inline engine: plain text rides as a bare
// string; everything else is an object with a kind field `k`. Delimiter
// runs (emphasis, strikethrough, link brackets) use k:'d' and carry
// {s, ch, n, on, open, close, active, link, image, pos}.
//
// Two pieces of state live across a whole document, exactly as in
// marked. (1) The <a> leak: an opening <a ...> tag encountered as INLINE
// html inside a paragraph (a lone <a> on its own line is an HTML block
// instead and does not count) disables extended autolinks — www.,
// schemes, bare emails — for every subsequent inline run, across
// paragraph boundaries, until an exact </a> appears. Bracket autolinks,
// bracket emails and ordinary links are immune. (2) The raw-text state:
// inside <pre>, <code>, <kbd> or <script>, character references are not
// decoded and text is emitted verbatim. parse() resets both per document.
let inLink = false;
let inRawBlock = false;

const RAW_TEXT_TAGS = new Set(['pre', 'code', 'kbd', 'script']);

// Identify a raw-text tag: given a complete tag string, return its name
// ('pre', 'code', 'kbd', 'script') for an opener or '/name' for a
// closer, else null. The name only counts when whitespace or '>' follows
// it (marked's start/endPreScriptTag rule), so <pre/> and <codex> do
// not qualify.
function rawBlockTagName(tag) {
  let p = 1;
  const isCloser = tag.charCodeAt(1) === 47; // '/'
  if (isCloser) p = 2;
  const nameFrom = p;
  while (p < tag.length && isLetterCode(tag.charCodeAt(p))) p += 1;
  const name = tag.slice(nameFrom, p).toLowerCase();
  if (!RAW_TEXT_TAGS.has(name)) return null;
  const follower = tag[p];
  if (follower !== '>' && !isWhitespace(follower)) return null;
  return isCloser ? '/' + name : name;
}

function parseInline(text, refs) {
  const nodes = [];
  const delims = [];
  const len = text.length;
  let pending = '';
  let pos = 0;

  // Emit the buffered text as a node. Under the raw-text state the node
  // is a raw node (k:9: verbatim out, no decoding, no escaping) like
  // marked's inRawBlock text tokens; otherwise it is a plain string.
  // Flushes only ever happen on tag boundaries, so a buffered run never
  // straddles the edge of a raw block.
  function flush() {
    if (pending === '') return;
    nodes.push(inRawBlock ? { k: 9, s: pending, raw: pending } : pending);
    pending = '';
  }

  // Flanking facts for the delimiter run starting at `at` with length
  // `runLen`: may it open, may it close? The punctuation test defaults
  // to isUnicodePunct; '~' runs supply one that treats '~' itself as
  // neither punctuation nor word character (GFM strikethrough flanking).
  function flanking(at, runLen, punctFn) {
    const testPunct = punctFn || isUnicodePunct;
    const prevCh = at === 0 ? '' : text[at - 1];
    const nextCh = at + runLen >= len ? '' : text[at + runLen];
    const prevWs = prevCh === '' || isWhitespace(prevCh);
    const nextWs = nextCh === '' || isWhitespace(nextCh);
    const prevPunct = prevCh !== '' && testPunct(prevCh);
    const nextPunct = nextCh !== '' && testPunct(nextCh);
    return {
      open: !nextWs && (!nextPunct || prevWs || prevPunct),
      close: !prevWs && (!prevPunct || nextWs || nextPunct),
    };
  }

  while (pos < len) {
    // Fast path: swallow a whole run of ordinary text in one slice. A
    // run stops at any special character, at a trigger letter that
    // starts a word (an extended autolink may begin there), and at the
    // first character of the word preceding an '@' (an email may begin
    // there). Nothing inside the run needs the per-character dispatch.
    {
      const head = text.charCodeAt(pos);
      const atWordStart = pos === 0 || !isEmailLocalCode(text.charCodeAt(pos - 1));
      if (!INLINE_SPECIAL[head] && !(atWordStart && isEmailLocalCode(head))) {
        let scan = pos + 1;
        let prevWasLocal = isEmailLocalCode(head);
        while (scan < len) {
          const code = text.charCodeAt(scan);
          if (INLINE_SPECIAL[code]) break;
          if (code === 64) {
            // '@': retreat to the start of the word it belongs to.
            let w = scan - 1;
            while (w >= pos && isEmailLocalCode(text.charCodeAt(w))) w -= 1;
            if (w + 1 > pos) { scan = w + 1; break; }
            // The word started at or before pos, so the email attempt
            // there already covered this '@': it is ordinary text.
            prevWasLocal = false;
            scan += 1;
            continue;
          }
          if (!prevWasLocal && isTriggerLetterCode(code)) break;
          prevWasLocal = isEmailLocalCode(code);
          scan += 1;
        }
        if (scan > pos) { pending += text.slice(pos, scan); pos = scan; }
        continue;
      }
    }
    const ch = text[pos];

    // Backslash: escape of an ASCII punctuation character, or a hard
    // break when the next character is a newline.
    if (ch === '\\') {
      const nx = text[pos + 1];
      if (nx === '\n') {
        flush();
        nodes.push(BR);
        pos += 2;
        while (pos < len && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        // The escaped character is stored pre-escaped where needed: an
        // escaped '&' must never be re-read as an entity start, and in a
        // raw block (whose text bypasses the escaper) every escapable
        // character is pre-escaped right here.
        if (inRawBlock) pending += ESCAPE_MAP[nx] || nx;
        else pending += nx === '&' ? '&amp;' : nx;
        pos += 2;
        continue;
      }
      pending += '\\';
      pos += 1;
      continue;
    }

    // Code span: a run of backticks, closed by a run of exactly the
    // same length.
    if (ch === '`') {
      let runLen = 0;
      while (pos + runLen < len && text[pos + runLen] === '`') runLen += 1;
      // The hunt for the closing run stops early at a ']' that would
      // close a live link opener: the link pattern consumes the
      // backticks as label text first, so the span must not swallow
      // that ']' (a span whose closer truly lies beyond the ']' forms
      // only when the link cannot form at all).
      let scan = pos + runLen;
      let closerAt = -1;
      let aborted = false;
      while (scan < len) {
        const sc = text[scan];
        if (sc === '`') {
          let r2 = 0;
          while (scan + r2 < len && text[scan + r2] === '`') r2 += 1;
          if (r2 === runLen) { closerAt = scan; break; }
          scan += r2;
        } else if (sc === ']' && (text[scan + 1] === '(' || text[scan + 1] === '[' || scan + 1 >= len)) {
          if (wouldFormLink(text, scan, delims, refs)) { aborted = true; break; }
          scan += 1;
        } else scan += 1;
      }
      if (closerAt < 0 || aborted) { pending += '`'.repeat(runLen); pos += runLen; continue; }
      let content = text.slice(pos + runLen, closerAt).replace(/\n/g, ' ');
      // An empty span is literal text, not a code node.
      if (content === '') { pending += '`'.repeat(runLen * 2); pos = closerAt + runLen; continue; }
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ k: 0, s: content });
      pos = closerAt + runLen;
      continue;
    }

    // '<': a bracket autolink <...> or a raw HTML tag.
    if (ch === '<') {
      const auto = tryBracketAutolink(text, pos);
      if (auto) { flush(); nodes.push(auto.node); pos = auto.next; continue; }
      const tag = tryHtmlTag(text, pos);
      if (tag) {
        flush();
        nodes.push({ k: 1, s: tag.text });
        // Maintain marked's tag-driven state (its startATag/endATag and
        // start/endPreScriptTag rules): <a opens inLink only when a
        // SPACE follows the 'a' — <a>, <a/> and <a\t...> do not count,
        // while a self-closing <a /> does — and only the exact string
        // </a> closes it (</a > does not). A raw-text opener switches
        // inRawBlock on; any of the four closers switches it off.
        const t = tag.text;
        const second = t[1];
        if (!inLink && t.length >= 3 && (second === 'a' || second === 'A') && t[2] === ' ') inLink = true;
        else if (inLink && t.length === 4 && second === '/' && (t[2] === 'a' || t[2] === 'A') && t[3] === '>') inLink = false;
        const rawName = rawBlockTagName(t);
        if (rawName !== null) {
          if (rawName[0] !== '/' && !inRawBlock) inRawBlock = true;
          else if (rawName[0] === '/' && inRawBlock) inRawBlock = false;
        }
        pos = tag.next;
        continue;
      }
      // A '<' that starts nothing is escaped on the spot — except in a
      // raw block, where text passes through verbatim.
      pending += inRawBlock ? '<' : '&lt;';
      pos += 1;
      continue;
    }

    // '&': a numeric character reference. Named entities are never
    // decoded, and inside a raw block even numeric ones stay literal.
    if (ch === '&') {
      const decoded = inRawBlock ? null : decodeNumRefAt(text, pos);
      if (decoded) {
        // A decoded '&' is a literal ampersand, never an entity start.
        pending += decoded[0] === '&' ? '&amp;' : decoded[0];
        pos += decoded[1];
        continue;
      }
      pending += '&';
      pos += 1;
      continue;
    }

    // Delimiter runs for emphasis (*, _) and strikethrough (~).
    if (ch === '*' || ch === '_' || ch === '~') {
      let runLen = 0;
      while (pos + runLen < len && text[pos + runLen] === ch) runLen += 1;
      // Three or more tildes are plain text, never a delimiter.
      if (ch === '~' && runLen >= 3) { pending += '~'.repeat(runLen); pos += runLen; continue; }
      const fl = ch === '~'
        ? flanking(pos, runLen, (c) => isUnicodePunct(c) && c !== '~')
        : flanking(pos, runLen);
      let mayOpen = fl.open;
      let mayClose = fl.close;
      if (ch === '_') {
        // Underscore runs obey the extra intraword restrictions.
        mayOpen = fl.open && (!fl.close || (pos > 0 && isUnicodePunct(text[pos - 1])));
        mayClose = fl.close && (!fl.open || (pos + runLen < len && isUnicodePunct(text[pos + runLen])));
      }
      flush();
      const delim = { k: 'd', s: ch.repeat(runLen), ch, n: runLen, on: runLen, open: mayOpen, close: mayClose, active: true, link: false, image: false, pos };
      nodes.push(delim);
      delims.push(delim);
      pos += runLen;
      continue;
    }

    // Link and image openers: '[' and '!['.
    if (ch === '[' || (ch === '!' && text[pos + 1] === '[')) {
      const isImage = ch === '!';
      flush();
      const opener = { k: 'd', s: isImage ? '![' : '[', ch: '[', n: 1, open: false, close: false, active: true, link: true, image: isImage, pos: isImage ? pos + 1 : pos };
      nodes.push(opener);
      delims.push(opener);
      pos += isImage ? 2 : 1;
      continue;
    }

    // ']': attempt to resolve a link or image.
    if (ch === ']') {
      flush();
      const made = tryCloseBracket(text, pos, nodes, delims, refs);
      if (made) { pos = made.next; continue; }
      // No link formed. But when '[label](dest)' still matches marked's
      // blockSkip `link` pattern (a label that is valid under the
      // Ot-masked grammar plus a balanced-paren destination), the
      // label's delimiters are invisible to the outer emphasis scan:
      // mask them so processEmphasis never pairs them. (A label whose
      // code span holds a backtick fails validLabel, so no link forms,
      // yet the mask still hides the label — doc-16/doc-20,
      // `[at _node `` a ` b ``_](...)`.)
      if (text[pos + 1] === '(' && blockSkipDestEnd(text, pos + 1) >= 0) {
        for (let d = delims.length - 1; d >= 0; d--) {
          const cand = delims[d];
          if (!cand.link || !cand.active) continue;
          if (!blockSkipLabelOk(text.slice(cand.pos + 1, pos))) break;
          for (let m = d + 1; m < delims.length; m++) {
            if (!delims[m].link) delims[m].masked = true;
          }
          break;
        }
      }
      // A literal ']' retires the nearest active LINK opener. An image
      // opener stays active, so an outer image can still resolve at a
      // later ']' (cm-520); and a retired link opener must not keep
      // suppressing the extended autolinks that follow it (doc-32).
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].link && !delims[k].image && delims[k].active) { delims[k].active = false; break; }
      }
      pending += ']';
      pos += 1;
      continue;
    }

    // Line ending: a soft break, or a hard break when two or more
    // spaces precede the newline (the spaces are consumed).
    if (ch === '\n') {
      let trailing = 0;
      while (trailing < pending.length && pending[pending.length - 1 - trailing] === ' ') trailing += 1;
      if (trailing >= 2) {
        pending = pending.slice(0, pending.length - trailing);
        flush();
        nodes.push(BR);
        pos += 1;
        while (pos < len && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
      } else {
        pending += '\n';
        pos += 1;
      }
      continue;
    }

    // Extended autolinks (GFM): www., scheme://, bare emails, and the
    // mailto:/xmpp: forms. Matching runs forward from the word start,
    // so a '_' inside an email local part is never misread as an
    // emphasis delimiter first (gfm-632). These autolinks do not form
    // inside link text, but that is settled when the link forms
    // (unlinkExtAutolinks reverts them to plain text), NOT by watching
    // openers here: an UNRESOLVED '[' must not suppress the autolinks
    // after it, because marked only suppresses them inside a resolved
    // link's text. A raw <a> tag does suppress them (inLink). A www.
    // additionally needs a word start: whitespace, '(', '*', '_', '~',
    // or the end of a previous real token (HTML tag, code span, link,
    // ... — after such a token marked tries its url tokenizer at the
    // fresh position).
    if (!inLink) {
      const prevCh = pos === 0 ? '' : text[pos - 1];
      if (ch === 'w' && text.startsWith('www.', pos)) {
        // A delimiter node (k:'d') is not a token: after a '[' the www.
        // is still rejected (prevCh is '['); only real tokens count.
        const lastNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
        const afterToken = pending === '' && lastNode !== null && typeof lastNode !== 'string' && lastNode.k !== 'd';
        if (prevCh === '' || isWhitespace(prevCh) || prevCh === '(' || prevCh === '*' || prevCh === '_' || prevCh === '~' || afterToken) {
          const hit = matchExtendedAutolink(text, pos, 'www', delims);
          if (hit) { flush(); nodes.push(hit.node); pos = hit.next; continue; }
        }
      }
      if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
        const hit = matchExtendedAutolink(text, pos, 'scheme', delims);
        if (hit) { flush(); nodes.push(hit.node); pos = hit.next; continue; }
      }
      // mailto:/xmpp: are lowercase-only and need a start position or a
      // non-alphanumeric before them; a bare email needs the same
      // boundary, with the current char in the local-part set.
      const atBoundary = prevCh === '' || !isAlnumCode(prevCh.charCodeAt(0));
      if (atBoundary && (ch === 'm' || ch === 'x') && (text.startsWith('mailto:', pos) || text.startsWith('xmpp:', pos))) {
        const hit = matchEmailAt(text, pos, delims);
        if (hit) { flush(); nodes.push(hit.node); pos = hit.next; continue; }
      }
      if (atBoundary && isEmailLocalCode(ch.charCodeAt(0))) {
        const hit = matchEmailAt(text, pos, delims);
        if (hit) { flush(); nodes.push(hit.node); pos = hit.next; continue; }
      }
    }

    pending += ch;
    pos += 1;
  }
  flush();
  // Delimiters inside a blockSkip-masked span are invisible to the outer
  // emphasis scan (marked's emStrong mask): the Ot mask pairs a backtick
  // run with a later run of the same length and neutralises the
  // backticks between them, then blockSkip swallows the whole span — so
  // a stray backtick inside a link label can hide emphasis far beyond
  // the link (doc-09/doc-28/doc-35). Delimiters consumed by a link that
  // formed are already off the stack, so only unformed labels and stray
  // spans are affected here.
  if (delims.length > 0) {
    const spans = blockSkipRanges(text);
    let si = 0;
    for (const delim of delims) {
      if (delim.link || delim.masked) continue;
      while (si < spans.length && spans[si][1] <= delim.pos) si += 1;
      if (si < spans.length && delim.pos >= spans[si][0] && delim.pos < spans[si][1]) delim.masked = true;
    }
  }
  processEmphasis(nodes, delims, 0, text);
  return renderNodes(nodes);
}

// Turn a finished node list into HTML. Strings are text (escaped);
// delimiter nodes that never paired render as their literal characters.
function renderNodes(nodes) {
  let html = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') { html += escText(nd); continue; }
    switch (nd.k) {
      case 0: html += '<code>' + escFull(nd.s) + '</code>'; break;
      case 1: html += nd.s; break;
      case 2: html += '<br>'; break;
      case 3: html += '<em>' + renderNodes(nd.c) + '</em>'; break;
      case 4: html += '<strong>' + renderNodes(nd.c) + '</strong>'; break;
      case 5: html += '<del>' + renderNodes(nd.c) + '</del>'; break;
      case 6: {
        html += '<a href="' + nd.href + '"';
        if (nd.title !== null && nd.title !== undefined) html += ' title="' + nd.title + '"';
        html += '>' + renderNodes(nd.c) + '</a>';
        break;
      }
      case 7: {
        html += '<img src="' + nd.src + '" alt="' + nd.alt + '"';
        if (nd.title !== null && nd.title !== undefined) html += ' title="' + nd.title + '"';
        html += '>';
        break;
      }
      case 8: // autolink text, already escaped when the node was built
      case 9: // raw-block text, verbatim by definition
        html += nd.s;
        break;
      case 'd': html += escText(nd.s); break;
    }
  }
  return html;
}

// Remove every <...> tag from rendered HTML (used for image alt text).
// An unterminated '<' keeps the rest of the string as text.
function stripTags(html) {
  let kept = '';
  let from = 0;
  for (;;) {
    const lt = html.indexOf('<', from);
    if (lt === -1) { kept += html.slice(from); return kept; }
    kept += html.slice(from, lt);
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) { kept += html.slice(lt); return kept; }
    from = gt + 1;
  }
}

/* ============ emphasis: the delimiter-stack pairing ============ */

// An emulation of marked's emStrong forward scan. Starting from the
// opener at stack index oi, walk the later runs of the same character
// the way marked's RDelim patterns classify them and report where the
// scan stops. All lengths are ORIGINAL lengths (on): in marked's
// left-to-right order the scan happens before any pair inside the
// opener's range has formed, so intervening runs count in full even
// when this parser's closer-first loop has already folded them into an
// inner pair. The result is { stop, m, f, b }: stop is the stack index
// where the running total m first reaches <= 0 (-1 when the scan runs
// off the end), f is the combined length of runs the rule of three
// stepped over as mid delimiters, and b is the stop run's original
// length. marked consumes min(b, b + m + f) characters of the closer,
// which is why m and f are reported to the caller.
function markedScan(delims, oi, text) {
  const opener = delims[oi];
  const ch = opener.ch;
  const origLen = opener.on;
  let balance = opener.n;
  let midTotal = 0;
  // The R flag of marked's emStrong: when the opener can open and the
  // character before it is not whitespace, even a pure closer is put
  // through the rule of three instead of closing unconditionally.
  const prevCh = opener.pos > 0 ? text[opener.pos - 1] : '';
  const nextCh = opener.pos + opener.on < text.length ? text[opener.pos + opener.on] : '';
  const nextIsPunct = nextCh !== '' && isUnicodePunct(nextCh);
  const prevIsPunct = prevCh !== '' && isUnicodePunct(prevCh); // '*' and '_' are punct too
  const ruleOfThreeForAll = prevCh !== '' && !isWhitespace(prevCh) &&
    (nextIsPunct || (ch === '*' && !prevIsPunct));
  for (let k = oi + 1; k < delims.length; k++) {
    const run = delims[k];
    if (run.ch !== ch || run.link || run.masked) continue;
    // A run sitting inside a pair of the OPPOSITE character is
    // invisible to this scan (the emStrongRDelim skip alternative);
    // a run inside a same-character pair still counts at full length.
    if (run.inPairCh !== undefined && run.inPairCh !== ch) continue;
    if (!run.open && !run.close) continue; // neither-flanking: invisible
    const runLen = run.on;
    if (run.open && !run.close) { balance += runLen; continue; } // pure opener
    if ((run.open && run.close) || ruleOfThreeForAll) {
      // Both-flanking (or R): the rule of three picks opener vs closer.
      if (origLen % 3 !== 0 && (origLen + runLen) % 3 === 0) { midTotal += runLen; continue; }
    }
    balance -= runLen;
    if (balance > 0) continue;
    return { stop: k, m: balance, f: midTotal, b: runLen };
  }
  return { stop: -1, m: balance, f: midTotal, b: 0 }; // ran out: no pair
}

// Where marked's scan from opener oi stops (a stack index, or -1), and
// whether it stops exactly at the closer ci.
function markedScanStopIndex(delims, oi, text) {
  return markedScan(delims, oi, text).stop;
}
function markedScanPairs(delims, oi, ci, text) {
  return markedScanStopIndex(delims, oi, text) === ci;
}

// Would some FRESH opener before stack index oi (but not before
// fromStack) claim closer ci under marked's opener-first order? It must
// share the closer's character, still be able to open at its full
// original length, be itself eligible against this closer under the
// rule of three, and have a forward scan that stops exactly at ci.
// Exception: when the claim would spend MORE closer characters than the
// pair's tags use (min(on, on + m + f) > use), the surplus falls inside
// the pair and can itself close an inner opener — that is how marked
// pairs `*foo *bar**` as nested ems — so the inner candidate must not
// stand down for such a claim.
function earlierOpenerClaims(delims, oi, ci, fromStack, text) {
  const closer = delims[ci];
  if (closer.n !== closer.on) return false;
  for (let j = oi - 1; j >= fromStack; j--) {
    const cand = delims[j];
    if (!cand.active || cand.masked || cand.ch !== closer.ch || !cand.open) continue;
    if (cand.n !== cand.on) continue; // only a fresh, untouched opener claims
    if ((cand.close || closer.open) && ((cand.n + closer.n) % 3 === 0) && !(cand.n % 3 === 0 && closer.n % 3 === 0)) continue;
    const scan = markedScan(delims, j, text);
    if (scan.stop !== ci) continue;
    const spent = Math.min(closer.on, closer.on + scan.m + scan.f);
    const tagUse = (cand.n >= 2 && closer.n >= 2) ? 2 : 1;
    if (spent <= tagUse) return true;
  }
  return false;
}

// Pair delimiters up: walk the closers from oldest to newest and match
// each with the nearest earlier opener that may open. Only stack
// entries at or after fromStack may take part, on either side.
function processEmphasis(nodes, delims, fromStack, text) {
  let ci = fromStack;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.active || closer.masked || closer.ch === '[' || !closer.close) { ci += 1; continue; }
    // Find the nearest preceding opener of the same character.
    let oi = -1;
    let opener = null;
    for (let j = ci - 1; j >= fromStack; j--) {
      const cand = delims[j];
      if (cand.masked) continue;
      if (cand.ch !== closer.ch || !cand.open || !cand.active) continue;
      // Strikethrough pairs only between runs of EQUAL length.
      if (closer.ch === '~' && cand.n !== closer.n) continue;
      // Rule of three: the pair is barred when the lengths sum to a
      // multiple of three without both being multiples of three.
      if ((cand.close || closer.open) && ((cand.n + closer.n) % 3 === 0) && !(cand.n % 3 === 0 && closer.n % 3 === 0)) continue;
      // Single-character openers are held to marked's emStrong scan: a
      // lone `*` or `_` opener pairs with this closer only when the
      // forward scan stops here. Multi-character openers are exempt —
      // marked retries a failed full-length scan as a shorter run, so
      // rejecting them here would lose pairs the retry forms
      // (cm-408/413/442/444/445).
      if (closer.ch !== '~' && cand.n === 1 && cand.on === 1 && !markedScanPairs(delims, j, ci, text)) continue;
      // A single-character closer must not steal characters from a
      // TWO-character opener whose scan pairs it with a later
      // multi-character closer at full length: in marked the strong
      // forms first and the single closer stays literal inside it
      // (doc-01/11/26). An opener of 3+ characters can spare one — the
      // single closer pairs first and the leftover still forms the
      // strong (cm-430 `***foo* bar**`) — so this guard is n === 2 only.
      if (closer.ch !== '~' && closer.n === 1 && cand.n === 2) {
        const stopAt = markedScanStopIndex(delims, j, text);
        if (stopAt > ci && delims[stopAt].n >= 2) continue;
      }
      // Opener priority, marked style: marked's tokenizer works
      // opener-first, so when an EARLIER fresh opener's forward scan
      // stops exactly at this closer, that opener owns the closer and
      // this candidate stands down — even if this candidate's own scan
      // would stop here too. Without this, a lone inner `*` steals the
      // closing `**` of a strong marked forms around it (`**a *b
      // **c**d* e**` keeps its inner `*`s literal and closes with the
      // final `**`).
      if (closer.ch !== '~' && earlierOpenerClaims(delims, j, ci, fromStack, text)) continue;
      oi = j;
      opener = cand;
      break;
    }
    if (opener === null) { ci += 1; continue; }
    const take = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    // marked's closer accounting: when the forward scan from this
    // opener stops at this closer, the closer contributes
    // min(on, on + m + f) characters. Runs the rule of three skipped
    // as mids (their total is f) let the closer contribute MORE
    // characters than the pair spends on its tags, and marked renders
    // the surplus INSIDE the pair, at the end of its content: in
    // `**by command *tool*one***` the scan skips the `*` after "tool"
    // as a mid, so all three closing characters are consumed and one
    // stays inside the strong. This applies only when both runs are
    // still untouched and the opener spends its whole run on the pair,
    // so the surplus can only land inside, never before the opener.
    let eat = take;
    let tailText = '';
    if (closer.ch !== '~' && opener.n === opener.on && closer.n === closer.on && opener.on === take) {
      // The scan can only enlarge the closer's contribution when a
      // rule-of-three mid skip is possible between the pair: either a
      // both-flanking run of the same character in between, or the R
      // flag (which puts even pure closers through the rule of three).
      // When neither can occur, skip the scan entirely.
      let midPossible = false;
      const prevCh = opener.pos > 0 ? text[opener.pos - 1] : '';
      const nextCh = opener.pos + opener.on < text.length ? text[opener.pos + opener.on] : '';
      if (prevCh !== '' && !isWhitespace(prevCh) &&
          ((nextCh !== '' && isUnicodePunct(nextCh)) ||
           (closer.ch === '*' && prevCh !== '*' && prevCh !== '_' && !isUnicodePunct(prevCh)))) {
        midPossible = true;
      }
      for (let k = oi + 1; !midPossible && k < ci; k++) {
        const run = delims[k];
        if (run.ch === closer.ch && run.open && run.close && !run.masked && !run.link &&
            !(run.inPairCh !== undefined && run.inPairCh !== closer.ch)) midPossible = true;
      }
      if (midPossible) {
        const scan = markedScan(delims, oi, text);
        if (scan.stop === ci) {
          const spent = Math.min(closer.on, closer.on + scan.m + scan.f);
          if (spent > take) { eat = spent; tailText = closer.ch.repeat(spent - take); }
        }
      }
    }
    const kind = closer.ch === '~' ? 5 : (take === 2 ? 4 : 3);
    const openNodeAt = nodes.indexOf(opener);
    const closeNodeAt = nodes.indexOf(closer);
    const children = nodes.slice(openNodeAt + 1, closeNodeAt);
    if (tailText !== '') children.push(tailText);
    const wrapped = { k: kind, c: children };
    opener.s = opener.s.slice(0, opener.s.length - take);
    opener.n -= take;
    closer.s = closer.s.slice(eat);
    closer.n -= eat;
    if (opener.n === 0) opener.active = false;
    if (closer.n === 0) closer.active = false;
    nodes.splice(openNodeAt + 1, closeNodeAt - openNodeAt - 1, wrapped);
    // The delimiters between the pair are now inside the wrapped node.
    // They stay on the stack, deactivated, so that a later outer
    // opener's marked-scan still sees them at their original lengths —
    // removing them would make the scan undercount and pair runs that
    // marked leaves literal. Each records the innermost pair's
    // character: a run inside a pair of the OPPOSITE character is
    // invisible to outer scans (the emStrongRDelim skip alternative
    // jumps over __...*...__ spans); inside a same-character pair it
    // still counts.
    const oiPos = delims.indexOf(opener);
    const ciPos = delims.indexOf(closer);
    for (let k = oiPos + 1; k < ciPos; k++) {
      if (delims[k].inPairCh === undefined) delims[k].inPairCh = closer.ch;
      delims[k].active = false;
    }
    ci = ciPos;
    if (closer.n === 0) ci += 1;
    // A closer with characters left is processed again against the
    // earlier openers on the next iteration.
  }
}

/* ---------------- link resolution ---------------- */

/* ============ link resolution ============ */

// Parse the "(destination "title")" part of an inline link, starting at
// the '(' at index `at`. On success returns { dest, title, next } with
// title null when absent; on any malformation returns null.
function parseInlineLink(text, at) {
  const n = text.length;
  if (text[at] !== '(') return null;
  const skipInlineWs = (p) => {
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p += 1;
    return p;
  };
  const isEscapedAt = (p) =>
    text[p] === '\\' && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1));
  let p = skipInlineWs(at + 1);
  if (p >= n) return null;
  let dest = '';
  if (text[p] === '<') {
    // Angle-bracket destination: everything up to the next '>' on the
    // same line, with backslash escapes resolved.
    let q = p + 1;
    while (q < n && text[q] !== '\n' && text[q] !== '>') {
      if (isEscapedAt(q)) { dest += text[q + 1]; q += 2; }
      else { dest += text[q]; q += 1; }
    }
    if (q >= n || text[q] !== '>') return null;
    p = q + 1;
  } else {
    // Bare destination: runs to whitespace or to the ')' that closes
    // the link, tracking balanced parentheses on the way.
    let depth = 0;
    while (p < n) {
      const c = text[p];
      if (isEscapedAt(p)) { dest += text[p + 1]; p += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth += 1;
      if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      dest += c;
      p += 1;
    }
  }
  // Then: optional whitespace, an optional title, optional whitespace,
  // and the closing ')'. The title must be preceded by whitespace —
  // otherwise (say, right after an angle destination) the quote
  // character belongs to the destination, not to a title.
  let q = skipInlineWs(p);
  let title = null;
  if (q < n && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
    if (q === p) return null; // title with no whitespace before it
    const opener = text[q];
    const closer = opener === '(' ? ')' : opener;
    let collected = '';
    let r = q + 1;
    let closed = false;
    while (r < n) {
      const c = text[r];
      if (isEscapedAt(r)) { collected += text[r + 1]; r += 2; continue; }
      if (c === closer) { closed = true; break; }
      collected += c; // a newline inside a title is kept verbatim
      r += 1;
    }
    if (!closed) return null;
    title = collected;
    q = skipInlineWs(r + 1);
  }
  if (q >= n || text[q] !== ')') return null;
  return { dest, title, next: q + 1 };
}

// Read the bracketed label that starts at the '[' at index `at`.
// Returns { label, next } or null. Labels do not nest — an unescaped
// '[' inside invalidates them — and they end at the first unescaped
// ']'. Backslashes stay verbatim in the returned label. A newline is
// allowed unless what follows it amounts to a blank line.
function parseLabel(text, at) {
  const n = text.length;
  if (text[at] !== '[') return null;
  let p = at + 1;
  let label = '';
  while (p < n) {
    const c = text[p];
    if (c === '\\' && p + 1 < n) { label += c + text[p + 1]; p += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label, next: p + 1 };
    if (c === '\n') {
      let q = p + 1;
      while (q < n && (text[q] === ' ' || text[q] === '\t')) q += 1;
      if (q < n && text[q] === '\n') return null;
      label += '\n';
      p += 1;
      continue;
    }
    label += c;
    p += 1;
  }
  return null;
}

// Does this node list contain a bracket-formed link anywhere inside?
// Autolinks are not links for this purpose: a bracket autolink <...>
// may sit inside link text, and an extended autolink is unlinked (see
// below) when the outer link forms.
function containsLink(children) {
  for (const node of children) {
    if (typeof node === 'string' || node.k === undefined) continue;
    if (node.k === 6 && !node.auto) return true;
    if (node.k >= 3 && node.k <= 6 && node.c && containsLink(node.c)) return true;
  }
  return false;
}

// Extended autolinks (www. / scheme:// / email) never form inside link
// text. The inline scanner meets them before it can know a link is
// forming, so when a link does form, any extended autolink among its
// children is demoted back to plain text. Bracket autolinks stay links.
function unlinkExtAutolinks(children) {
  const kept = [];
  for (const node of children) {
    if (typeof node === 'string') { kept.push(node); continue; }
    if (node.k === 6 && node.auto === 'ext') {
      let rawText = '';
      for (const part of node.c) {
        if (typeof part === 'string') rawText += part;
        else if (part.raw !== undefined) rawText += part.raw;
        else rawText += part.s;
      }
      kept.push(rawText);
      continue;
    }
    if ((node.k === 3 || node.k === 4 || node.k === 5 || node.k === 6) && node.c) {
      kept.push({ ...node, c: unlinkExtAutolinks(node.c) });
      continue;
    }
    kept.push(node);
  }
  return kept;
}

// The plain-text reading of inline children, used as image alt text:
// nested images contribute their own alt, links and emphasis contribute
// their inner text, code contributes its content, and raw HTML and hard
// breaks contribute nothing.
function altTextOf(children) {
  let out = '';
  for (const node of children) {
    if (typeof node === 'string') { out += node; continue; }
    switch (node.k) {
      case 0: out += node.s; break;
      case 1: case 2: break; // raw HTML, hard break: no text
      case 8: out += node.raw !== undefined ? node.raw : node.s; break;
      case 9: out += node.s; break;
      case 'd': out += node.s; break;
      case 3: case 4: case 5: case 6: out += altTextOf(node.c); break;
      case 7: out += node.alt; break;
    }
  }
  return out;
}

// --- label validation: marked's link/reflink label grammar ---
// A label is valid when a scanner can consume its whole raw text as a
// sequence of these chunks (a hand-written scanner for the grammar —
// no regex is copied):
//   [ ... ]  a nested bracket group (inner brackets go one level deep)
//   \x       an escaped character
//   `...`    a code-span chunk: a maximal backtick run, a middle with
//            no backticks, then the next backtick run (also maximal)
//   ``+      a run of 2+ backticks immediately before the closing ']'
//   x        any other single character (not '[', ']', '\' or '`')
// Shortcut references do NOT go through this grammar (their labels may
// hold backticks freely); it applies to inline links and to full and
// collapsed references only.
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
      // A run of 2+ backticks that reaches the end of the label is a
      // valid final chunk on its own.
      let q = p;
      while (q < n && raw[q] === '`') q += 1;
      if (q === n && q - p >= 2) return true;
      const after = matchLabelCodeSpan(raw, p);
      if (after < 0) return false;
      p = after;
    } else if (c === ']') {
      return false;
    } else {
      p += 1;
    }
  }
  return true;
}

// Consume a nested bracket group at s[pos]: '[' then any mix of
// one-level inner groups, escapes and ordinary characters, then ']'.
// Returns the index just past the ']', or -1.
function matchLabelBracket(s, pos) {
  let q = pos + 1;
  while (q < s.length) {
    const c = s[q];
    if (c === '[') {
      const inner = matchLabelBracketLe(s, q);
      if (inner < 0) return -1;
      q = inner;
    } else if (c === '\\') {
      if (q + 1 >= s.length) return -1;
      q += 2;
    } else if (c === ']') {
      return q + 1;
    } else {
      q += 1;
    }
  }
  return -1;
}

// Consume a one-level bracket group (marked's `brackets` alternative):
// '[' then escapes and non-bracket characters, then ']'. An inner '['
// rejects it. Returns the index just past the ']', or -1.
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
      q += 1;
    }
  }
  return -1;
}

// Consume a label code-span chunk at s[pos]: a maximal backtick run, a
// stretch of non-backtick characters, and the first backtick run after
// it (again maximal). Returns the index past the closing run, or -1
// when no closing run exists.
function matchLabelCodeSpan(s, pos) {
  const n = s.length;
  let openEnd = pos;
  while (openEnd < n && s[openEnd] === '`') openEnd += 1;
  let midEnd = openEnd;
  while (midEnd < n && s[midEnd] !== '`') midEnd += 1;
  if (midEnd >= n) return -1;
  let closeEnd = midEnd;
  while (closeEnd < n && s[closeEnd] === '`') closeEnd += 1;
  return closeEnd;
}

// Consume an Ot code span (the code-span alternative of marked's
// anyPunctuationOutsideCode): an opening backtick run; content that
// begins and ends with a non-backtick character — it may contain
// shorter backtick runs, exactly the ones the Ot mask rewrites to '+';
// and a closing run of the same length, not followed by another
// backtick. Returns the index past the closing run, or -1. This is the
// code-span grammar the blockSkip mask works with, applied to text the
// Ot mask has already neutralised.
function matchOtCodeSpan(s, pos) {
  const n = s.length;
  let openEnd = pos;
  while (openEnd < n && s[openEnd] === '`') openEnd += 1;
  const runLen = openEnd - pos;
  if (runLen === 0 || openEnd >= n || s[openEnd] === '`') return -1;
  let q = openEnd;
  while (q < n) {
    if (s[q] !== '`') { q += 1; continue; }
    let runEnd = q;
    while (runEnd < n && s[runEnd] === '`') runEnd += 1;
    if (runEnd - q === runLen) return runEnd;
    q = runEnd;
  }
  return -1;
}

// Does a label satisfy the blockSkip `link` label grammar — the grammar
// the emStrong mask sees, applied to Ot-masked text? No '[' or ']' may
// appear inside (the class is [^\[\]], so a nested bracket rejects the
// whole match); escapes and code spans (per matchOtCodeSpan) are the
// only structure. A label can pass here while failing validLabel (when
// its code span holds a backtick) and still mask the emphasis inside
// it: the link never forms, yet the outer emStrong scan never sees the
// label's delimiters.
function blockSkipLabelOk(raw) {
  const n = raw.length;
  let p = 0;
  while (p < n) {
    const c = raw[p];
    if (c === '[' || c === ']') return false;
    if (c === '\\') {
      if (p + 1 >= n) return false;
      p += 2;
      continue;
    }
    if (c === '`') {
      const after = matchOtCodeSpan(raw, p);
      if (after < 0) return false;
      p = after;
      continue;
    }
    p += 1;
  }
  return true;
}

// The end of a balanced-paren destination following '](' (the blockSkip
// `link` destination: one nesting level). text[p] must be '('. Returns
// the index just past the closing ')', or -1.
function blockSkipDestEnd(text, p) {
  const n = text.length;
  let q = p + 1;
  let depth = 0;
  while (q < n) {
    const c = text[q];
    if (c === '\\') { q += 2; continue; }
    if (c === '(') {
      if (depth > 0) return -1;
      depth += 1;
      q += 1;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return q + 1;
      depth -= 1;
      q += 1;
      continue;
    }
    q += 1;
  }
  return -1;
}

// The Ot mask (marked's anyPunctuationOutsideCode). It preserves length:
// a code span keeps its delimiter backticks but has every backtick
// inside its content replaced with '+', and a backslash-escaped
// punctuation character becomes '++'. Because positions are preserved,
// the blockSkip scan below can run on the masked text and report ranges
// in the original text.
function otMaskedText(text) {
  // Fast path: the mask only ever changes escaped punctuation and
  // backticks inside code spans. When the text holds neither a backtick
  // nor a backslash it is the identity — return it untouched.
  if (!text.includes('`') && !text.includes('\\')) return text;
  const chars = text.split('');
  const n = chars.length;
  let p = 0;
  while (p < n) {
    if (text[p] === '\\' && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) {
      chars[p] = '+';
      chars[p + 1] = '+';
      p += 2;
      continue;
    }
    if (text[p] === '`') {
      const spanEnd = matchOtCodeSpan(text, p);
      if (spanEnd >= 0) {
        let openEnd = p;
        while (openEnd < n && text[openEnd] === '`') openEnd += 1;
        const runLen = openEnd - p;
        for (let q = openEnd; q < spanEnd - runLen; q++) {
          if (chars[q] === '`') chars[q] = '+';
        }
        p = spanEnd;
        continue;
      }
      // No span here: step over the whole run.
      let q = p;
      while (q < n && text[q] === '`') q += 1;
      p = q;
      continue;
    }
    p += 1;
  }
  return chars.join('');
}

// Consume a blockSkip code-span chunk on masked text: a maximal
// backtick run, non-backtick content, and a closing run of the same
// length (maximality makes "not followed by another backtick"
// automatic). Returns the index past the closing run, or -1.
function matchBlockSkipCodeSpan(s, pos) {
  const n = s.length;
  let openEnd = pos;
  while (openEnd < n && s[openEnd] === '`') openEnd += 1;
  const runLen = openEnd - pos;
  if (runLen === 0) return -1;
  let midEnd = openEnd;
  while (midEnd < n && s[midEnd] !== '`') midEnd += 1;
  if (midEnd === openEnd || midEnd >= n) return -1;
  let closeEnd = midEnd;
  while (closeEnd < n && s[closeEnd] === '`') closeEnd += 1;
  if (closeEnd - midEnd !== runLen) return -1;
  return closeEnd;
}

// Match a whole blockSkip `link` on masked text, starting at the '[' at
// s[pos]: '[' + label + '](' + dest + ')'. The label holds no '[' or
// ']' (class [^\[\]]); a ']' that is not followed by '(' and a valid
// destination rejects the whole match. Returns the index past the
// destination's ')', or -1.
function matchBlockSkipLink(s, pos) {
  const n = s.length;
  let q = pos + 1;
  while (q < n) {
    const c = s[q];
    if (c === '\\') { q += 2; continue; }
    if (c === '`') {
      const after = matchBlockSkipCodeSpan(s, q);
      if (after < 0) return -1;
      q = after;
      continue;
    }
    if (c === '[' || c === ']') {
      if (c === ']' && s[q + 1] === '(') {
        const afterDest = blockSkipDestEnd(s, q + 1);
        if (afterDest >= 0) return afterDest;
      }
      return -1;
    }
    q += 1;
  }
  return -1;
}

// The ranges of `text` that marked's emStrong mask replaces (blockSkip:
// `[label](dest)` links, code spans and HTML tags), computed on the
// Ot-masked text so the ranges are positions in the original.
// Delimiters inside these ranges are invisible to the outer emphasis
// scan; they are re-lexed only inside a link that actually forms.
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
      p += 1;
      continue;
    }
    if (c === '`') {
      if (p > 0 && masked[p - 1] === '`') { p += 1; continue; }
      const after = matchBlockSkipCodeSpan(masked, p);
      if (after >= 0) { spans.push([p, after]); p = after; continue; }
      p += 1;
      continue;
    }
    if (c === '<') {
      if (masked[p + 1] !== ' ') {
        let q = p + 1;
        while (q < n && masked[q] !== '>' && masked[q] !== '<') q += 1;
        if (q < n && masked[q] === '>') { spans.push([p, q + 1]); p = q + 1; continue; }
      }
      p += 1;
      continue;
    }
    if (c === '\\') { p += 2; continue; }
    p += 1;
  }
  return spans;
}

// marked's Be() test: does the label (the raw text between `start` and
// `end` in `text`) contain a '<' that opens an HTML tag or an autolink
// running PAST the end of the label? Such a label rejects its link
// outright — inline, reference and shortcut alike. A '<' inside a code
// span does not count, and a tag or autolink that ends inside the label
// is simply stepped over.
function labelHasRunawayTag(text, start, end) {
  const raw = text.slice(start, end);
  if (raw.indexOf('<') === -1) return false;
  for (let q = 0; q < raw.length; q++) {
    const c = raw[q];
    if (c === '\\') { q += 1; continue; }
    if (c === '`') {
      const after = matchLabelCodeSpan(raw, q);
      if (after >= 0) { q = after - 1; continue; }
    }
    if (c !== '<') continue;
    const at = start + q;
    const tagHit = tryHtmlTag(text, at);
    const autoHit = tagHit === null ? tryBracketAutolink(text, at) : null;
    const hit = tagHit || autoHit;
    if (hit !== null) {
      const spanLen = hit.next - at;
      if (spanLen > end - at) return true;
      q += spanLen - 1;
    }
  }
  return false;
}

// A non-mutating rehearsal of tryCloseBracketOpener's decision: would a
// link form at the ']' at position j? It needs the nearest active
// opener, balanced brackets, a label that passes the runaway-tag test
// (and the label grammar where that applies), and a destination or
// reference that resolves. The code-span scanner uses this to avoid
// swallowing a ']' that a link is about to claim (the link pattern
// consumes the backticks as a label chunk first).
function wouldFormLink(text, j, delims, refs) {
  let opener = null;
  for (let d = delims.length - 1; d >= 0; d--) {
    if (delims[d].link && delims[d].active) { opener = delims[d]; break; }
  }
  if (opener === null) return false;
  // Bracket balance over the raw text between the opener and this ']':
  // count the unescaped occurrences of each bracket character (a
  // character is escaped when an odd number of backslashes precede it).
  const countUnescaped = (bracket) => {
    let total = 0;
    for (let k = opener.pos + 1; k < j; k++) {
      if (text[k] !== bracket) continue;
      let slashes = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) slashes += 1;
      if (slashes % 2 === 0) total += 1;
    }
    return total;
  };
  if (countUnescaped('[') !== countUnescaped(']')) return false;
  const rawLabel = text.slice(opener.pos + 1, j);
  if (labelHasRunawayTag(text, opener.pos + 1, j)) return false;
  if (text[j + 1] === '(') {
    if (!validLabel(rawLabel)) {
      // An inline link whose label is invalid falls back to a shortcut.
      return refs.has(normLabel(rawLabel));
    }
    if (parseInlineLink(text, j + 1) !== null) return true;
    return refs.has(normLabel(rawLabel));
  }
  if (text[j + 1] === '[') {
    if (!validLabel(rawLabel)) return false;
    const lab = parseLabel(text, j + 1);
    if (lab === null) return false;
    return refs.has(normLabel(lab.label === '' ? rawLabel : lab.label));
  }
  // Shortcut reference: no label-grammar check — backticks are free here.
  return refs.has(normLabel(rawLabel));
}

// Try to form a link or image at the ']' at position i. Every active
// link opener is tried, nearest first: the ']' closes the opener whose
// brackets balance with it — the nearest opener may be an inner '['
// that is merely part of the outer link's text (cm-512:
// [link [foo [bar]]](/uri) closes the OUTER '['). Returns { next } when
// a link formed (nodes and delims updated), otherwise null.
function tryCloseBracket(text, i, nodes, delims, refs) {
  for (let d = delims.length - 1; d >= 0; d--) {
    if (!delims[d].link || !delims[d].active) continue;
    const opener = delims[d];
    const ai = nodes.indexOf(opener);
    // Balance test: every unmatched '[' inside must be matched by a
    // literal ']' inside, so a ']' sitting inside a nested bracket
    // pair does not close the outer opener (cm-520: the middle ']' of
    // ![[[foo](uri1)](uri2)](uri3) fails, and the last one forms the
    // image with alt '[foo](uri2)').
    let openCount = 0;
    let closeCount = 0;
    for (let k = ai + 1; k < nodes.length; k++) {
      const node = nodes[k];
      if (typeof node === 'string') {
        for (let q = 0; q < node.length; q++) if (node[q] === ']') closeCount += 1;
      } else if (node.k === 'd' && node.link) {
        openCount += 1;
      }
    }
    // A ']' produced by a backslash escape (\]) lands in a string node
    // but is not a bracket, so it must not count as a close (cm-194:
    // [Foo*bar\]] holds one escaped ']' in its label).
    for (let k = opener.pos + 1; k < i; k++) {
      if (text[k] !== ']') continue;
      let slashes = 0;
      for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) slashes += 1;
      if (slashes % 2 === 1) closeCount -= 1;
    }
    if (openCount !== closeCount) continue;
    // A link may not contain another link; an image may.
    if (!opener.image && containsLink(nodes.slice(ai + 1))) continue;
    const made = tryCloseBracketOpener(text, i, nodes, delims, opener, refs);
    if (made) return made;
  }
  return null;
}

// Resolve the ']' at i against one specific opener, as an inline link,
// a full or collapsed reference, or a shortcut reference. Returns
// { next } or null. A label holding a '<' that starts a tag or autolink
// running past the ']' rejects the link outright (marked's Be). Inline
// links and full/collapsed references also need the label to satisfy
// the label grammar (validLabel); shortcut references do not.
function tryCloseBracketOpener(text, i, nodes, delims, opener, refs) {
  const rawLabel = text.slice(opener.pos + 1, i);
  if (labelHasRunawayTag(text, opener.pos + 1, i)) return null;
  let dest = null;
  let title = null;
  let next = i + 1;
  if (text[i + 1] === '(') {
    const parsed = parseInlineLink(text, i + 1);
    if (parsed && validLabel(rawLabel)) {
      dest = parsed.dest;
      title = parsed.title;
      next = parsed.next;
    } else {
      // A failed inline link falls back to a shortcut reference.
      const ref = refs.get(normLabel(rawLabel));
      if (!ref) return null;
      dest = ref.href;
      title = ref.title;
    }
  } else if (text[i + 1] === '[') {
    if (!validLabel(rawLabel)) return null;
    const labelRef = parseLabel(text, i + 1);
    if (!labelRef) return null;
    // A collapsed reference [] takes the link text as its label — the
    // RAW source text, backslashes kept, not the resolved inline text.
    const key = normLabel(labelRef.label === '' ? rawLabel : labelRef.label);
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.href;
    title = ref.title;
    next = labelRef.next;
  } else {
    // Shortcut reference: the label is the raw link text.
    const ref = refs.get(normLabel(rawLabel));
    if (!ref) return null;
    dest = ref.href;
    title = ref.title;
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  // Emphasis inside the link text is resolved before wrapping.
  processEmphasis(nodes, delims, delims.indexOf(opener) + 1, text);
  const ai = nodes.indexOf(opener);
  let children = nodes.slice(ai + 1);
  // Extended autolinks do not form inside link text.
  if (!opener.image) children = unlinkExtAutolinks(children);
  let node;
  if (opener.image) {
    node = { k: 7, src: escText(href), title: title === null ? null : escText(title), alt: escText(altTextOf(children)) };
  } else {
    node = { k: 6, href: escText(href), title: title === null ? null : escText(title), c: children };
  }
  nodes.splice(ai, nodes.length - ai, node);
  // The opener and everything after it leave the delimiter stack.
  delims.splice(delims.indexOf(opener));
  if (!opener.image) {
    // Links cannot nest: retire every earlier LINK opener. Image
    // openers stay active, so an outer image can still form.
    for (const cand of delims) if (cand.link && !cand.image) cand.active = false;
  }
  return { next };
}

// The raw text of everything between `opener` and the end of `nodes`
// (references decoded, escapes resolved) — used for reference labels.
// Differs from nodesTextOf only at the top level, where raw-block nodes
// (k:9) contribute nothing here.
function nodesTextBetween(nodes, opener) {
  const ai = nodes.indexOf(opener);
  let out = '';
  for (let k = ai + 1; k < nodes.length; k++) {
    const node = nodes[k];
    if (typeof node === 'string') { out += node; continue; }
    switch (node.k) {
      case 0: case 1: out += node.s; break;
      case 8: out += node.raw !== undefined ? node.raw : node.s; break;
      case 'd': out += node.s; break;
      case 3: case 4: case 5: case 6: out += nodesTextOf(node.c); break;
      case 7: out += node.alt; break;
    }
  }
  return out;
}
function nodesTextOf(children) {
  let out = '';
  for (const node of children) {
    if (typeof node === 'string') { out += node; continue; }
    switch (node.k) {
      case 0: case 1: out += node.s; break;
      case 8: out += node.raw !== undefined ? node.raw : node.s; break;
      case 9: out += node.s; break;
      case 'd': out += node.s; break;
      case 3: case 4: case 5: case 6: out += nodesTextOf(node.c); break;
      case 7: out += node.alt; break;
    }
  }
  return out;
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
  let pendingBlank = false;
  let i = start;
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
    const r = parseParagraph(lines, i, end, refs,
      stripAtEnd, inList);
    if (r.block) blocks.push(r.block);
    i = r.next;
  }
  const tail = blocks[blocks.length - 1];
  const endsWithText = end > start && !isBlank(lines[end - 1]);
  return { blocks, blankBetween, lastKind: tail ? tail.t : null, lastNonBlank: endsWithText };
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
  let row = b.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) {
    let slashes = 0;
    for (let p = row.length - 2; p >= 0 && row[p] === '\\'; p--) slashes++;
    if (slashes % 2 === 0) row = row.slice(0, -1);
  }
  const cells = [];
  let cell = '';
  for (let p = 0; p < row.length; p++) {
    const c = row[p];
    if (c === '\\') {
      let slashes = 0;
      while (p + slashes < row.length && row[p + slashes] === '\\') slashes++;
      if (p + slashes < row.length && row[p + slashes] === '|') {
        if (slashes % 2 === 1) { cell += '\\'.repeat(slashes - 1) + '|'; p += slashes; continue; }
        cell += '\\'.repeat(slashes); p += slashes - 1; continue;
      }
      cell += '\\'.repeat(slashes); p += slashes - 1; continue;
    }
    if (c === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

// Parse a delimiter row; returns the alignment array or null.
function parseDelimiterRow(b) {
  const cells = splitTableRow(b);
  const aligns = [];
  for (const cell of cells) {
    const hit = /^(:?)-+(:?)$/.exec(cell);
    if (!hit) return null;
    aligns.push(hit[1] === ':' && hit[2] === ':' ? 'center' : hit[1] === ':' ? 'left' : hit[2] === ':' ? 'right' : null);
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
  let spaces = 0;
  while (spaces < b.length && b[spaces] === ' ') spaces++;
  if (spaces === b.length) return false; // spaces-only: blank
  if (spaces >= 4) return false; // 4-space indent: code
  return spaces + 1 === b.length; // tab must be the last character
}

function parseTable(lines, i, end) {
  const head = splitTableRow(body(lines[i]));
  const aligns = parseDelimiterRow(body(lines[i + 1]));
  const rows = [];
  let q = i + 2;
  while (q < end) {
    const line = lines[q];
    if (isBlank(line)) {
      if (isTableBlankRow(body(line))) { rows.push(splitTableRow(body(line))); q++; continue; }
      break;
    }
    const rowBody = body(line);
    if (indentCols(rowBody) >= 4) break;
    if (matchATX(rowBody) || matchFencedStart(rowBody) || isThematicBreak(rowBody)) break;
    if (htmlBlockType(rowBody, true) > 0) break;
    if (stripQuote(line) !== null) break;
    const marker = matchListStart(rowBody);
    if (marker && listInterruptsPara(marker, rowBody)) break;
    rows.push(splitTableRow(rowBody));
    q++;
  }
  for (const row of rows) {
    while (row.length < head.length) row.push('');
    if (row.length > head.length) row.length = head.length;
  }
  return { block: { t: 'table', align: aligns, head, rows }, next: q };
}

/* --- paragraph, setext, link-reference definitions --- */

function setextLevel(b) {
  let p = 0;
  while (p < b.length && b[p] === ' ' && p < 3) p++;
  if (p >= b.length) return 0;
  const mark = b[p];
  if (mark !== '=' && mark !== '-') return 0;
  let q = p;
  while (q < b.length && b[q] === mark) q++;
  while (q < b.length && (b[q] === ' ' || b[q] === '\t')) q++;
  if (q !== b.length) return 0;
  return mark === '=' ? 1 : 2;
}

// Try to parse a link-reference definition starting at lines[i].
// Returns {label, href, title, next} or null. The label may span lines;
// the destination and title may be on following lines; a definition
// never spans a blank line.
function tryDef(lines, i, end) {
  // join the following non-blank lines into one string to parse
  const parts = [];
  let q = i;
  while (q < end && !isBlank(lines[q]) && parts.length < 50) { parts.push(body(lines[q])); q++; }
  if (parts.length === 0) return null;
  const s = parts.join('\n');
  const starts = [0];
  for (let r = 0; r < parts.length; r++) starts.push(starts[r] + parts[r].length + 1);
  const lineAt = (off) => {
    let r = 0;
    while (r + 1 < starts.length && starts[r + 1] <= off) r++;
    return r;
  };
  let p = 0;
  while (p < s.length && s[p] === ' ' && p < 3) p++;
  if (s[p] !== '[') return null;
  const labelMatch = parseLabel(s, p);
  if (!labelMatch) return null;
  const label = labelMatch.label;
  if (label === '' || normLabel(label) === '') return null;
  let cur = labelMatch.next;
  // ']' must be followed immediately by ':' (no whitespace between)
  if (s[cur] !== ':') return null;
  cur++;
  // spaces only (no tab) before the destination; it may be on the next
  // line (newline + spaces/tabs)
  while (cur < s.length && s[cur] === ' ') cur++;
  if (cur < s.length && s[cur] === '\n') {
    cur++;
    while (cur < s.length && (s[cur] === ' ' || s[cur] === '\t')) cur++;
  }
  if (cur >= s.length) return null;
  let dest = '';
  if (s[cur] === '<') {
    let r = cur + 1;
    while (r < s.length && s[r] !== '\n' && s[r] !== '>') {
      if (s[r] === '\\' && r + 1 < s.length && isAsciiPunct(s.charCodeAt(r + 1))) { dest += s[r + 1]; r += 2; }
      else { dest += s[r]; r++; }
    }
    if (r >= s.length || s[r] !== '>') return null;
    cur = r + 1;
  } else {
    let r = cur, depth = 0;
    while (r < s.length) {
      const c = s[r];
      if (c === '\\' && r + 1 < s.length && isAsciiPunct(s.charCodeAt(r + 1))) { dest += s[r + 1]; r += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      dest += c; r++;
    }
    if (dest === '' || depth !== 0) return null;
    cur = r;
  }
  // optional title (must be preceded by whitespace)
  let title = null;
  let tq = cur, sawSpace = false;
  while (tq < s.length && (s[tq] === ' ' || s[tq] === '\t')) { tq++; sawSpace = true; }
  if (tq < s.length && s[tq] === '\n') {
    tq++;
    while (tq < s.length && (s[tq] === ' ' || s[tq] === '\t')) tq++;
    sawSpace = true;
  }
  if (sawSpace && tq < s.length && (s[tq] === '"' || s[tq] === "'" || s[tq] === '(')) {
    const quote = s[tq];
    const closer = quote === '(' ? ')' : quote;
    let titleText = '', r = tq + 1, ok = false;
    while (r < s.length) {
      const c = s[r];
      if (c === '\\' && r + 1 < s.length && isAsciiPunct(s.charCodeAt(r + 1))) { titleText += s[r + 1]; r += 2; continue; }
      if (c === closer) { ok = true; break; }
      titleText += c; r++;
    }
    if (ok) {
      // only whitespace may follow the closing quote on its line
      let tail = r + 1;
      while (tail < s.length && (s[tail] === ' ' || s[tail] === '\t')) tail++;
      if (tail >= s.length || s[tail] === '\n') { title = titleText; cur = tail; }
    }
  }
  // after dest/title, only spaces may remain, then a newline or the end
  let tail = cur;
  while (tail < s.length && (s[tail] === ' ' || s[tail] === '\t')) tail++;
  if (tail < s.length && s[tail] !== '\n') return null;
  return { label, href: dest, title, next: i + lineAt(tail) + 1 };
}

// True when a setext heading may not form over lines[j..k): some content
// line after the first starts a block construct (marked's lheading content
// restriction). The table pattern here requires a pipe — a bare '---'
// delimiter line does not block.
function setextBlocked(lines, j, k) {
  for (let r = j + 1; r < k; r++) {
    const b = body(lines[r]);
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
  let q = i;
  // leading link-reference definitions
  while (q < end) {
    const def = tryDef(lines, q, end);
    if (!def) break;
    if (!refs.has(normLabel(def.label))) refs.set(normLabel(def.label), { href: def.href, title: def.title });
    q = def.next;
  }
  if (q >= end || isBlank(lines[q])) return { block: null, next: q };
  const firstLine = body(lines[q]);
  // a table may start the paragraph position
  if (q + 1 < end && isTableHeader(firstLine, body(lines[q + 1]))) {
    const table = parseTable(lines, q, end);
    return { block: table.block, next: table.next };
  }
  if (startsInterruptBlock(firstLine, inList)) return { block: null, next: q };
  const paraLines = [];
  let r = q;
  while (r < end) {
    const b = body(lines[r]);
    if (isBlank(lines[r])) {
      // a whitespace-only line is a continuation only when it is the last
      // line of the range and has no trailing newline (an inner/container
      // range's text has no trailing newline, so its last line qualifies).
      // A truly empty line never counts.
      if (r === end - 1 && paraLines.length > 0 && body(lines[r]) !== '' && (!hasNL(lines[r]) || inner)) {
        paraLines.push(lines[r]);
        r++;
      }
      break;
    }
    if (paraLines.length > 0) {
      const level = setextLevel(b);
      if (level && !setextBlocked(lines, q, r)) {
        // a setext heading's content is the paragraph text trimmed
        const headingText = joinParaLines(paraLines).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        return { block: { t: 'head', level, text: headingText }, next: r + 1 };
      }
      if (r + 1 < end && isTableCandidate(b, body(lines[r + 1]))) {
        // a table header candidate stops the paragraph — unless the
        // delimiter line is a setext underline for the paragraph
        // including this line
        const nextLine = body(lines[r + 1]);
        if (setextLevel(nextLine) > 0 && !setextBlocked(lines, q, r + 1)) {
          paraLines.push(lines[r]);
          r++;
          continue;
        }
        break;
      }
      if (startsInterruptBlock(b, inList)) break;
    }
    paraLines.push(lines[r]);
    r++;
  }
  return { block: { t: 'para', text: joinParaLines(paraLines) }, next: r };
}

// True when the line starts a block that interrupts a paragraph.
function startsInterruptBlock(b, inList) {
  if (matchATX(b)) return true;
  if (matchFencedStart(b)) return true;
  if (isThematicBreak(b)) return true;
  if (htmlBlockType(b, true) > 0) return true;
  if (stripQuoteText(b) !== null) return true;
  const marker = matchListStart(b);
  if (marker && listInterruptsPara(marker, b, inList)) return true;
  return false;
}

function stripQuoteText(b) {
  let p = 0;
  while (p < b.length && b[p] === ' ' && p < 3) p++;
  return b[p] === '>' ? b.slice(p + 1) : null;
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
        let ct = b.text;
        if (ct !== '') {
          if (ct.charCodeAt(ct.length - 1) === 10) ct = ct.slice(0, -1);
          ct += '\n';
        }
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
        for (let col = 0; col < b.head.length; col++) {
          const alignAttr = b.align[col] ? ' align="' + b.align[col] + '"' : '';
          out += '<th' + alignAttr + '>' + parseInline(b.head[col], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let col = 0; col < b.head.length; col++) {
              const cell = row[col] !== undefined ? row[col] : '';
              const alignAttr = b.align[col] ? ' align="' + b.align[col] + '"' : '';
              out += '<td' + alignAttr + '>' + parseInline(cell, refs) + '</td>\n';
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
    const check = /^\[( |x|X)\]([ \t]|$)/.exec(item[0].text);
    if (check) {
      const isChecked = check[1] === 'x' || check[1] === 'X';
      const afterCheck = item[0].text.slice(3);
      const box = isChecked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      if (tight) out += box + parseInline(afterCheck, refs);
      else out += '<p>' + box + parseInline(afterCheck, refs) + '</p>\n';
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
  // document-level inline state starts fresh for every document
  inLink = false;
  inRawBlock = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const docLines = splitLines(src);
  const refs = new Map();
  const { blocks } = parseBlocks(docLines, 0, docLines.length, refs, false);
  return renderBlocks(blocks, refs, false);
}

// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Returns exactly what csv-reader's readCsv returns for {text, header}:
// {columns, rows, errors} under the same broken-row policy (BOM dropped,
// CRLF/LF record ends, blank lines are no records, stray CRs dropped with
// stray_cr, quoted fields with "" escapes and LF-normalised line breaks
// inside, quote_junk after a closing quote, unterminated quotes re-read as
// unquoted, short_row/long_row padding and cutting to the first record's
// width, errors in the order met).
//
// Speed comes from never reading the text one character at a time:
//   - fast path: a record whose line holds no '"' and no stray CR is split
//     with one native String split (slice + split, both C++);
//   - slow path: only records that hold a quote or a stray CR are walked
//     field by field, and each field is scanned with native indexOf calls
//     (next comma / line break / quote) instead of a per-character loop.
// No per-field allocation on the fast path beyond the fields themselves;
// no regular expressions; no dependencies. Pure: no clock, no randomness,
// no locale, nothing kept from one call to the next.

// Field terminators, as numbers for charCodeAt comparisons.
const COMMA = 0; // ended at a comma (the record goes on)
const LINE_BREAK = 1; // ended at a line break (the record ends)
const END = 2; // ended at the end of the text (the record ends)

const C_COMMA = 44; // ','
const C_QUOTE = 34; // '"'
const C_LF = 10; // '\n'
const C_CR = 13; // '\r'
const C_BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === C_BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      if (pos >= len) return { value, ended: END, added };
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      let end = len;
      let ended = END;
      if (comma !== -1 && (lf === -1 || comma < lf)) {
        end = comma;
        ended = COMMA;
      } else if (lf !== -1) {
        end = lf;
        ended = LINE_BREAK;
      }
      // CRLF: the field ends before the CR, the line break consumes both.
      // (A stray CR may still hide inside the field before that CR, so the
      // segment below is always checked for '\r' first.)
      let crlf = false;
      if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === C_CR) {
        end -= 1;
        crlf = true;
      }
      const seg = text.slice(pos, end);
      if (seg.indexOf('\r') === -1) {
        if (seg.length !== 0) {
          value += seg;
          added += seg.length;
        }
        if (ended === COMMA) pos = end + 1;
        else if (ended === LINE_BREAK) {
          pos = end + (crlf ? 2 : 1);
          line += 1;
        } else {
          pos = end;
        }
        return { value, ended, added };
      }
      // Stray CRs inside the field: drop each (stray_cr), keep the rest.
      let s = 0;
      for (;;) {
        const cr = seg.indexOf('\r', s);
        if (cr === -1) break;
        if (cr > s) {
          value += seg.slice(s, cr);
          added += cr - s;
        }
        error('stray_cr');
        s = cr + 1;
      }
      if (s < seg.length) {
        value += seg.slice(s);
        added += seg.length - s;
      }
      pos = end;
      // Loop again: the comma / line break / end at pos ends the field.
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let closed = false;
    while (pos < len) {
      const q = text.indexOf('"', pos);
      const limit = q === -1 ? len : q;
      const seg = text.slice(pos, limit);
      if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
        if (q === -1) {
          value += seg;
          pos = len;
          break;
        }
        value += seg;
        if (text.charCodeAt(q + 1) === C_QUOTE) {
          value += '"';
          pos = q + 2;
          continue;
        }
        pos = q + 1;
        closed = true;
        break;
      }
      // Line break(s) inside the quotes: each CRLF or lone CR reads as one
      // LF, and every line break counts a line.
      let s = 0;
      for (;;) {
        const nl = seg.indexOf('\n', s);
        const cr = seg.indexOf('\r', s);
        let br = -1;
        let isCR = false;
        if (cr !== -1 && (nl === -1 || cr < nl)) {
          br = cr;
          isCR = true;
        } else if (nl !== -1) {
          br = nl;
        }
        if (br === -1) break;
        if (br > s) value += seg.slice(s, br);
        value += '\n';
        line += 1;
        s = br + 1;
        if (isCR && seg.charCodeAt(s) === C_LF) s += 1;
      }
      if (s < seg.length) value += seg.slice(s);
      pos = limit;
      if (q === -1) {
        pos = len;
        break;
      }
      if (text.charCodeAt(q + 1) === C_QUOTE) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === C_COMMA) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === C_LF) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === C_CR && text.charCodeAt(pos + 1) === C_LF) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Finishes a record: the header is kept as columns; any other record is
  // padded with "" (short_row) or cut (long_row) to the first record's
  // width, then pushed to rows.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // The error codes the line parser below met, in order; they are only
  // pushed to `errors` when the line parser finishes the record, so a
  // record it gives up on (a quoted field that does not close on its line)
  // leaves no error behind for the slow path to repeat.
  let lineCodes = null;
  // Whether the line parser's last field was quoted (for the no-record
  // rule: one empty unquoted field is no record).
  let lineQuoted = false;

  // Parses one record out of its first physical line, `lineStr` (the
  // CRLF's CR already stripped). Returns the fields, or null when a quoted
  // field does not close on this line: the record then spans lines (a line
  // break inside quotes) or its quote never closes, and the caller falls
  // back to the slow path. Every other broken thing a single-line record
  // can hold is handled here exactly as the reference handles it: quotes
  // inside unquoted fields are literal, "" inside quotes is one quote,
  // junk after a closing quote is appended (quote_junk), stray CRs are
  // dropped (stray_cr). `hasCR` says whether the line holds any '\r' at
  // all; when it does not, the CR checks are skipped outright.
  // Lines the line parser's record consumed beyond its terminating LF:
  // each lone CR inside quotes reads as one LF and counts a line.
  let lineExtraLines = 0;

  function tryLineRecord(lineStr, hasCR) {
    const fields = [];
    const codes = [];
    const L = lineStr.length;
    let p = 0;
    let quoted = false;
    lineExtraLines = 0;
    // A quoted segment with its lone CRs read as LFs (a CRLF inside quotes
    // cannot sit on this line: its LF would end the line, so the record
    // would have fallen back to the slow path). When the line holds no CR
    // at all this is a plain slice.
    function qseg(a, b) {
      if (!hasCR) return lineStr.slice(a, b);
      let out = '';
      let s = a;
      for (;;) {
        const cr = lineStr.indexOf('\r', s);
        if (cr === -1 || cr >= b) break;
        out += lineStr.slice(s, cr) + '\n';
        lineExtraLines += 1;
        s = cr + 1;
      }
      if (s < b) out += lineStr.slice(s, b);
      return out;
    }
    for (;;) {
      quoted = lineStr.charCodeAt(p) === C_QUOTE;
      if (quoted) {
        // Find the closing quote, folding "" into one quote.
        let val = '';
        let segStart = p + 1;
        let q = segStart;
        let closedAt = -1;
        for (;;) {
          const nq = lineStr.indexOf('"', q);
          if (nq === -1) return null;
          if (lineStr.charCodeAt(nq + 1) === C_QUOTE) {
            val += qseg(segStart, nq) + '"';
            q = nq + 2;
            segStart = q;
            continue;
          }
          val += qseg(segStart, nq);
          closedAt = nq + 1;
          break;
        }
        if (closedAt >= L) {
          fields.push(val);
          break;
        }
        if (lineStr.charCodeAt(closedAt) === C_COMMA) {
          fields.push(val);
          p = closedAt + 1;
          continue;
        }
        // Junk after the closing quote, up to the next comma or the line's
        // end, appended as it stands (stray CRs dropped, as unquoted).
        const comma = lineStr.indexOf(',', closedAt);
        const jend = comma === -1 ? L : comma;
        let junk = lineStr.slice(closedAt, jend);
        if (hasCR && junk.indexOf('\r') !== -1) {
          let kept = '';
          let s = 0;
          for (;;) {
            const cr = junk.indexOf('\r', s);
            if (cr === -1) break;
            if (cr > s) kept += junk.slice(s, cr);
            codes.push('stray_cr');
            s = cr + 1;
          }
          if (s < junk.length) kept += junk.slice(s);
          junk = kept;
        }
        if (junk.length > 0) {
          val += junk;
          codes.push('quote_junk');
        }
        fields.push(val);
        if (comma === -1) break;
        p = comma + 1;
        continue;
      }
      // Plain field: up to the next comma or the line's end.
      const comma = lineStr.indexOf(',', p);
      const fend = comma === -1 ? L : comma;
      let f = lineStr.slice(p, fend);
      if (hasCR && f.indexOf('\r') !== -1) {
        let kept = '';
        let s = 0;
        for (;;) {
          const cr = f.indexOf('\r', s);
          if (cr === -1) break;
          if (cr > s) kept += f.slice(s, cr);
          codes.push('stray_cr');
          s = cr + 1;
        }
        if (s < f.length) kept += f.slice(s);
        f = kept;
      }
      fields.push(f);
      if (comma === -1) break;
      p = comma + 1;
    }
    lineCodes = codes;
    lineQuoted = quoted;
    return fields;
  }

  while (pos < len) {
    // Lines with no characters are no records.
    let c = text.charCodeAt(pos);
    if (c === C_LF) {
      pos += 1;
      line += 1;
      continue;
    }
    if (c === C_CR && text.charCodeAt(pos + 1) === C_LF) {
      pos += 2;
      line += 1;
      continue;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first physical line: it ends at the next LF (or the
    // end of the text); a CR right before that LF is the CRLF ending, not
    // a stray CR.
    const lf = text.indexOf('\n', pos);
    let lineEnd = lf === -1 ? len : lf;
    if (lf !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === C_CR) lineEnd -= 1;
    const lineStr = text.slice(pos, lineEnd);
    const hasQuote = lineStr.indexOf('"') !== -1;
    const hasCR = lineStr.indexOf('\r') !== -1;

    // Fast path: the line holds no quote and no stray CR; one native
    // split gives the fields.
    if (!hasQuote && !hasCR) {
      const fields = lineStr.split(',');
      pos = lf === -1 ? len : lf + 1;
      if (lf !== -1) line += 1;
      finishRecord(fields);
      continue;
    }

    // Line path: the record holds a quote or a stray CR, but every quoted
    // field closes on this line; parse the line directly.
    const lined = tryLineRecord(lineStr, hasCR);
    if (lined !== null) {
      pos = lf === -1 ? len : lf + 1;
      if (lf !== -1) line += 1 + lineExtraLines;
      for (let i = 0; i < lineCodes.length; i++) error(lineCodes[i]);
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (lined.length === 1 && lined[0] === '' && !lineQuoted) continue;
      finishRecord(lined);
      continue;
    }

    // Slow path: a quoted field runs past this line (a line break inside
    // quotes) or never closes; walk the record field by field exactly as
    // the reference does.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === C_QUOTE;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

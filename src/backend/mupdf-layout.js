// Backend wrapper around mupdf.js for the shared layout engine.
//
// ADR-0002: viewer renderer & pdf renderer must use the SAME layout
// computation to guarantee pixel parity.
//
// Domain layer must NOT import this directly. Render layer is the gateway.

import * as mupdf from "mupdf";

/**
 * Cached fonts keyed by stable id (e.g. file path or hash).
 * @type {Map<string, mupdf.Font>}
 */
const fontCache = new Map();

/**
 * Load a font from a Buffer / TTF data and cache it.
 *
 * @param {string} id           stable identifier (used for cache + later lookup)
 * @param {string} name         display name (passed to mupdf.Font ctor)
 * @param {Buffer | Uint8Array | ArrayBuffer} data
 * @returns {mupdf.Font}
 */
export function loadFont(id, name, data) {
  if (fontCache.has(id)) return fontCache.get(id);
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const font = new mupdf.Font(name, buf);
  fontCache.set(id, font);
  return font;
}

/**
 * Get a previously loaded font by id.
 * @param {string} id
 */
export function getFont(id) {
  return fontCache.get(id) ?? null;
}

/**
 * Per-glyph layout metrics for a string.
 *
 * @typedef {object} GlyphMetric
 * @property {number} gid
 * @property {number} unicode
 * @property {number} x       advance position from start (PDF point at fontSize=1)
 * @property {number} advance glyph advance (PDF point at fontSize=1)
 * @property {string} char
 */

/**
 * Compute glyph layout for a single line of text.
 * Returns positions in "font-unit space" (multiply by fontSize).
 *
 * No line wrapping. Caller is responsible for line breaking.
 *
 * @param {mupdf.Font} font
 * @param {string} text
 * @returns {{ glyphs: GlyphMetric[], totalAdvance: number }}
 */
export function shapeLine(font, text) {
  const glyphs = [];
  let cursor = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const gid = font.encodeCharacter(code);
    const advance = font.advanceGlyph(gid, 0);
    glyphs.push({ gid, unicode: code, x: cursor, advance, char: ch });
    cursor += advance;
  }
  return { glyphs, totalAdvance: cursor };
}

/**
 * Convenience: total width of a line at a given font size.
 *
 * @param {mupdf.Font} font
 * @param {string} text
 * @param {number} fontSize  PDF point
 */
export function measureLine(font, text, fontSize) {
  const { totalAdvance } = shapeLine(font, text);
  return totalAdvance * fontSize;
}

/**
 * Word-aware (CJK-aware) line break: split text into lines so each fits within maxWidth.
 *
 * MVP behavior:
 *   - Hard break at U+000A (LF).
 *   - Otherwise greedy fit per character (CJK-style "any character is a break point").
 *   - Latin space is also treated as a break point.
 *   - 禁則処理は未実装（M6 で追加検討）。
 *
 * @param {mupdf.Font} font
 * @param {string} text
 * @param {number} fontSize
 * @param {number} maxWidth   PDF point
 * @returns {string[]}
 */
export function wrapLines(font, text, fontSize, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const ch of paragraph) {
      const code = ch.codePointAt(0);
      const gid = font.encodeCharacter(code);
      const advance = font.advanceGlyph(gid, 0) * fontSize;
      if (line.length > 0 && lineWidth + advance > maxWidth) {
        lines.push(line);
        line = ch;
        lineWidth = advance;
      } else {
        line += ch;
        lineWidth += advance;
      }
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

/**
 * Dispose all cached fonts. Call on workspace close.
 */
export function disposeFonts() {
  for (const font of fontCache.values()) {
    try {
      font.destroy();
    } catch {
      // ignore
    }
  }
  fontCache.clear();
}

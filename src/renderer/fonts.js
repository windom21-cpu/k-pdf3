// Renderer-side font registry for text overlays.
//
// One source of truth for the CSS font-family stacks the viewer applies
// to live overlay DOM elements and the exporter passes to canvas
// fillText. Stamps still have their own hardcoded stack — they're
// rendered bold and the visual identity is part of the印影 design, so
// they don't go through this picker.
//
// Backwards compatibility: overlays saved with `fontId: "default"`
// (pre §17.9) keep their original gothic look. New placements default
// to mincho per the user's spec — see TEXT_FONT_DEFAULT_ID.

export const TEXT_FONT_STACKS = {
  default:
    '"MS UI Gothic", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", sans-serif',
  gothic:
    '"MS UI Gothic", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", sans-serif',
  mincho:
    '"MS 明朝", "MS Mincho", "Hiragino Mincho ProN", "Yu Mincho", "IPAexMincho", "Noto Serif JP", serif',
  serif:
    '"Times New Roman", "MS 明朝", "Hiragino Mincho ProN", serif',
  sans:
    '"Helvetica Neue", "Arial", "MS UI Gothic", sans-serif',
};

/** Display labels for the toolbar font select. */
export const TEXT_FONT_LABELS = {
  mincho: "明朝",
  gothic: "ゴシック",
  serif: "Serif",
  sans: "Sans",
};

/** β32: family name of the digits-only @font-face declared in style.css.
 *  Prepended to the resolved text stack when `digitsHanko` is on, so
 *  half-width digits 0-9 render in hanko style while every other
 *  character keeps the user's chosen main font. */
export const TEXT_DIGITS_HANKO_FAMILY = '"CrashNumberingDigits"';

/** New text overlays default to mincho per §17.9. */
export const TEXT_FONT_DEFAULT_ID = "mincho";

/** Default font size for a new text overlay (pt → CSS px at zoom 1). */
export const TEXT_FONT_DEFAULT_SIZE = 12;

/** Toolbar size preset menu options (§17.12). */
export const TEXT_FONT_SIZE_PRESETS = [8, 10, 12, 14, 18, 24, 36];

/**
 * Resolve a fontId (possibly missing or unknown) to a CSS font-family
 * stack. Falls back to the legacy `default` stack so older overlays
 * keep rendering even if a fontId gets removed in the future.
 *
 * β32: pass `{ digitsHanko: true }` to prepend the digits-only hanko
 * face onto the resolved stack. The CrashNumberingDigits @font-face
 * has unicode-range U+0030-0039, so only 0-9 land in the hanko face;
 * letters / punctuation / CJK fall straight through to the main stack.
 *
 * β31 compatibility: text overlays saved with fontId === "numeric"
 * (the short-lived single-axis design) are re-routed to mincho + hanko
 * digits so existing pages keep looking close to what the user saw.
 */
export function getTextFontStack(fontId, opts = {}) {
  if (fontId === "numeric") {
    // β31 legacy — map to the new two-axis form (mincho + hanko digits)
    return `${TEXT_DIGITS_HANKO_FAMILY}, ${TEXT_FONT_STACKS.mincho}`;
  }
  const main = TEXT_FONT_STACKS[fontId] ?? TEXT_FONT_STACKS.default;
  if (opts.digitsHanko) return `${TEXT_DIGITS_HANKO_FAMILY}, ${main}`;
  return main;
}

// ---- Stamp fonts (ADR-0019 後半) ----------------------------------------
//
// Stamps render with their own stacks because:
//  - they're always bold (印影 weight),
//  - users want a numeric-serif font for half-width digits in date
//    stamps (e.g. CrashNumberingSerif → makes `8.5.9` look hanko-like)
//    while keeping CJK kanji in MS明朝 / IPAex明朝.
//
// The font_full / font_half split lets the user pick those two stacks
// independently. Both default to mincho so unconfigured stamps still
// look like the M6 baseline. CrashNumberingSerif isn't bundled yet —
// it'll be installed via M6 IPAex同梱; until then `numeric` falls back
// to the system serif.

export const STAMP_FONT_STACKS = {
  mincho:
    '"MS 明朝", "MS Mincho", "Hiragino Mincho ProN", "Yu Mincho", "IPAexMincho", "Noto Serif JP", serif',
  gothic:
    '"MS UI Gothic", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", sans-serif',
  numeric:
    '"CrashNumberingSerif", "MS 明朝", "Times New Roman", serif',
  serif:
    '"Times New Roman", "MS 明朝", "Hiragino Mincho ProN", serif',
  sans:
    '"Helvetica Neue", "Arial", "MS UI Gothic", sans-serif',
};

export const STAMP_FONT_LABELS = {
  mincho: "明朝",
  gothic: "ゴシック",
  numeric: "数字明朝（hanko 風）",
  serif: "Serif",
  sans: "Sans",
};

export const STAMP_FONT_DEFAULT_FULL = "mincho";
// 半角は同梱の CrashNumberingSerif（hanko 風数字）を既定。日付スタンプ
// の `8.5.9` / `令和8年5月10日` のような数字混じり表現で、漢字は明朝の
// まま、数字だけが印鑑風セリフで打たれる — ユーザーが「フォント設定…」
// で別のものを選んだ場合は localStorage 側が優先されるので、過去の
// 選択を踏み潰すことはない。
export const STAMP_FONT_DEFAULT_HALF = "numeric";

const LS_FULL = "kpdf3.stampFontFull";
const LS_HALF = "kpdf3.stampFontHalf";

/** Read the current stamp-font defaults from localStorage. Falls back
 *  to the module-level defaults when storage is empty / unavailable. */
export function getStampFontDefaults() {
  let full = STAMP_FONT_DEFAULT_FULL;
  let half = STAMP_FONT_DEFAULT_HALF;
  try {
    const f = localStorage?.getItem(LS_FULL);
    const h = localStorage?.getItem(LS_HALF);
    if (f && STAMP_FONT_STACKS[f]) full = f;
    if (h && STAMP_FONT_STACKS[h]) half = h;
  } catch {
    // localStorage may be unavailable in tests — defaults are fine.
  }
  return { full, half };
}

export function setStampFontDefaults({ full, half }) {
  try {
    if (full && STAMP_FONT_STACKS[full]) localStorage.setItem(LS_FULL, full);
    if (half && STAMP_FONT_STACKS[half]) localStorage.setItem(LS_HALF, half);
  } catch {
    // best-effort; no-op on failure
  }
}

export function getStampFontStack(fontId) {
  return STAMP_FONT_STACKS[fontId] ?? STAMP_FONT_STACKS.mincho;
}

/** Split a string into runs of consecutive same-class characters.
 *  - "half" = ASCII printable (U+0020–U+007E) + half-width katakana
 *  - "full" = everything else (CJK, full-width ASCII, etc.)
 *  Use this to apply different font stacks per run when rendering
 *  date / text stamps that mix kanji + Arabic numerals.
 */
export function splitStampRuns(text) {
  const runs = [];
  let cur = "";
  let curClass = null;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    const isHalf =
      (code >= 0x20 && code <= 0x7e) || (code >= 0xff61 && code <= 0xff9f);
    const cls = isHalf ? "half" : "full";
    if (cls !== curClass) {
      if (cur) runs.push({ cls: curClass, text: cur });
      cur = ch;
      curClass = cls;
    } else {
      cur += ch;
    }
  }
  if (cur) runs.push({ cls: curClass, text: cur });
  return runs;
}

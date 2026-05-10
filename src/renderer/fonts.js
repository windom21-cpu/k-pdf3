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
 */
export function getTextFontStack(fontId) {
  return TEXT_FONT_STACKS[fontId] ?? TEXT_FONT_STACKS.default;
}

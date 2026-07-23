const assert = require("node:assert/strict");
const test = require("node:test");

const {
  alternativeWord,
  isQuranGlyphFont,
  joinSelectionParts,
  normalizeSelectionText,
  selectArabicAlternative
} = require("../selection-text.js");

test("recognizes Quran.com page-font glyph modes", () => {
  assert.equal(isQuranGlyphFont("code_v2"), true);
  assert.equal(isQuranGlyphFont("code_v1"), true);
  assert.equal(isQuranGlyphFont("text_uthmani"), false);
});

test("prefers Quran.com's simple Arabic alternative over the diacritized duplicate", () => {
  const simple = "تبارك الذي بيده الملك وهو على كل شيء قدير ١";
  const uthmani = "تَبَـٰرَكَ ٱلَّذِى بِيَدِهِ ٱلْمُلْكُ وَهُوَ عَلَىٰ كُلِّ شَىْءٍۢ قَدِيرٌ ١";

  const selected = selectArabicAlternative([uthmani, simple], 10);
  assert.equal(selected, simple);
  assert.equal(alternativeWord(selected, 1), "تبارك");
  assert.equal(alternativeWord(selected, 10), "١");
});

test("drops selected interface labels when actual content is present", () => {
  assert.equal(
    joinSelectionParts([
      { text: "67:1", noise: true },
      { text: "Blessed is the One.", noise: false },
      { text: "Share", noise: true }
    ]),
    "Blessed is the One."
  );
});

test("keeps an explicitly selected control when it is the only text", () => {
  assert.equal(joinSelectionParts([{ text: "Open settings", noise: true }]), "Open settings");
});

test("removes directional and soft-hyphen control noise", () => {
  assert.equal(normalizeSelectionText("Hello\u2066 \u2069wor\u00ADld"), "Hello world");
});

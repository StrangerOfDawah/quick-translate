(function exposeSelectionText(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkSelectionText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ARABIC_LETTER = /\p{Script=Arabic}/u;
  const COMBINING_MARK = /\p{M}/gu;
  const DIRECTIONAL_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

  function normalizeSelectionText(value) {
    return String(value || "")
      .replace(DIRECTIONAL_CONTROL, "")
      .replace(/\u00AD/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function isQuranGlyphFont(value) {
    return /^code_v\d+$/i.test(String(value || "").trim());
  }

  function arabicTokens(value) {
    return normalizeSelectionText(value).split(/\s+/u).filter(Boolean);
  }

  // Quran.com already places two semantic Arabic copies beside its page-font
  // glyphs. Prefer the simple Imlaei copy: it has the same words with fewer
  // Quranic combining marks, which is cheaper and easier for the model to read.
  function selectArabicAlternative(candidates, expectedWords = 0) {
    return (Array.isArray(candidates) ? candidates : [])
      .map((value, order) => {
        const text = normalizeSelectionText(value);
        const tokens = arabicTokens(text);
        return {
          text,
          tokens,
          order,
          marks: (text.match(COMBINING_MARK) || []).length
        };
      })
      .filter((candidate) => candidate.tokens.length > 0 && ARABIC_LETTER.test(candidate.text))
      .sort((left, right) => {
        const leftDistance = expectedWords
          ? Math.abs(left.tokens.length - expectedWords)
          : 0;
        const rightDistance = expectedWords
          ? Math.abs(right.tokens.length - expectedWords)
          : 0;
        return (
          leftDistance - rightDistance ||
          left.marks - right.marks ||
          left.text.length - right.text.length ||
          left.order - right.order
        );
      })[0]?.text || "";
  }

  function alternativeWord(value, oneBasedIndex) {
    const index = Number(oneBasedIndex) - 1;
    if (!Number.isInteger(index) || index < 0) return "";
    return arabicTokens(value)[index] || "";
  }

  function joinSelectionParts(parts) {
    const normalized = (Array.isArray(parts) ? parts : [])
      .map((part) => ({
        text: normalizeSelectionText(part?.text),
        noise: Boolean(part?.noise)
      }))
      .filter((part) => part.text);

    const content = normalized.filter((part) => !part.noise);
    const selected = content.length ? content : normalized;
    return normalizeSelectionText(selected.map((part) => part.text).join(" "));
  }

  return {
    alternativeWord,
    isQuranGlyphFont,
    joinSelectionParts,
    normalizeSelectionText,
    selectArabicAlternative
  };
});

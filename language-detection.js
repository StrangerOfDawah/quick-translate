(function exposeLanguageDetection(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkLanguageDetection = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const RUSSIAN_LETTER = /^[А-Яа-яЁё]$/u;
  const LETTER = /^\p{L}$/u;
  const SCRIPT_DEFINITIONS = [
    ["Latin", /\p{Script=Latin}/u],
    ["Cyrillic", /\p{Script=Cyrillic}/u],
    ["Arabic", /\p{Script=Arabic}/u],
    ["Han", /\p{Script=Han}/u],
    ["Hiragana", /\p{Script=Hiragana}/u],
    ["Katakana", /\p{Script=Katakana}/u],
    ["Hangul", /\p{Script=Hangul}/u],
    ["Hebrew", /\p{Script=Hebrew}/u],
    ["Greek", /\p{Script=Greek}/u],
    ["Devanagari", /\p{Script=Devanagari}/u]
  ];

  function detectScripts(text) {
    const scripts = new Set();
    for (const char of String(text || "")) {
      if (!LETTER.test(char)) continue;
      const definition = SCRIPT_DEFINITIONS.find(([, pattern]) => pattern.test(char));
      scripts.add(definition?.[0] || "Other");
    }
    if (scripts.has("Hiragana") || scripts.has("Katakana")) {
      scripts.delete("Han");
      scripts.delete("Hiragana");
      scripts.delete("Katakana");
      scripts.add("Japanese");
    }
    if (scripts.has("Hangul")) {
      scripts.delete("Han");
      scripts.delete("Hangul");
      scripts.add("Korean");
    }
    return [...scripts];
  }

  function hasMultipleScripts(text) {
    return detectScripts(text).length > 1;
  }

  function isRussianOnly(text, detection = null) {
    const letters = [...String(text || "")].filter((char) => LETTER.test(char));
    if (!letters.length || letters.some((char) => !RUSSIAN_LETTER.test(char))) return false;

    // Для короткого русского текста CLD часто не уверен, поэтому алфавит служит
    // запасным сигналом. Надёжное определение другого языка имеет приоритет —
    // так болгарский или сербский текст не будет ошибочно проигнорирован.
    const detected = detection?.languages?.find(
      (item) => item.language && item.language !== "und" && item.percentage >= 20
    );
    if (detection?.isReliable && detected && detected.language !== "ru") return false;

    return true;
  }

  return { detectScripts, hasMultipleScripts, isRussianOnly };
});

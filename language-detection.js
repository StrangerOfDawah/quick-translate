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
  const SCRIPT_PATTERNS = [
    /\p{Script=Latin}/u,
    /\p{Script=Cyrillic}/u,
    /\p{Script=Arabic}/u,
    /\p{Script=Han}/u,
    /\p{Script=Hiragana}/u,
    /\p{Script=Katakana}/u,
    /\p{Script=Hangul}/u,
    /\p{Script=Hebrew}/u,
    /\p{Script=Greek}/u,
    /\p{Script=Devanagari}/u
  ];

  function letterScripts(text) {
    const scripts = new Set();
    for (const char of String(text || "")) {
      if (!LETTER.test(char)) continue;
      const index = SCRIPT_PATTERNS.findIndex((pattern) => pattern.test(char));
      scripts.add(index === -1 ? "other" : index);
    }
    return scripts;
  }

  function hasMultipleScripts(text) {
    return letterScripts(text).size > 1;
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

  return { hasMultipleScripts, isRussianOnly };
});

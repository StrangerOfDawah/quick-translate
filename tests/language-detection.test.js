const assert = require("node:assert/strict");
const test = require("node:test");

const { hasMultipleScripts, isRussianOnly } = require("../language-detection.js");

test("recognizes Russian-only selections without requiring reliable CLD output", () => {
  assert.equal(isRussianOnly("Привет, как дела?", { isReliable: false, languages: [] }), true);
});

test("does not suppress mixed Russian and English text", () => {
  assert.equal(isRussianOnly("Привет! How are you?"), false);
  assert.equal(hasMultipleScripts("Привет! How are you?"), true);
});

test("does not treat distinct Ukrainian letters as Russian", () => {
  assert.equal(isRussianOnly("Привіт, як справи?"), false);
});

test("reliable Chrome detection can distinguish a same-script language", () => {
  const bulgarian = {
    isReliable: true,
    languages: [{ language: "bg", percentage: 100 }]
  };
  assert.equal(isRussianOnly("Как си днес?", bulgarian), false);
});

test("detects Latin, Cyrillic, and Arabic as multiple scripts", () => {
  assert.equal(hasMultipleScripts("Hello. Привет. مرحبا."), true);
});

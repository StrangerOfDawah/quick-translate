const assert = require("node:assert/strict");
const test = require("node:test");

const { parse } = require("../text-response.js");

test("parses a regular translated text", () => {
  assert.deepEqual(parse("[[text]]\nПереведённый абзац."), {
    mode: "text",
    text: "Переведённый абзац.",
    sections: []
  });
});

test("parses multilingual sections in their original order", () => {
  assert.deepEqual(
    parse(
      "[[multilingual]]\n" +
        "[[lang:русский]]\nПривет!\n" +
        "[[lang:английский]]\nКак дела?\n" +
        "[[lang:арабский]]\nДобро пожаловать."
    ),
    {
      mode: "multilingual",
      text: "",
      sections: [
        { language: "русский", text: "Привет!" },
        { language: "английский", text: "Как дела?" },
        { language: "арабский", text: "Добро пожаловать." }
      ]
    }
  );
});

test("recognizes a Russian-only skip response", () => {
  assert.equal(parse("[[skip]]").mode, "skip");
});

test("hides incomplete streaming markers and empty multilingual scaffolding", () => {
  assert.equal(parse("[").mode, "pending");
  assert.equal(parse("[[multi").mode, "pending");
  assert.equal(parse("[[multilingual]]\n").mode, "pending");
});

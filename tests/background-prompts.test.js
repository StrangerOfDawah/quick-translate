const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function eventStub() {
  return { addListener() {} };
}

function loadBackground() {
  const settings = {
    apiKey: "test-key",
    model: "gpt-4o-mini",
    targetLang: "русский",
    autoTranslate: false,
    privacyConsentVersion: 1
  };
  const context = {
    AbortController,
    TextDecoder,
    chrome: {
      runtime: {
        onInstalled: eventStub(),
        onMessage: eventStub(),
        onConnect: eventStub(),
        openOptionsPage() {}
      },
      contextMenus: {
        onClicked: eventStub(),
        removeAll() {},
        create() {}
      },
      action: { onClicked: eventStub() },
      commands: { onCommand: eventStub() },
      storage: { local: { get: async () => settings } },
      tabs: { sendMessage: async () => {} },
      scripting: { executeScript: async () => {} }
    }
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(source, context);
  return context;
}

test("text prompt auto-detects the source language", () => {
  const { buildTextMessages } = loadBackground();
  const prompt = buildTextMessages("مرحبا", "русский")[0].content;

  assert.match(prompt, /Самостоятельно определи язык каждого предложения/);
  assert.match(prompt, /Не считай английский языком по умолчанию/);
  assert.match(prompt, /\[\[skip\]\]/);
  assert.match(prompt, /\[\[text\]\]/);
  assert.match(prompt, /\[\[multilingual\]\]/);
  assert.match(prompt, /Переводи только фрагменты не на целевом языке/);
});

test("word prompt defines a safe unknown-term response", () => {
  const { buildWordMessages } = loadBackground();
  const messages = buildWordMessages("Sensemark", null, "русский");
  const prompt = messages[0].content;

  assert.match(prompt, /«Why» — обычное английское слово/);
  assert.match(prompt, /\[\[translation\]\]/);
  assert.match(prompt, /\[\[reference\]\]/);
  assert.match(prompt, /Заглавная буква сама по себе НЕ означает/);
  assert.match(prompt, /Не выдумывай значения и факты/);
  assert.match(messages[1].content, /Контекст не предоставлен/);
});

test("word mode is explicit even when sentence context is unavailable", async () => {
  const { prepareRequest } = loadBackground();
  const wordRequest = await prepareRequest("Sensemark", null, true);
  const textRequest = await prepareRequest("Sensemark", null, false);

  assert.match(wordRequest.cacheKey, /\|word\|/);
  assert.match(wordRequest.messages[0].content, /\[\[reference\]\]/);
  assert.match(textRequest.cacheKey, /\|text\|/);
  assert.doesNotMatch(textRequest.messages[0].content, /\[\[reference\]\]/);
});

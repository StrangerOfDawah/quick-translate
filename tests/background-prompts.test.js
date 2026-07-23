const assert = require("node:assert/strict");
const test = require("node:test");
const { loadBackground } = require("./helpers/background.js");

test("text prompt auto-detects the source language", () => {
  const { buildTextMessages } = loadBackground();
  const prompt = buildTextMessages("مرحبا", "русский", ["Arabic"])[0].content;

  assert.match(prompt, /Самостоятельно определи язык каждого предложения/);
  assert.match(prompt, /Не считай английский языком по умолчанию/);
  assert.match(prompt, /Метка \[\[skip\]\] запрещена/);
  assert.match(prompt, /\[\[text\]\]/);
  assert.match(prompt, /Переводи только фрагменты не на целевом языке/);
  assert.doesNotMatch(prompt, /полный перевод на язык/);
  assert.match(prompt, /Классический или коранический арабский переводи непосредственно с арабского/);
});

test("multiscript prompt requires a section for every detected script", () => {
  const { buildTextMessages } = loadBackground();
  const prompt = buildTextMessages("Hello مرحبا", "русский", ["Latin", "Arabic"])[0]
    .content;

  assert.match(prompt, /Latin, Arabic/);
  assert.match(prompt, /\[\[multilingual\]\]/);
  assert.match(prompt, /\[\[script:SCRIPT\|lang:LANGUAGE\]\]/);
  assert.match(prompt, /для КАЖДОЙ письменности/);
  assert.match(prompt, /НИКОГДА не означает, что результат нужно писать этой письменностью/);
});

test("parallel bilingual titles may produce one natural translation", () => {
  const { buildTextMessages, isParallelTitleCandidate, responseIssue } = loadBackground();
  const source = "Japanese Daycares – 日本の保育園";
  const scripts = ["Latin", "Japanese"];
  const prompt = buildTextMessages(source, "русский", scripts)[0].content;

  assert.equal(isParallelTitleCandidate(source, scripts), true);
  assert.match(prompt, /короткий параллельный заголовок/);
  assert.match(prompt, /один естественный перевод/);
  assert.equal(
    responseIssue("[[text]]\nЯпонские детские сады", false, scripts, source),
    ""
  );
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nЯпонские детские сады\n" +
        "[[script:Japanese|lang:японский]]\nЯпонские детские сады",
      false,
      scripts,
      source
    ),
    ""
  );
});

test("ordinary multiscript prose still requires every source section", () => {
  const { isParallelTitleCandidate, responseIssue } = loadBackground();
  const source = "Read this English sentence. ثم اقرأ هذه الجملة العربية.";
  const scripts = ["Latin", "Arabic"];

  assert.equal(isParallelTitleCandidate(source, scripts), false);
  assert.match(
    responseIssue("[[text]]\nПрочитайте эти предложения.", false, scripts, source),
    /\[\[multilingual\]\]/
  );
});

test("response validation rejects skip and missing script sections", () => {
  const { responseIssue } = loadBackground();

  assert.match(responseIssue("[[skip]]", true, ["Arabic"]), /запрещённую метку/);
  assert.match(
    responseIssue(
      "[[multilingual]]\n[[script:Latin|lang:английский]]\nПеревод.",
      false,
      ["Latin", "Arabic"]
    ),
    /Arabic/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nПеревод.\n" +
        "[[script:Arabic|lang:арабский]]\n",
      false,
      ["Latin", "Arabic"]
    ),
    /Arabic/
  );
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nПеревод.\n" +
        "[[script:Arabic|lang:арабский]]\nДругой перевод.",
      false,
      ["Latin", "Arabic"]
    ),
    ""
  );
});

test("response validation rejects copied instructions, source echoes, and non-Russian output", () => {
  const { responseIssue } = loadBackground();
  const arabic = "ذَٰلِكَ ٱلْكِتَـٰبُ لَا رَيْبَ فِيهِ";

  assert.match(
    responseIssue(
      "[[text]]\nполный перевод на язык «русский» без пояснений и исходного текста",
      false,
      ["Arabic"],
      arabic
    ),
    /повторяет инструкцию/
  );
  assert.match(
    responseIssue("[[text]]\nاقترب من الله", false, ["Latin"], "Come Close to Allah."),
    /исходной письменностью|не русский перевод/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nCome Close to Allah.\n" +
        "[[script:Arabic|lang:арабский]]\nاقترب من الله.",
      false,
      ["Latin"],
      "Come Close to Allah."
    ),
    /отсутствующие в выделении письменности: Arabic/
  );
  assert.match(
    responseIssue(
      "[[text]]\nوَٱجْعَلْهُ رَبِّ رَضِيًّۭا\nПеревод:\nИ сделай его, о Господи, довольным.",
      false,
      ["Arabic"],
      "وَٱجْعَلْهُ رَبِّ رَضِيًّۭا"
    ),
    /лишнюю подпись|повторяет выделенный/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n[[script:Arabic|lang:арабский]]\nЭто Писание.",
      false,
      ["Arabic"],
      arabic
    ),
    /ошибочно выбран многоязычный формат/
  );
  assert.equal(
    responseIssue("[[text]]\nЭто Писание, в котором нет сомнения.", false, ["Arabic"], arabic),
    ""
  );
});

test("repair request replaces an invalid skip response", async () => {
  const background = loadBackground();
  background.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "[[translation]]\nбогобоязненные" } }]
    })
  });

  const repaired = await background.repairResponse(
    { apiKey: "test-key", model: "gpt-4o-mini" },
    [{ role: "system", content: "Переведи." }],
    "[[skip]]",
    "Запрещённая метка.",
    true,
    ["Arabic"],
    "لِّلْمُتَّقِينَ",
    new AbortController().signal
  );

  assert.equal(repaired, "[[translation]]\nбогобоязненные");
});

test("word prompt defines a safe unknown-term response", () => {
  const { buildWordMessages } = loadBackground();
  const messages = buildWordMessages("Sensemark", null, "русский", ["Latin"]);
  const prompt = messages[0].content;

  assert.match(prompt, /«Why» — обычное английское слово/);
  assert.match(prompt, /\[\[translation\]\]/);
  assert.match(prompt, /\[\[reference\]\]/);
  assert.match(prompt, /Заглавная буква сама по себе НЕ означает/);
  assert.match(prompt, /Не выдумывай значения и факты/);
  assert.match(prompt, /письменность выделения: Latin/);
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

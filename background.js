const MENU_ID = "translate-selection";
const API_URL = "https://api.openai.com/v1/chat/completions";
const PRIVACY_CONSENT_VERSION = 1;

const DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",
  targetLang: "русский",
  autoTranslate: false,
  privacyConsentVersion: 0
};

// Небольшой кэш, чтобы повторный перевод того же куска не стоил денег.
const cache = new Map();
const CACHE_LIMIT = 200;

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Перевести на русский",
      contexts: ["selection"]
    });
  });

  // До первого перевода пользователь должен увидеть раскрытие обработки данных.
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  } else if (details.reason === "update") {
    chrome.storage.local.get({ privacyConsentVersion: 0 }).then((settings) => {
      if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
        chrome.runtime.openOptionsPage();
      }
    });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  ping(tab.id, info.frameId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== MENU_ID || !tab?.id) return;
  // Без frameId сообщение уходит во все фреймы — ответит тот, где есть выделение.
  ping(tab.id);
});

// На вкладках, открытых до установки расширения, content script ещё не внедрён.
// Пробуем достучаться, а при неудаче внедряем его и повторяем.
async function ping(tabId, frameId) {
  const options = frameId === undefined ? {} : { frameId };
  const message = { type: "translate-selection" };

  try {
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target:
          frameId === undefined
            ? { tabId, allFrames: true }
            : { tabId, frameIds: [frameId] },
        files: ["language-detection.js", "word-response.js", "text-response.js", "content.js"]
      });
      await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      // Служебные страницы (chrome://, Web Store) скриптам недоступны — молчим.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    translate(message.text, message.context, message.wordMode)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // держим канал открытым для асинхронного ответа
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});

// Разовый перевод без стриминга — используется кнопкой «Проверить ключ».
async function translate(rawText, context, wordMode = false) {
  const { settings, cacheKey, messages } = await prepareRequest(rawText, context, wordMode);

  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(await describeError(response));
  }

  const data = await response.json();
  const result = data?.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("Пустой ответ от API.");

  cacheSet(cacheKey, result);
  return result;
}

// Общая подготовка запроса для обоих режимов — обычного и стримингового.
async function prepareRequest(rawText, context, wordMode = false) {
  const text = (rawText || "").trim();
  if (!text) throw new Error("Ничего не выделено.");

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    throw new Error(
      "Перед переводом подтвердите отправку текста в OpenAI в настройках расширения."
    );
  }
  if (!settings.apiKey) {
    throw new Error("Не задан API-ключ. Откройте настройки расширения.");
  }

  const requestMode = wordMode ? "word" : "text";
  const cacheKey = `${settings.model}|${settings.targetLang}|${requestMode}|${context || ""}|${text}`;
  const messages = wordMode
    ? buildWordMessages(text, context, settings.targetLang)
    : buildTextMessages(text, settings.targetLang);

  return { settings, cacheKey, messages };
}

// Стриминг: перевод уходит в content script по мере генерации,
// первые слова видны через долю секунды вместо ожидания всего ответа.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      streamTranslate(port, message.text, message.context, message.wordMode);
    }
  });
});

async function streamTranslate(port, rawText, context, wordMode = false) {
  const abort = new AbortController();
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    abort.abort(); // пользователь закрыл карточку — не жжём токены впустую
  });
  const send = (message) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      disconnected = true;
      abort.abort();
    }
  };

  try {
    const { settings, cacheKey, messages } = await prepareRequest(rawText, context, wordMode);

    const hit = cacheGet(cacheKey);
    if (hit) {
      send({ type: "done", text: hit });
      return;
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        stream: true,
        messages
      }),
      signal: abort.signal
    });

    if (!response.ok) {
      throw new Error(await describeError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // хвост неполной строки ждёт следующего чанка

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            send({ type: "chunk", text: full });
          }
        } catch {
          // повреждённое SSE-событие — пропускаем
        }
      }
    }

    full = full.trim();
    if (!full) throw new Error("Пустой ответ от API.");

    cacheSet(cacheKey, full);
    send({ type: "done", text: full });
  } catch (error) {
    if (error.name !== "AbortError") {
      send({ type: "error", error: error.message });
    }
  }
}

function buildTextMessages(text, lang) {
  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик на язык «${lang}». Самостоятельно определи язык каждого предложения или смыслового фрагмента. ` +
        "Не считай английский языком по умолчанию: в одном выделении могут одновременно встречаться русский, английский, арабский и другие языки. " +
        "Переводи только фрагменты не на целевом языке; фрагменты уже на целевом языке сохраняй дословно. Сохраняй порядок, абзацы, имена собственные и технические термины.\n" +
        "Ответь строго в одном из трёх форматов. Служебные метки пиши точно как указано.\n" +
        `Если весь текст уже на языке «${lang}», ответь только:\n[[skip]]\n` +
        `Если весь текст на одном языке, отличном от «${lang}», ответь:\n[[text]]\nполный перевод на язык «${lang}» без пояснений и исходного текста\n` +
        "Если в выделении есть два или больше языков, включая сочетание русского с одним иностранным языком, ответь:\n" +
        "[[multilingual]]\n" +
        "[[lang:название исходного языка по-русски]]\n" +
        `перевод этого фрагмента на язык «${lang}»; если фрагмент уже на целевом языке, повтори его без изменений\n` +
        "Создавай отдельную секцию для каждого последовательного предложения или блока исходного языка и сохраняй исходный порядок. Соседние фрагменты одного языка можно объединить. Не добавляй никаких пояснений вне секций."
    },
    { role: "user", content: text }
  ];
}

// Короткий фрагмент переводим с оглядкой на предложение: у слова значений много,
// а нужно то единственное, в котором оно употреблено здесь.
function buildWordMessages(text, context, lang) {
  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик на ${lang} язык. Самостоятельно определи исходный язык выделенного фрагмента; не считай английский языком по умолчанию. ` +
        "Контекст, если он дан, нужен ТОЛЬКО для определения значения — переводить его целиком не нужно.\n" +
        "Сначала определи, как фрагмент употреблён именно здесь. Заглавная буква сама по себе НЕ означает, что это имя или название: слово может стоять в начале предложения. Если контекста нет, но фрагмент является обычным словарным словом хотя бы одного языка, предпочти перевод. Например, «Why» — обычное английское слово и переводится как «почему».\n" +
        "Используй режим reference только если по контексту фрагмент употреблён как имя, название, бренд или никнейм либо если это действительно опечатка или придуманное слово без словарного значения. Например, Apple в «Apple released an update» — бренд, а apple в «I ate an apple» — обычное слово. Не выдумывай значения и факты.\n" +
        "Ответь строго в одном из двух форматов. Служебную метку пиши точно как указано.\n" +
        "Для обычного слова или выражения:\n" +
        "[[translation]]\n" +
        `перевод в подходящем по контексту значении на языке «${lang}»\n` +
        "другие значения: необязательный список через запятую\n" +
        `Если фрагмент уже на языке «${lang}», верни его без изменений. Строку «другие значения» не пиши, если их нет.\n` +
        "Для имени, названия, бренда, никнейма, опечатки или придуманного слова:\n" +
        "[[reference]]\n" +
        "одна категория: название, имя, бренд, никнейм, опечатка или неизвестный термин\n" +
        `одно короткое осторожное объяснение на языке «${lang}» по написанию и контексту; если определить нельзя, напиши, что это, вероятно, имя или название\n` +
        "Никакого другого текста в ответе быть не должно."
    },
    {
      role: "user",
      content: `${context ? `Контекст: ${context}\n\n` : "Контекст не предоставлен.\n\n"}Выделенный фрагмент: ${text}`
    }
  ];
}

async function describeError(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message || "";
  } catch {
    // тело не JSON — не страшно
  }

  switch (response.status) {
    case 401:
      return "Неверный API-ключ (401). Проверьте его в настройках.";
    case 403:
      return "Доступ запрещён (403). Возможно, модель недоступна для вашего аккаунта.";
    case 404:
      return `Модель не найдена (404). ${detail}`;
    case 429:
      return "Лимит запросов или закончился баланс (429). Проверьте billing в OpenAI.";
    default:
      return `Ошибка API ${response.status}. ${detail}`.trim();
  }
}

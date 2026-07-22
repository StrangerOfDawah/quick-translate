const DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",
  targetLang: "русский",
  autoTranslate: false,
  privacyConsentVersion: 0
};
const PRIVACY_CONSENT_VERSION = 1;

const fields = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  autoTranslate: document.getElementById("autoTranslate"),
  dataConsent: document.getElementById("dataConsent")
};
const testBtn = document.getElementById("test");
const testStatus = document.getElementById("testStatus");
const toastEl = document.getElementById("toast");

// Горячая клавиша — под текущую платформу.
const isMac = /Mac/i.test(navigator.platform);
document.getElementById("kbd").innerHTML = isMac
  ? "<kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd>"
  : "<kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Y</kbd>";

// Страница, открытая как обычный файл (file://), не имеет доступа к chrome.*
// Без этой проверки скрипт молча падал бы и элементы просто ничего не делали.
const inExtension = typeof chrome !== "undefined" && chrome.storage?.local;

if (!inExtension) {
  document.getElementById("banner").classList.add("show");
  document.querySelectorAll("input, select, button").forEach((el) => (el.disabled = true));
} else {
  init();
}

// Поле не должно быть шире того, что в нём написано.
const fitKey = () => {
  // Скрытый ключ рисуется точками — они уже букв, держим компактно.
  const len = Math.max(8, Math.min([...fields.apiKey.value].length + 1, 26));
  fields.apiKey.style.width = `calc(${len}ch + 44px)`;
};

function init() {
  chrome.storage.local.get(DEFAULTS).then((settings) => {
    // Модель, вписанную вручную в прошлой версии, сохраняем как пункт списка.
    if (![...fields.model.options].some((o) => o.value === settings.model)) {
      const custom = new Option(settings.model, settings.model);
      fields.model.add(custom);
    }
    fields.apiKey.value = settings.apiKey;
    fields.model.value = settings.model;
    fields.autoTranslate.checked = settings.autoTranslate;
    fields.dataConsent.checked = settings.privacyConsentVersion === PRIVACY_CONSENT_VERSION;
    fitKey();
  });

  // Автосохранение: как в System Settings — без кнопки «Сохранить».
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  fields.apiKey.addEventListener("input", () => { fitKey(); scheduleSave(); });
  fields.model.addEventListener("change", scheduleSave);
  fields.autoTranslate.addEventListener("change", scheduleSave);
  fields.dataConsent.addEventListener("change", () => {
    save();
    if (!fields.dataConsent.checked) {
      setTestStatus("Согласие отозвано — запросы в OpenAI заблокированы", "err");
    } else {
      setTestStatus("");
    }
  });

  testBtn.addEventListener("click", runTest);

  const toggleKey = document.getElementById("toggleKey");
  toggleKey.addEventListener("click", () => {
    const hidden = fields.apiKey.type === "password";
    fields.apiKey.type = hidden ? "text" : "password";
    toggleKey.title = hidden ? "Скрыть ключ" : "Показать ключ";
  });
}

function collect() {
  return {
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || DEFAULTS.model,
    // Язык зафиксирован — поля ввода нет, чтобы в промпт не попал произвольный текст.
    targetLang: DEFAULTS.targetLang,
    autoTranslate: fields.autoTranslate.checked,
    privacyConsentVersion: fields.dataConsent.checked ? PRIVACY_CONSENT_VERSION : 0
  };
}

async function save() {
  try {
    await chrome.storage.local.set(collect());
    toast("Сохранено");
  } catch (error) {
    toast(`Не удалось сохранить: ${error.message}`);
  }
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

function setTestStatus(message, kind = "") {
  testStatus.textContent = message;
  testStatus.className = `status ${kind}`;
}

async function runTest() {
  const settings = collect();
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    setTestStatus("Сначала подтвердите согласие на отправку текста", "err");
    return;
  }
  if (!settings.apiKey) {
    setTestStatus("Сначала введите ключ", "err");
    return;
  }

  testBtn.disabled = true;
  setTestStatus("Проверяю…", "busy");
  // Сохраняем перед проверкой, чтобы background видел те же настройки.
  await chrome.storage.local.set(settings);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "translate", text: "Hello, world!" });
  } catch {
    response = { ok: false, error: "Не удалось связаться с расширением" };
  }
  testBtn.disabled = false;

  if (response?.ok) {
    setTestStatus(`Работает — «${response.text}»`, "ok");
  } else {
    setTestStatus(response?.error || "Не удалось выполнить запрос", "err");
  }
}

(() => {
  // Скрипт может быть внедрён повторно из background — второй раз не выполняемся.
  if (window.__gptTranslateLoaded) return;
  window.__gptTranslateLoaded = true;

  const HOST_ID = "__gpt_translate_popup_host__";
  const MAX_CHARS = 5000;

  let host = null;
  let shadow = null;
  let card = null;
  let bodyEl = null;
  let requestId = 0;
  let lastRect = null;
  let currentPort = null;
  let streamState = null;

  // Размеры карточки живут в storage, чтобы держаться на всех страницах.
  const VIEW_DEFAULTS = { uiScale: 1, cardWidth: 0, cardHeight: 0 };
  const SCALE_MIN = 0.75;
  const SCALE_MAX = 2.2;
  const WIDTH_MIN = 230; // совпадает с min-width карточки в CSS
  const HEIGHT_MIN = 120;

  // Держим флаги локально, чтобы не будить service worker на каждое выделение.
  let autoTranslate = false;
  let view = { ...VIEW_DEFAULTS };

  chrome.storage.local.get({ autoTranslate: false, ...VIEW_DEFAULTS }).then((s) => {
    autoTranslate = s.autoTranslate;
    view = { uiScale: s.uiScale, cardWidth: s.cardWidth, cardHeight: s.cardHeight };
    if (card) applyView();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.autoTranslate) autoTranslate = changes.autoTranslate.newValue;
    // Изменения из соседней вкладки применяем на лету.
    let touched = false;
    for (const key of Object.keys(VIEW_DEFAULTS)) {
      if (changes[key]) {
        view[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched && card) applyView();
  });

  let saveViewTimer = null;
  function saveView() {
    clearTimeout(saveViewTimer);
    saveViewTimer = setTimeout(() => {
      chrome.storage.local.set(view).catch(() => {});
    }, 350);
  }

  function applyView() {
    if (!card) return;
    card.style.setProperty("--ui-scale", view.uiScale);

    if (view.cardWidth) {
      card.style.width = `${view.cardWidth}px`;
      card.style.maxWidth = "none";
    } else {
      card.style.width = "";
      card.style.maxWidth = "";
    }

    if (view.cardHeight) {
      card.style.height = `${view.cardHeight}px`;
      // Тело растягивается на всю карточку, свой лимит уступает.
      card.style.setProperty("--bd-max", "none");
    } else {
      card.style.height = "";
      card.style.removeProperty("--bd-max");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "translate-selection") {
      sendResponse({ received: true }); // подтверждаем, что скрипт жив
      handleSelection();
    }
  });

  let autoTimer = null;
  document.addEventListener("mouseup", (event) => {
    if (!autoTranslate) return;
    if (host && event.composedPath().includes(host)) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(handleSelection, 250);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const text = selection.toString().trim();
    if (text.length < 2) return null;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    // Для коротких фрагментов подтягиваем предложение вокруг — без него
    // многозначные слова переводятся наугад.
    const context = isShort(text) ? extractContext(range, text) : null;

    return { text, rect, context };
  }

  function isShort(text) {
    return text.length <= 40 && text.split(/\s+/).length <= 3;
  }

  // Ближайший блочный предок — за его границы предложение не выходит.
  function nearestBlock(node) {
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display && !display.startsWith("inline") && display !== "contents") {
        return element;
      }
      element = element.parentElement;
    }
    return element || document.body;
  }

  function extractContext(range, selectedText) {
    const block = nearestBlock(range.startContainer);
    if (!block) return null;

    let full;
    let offset;
    try {
      const whole = document.createRange();
      whole.selectNodeContents(block);
      full = whole.toString();

      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      offset = before.toString().length;
    } catch {
      return null; // выделение через границы узлов, с которыми Range не справился
    }

    if (!full || offset < 0 || offset > full.length) return null;

    const LOOKAROUND = 400;
    const BOUNDARY = /[.!?…\n\r]/;

    let start = offset;
    while (start > 0 && offset - start < LOOKAROUND && !BOUNDARY.test(full[start - 1])) {
      start--;
    }

    let end = offset + selectedText.length;
    const from = end;
    while (end < full.length && end - from < LOOKAROUND && !BOUNDARY.test(full[end])) {
      end++;
    }
    if (end < full.length) end++; // забираем сам знак конца предложения

    const sentence = full.slice(start, end).replace(/\s+/g, " ").trim();

    // Контекст полезен, только если он реально шире выделения и содержит его.
    if (sentence.length <= selectedText.length + 5) return null;
    if (!sentence.includes(selectedText)) return null;

    return sentence;
  }

  async function handleSelection() {
    const info = getSelectionInfo();
    if (!info) return; // в этом фрейме выделения нет — молчим

    if (info.text.length > MAX_CHARS) {
      render(info.rect, {
        state: "error",
        message: `Слишком длинный фрагмент: ${info.text.length} символов (максимум ${MAX_CHARS}).`
      });
      return;
    }

    const id = ++requestId;
    render(info.rect, { state: "loading" });

    // Стриминг: перевод печатается по мере генерации, не дожидаясь всего ответа.
    currentPort?.disconnect();
    let port;
    try {
      port = chrome.runtime.connect({ name: "translate" });
    } catch {
      render(info.rect, { state: "error", message: "Расширение перезагружено — обновите страницу." });
      return;
    }
    currentPort = port;

    let started = false;
    let finished = false;
    const release = () => {
      finished = true;
      if (currentPort === port) currentPort = null;
    };

    port.onMessage.addListener((message) => {
      if (id !== requestId) return;

      if (message.type === "chunk" || message.type === "done") {
        if (!started) {
          beginStreamCard(info.text, Boolean(info.context));
          started = true;
        }
        updateStream(message.text);
        position(lastRect);
        if (message.type === "done") {
          finalizeStream();
          release();
          port.disconnect();
        }
      } else if (message.type === "error") {
        render(info.rect, { state: "error", message: message.error });
        release();
        port.disconnect();
      }
    });

    // Service worker умер посреди ответа — молчать нельзя.
    port.onDisconnect.addListener(() => {
      if (id !== requestId || finished) return;
      release();
      render(info.rect, { state: "error", message: "Соединение прервано — попробуйте ещё раз." });
    });

    port.postMessage({ type: "start", text: info.text, context: info.context });
  }

  const ICONS = {
    close:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    copy:
      '<svg viewBox="0 0 16 16" fill="none"><rect x="5.2" y="5.2" width="8" height="8.6" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M10.8 3.4v-.2a1.8 1.8 0 0 0-1.8-1.8H4.6a1.8 1.8 0 0 0-1.8 1.8V8a1.8 1.8 0 0 0 1.8 1.8h.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M3.2 8.6 6.6 12l6.2-7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M6 4.5 10 8l-4 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.4 14.5 13a1 1 0 0 1-.86 1.5H2.36A1 1 0 0 1 1.5 13L8 2.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.4v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".9" fill="currentColor"/></svg>'
  };

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    // Стили самого хоста задаём инлайном, чтобы CSS страницы не мог их перебить.
    host.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .card {
          --text: #1d1d1f;
          --sec: #6e6e73;
          --hair: rgba(0, 0, 0, 0.09);
          --fill: rgba(120, 120, 128, 0.10);
          --fill-hover: rgba(120, 120, 128, 0.18);
          --accent: #007aff;
          --warn: #ff9500;
          --ok: #34c759;
          position: fixed;
          width: max-content;
          min-width: 230px;
          max-width: 400px;
          border-radius: 18px;
          border: 1px solid transparent;
          background:
            linear-gradient(rgba(250, 250, 253, 0.80), rgba(250, 250, 253, 0.80)) padding-box,
            linear-gradient(135deg, rgba(100, 210, 255, 0.55), rgba(94, 92, 230, 0.35) 50%, rgba(191, 90, 242, 0.5)) border-box;
          -webkit-backdrop-filter: blur(28px) saturate(1.9);
          backdrop-filter: blur(28px) saturate(1.9);
          box-shadow:
            0 1px 2px rgba(0, 0, 0, 0.06),
            0 12px 44px rgba(0, 0, 0, 0.20),
            0 0 34px rgba(94, 92, 230, 0.16);
          color: var(--text);
          /* Всё внутри задано в em — карточка целиком тянется от этого размера. */
          font: calc(14px * var(--ui-scale, 1)) / 1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          opacity: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .card.in {
          opacity: 1;
          animation: pop 0.34s cubic-bezier(0.21, 1.02, 0.36, 1);
          transition: top 0.28s cubic-bezier(0.32, 0.72, 0, 1), left 0.28s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .card.out {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        @keyframes pop {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-color-scheme: dark) {
          .card {
            --text: #f5f5f7;
            --sec: #98989d;
            --hair: rgba(255, 255, 255, 0.12);
            --fill: rgba(120, 120, 128, 0.24);
            --fill-hover: rgba(120, 120, 128, 0.36);
            --accent: #0a84ff;
            --warn: #ff9f0a;
            --ok: #30d158;
            background:
              linear-gradient(rgba(22, 23, 34, 0.74), rgba(22, 23, 34, 0.74)) padding-box,
              linear-gradient(135deg, rgba(100, 210, 255, 0.5), rgba(94, 92, 230, 0.35) 50%, rgba(191, 90, 242, 0.5)) border-box;
            box-shadow:
              0 1px 2px rgba(0, 0, 0, 0.3),
              0 12px 44px rgba(0, 0, 0, 0.5),
              0 0 38px rgba(94, 92, 230, 0.22);
          }
        }

        .hd {
          display: flex;
          align-items: center;
          flex: none;
          padding: 0.79em 0.71em 0 1.14em;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
          font-size: 0.79em;
          font-weight: 600;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--sec);
          white-space: nowrap;
        }
        .badge::before {
          content: "";
          width: 0.55em;
          height: 0.55em;
          border-radius: 50%;
          background: linear-gradient(135deg, #64d2ff, #bf5af2);
          box-shadow: 0 0 9px rgba(100, 210, 255, 0.9);
          flex: none;
        }
        .sp { flex: 1; }

        .bd {
          flex: 1;
          padding: 0.5em 1.14em 0.93em;
          max-height: var(--bd-max, 340px);
          overflow-y: auto;
          animation: fade 0.22s ease;
        }
        .bd::-webkit-scrollbar { width: 6px; }
        .bd::-webkit-scrollbar-thumb { background: var(--fill-hover); border-radius: 3px; }
        @keyframes fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .tr {
          font-size: 1.04em;
          letter-spacing: -0.01em;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
          cursor: text;
        }

        .sk {
          height: 0.79em;
          border-radius: 6px;
          margin: 0.43em 0 0.57em;
          background: linear-gradient(90deg,
            rgba(100, 210, 255, 0.12) 20%,
            rgba(94, 92, 230, 0.28) 45%,
            rgba(191, 90, 242, 0.16) 70%);
          background-size: 220% 100%;
          animation: shimmer 1.3s ease-in-out infinite;
        }
        @keyframes shimmer {
          from { background-position: 180% 0; }
          to { background-position: -90% 0; }
        }

        .alt {
          margin-top: 0.79em;
          padding-top: 0.71em;
          border-top: 1px solid var(--hair);
        }
        .cap {
          font-size: 0.75em;
          font-weight: 600;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--sec);
          margin-bottom: 0.21em;
        }
        .alt-t {
          font-size: 0.89em;
          color: var(--sec);
          overflow-wrap: break-word;
        }

        .src {
          overflow: hidden;
          max-height: 0;
          opacity: 0;
          transition: max-height 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.22s ease, margin-top 0.28s ease;
        }
        .src.open { opacity: 1; margin-top: 0.64em; }
        .src-t {
          font-size: 0.89em;
          color: var(--sec);
          padding: 0.14em 0 0.14em 0.71em;
          border-left: 2px solid var(--hair);
          white-space: pre-wrap;
          overflow-wrap: break-word;
          max-height: 9.4em;
          overflow-y: auto;
          user-select: text;
          -webkit-user-select: text;
        }

        .acts {
          display: flex;
          align-items: center;
          gap: 0.43em;
          margin-top: 0.79em;
          transition: opacity 0.25s ease;
        }
        .acts.pending { opacity: 0; pointer-events: none; }

        .caret {
          display: inline-block;
          width: 0.14em;
          height: 1.05em;
          margin-left: 0.14em;
          vertical-align: -0.18em;
          border-radius: 1px;
          background: linear-gradient(180deg, #64d2ff, #bf5af2);
          animation: blink 1s steps(2) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2em;
          height: 2em;
          border: none;
          border-radius: 0.57em;
          background: transparent;
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }
        .icon-btn:hover { background: var(--fill); color: var(--text); }
        .icon-btn:active { transform: scale(0.92); }
        .icon-btn svg { width: 1.07em; height: 1.07em; }
        .icon-btn.ok { color: var(--ok); }
        .icon-btn.xs { width: 1.71em; height: 1.71em; border-radius: 0.5em; }
        .icon-btn.xs svg { width: 0.86em; height: 0.86em; }

        .chip {
          display: inline-flex;
          align-items: center;
          gap: 0.21em;
          border: none;
          border-radius: 999px;
          padding: 0.36em 0.79em 0.36em 0.5em;
          font: 600 0.86em/1 -apple-system, BlinkMacSystemFont, sans-serif;
          background: transparent;
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .chip:hover { background: var(--fill); color: var(--text); }
        .chip svg { width: 1em; height: 1em; transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1); }
        .chip.open svg { transform: rotate(90deg); }
        .chip.accent { color: var(--accent); padding: 6px 13px; }
        .chip.accent:hover { background: var(--fill); color: var(--accent); }

        .err {
          display: flex;
          gap: 9px;
          align-items: flex-start;
        }
        .err svg { width: 1.14em; height: 1.14em; flex: none; margin-top: 0.14em; color: var(--warn); }
        .err-t { font-size: 0.96em; color: var(--text); overflow-wrap: break-word; }

        /* Уголок для изменения размера — свой, чтобы не тащить системный resize. */
        .grip {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 18px;
          height: 18px;
          cursor: nwse-resize;
          opacity: 0;
          transition: opacity 0.2s ease;
          touch-action: none;
        }
        .card:hover .grip, .grip.active { opacity: 0.55; }
        .grip:hover { opacity: 0.9 !important; }
        .grip::after {
          content: "";
          position: absolute;
          right: 4px;
          bottom: 4px;
          width: 8px;
          height: 8px;
          border-right: 1.5px solid var(--sec);
          border-bottom: 1.5px solid var(--sec);
          border-bottom-right-radius: 3px;
        }

        /* Процент масштаба показываем вместо заголовка, пока крутят колесо. */
        .zoom {
          font-size: 0.79em;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--accent);
          font-variant-numeric: tabular-nums;
        }
      </style>
      <div class="card" role="dialog" aria-label="Перевод">
        <div class="hd">
          <span class="badge">Перевод</span>
          <span class="zoom" hidden></span>
          <span class="sp"></span>
          <button class="icon-btn xs" data-act="close" title="Закрыть (Esc)">${ICONS.close}</button>
        </div>
        <div class="bd"></div>
        <div class="grip" title="Потяните — размер, двойной клик — сброс"></div>
      </div>
    `;
    document.documentElement.appendChild(host);

    card = shadow.querySelector(".card");
    bodyEl = shadow.querySelector(".bd");
    shadow.querySelector("[data-act=close]").addEventListener("click", close);

    applyView();
    setupZoom();
    setupResize();

    document.addEventListener("mousedown", onOutsideClick, true);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", close, { passive: true });
  }

  function onOutsideClick(event) {
    if (host && !event.composedPath().includes(host)) close();
  }

  // Прокрутка внутри карточки не должна её закрывать — иначе длинный
  // перевод невозможно домотать до конца.
  function onScroll(event) {
    if (host && event.composedPath?.().includes(host)) return;
    close();
  }

  // Cmd/Ctrl + колесо — масштаб карточки. preventDefault обязателен,
  // иначе браузер зумит всю страницу.
  function setupZoom() {
    card.addEventListener(
      "wheel",
      (event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();

        const step = event.deltaY > 0 ? -0.08 : 0.08;
        const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, view.uiScale + step));
        if (next === view.uiScale) return;

        view.uiScale = Math.round(next * 100) / 100;
        applyView();
        showZoom();
        saveView();
        if (lastRect) position(lastRect);
      },
      { passive: false }
    );
  }

  let zoomTimer = null;
  function showZoom() {
    const badge = shadow.querySelector(".badge");
    const zoom = shadow.querySelector(".zoom");
    if (!zoom) return;
    zoom.textContent = `${Math.round(view.uiScale * 100)}%`;
    zoom.hidden = false;
    badge.hidden = true;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoom.hidden = true;
      badge.hidden = false;
    }, 900);
  }

  function setupResize() {
    const grip = shadow.querySelector(".grip");
    if (!grip) return;

    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("active");

      const box = card.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = box.width;
      const startH = box.height;

      const onMove = (moveEvent) => {
        view.cardWidth = Math.max(WIDTH_MIN, Math.round(startW + moveEvent.clientX - startX));
        view.cardHeight = Math.max(HEIGHT_MIN, Math.round(startH + moveEvent.clientY - startY));
        applyView();
      };

      const onUp = () => {
        grip.classList.remove("active");
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        saveView();
        if (lastRect) position(lastRect);
      };

      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });

    // Двойной клик по уголку возвращает размер и масштаб по умолчанию.
    grip.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      view = { ...VIEW_DEFAULTS };
      applyView();
      showZoom();
      saveView();
      if (lastRect) position(lastRect);
    });
  }

  function render(rect, payload) {
    ensureHost();
    lastRect = rect;

    if (payload.state === "loading") {
      bodyEl.innerHTML = `
        <div class="sk" style="width: 94%"></div>
        <div class="sk" style="width: 62%"></div>`;
    } else if (payload.state === "error") {
      bodyEl.innerHTML = `
        <div class="err">${ICONS.warn}<p class="err-t"></p></div>
        <div class="acts"><span class="sp"></span><button class="chip accent" data-act="options">Открыть настройки</button></div>`;
      bodyEl.querySelector(".err-t").textContent = payload.message;
      bodyEl.querySelector("[data-act=options]").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "open-options" });
      });
    }

    // Перезапускаем появление контента.
    bodyEl.style.animation = "none";
    void bodyEl.offsetWidth;
    bodyEl.style.animation = "";

    position(rect);
  }

  // Каркас карточки для стриминга: текст пишется в .live, действия скрыты до конца.
  // wordMode — только для коротких фрагментов: там модель отдаёт перевод первой
  // строкой и прочие значения второй. У обычного текста переносы строк — это
  // просто абзацы, и разбирать их как «другие значения» нельзя.
  function beginStreamCard(source, wordMode) {
    bodyEl.innerHTML = `
      <p class="tr"><span class="live"></span><span class="caret"></span></p>
      <div class="alt" hidden><div class="cap">Другие значения</div><p class="alt-t"></p></div>
      <div class="src"><p class="src-t"></p></div>
      <div class="acts pending">
        <button class="chip" data-act="orig">${ICONS.chevron}<span>Оригинал</span></button>
        <span class="sp"></span>
        <button class="icon-btn" data-act="copy" title="Скопировать">${ICONS.copy}</button>
      </div>`;

    streamState = {
      main: "",
      wordMode,
      live: bodyEl.querySelector(".live"),
      caret: bodyEl.querySelector(".caret"),
      alt: bodyEl.querySelector(".alt"),
      altT: bodyEl.querySelector(".alt-t"),
      acts: bodyEl.querySelector(".acts")
    };

    const src = bodyEl.querySelector(".src");
    src.querySelector(".src-t").textContent = source || "";

    const origBtn = bodyEl.querySelector("[data-act=orig]");
    if (!source) origBtn.hidden = true;
    origBtn.addEventListener("click", () => {
      const opening = !src.classList.contains("open");
      origBtn.classList.toggle("open", opening);
      src.classList.toggle("open", opening);
      src.style.maxHeight = opening ? `${src.scrollHeight}px` : "0";
      if (opening && lastRect) setTimeout(() => position(lastRect), 290);
    });

    const copyBtn = bodyEl.querySelector("[data-act=copy]");
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(streamState.main);
      copyBtn.classList.toggle("ok", ok);
      copyBtn.innerHTML = ok ? ICONS.check : ICONS.copy;
      setTimeout(() => {
        copyBtn.classList.remove("ok");
        copyBtn.innerHTML = ICONS.copy;
      }, 1400);
    });
  }

  function updateStream(text) {
    if (!streamState) return;

    if (!streamState.wordMode) {
      // Обычный текст показываем как есть — переносы строк это абзацы оригинала.
      streamState.main = text;
      streamState.live.textContent = text;
      return;
    }

    // Для слов модель возвращает перевод первой строкой, прочие значения — ниже.
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    streamState.main = lines[0] || "";
    streamState.live.textContent = streamState.main;

    const alt = lines.slice(1).join(" ").replace(/^друг\S*\s+значения\s*:\s*/i, "");
    if (alt) {
      streamState.alt.hidden = false;
      streamState.altT.textContent = alt;
    }
  }

  function finalizeStream() {
    if (!streamState) return;
    streamState.caret.remove();
    streamState.acts.classList.remove("pending");
    streamState = null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position: fixed; opacity: 0;";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function position(rect) {
    requestAnimationFrame(() => {
      if (!card) return;
      const box = card.getBoundingClientRect();
      const margin = 10;

      let top = rect.bottom + margin;
      if (top + box.height > window.innerHeight - margin) {
        top = rect.top - box.height - margin; // не влезает снизу — показываем сверху
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));

      let left = rect.left + rect.width / 2 - box.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

      card.style.top = `${top}px`;
      card.style.left = `${left}px`;
      card.classList.add("in");
    });
  }

  function close() {
    if (!host) return;
    requestId++; // отменяем ответ на текущий запрос
    currentPort?.disconnect(); // background оборвёт fetch и не будет жечь токены
    currentPort = null;
    streamState = null;

    document.removeEventListener("mousedown", onOutsideClick, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);

    const dying = host;
    card.classList.add("out");
    setTimeout(() => dying.remove(), 170);

    host = null;
    shadow = null;
    card = null;
    bodyEl = null;
  }
})();

<div align="center">

[Русский](README.md) · **English**

<img src="icons/icon-128.png" width="88" alt="">

# Quick Translate

**Select text on any page — get a Russian translation.**
A Manifest V3 Chrome extension powered by the OpenAI API.

[**Download the latest release**](https://github.com/StrangerOfDawah/quick-translate/releases/latest)

</div>

<br>

<img src="docs/popup-text.png" alt="Translating a selected paragraph">

<br>

## Features

**The translation streams in as it is generated.** The response arrives over SSE, so the first words show up in about half a second — no waiting for the model to finish the whole paragraph.

**Single words are translated in context.** Select one word and the extension picks up the surrounding sentence, then asks for the translation that fits *that* sentence. Other common meanings are listed underneath.

<img src="docs/popup-word.png" alt="Translating a word in context">

In `I went to the **bank** to deposit a check` you get «банк»; in `We sat on the river **bank**` you get «берег».

**Dark mode** is detected automatically.

<img src="docs/popup-word-dark.png" alt="Dark mode">

**Resizable.** `Cmd`/`Ctrl` + scroll over the card changes the scale, the corner grip resizes it, and a double-click on the grip resets both. Your settings apply on every page.

**Site styles can't break it** — the card lives in a Shadow DOM, so it looks the same everywhere.

<br>

## Install

1. Download the archive from the [**Releases**](https://github.com/StrangerOfDawah/quick-translate/releases/latest) page and unpack it
2. Open `chrome://extensions`
3. Turn on **Developer mode** — the toggle in the top right
4. Click **Load unpacked** and select the unpacked folder

Don't delete or rename the folder afterwards — Chrome loads the extension straight from it. Put it somewhere permanent.

The extension isn't on the Chrome Web Store, hence the manual install. Chrome will remind you about developer mode on startup; that's normal for manually installed extensions.

<br>

## Setup

You need an OpenAI API key. This is **not** a ChatGPT Plus subscription — that gives no programmatic access. The API is billed separately, per use.

1. Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and top up your balance
2. Click the extension icon to open its settings
3. Paste the key and hit **Проверить ключ** (Test key)

<img src="docs/options.png" alt="Settings page">

There is no Save button — everything saves itself.

**On cost.** The default model is `gpt-4o-mini`, the cheapest one. A paragraph costs hundredths of a cent, and $5 of credit lasts a long time. Track spending at [platform.openai.com/usage](https://platform.openai.com/usage), where you can also set a monthly limit.

> **Note on language.** The interface is in Russian, and the extension translates *into* Russian — the source language is detected automatically. To translate into a different language, change `targetLang` in `DEFAULTS` inside `background.js` and `options.js`.

<br>

## Usage

| Method | How |
| --- | --- |
| Keyboard shortcut | Select text → <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd> (Mac) or <kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Y</kbd> (Windows) |
| Context menu | Select text → right-click → «Перевести на русский» |
| Automatic | Enable the toggle in settings — translates on any mouse selection |

In the card: the icon button copies the translation, «Оригинал» expands the source text. Close it with <kbd>Esc</kbd>, the ×, a click outside, or by scrolling.

You can rebind the shortcut at `chrome://extensions/shortcuts`. If it doesn't work right away, check there that the combination is actually assigned — Chrome silently leaves the field empty when another extension already claims it.

<br>

## How it works

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest, permissions, keyboard shortcut |
| `background.js` | Service worker: context menu, OpenAI streaming, translation cache |
| `content.js` | On-page card, context extraction, scale and size |
| `options.html` · `options.js` | Settings page |
| `icons/` | Icons, 16–128 |

The key is stored in `chrome.storage.local` and only ever sent to `api.openai.com`. No analytics, no third-party servers.

Repeat translations of the same fragment come from an in-memory cache in the service worker (last 200) and cost nothing. Closing the card mid-translation aborts the request, so unfinished output isn't billed.

Selections are capped at 5000 characters so an accidental <kbd>⌘</kbd><kbd>A</kbd> doesn't send a whole page to the API. Change `MAX_CHARS` in `content.js`.

<br>

## Limitations

- Works only where Chrome lets extensions run scripts: the card won't appear on `chrome://` pages, the Chrome Web Store, or other extensions' pages
- The target language is fixed to Russian on purpose — the value goes straight into the system prompt, so there's no free-text field. Change it in `DEFAULTS` in `background.js` and `options.js`
- After editing the code, press Reload on the extension card in `chrome://extensions` and refresh open tabs

<br>

## License

MIT — see [LICENSE](LICENSE).

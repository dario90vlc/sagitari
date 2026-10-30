# Interface language — design (5.4)

Approved by the user on 2026-10-30 with two decisions: **everything the user can see on
screen must be translatable** (interface, tool results, cards, native dialogs, tray and
notifications) and **automatic detection of the Windows language with a selector in
Settings**, applied on restart.

## What this is

Today every string in SAGITARI is hard-coded in Spanish: ~296 text nodes in
`renderer/index.html`, ~47 dynamic strings in `renderer/*.js`, and ~144 messages from
`main/` and `agent/` that the interface shows verbatim. There is no language
infrastructure at all.

With this, the app speaks **Spanish when Windows is Spanish** (any region: `es-ES`,
`es-AR`, `es-MX`…) and **English otherwise**, and the user can force it in Settings. The
agent's answers already follow the user's language (the system prompt says so), so that is
not touched.

## Decisions

| Decision | Value | Why |
|---|---|---|
| Mechanism | keys + two dictionaries (`es`, `en`) | a "Spanish text → English text" map silently breaks the moment a Spanish word changes |
| Detection | `app.getLocale()` → `/^es/i` | one source, the one Windows already uses; any regional variant lands on Spanish |
| Preference | `settings.uiLang`: `auto` \| `es` \| `en` | `auto` by default; the user decides |
| Applied | on restart | repainting live forces redoing every string already painted; no gain |
| Scope | **everything visible**: interface, tool results, cards, native dialogs, tray and notifications | what the user sees on screen must be able to be in their language; the only thing out is what is never painted |

## How the language is resolved

```
resolverIdioma(uiLang, locale)            // agent/i18n.js, pure function
  explicit 'es' | 'en'   → that one
  'auto' (or invalid)    → /^es\b/i.test(locale) ? 'es' : 'en'
  empty/undefined locale → 'es'          // the suite without Electron stays in Spanish
```

- `main/main.js` resolves **once** at startup (`app.getLocale()`) and stores the active
  language; `agent/i18n.js` receives it through `configurar(idioma)`.
- No new IPC channel for the renderer: the window is created with
  `webPreferences.additionalArguments: ['--sag-idioma=es']` and `preload.js` reads it from
  the process, exposing it as `window.sagitari.idioma`.
- Changing the selector saves `uiLang` and tells the user "applies on restart"; nothing is
  repainted.

## New modules

| Module | What it exposes |
|---|---|
| `agent/i18n.js` | `t(clave, vars)`, `configurar(idioma)`, `idiomaActual()`, `claves()`, `resolverIdioma(uiLang, locale)` |
| `agent/i18n/es.js`, `agent/i18n/en.js` | engine dictionary (messages, reasons, card titles, states) |
| `renderer/i18n.js` | `I18N.t(clave, vars)`, `I18N.aplicarDOM()`, `I18N.idioma` (read from `window.sagitari.idioma`) |
| `renderer/i18n-es.js`, `renderer/i18n-en.js` | interface dictionary |

Rules shared by both dictionaries:

- Flat key, area first: `ajustes.modelo.titulo`, `chat.detener`, `mcp.sinServidor`.
- Interpolation with braces: `t('chat.herramientas', { n: 3 })` → `{n} tools`.
- **Cascading fallback**: key missing in `en` → paint the `es` one; missing in `es` → paint
  `⟦clave⟧`. Never empty, never throws.
- The two dictionaries of a pair have **exactly the same keys** (a test enforces it; a
  missing or extra key turns the suite red).

## Marking the HTML

`renderer/index.html` gains attributes, without changing a single tag:

| Attribute | Fills |
|---|---|
| `data-i18n="clave"` | the node's text |
| `data-i18n-ph="clave"` | the `placeholder` |
| `data-i18n-title="clave"` | the `title` |
| `data-i18n-aria="clave"` | the `aria-label` |

`I18N.aplicarDOM()` runs once when the renderer boots (before painting anything) and is
idempotent. Strings generated in code (toasts, cards, lists) are painted with `I18N.t()` at
the place where the literal sits today.

## What gets translated and what does not

**Single rule: what can appear on screen goes through a key.** If a string is also read by
the model (a tool result, a guardrail reason), it is translated anyway: the model
understands English, and the user must understand what they see.

| Translated (everything visible) | Not translated (never reaches the screen) |
|---|---|
| `index.html` and strings in `renderer/*.js` | system prompt (`agent/agent.js`, `subagents.js`) |
| IPC errors and notices the interface shows | tool descriptions (`tools.js`), read only by the model |
| **tool results** painted in their card | skill bodies (bundled or imported) |
| permission card titles, summaries and reasons | log files (`main/log.js`, `runlog`) |
| turn states, reasoning, task list, team, memory, history | third-party text: provider, websites, MCP tools, compiler output |
| window, **native dialogs** (`dialog.showMessageBox`), tray, notifications, update notices | |

**Mandatory exception (one line):** the `/compact` prompt asks for the summary "in Spanish"
unconditionally; it becomes "in the user's language". Without that, an English user gets a
Spanish summary.

## Messages are not read by their text

Translating breaks any code that decides by looking at a message string. There are three
such places today, and they are fixed **before** translating the engine:

| Place | Today | Becomes |
|---|---|---|
| `renderer/10-chat.js:2185` | hides Undo if the error contains `no hay ningún cambio` | the engine returns `{ ok:false, code:'sin_cambios' }` and the renderer looks at `code` |
| `renderer/20-app.js:515` | paints red if `result.startsWith('Error')` | uses `ev.ok === false`, which the event already carries |
| `agent/agent.js:2050` | marks the tool as failed if its text starts with `Error` | uses the explicit `failed` that already exists; the prefix stays only as last resort |

Rule for new code: **a message is for reading, not for interpreting**. If anyone needs to
know *what* happened, pass a `code` or a boolean, not a sentence.

## Settings

- **Language** row, first in Appearance (Automatic / Español / English), with the note that
  it applies on restart.
- `uiLang` joins the allowlist in `main/ipc-config.js` and is validated to `auto|es|en`;
  any other value is discarded and the previous one is kept.

## Edge cases

- `app.getLocale()` empty or unknown → `es`.
- `uiLang` hand-edited in `config.json` → `auto`.
- Window recreated after a crash: inherits the same `additionalArguments` (a single helper
  creates the window).
- Tests: without Electron, `resolverIdioma('auto', undefined)` → `es`, so the 1,437
  existing tests (many of them compare Spanish strings) still hold.

## Tests

| Test | Covers |
|---|---|
| `test/47-idioma.js` | key parity in both pairs, interpolation, cascading fallback, `resolverIdioma` with `es-AR`, `en-GB`, empty and invalid values |
| `test/renderer/idioma.test.js` | `aplicarDOM()` fills text and the three attributes over the real `index.html`, leaves nodes without a key alone, and with `en` leaves the HTML in English |
| error codes | `cambios:deshacer` returns `code:'sin_cambios'` and the renderer hides the button by the code, with the message deliberately changed |
| couplings | neither `renderer/*.js` nor `agent/agent.js` decide by a message's text (the three places in the table, each with its own test) |
| Existing suite | stays in Spanish by default (resolved language = `es`) |

## Work order

1. **Skeleton**: `agent/i18n.js`, `renderer/i18n*.js`, resolution in `main`, passing it to
   the renderer through `additionalArguments`, the Settings selector, and the parity tests
   with minimal dictionaries.
2. **Full `index.html`** (296 nodes) + `aplicarDOM`.
3. **Rail and chat**: `10-chat.js`, `20-app.js`.
4. **Settings**: `30-ajustes.js`.
5. **Views**: `40-vistas.js`, `memoria-ui.js`, `chatkit.js`.
6. **Engine messages**: first the three text couplings (codes and flags), then `main/*.js`
   and the `agent/` ones that reach the screen, the native dialogs and the `/compact` line.
7. **Final sweep**: find Spanish text that does not go through a key (renderer, main and
   agent), including native dialogs, tray and notifications.

At every step the app works in Spanish; English is complete at the end of step 6.

## Acceptance criteria

- With Windows in English: menus, chat, settings, views, cards, **tool results**, errors,
  native dialogs, tray and notifications in English; the agent answers in English.
- With Windows in Spanish (any region): everything in Spanish, as today.
- The selector forces the language and applies on restart.
- Nothing visible stays in Spanish with the app in English; no key paints empty.
- No code decides by a message's text: change a message to the other language and nothing
  stops working.
- `npm test`, `npm run test:renderer` and `npm run lint` green at the end of every step.

## Out of scope

- Translating the system prompt, tool descriptions, bundled skills, `README`/`PRODUCT.md`
  or release notes.
- Changing language live, without restarting.
- Languages other than Spanish and English.

## Risks

- **Missing strings**: 1,400 strings are a lot; the sweep in step 7 (looking for Spanish
  literals outside the dictionaries) is the net, and running the app in English shows it
  instantly.
- **Existing tests compare Spanish strings**: that is why the default language without
  Electron is `es`; if a test pins the language, it is updated together with the change.
- **Two dictionary sources** (engine and interface): parity is checked per pair, not across
  pairs; a string repeated on both sides is acceptable and is not unified.

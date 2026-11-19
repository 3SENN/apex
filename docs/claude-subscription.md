# Your Claude subscription

Atelier's companions run on one of two engines: your Anthropic API key, or **your Claude subscription**. The
second runs Claude Code, Anthropic's own program, on your computer, signed in to your own paid Claude plan. This
page explains how that engine works and how it stays within Anthropic's terms. The code lives in `src/engines/`;
file paths below are under it unless they start with `src/main/` or `tests/`.

## Anthropic's terms

Anthropic's [Legal and compliance page for Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
allows a product to run Claude Code when each person signs in to the unmodified Claude Code program with their
own Claude subscription, through Anthropic's own sign-in. What it does not allow is a product that offers Claude.ai
login itself, or that collects, stores or routes people's Claude credentials. Atelier keeps to that:

- **Anthropic's program, unmodified.** Atelier runs the `claude` program that you installed from Anthropic
  ([install guide](https://code.claude.com/docs/en/setup)). A public release never bundles it. Atelier starts it
  with its documented command-line flags and changes nothing in it.
- **Anthropic's own sign-in.** Sign in opens Terminal on Claude Code's own `claude auth login`. Atelier never sees
  your password, token or session, and reads only whether you are signed in (`claude auth status --json`).
- **Every sign-in method stays.** Atelier doesn't remove or turn off any of Claude Code's sign-in methods: your
  Claude plan, an API key you gave it, or a cloud provider.
- **Your own usage, billed to you.** Each person uses their own Claude plan or key. Atelier pays for nothing,
  resells nothing and sits in the middle of nothing: it talks only to the `claude` program on your computer.
- **Names.** Atelier calls this engine "your Claude subscription" and says in plain text that it runs Claude Code.
  It doesn't use Claude Code or Anthropic as the name of anything of its own, and it shows no Anthropic logos.
- **AI can be wrong.** The welcome flow and Settings › Model and key say that companions can get things wrong
  and that you should check important facts.

Claude Code needs a paid Claude plan (Pro or higher), a Console account, or a cloud provider. The free Claude plan
doesn't include it.

## How it plugs in

- `shared.ts` adds the engine id `claude-code` (its label is "Your Claude subscription"), its EngineStatus fields
  (`claudeCodeAvailable`, `claudeCode`), its chat error codes (`cc-*`), its setting (`claudeCodePath`) and its
  service namespace (`claudeCode`: recheck, openSignIn, chooseCli, updateCli).
- `main.ts` builds the `ClaudeCodeEngine` (`claude-code/main/engine.ts`) and hands it to the app's
  `EngineService` (`src/main/engines/service.ts`): the backend, the summary every surface shows, quick calls
  (`claude-code/main/quick.ts`), the chat routes on the local MCP server, the `claude` program for the external
  MCP server's Add for me, the service methods and their schemas, and the `d-settings-model-engines` smoke shot.
- `renderer.tsx` adds the engine choice, the Settings › Model and key section, the welcome step and the error
  cards' Update Claude Code step (`claude-code/renderer/ClaudeCode.tsx`); `cards.ts` the cards of the `cc-*` codes.
- `i18n/en.ts` and `i18n/nl.ts` are the `engines` area of the catalogue (`engines.settings.modelAndKey.…`).
- Public code imports these as `@engines/<name>` (an alias for `src/engines/`).

## The engine

**The bridge** (`claude-code/main/claudeCode.ts`, `process.ts`, `streamJson.ts`). Each working chat has one
long-lived `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`
process, started at its first message in the companion's own folder and stopped after ten idle minutes (at most
eight run at once). The chat stores Claude Code's session id and resumes it with `--resume`; a duplicated chat
forks it (`--fork-session`), and a chat whose history was cut (edit and resend, retry) starts a new conversation
that gets the kept history as context. Flags: `--model`, `--effort`, `--permission-mode dontAsk`,
`--setting-sources ""` (your own Claude Code settings, hooks and CLAUDE.md stay out), `--strict-mcp-config
--mcp-config <file>`, `--tools ""` (or `WebSearch` with web tools on), `--disallowedTools` for the file, shell,
edit, sub-agent and local fetch tools, `--allowedTools` for Atelier's tools only, and `--append-system-prompt` with
the chat's fixed system prompt. The child loses `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`,
`ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`, and gets the interactive and login shells' PATH. Stream events become
the same chat events as the API-key engine (text and thinking deltas, tool rows, per-turn usage, the reply's cost,
rate limits, errors that say what to do).

**Finding Claude Code** (`claude-code/main/cli.ts`, `cliUpdate.ts`, `engine.ts`; the shell is
`src/main/system/shell.ts`). A valid explicit path (Settings, or `ATELIER_CLAUDE_PATH`) wins outright. Otherwise
Atelier gathers every candidate: a `claude` bundled in the app's Resources (only in a maintainer's own build),
`command -v claude` from a login shell and from an interactive login shell, and the usual install folders. Each
answers `--version` in parallel and the highest version runs. Settings › Model and key lists every install with the
chosen one marked, and Use this one pins another. When none is found, How to install Claude Code opens Anthropic's
install guide. A version error from the API (`claude_code_version_too_old`) records that model's minimum; the chat
card and Settings offer Update Claude Code, which runs Claude Code's own `claude update`, or opens Terminal with
npm's, Homebrew's or Claude Code's own update command when it can't update itself. Settings › Model and key and an
optional welcome step show not found / signed out / ready with the exact next step; Re-check (also on returning to
Atelier) looks again.

**Launch policy (ST-61).** `claude-code/main/launchPolicy.ts` turns a chat's capabilities into the `claude` flags
and working folder, so a feature means the same on both engines: the fallback model (none for Haiku); web search
with page reading whenever web tools are on; a deny rule for every connector tool switched off in Settings;
`--no-session-persistence` for a private chat; and, for a Files and documents chat, the chat's folder as the working
directory (`--add-dir`, `--plugin-dir` with Atelier's document skills, and Bash, Read, Write, Edit and Skill limited
to that folder). The step limit counts one step per model message that asks for tools, as the API loop does, and
reads Settings › Model and key › No step limit before each step. Compact now writes `/compact` on stdin and shows
the same compaction card. PDFs go in as a `document` block, with their text as the fallback above 10 MB or 100
pages; Office files are read to text locally (`claude-code/main/officeText.ts`).

**Files and documents.** `claude-code/main/documentsWorkspace.ts` gives each such chat
`<userData>/documents/chats/<chatId>/` with `inputs/` (attached files are copied in) and `outputs/`. After each
reply, new files in `outputs/` go to Library › Files and show as file cards. The skills that write docx, xlsx,
pptx and pdf are Atelier's own (`claude-code/main/documentSkills/*/SKILL.md`).

**One-shot calls.** Every model call outside a chat goes through one shared `QuickModel` (`src/main/agent/quick.ts`)
on whichever engine is chosen; on Claude Code, `--json-schema` gives structured output and a one-shot call never
saves a session.

**Bundling Claude Code in your own build.** The maintainer's private `internal/scripts/vendor-claude.mjs` can put
Anthropic's CLI inside a personal build (`ATELIER_BUNDLE_CLAUDE=1`), checked against Anthropic's release manifest.
It refuses a public release (`ATELIER_PUBLIC_RELEASE=1`): people who download Atelier install Claude Code from
Anthropic.

## Testing

- The engine is tested against a fake `claude` (`tests/fixtures/fake-claude.mjs`) that speaks the stream-json
  protocol and calls back into Atelier's MCP server: launch flags, environment hygiene, the companion folder, event
  mapping, one process per chat, resume after an idle shutdown, forks, stop, crashes, signed-out and limit errors,
  the guard and approvals for browser actions, memory, routines, the sign-in check, the Terminal script, and adding
  Atelier to Claude Code with revoke (`tests/claudeCodeBridge.test.ts`, built with `tests/helpers/engines.ts`).
  `tests/engine-parity.test.ts` runs every model feature on both engines, offline. The real Claude Code never runs
  in tests or smoke.
- `ATELIER_SMOKE_FAKE_CLAUDE=1` (from a checkout) puts the fake behind the engine in a smoke run, signed out unless
  `FAKE_CLAUDE_AUTH=in`, and adds the `d-settings-model-engines` shot of both engines.

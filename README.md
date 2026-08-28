# pi-extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) agent extensions. Each entry here is symlinked into `~/.pi/agent/extensions/` by `setup.sh`, and pi auto-loads it on startup (or after `/reload`).

## Contents

| Entry | Kind | What it does | [中文](README.zh-CN.md) |
| --- | --- | --- | --- |
| `git-trailer.ts` | extension | Appends `Assisted-by: Pi / <modelName>` to `git commit` messages by intercepting `bash` tool calls via a `tool_call` hook. |
| `show-resources.ts` | extension | `/resources` command — lists every extension's registered flag / command / tool / skill as a rendered markdown table in an overlay panel (with `customMessageBg` background). |
| `pi-permission-system/` | config | Config directory for [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) — `config.json` holds personal allow/ask/deny permission rules. Not self-authored code. |
| `rainbow-editor.ts` | extension (not installed) | Highlights regex matches typed into the input editor with an animated rainbow shine. Patterns come from `rainbow-editor.json`. See [Why rainbow-editor is not installed](#why-rainbow-editor-is-not-installed) below. |

## Requirements

- pi installed (`@earendil-works/pi-coding-agent`). The extensions import from pi's own packages, so no `node_modules` or `package.json` is needed in this repo.

## Setup

Clone anywhere, then run the setup script to symlink the extensions into `~/.pi/agent/extensions/`:

```bash
git clone git@github.com:cooocy/pi-extensions.git ~/firelink/pi-extensions
cd ~/firelink/pi-extensions
./setup.sh
```

Then in pi:

```
/reload
```

`setup.sh` is idempotent — re-running it only fixes missing or stale links. If a real file or directory already exists at a target path (e.g. a previous non-symlinked install), it is backed up to `<name>.bak.<timestamp>` before the symlink is created, so nothing is overwritten destructively.

## How it works

- `setup.sh` symlinks every `*.ts` / `*.js` file and every non-hidden directory at the repo root into `~/.pi/agent/extensions/`. Repo metadata (`README.md`, `setup.sh`, `.gitignore`, `LICENSE`) is skipped.
- pi scans `~/.pi/agent/extensions/` for `.ts` entry points and loads them as extensions. The `pi-permission-system/` directory is read by the `@gotgenes/pi-permission-system` package for its config.

## Why rainbow-editor is not installed

`rainbow-editor.ts` ships in this repo (configurable regex highlighter for the input editor) but **`setup.sh` does not install it**, for two reasons:

1. **It conflicts with `pi-open-tui`.** Both replace the input editor via `ctx.ui.setEditorComponent` — only the last-loaded one wins. `pi-open-tui` (an npm package) loads from `settings.json` `packages`, *after* the global `~/.pi/agent/extensions/` dir, so a symlinked rainbow-editor gets overwritten and never highlights. Installing rainbow-editor via `pi install` (so it lands after `pi-open-tui`) makes highlighting work, but then it overwrites `pi-open-tui`'s input box — losing its rounded border, cursor styles (`bar`/`underline`), and fullscreen wheel lines.
2. **Composing them doesn't work.** Wrapping `pi-open-tui`'s editor inside rainbow-editor (so both keep running) breaks `Ctrl+D` (exit), `/`-command autocomplete, and input colors: those features are bound to the single *active* editor instance's callbacks (`onCtrlD`, `onExtensionShortcut`, autocomplete state), which the wrapped instance doesn't receive. This is a structural limitation of pi's editor-component model, not a fixable bug in either extension.

So the choices are mutually exclusive: either rainbow-editor's highlight (no open-tui input box), or open-tui's full input box (no highlight). Since open-tui's features matter more day-to-day, the repo keeps rainbow-editor as a **standalone, opt-in** extension: it's here and works on its own, but `setup.sh` leaves it uninstalled to avoid silently breaking open-tui.

To try it manually (you'll lose open-tui's input-box extras):

```bash
pi install ~/firelink/pi-extensions/rainbow-editor.ts   # loads after pi-open-tui
# config (optional, defaults to ["ultrathink"]):
cp ~/firelink/pi-extensions/rainbow-editor.json ~/.pi/agent/
/reload   # in pi
```

To remove it later: `pi uninstall ~/firelink/pi-extensions/rainbow-editor.ts` (and delete `~/.pi/agent/rainbow-editor.json` if you copied it).

## Notes

- `pi-permission-system/config.json` contains personal permission rules (path patterns, deny/ask lists). If this repo is public, that exposes your directory layout and policy — consider making the repo private, or gitignoring the config and managing it per-machine.
- Symlinks are absolute, so if you move the repo, re-run `./setup.sh` to refresh them.

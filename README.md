# pi-extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) agent extensions. Each entry here is symlinked into `~/.pi/agent/extensions/` by `setup.sh`, and pi auto-loads it on startup (or after `/reload`).

## Contents

| Entry | Kind | What it does | [中文](README.zh-CN.md) |
| --- | --- | --- | --- |
| `git-trailer.ts` | extension | Appends `Assisted-by: Pi / <modelName>` to `git commit` messages by intercepting `bash` tool calls via a `tool_call` hook. |
| `show-resources.ts` | extension | `/resources` command — lists every extension's registered flag / command / tool / skill as a rendered markdown table in an overlay panel (with `customMessageBg` background). |
| `pi-permission-system/` | config | Config directory for [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) — `config.json` holds personal allow/ask/deny permission rules. Not self-authored code. |

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

## Notes

- `pi-permission-system/config.json` contains personal permission rules (path patterns, deny/ask lists). If this repo is public, that exposes your directory layout and policy — consider making the repo private, or gitignoring the config and managing it per-machine.
- Symlinks are absolute, so if you move the repo, re-run `./setup.sh` to refresh them.

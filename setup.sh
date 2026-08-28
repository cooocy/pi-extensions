#!/usr/bin/env bash
#
# setup.sh — install the pi extensions and config files from this repo
#
# Default install path: symlink repo-root *.ts/*.js files and non-hidden
# directories into ~/.pi/agent/extensions/. Repo metadata (README*, setup.sh,
# .gitignore, LICENSE) is skipped.
#
# Optional mechanisms (currently unused — keep arrays empty to disable):
#  - INSTALL_VIA_PI: register local files via `pi install` into
#    ~/.pi/agent/settings.json `packages` so they load AFTER pi-open-tui.
#    (Local paths only; never trigger network fetches.)
#  - COPY_CONFIGS: copy repo-root config files into ~/.pi/agent/ (not
#    symlinked) so each machine keeps its own edits.
#
# Safe to re-run (idempotent). Existing real files/dirs at a symlink target are
# backed up to <name>.bak.<timestamp> before being replaced. An existing config
# file at the destination is preserved (never overwritten) — delete it first to
# refresh it from the repo.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions"
AGENT_DIR="$HOME/.pi/agent"

# Repo-root config files copied (not symlinked) into ~/.pi/agent/. Add entries
# here as new configurable extensions are added. Empty = skip the section.
COPY_CONFIGS=()

# Entries here are registered via `pi install` (into settings.json packages,
# appended after npm:pi-open-tui) instead of symlinked into extensions/. Use
# this for extensions that must load AFTER pi-open-tui to win the editor
# component. (Local paths only — no network.) Empty = skip the section.
# NOTE: `rainbow-editor.ts` was here previously but is intentionally NOT
# installed now — see README.md for why.
INSTALL_VIA_PI=()

# Repo-root extensions that are deliberately NOT installed by this script at
# all (neither symlinked nor `pi install`ed). They ship in the repo as
# standalone/opt-in extensions; install them manually if you want them.
# (Any leftover symlink from a previous install is removed, not left stale.)
SKIP_INSTALL=("rainbow-editor.ts")

# Top-level entries that are repo metadata, not extensions.
is_metadata() {
    case "$1" in
        README.md|setup.sh|.gitignore|LICENSE|LICENSE.md) return 0 ;;
        *) return 1 ;;
    esac
}

# is an entry in the SKIP_INSTALL list?
is_skip_install() {
    local needle="$1"
    local e
    for e in "${SKIP_INSTALL[@]}"; do
        [ "$e" = "$needle" ] && return 0
    done
    return 1
}

link_item() {
    local name="$1"
    local src="$REPO_DIR/$name"
    local dst="$TARGET_DIR/$name"

    if [ -L "$dst" ]; then
        if [ "$(readlink "$dst")" = "$src" ]; then
            echo "  ✓ $name (already linked)"
            return 0
        fi
        rm "$dst"
        ln -s "$src" "$dst"
        echo "  ↻ $name (relinked, previous symlink pointed elsewhere)"
        return 0
    fi

    if [ -e "$dst" ]; then
        local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
        mv "$dst" "$bak"
        echo "  ⚠ $name (backed up existing → $(basename "$bak"))"
    fi

    ln -s "$src" "$dst"
    echo "  + $name (linked)"
}

# Remove a stale symlink target left by an earlier symlink-based install of an
# extension that now installs via `pi install`. No-op if absent.
remove_stale_symlink() {
    local name="$1"
    local dst="$TARGET_DIR/$name"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$REPO_DIR/$name" ]; then
        rm "$dst"
        echo "  - $name (removed stale symlink; now installed via pi install)"
    fi
}

# Register a local extension with `pi install` (user scope). Idempotent:
# `pi install` no-ops when the source is already in settings packages.
pi_install() {
    local name="$1"
    local src="$REPO_DIR/$name"
    if ! command -v pi >/dev/null 2>&1; then
        echo "  ! $name (skipped: pi command not found on PATH)" >&2
        return 1
    fi
    remove_stale_symlink "$name"
    if pi install "$src" >/tmp/pi-install-$$.log 2>&1; then
        rm -f /tmp/pi-install-$$.log
        echo "  ✓ $name (pi install — loads after pi-open-tui)"
    else
        local code=$?
        echo "  ! $name (pi install failed, exit $code):" >&2
        cat /tmp/pi-install-$$.log >&2 2>/dev/null || true
        rm -f /tmp/pi-install-$$.log
        return $code
    fi
}

# Copy a config file into ~/.pi/agent/. An existing destination is preserved so
# local edits survive re-runs; delete the destination to refresh from the repo.
copy_config() {
    local name="$1"
    local src="$REPO_DIR/$name"
    local dst="$AGENT_DIR/$name"

    if [ -e "$dst" ] || [ -L "$dst" ]; then
        echo "  ✓ $name (kept existing config)"
        return 0
    fi
    cp "$src" "$dst"
    echo "  + $name (copied config)"
}

# is an entry in the INSTALL_VIA_PI list?
is_install_via_pi() {
    local needle="$1"
    local e
    for e in "${INSTALL_VIA_PI[@]}"; do
        [ "$e" = "$needle" ] && return 0
    done
    return 1
}

shopt -s nullglob

# Collect entries into install-path buckets so each section's output only
# lists items that actually take that path. Config files (*.json at repo root
# or in COPY_CONFIGS) get their own section; the rest split by INSTALL_VIA_PI.
LINK_NAMES=()
PI_INSTALL_NAMES=()
SKIP_STALE_NAMES=()
for entry in "$REPO_DIR"/*; do
    name="$(basename "$entry")"
    # hidden entries (.git, etc.) are not matched by the non-dotglob glob
    if is_metadata "$name"; then
        continue
    fi
    case "$name" in
        *.json) continue ;; # config files handled in their own section
    esac
    if is_skip_install "$name"; then
        SKIP_STALE_NAMES+=("$name")
        continue
    fi
    if [ -f "$entry" ]; then
        case "$name" in
            *.ts|*.js)
                if is_install_via_pi "$name"; then
                    PI_INSTALL_NAMES+=("$name")
                else
                    LINK_NAMES+=("$name")
                fi
                ;;
            *) ;; # skip non-code files at repo root
        esac
    elif [ -d "$entry" ]; then
        LINK_NAMES+=("$name")
    fi
done

mkdir -p "$TARGET_DIR" "$AGENT_DIR"

# Remove leftover symlinks for entries now in SKIP_INSTALL (from an earlier
# setup run that did install them). The header is printed only when at least one
# stale symlink is actually removed, so a clean re-run prints nothing here.
for name in "${SKIP_STALE_NAMES[@]}"; do
    if [ -L "$TARGET_DIR/$name" ] && [ "$(readlink "$TARGET_DIR/$name")" = "$REPO_DIR/$name" ]; then
        if [ -z "${_tidying_header_printed:-}" ]; then
            echo "Tidying skipped extensions"
            _tidying_header_printed=1
        fi
        rm "$TARGET_DIR/$name"
        echo "  - $name (removed stale symlink; not installed — see README)"
    fi
done

echo "Symlinking pi extensions"
echo "  repo:   $REPO_DIR"
echo "  target: $TARGET_DIR"
for name in "${LINK_NAMES[@]}"; do
    link_item "$name"
done

if [ "${#PI_INSTALL_NAMES[@]}" -gt 0 ]; then
    echo
    echo "Registering via pi install (loads after pi-open-tui)"
    echo "  target: $AGENT_DIR/settings.json packages[]"
    for name in "${PI_INSTALL_NAMES[@]}"; do
        pi_install "$name" || true
    done
fi

if [ "${#COPY_CONFIGS[@]}" -gt 0 ]; then
    echo
    echo "Copying config files"
    echo "  target: $AGENT_DIR"
    for name in "${COPY_CONFIGS[@]}"; do
        if [ -f "$REPO_DIR/$name" ]; then
            copy_config "$name"
        fi
    done
fi

echo
echo "Done. Run /reload in pi to pick up changes."

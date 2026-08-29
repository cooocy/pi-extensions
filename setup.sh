#!/usr/bin/env bash
#
# setup.sh — install the pi extensions and config files from this repo.
#
# Driven by a single INSTALL table (associative array) near the top of this
# file. Each repo entry maps to one of four install methods:
#
#   symlink     symlink into ~/.pi/agent/extensions/   (*.ts / *.js / dirs)
#   pi-install  register via `pi install` into ~/.pi/agent/settings.json
#               packages[] — loads AFTER pi-open-tui (local paths, no network)
#   copy        copy into ~/.pi/agent/ (per-machine, not symlinked)
#   skip        keep in repo, do not install (cleans up any stale symlink)
#
# Add a row to install a new extension; set its value to `skip` to stop
# installing one. There is no auto-scan of the repo — only table entries are
# touched.
#
# Safe to re-run (idempotent). Existing real files/dirs at a symlink target
# are backed up to <name>.bak.<timestamp> before being replaced. An existing
# copied config at the destination is preserved (never overwritten) — delete it
# first to refresh it from the repo.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions"
AGENT_DIR="$HOME/.pi/agent"

# ──────────────────────────────────────────────────────────────────────────
# The single source of truth: which repo entries to install, and how.
# Add a row to install something; set its value to `skip` to stop installing.
# ──────────────────────────────────────────────────────────────────────────
declare -A INSTALL=(
    [git-trailer.ts]=symlink
    [show-resources.ts]=symlink
    [pi-permission-system]=symlink
    # rainbow-editor.ts conflicts with pi-open-tui (see README); left as opt-in.
    [rainbow-editor.ts]=skip
    # To enable rainbow-editor, comment the line above and use these instead:
    #     [rainbow-editor.ts]=pi-install
    #     [rainbow-editor.json]=copy
)

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

remove_stale_symlink() {
    local name="$1"
    local dst="$TARGET_DIR/$name"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$REPO_DIR/$name" ]; then
        rm "$dst"
        echo "  - $name (removed stale symlink; now installed via pi install)"
    fi
}

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

skip_item() {
    local name="$1"
    local src="$REPO_DIR/$name"
    local dst="$TARGET_DIR/$name"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
        rm "$dst"
        echo "  - $name (removed stale symlink)"
    else
        echo "  · $name (not installed)"
    fi
}

# Process every table entry whose method matches, in sorted name order.
# Methods with no entries print nothing.
dispatch_group() {
    local method="$1" label="$2" dest="$3"
    local names=() name src
    for name in "${!INSTALL[@]}"; do
        if [[ "${INSTALL[$name]}" == "$method" ]]; then
            names+=("$name")
        fi
    done
    ((${#names[@]})) || return 0
    mapfile -t names < <(printf '%s\n' "${names[@]}" | sort)

    printf "%-10s →  %s\n" "$label" "$dest"
    for name in "${names[@]}"; do
        src="$REPO_DIR/$name"
        if [ ! -e "$src" ] && [ ! -L "$src" ]; then
            echo "  ! $name (missing in repo, skipped)" >&2
            continue
        fi
        case "$method" in
            symlink)    link_item "$name" ;;
            pi-install)  pi_install "$name" || true ;;
            copy)        copy_config "$name" ;;
            skip)        skip_item "$name" ;;
        esac
    done
    echo
}

mkdir -p "$TARGET_DIR" "$AGENT_DIR"

echo "pi-extensions setup"
echo "  repo: $REPO_DIR"
echo

dispatch_group symlink    "symlink"    "$TARGET_DIR"
dispatch_group pi-install  "pi install" "$AGENT_DIR/settings.json packages[]"
dispatch_group copy       "copy"       "$AGENT_DIR"
dispatch_group skip       "skip"       "(kept in repo, not installed)"

echo "Done. Run /reload in pi to pick up changes."

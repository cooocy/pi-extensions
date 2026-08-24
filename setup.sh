#!/usr/bin/env bash
#
# setup.sh — symlink the pi extensions in this repo into ~/.pi/agent/extensions
#
# Safe to re-run (idempotent). Existing real files/dirs at the target are
# backed up to <name>.bak.<timestamp> before being replaced by a symlink.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions"

# Top-level entries that are repo metadata, not extensions.
is_metadata() {
	case "$1" in
		README.md|setup.sh|.gitignore|LICENSE|LICENSE.md) return 0 ;;
		*) return 1 ;;
	esac
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

echo "Linking pi extensions"
echo "  repo:   $REPO_DIR"
echo "  target: $TARGET_DIR"
echo

mkdir -p "$TARGET_DIR"

shopt -s nullglob
for entry in "$REPO_DIR"/*; do
	name="$(basename "$entry")"
	# hidden entries (.git, etc.) are not matched by the non-dotglob glob
	if is_metadata "$name"; then
		continue
	fi
	if [ -f "$entry" ]; then
		case "$name" in
			*.ts|*.js) link_item "$name" ;;
			*) ;; # skip non-code files at repo root
		esac
	elif [ -d "$entry" ]; then
		link_item "$name"
	fi
done

echo
echo "Done. Run /reload in pi to pick up the extensions."

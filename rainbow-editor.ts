/**
 * Rainbow Editor - highlights configurable regex matches with an animated shine effect.
 *
 * Config: ~/.pi/agent/rainbow-editor.json — a JSON array of regex source strings,
 * each compiled with flags "gi" and combined into one alternation. Defaults to
 * ["ultrathink"] when the file is absent or invalid, so behavior is unchanged
 * out of the box.
 *
 * This is the standalone (non-composing) editor: it replaces the input editor
 * directly. Install via `pi install` (setup.sh does this) so it loads AFTER
 * npm:pi-open-tui and wins the editor component; a symlink into
 * ~/.pi/agent/extensions/ loads too early and would be overwritten by
 * pi-open-tui. When both are enabled, rainbow takes over the input box, so
 * pi-open-tui's input-box extras (rounded border, cursor style, wheel lines)
 * are NOT preserved — only its header/footer (independent widgets) remain.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

// Base colors (coral → yellow → green → teal → blue → purple → pink)
const COLORS: [number, number, number][] = [
	[233, 137, 115], // coral
	[228, 186, 103], // yellow
	[141, 192, 122], // green
	[102, 194, 179], // teal
	[121, 157, 207], // blue
	[157, 134, 195], // purple
	[206, 130, 172], // pink
];
const RESET = "\x1b[0m";

function brighten(rgb: [number, number, number], factor: number): string {
	const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * factor));
	return `\x1b[38;2;${r};${g};${b}m`;
}

function colorize(text: string, shinePos: number): string {
	return (
		[...text]
			.map((c, i) => {
				const baseColor = COLORS[i % COLORS.length]!;
				// 3-letter shine: center bright, adjacent dimmer
				let factor = 0;
				if (shinePos >= 0) {
					const dist = Math.abs(i - shinePos);
					if (dist === 0) factor = 0.7;
					else if (dist === 1) factor = 0.35;
				}
				return `${brighten(baseColor, factor)}${c}`;
			})
			.join("") + RESET
	);
}

const CONFIG_FILE = "rainbow-editor.json";
const DEFAULT_SOURCES = ["ultrathink"];

/**
 * Load highlight patterns from ~/.pi/agent/rainbow-editor.json (a JSON array of
 * regex source strings). Returns one combined /gi/ regex, or null when nothing
 * should match. Falls back to DEFAULT_SOURCES on missing or invalid config.
 */
function loadConfig(): RegExp | null {
	const path = join(getAgentDir(), CONFIG_FILE);
	let sources: string[] = DEFAULT_SOURCES;
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
				throw new Error("expected a JSON array of strings");
			}
			sources = parsed;
		} catch (err) {
			console.error(`[rainbow-editor] failed to load config ${path}: ${err}`);
			sources = DEFAULT_SOURCES;
		}
	}

	const valid: string[] = [];
	for (const src of sources) {
		try {
			new RegExp(src, "gi");
			valid.push(src);
		} catch (err) {
			console.error(`[rainbow-editor] invalid regex "${src}": ${err}`);
		}
	}
	if (valid.length === 0) return null;
	return new RegExp(valid.map((s) => `(?:${s})`).join("|"), "gi");
}

class RainbowEditor extends CustomEditor {
	private animationTimer?: ReturnType<typeof setInterval>;
	private frame = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly renderRe: RegExp | null,
	) {
		super(tui, theme, keybindings);
	}

	private hasMatch(): boolean {
		return this.renderRe !== null && this.getText().match(this.renderRe) !== null;
	}

	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationTimer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 60);
	}

	private stopAnimation(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	handleInput(data: string): void {
		super.handleInput(data);
		if (this.hasMatch()) {
			this.startAnimation();
		} else {
			this.stopAnimation();
		}
	}

	render(width: number): string[] {
		// Cycle: 10 shine positions + 10 pause frames
		const cycle = this.frame % 20;
		const shinePos = cycle < 10 ? cycle : -1; // -1 means no shine (pause)
		if (this.renderRe === null) return super.render(width);
		return super.render(width).map((line) => line.replace(this.renderRe, (m) => colorize(m, shinePos)));
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const renderRe = loadConfig();
		ctx.ui.setEditorComponent((tui, theme, kb) => new RainbowEditor(tui, theme, kb, renderRe));
	});
}

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Key, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * show-prompt — inspect what pi actually sends to the model.
 *
 *   /show-prompt        system prompt as sent (after every injection layer),
 *                       rendered as Markdown, dumped to last-system-prompt.md
 *   /show-prompt tools  the provider request's `tools` array: per-tool summary
 *                       plus raw JSON, dumped to last-provider-tools.json
 *
 * Sources, best first (labeled in the viewer header):
 *   1. before_provider_request — the literal HTTP request payload captured
 *      at the user's last LLM call.
 *   2. turn_start — agent.state.systemPrompt captured when a turn began
 *      (system mode only; carries no tools information).
 *   3. live state — only before any LLM call has happened this session; the
 *      pi-memory block has not been injected yet at that point.
 *
 * Keys:  y/c copy (raw text of the shown mode) · g/G jump top/end ·
 *        ↑/↓ PgUp/PgDn scroll · Esc/Enter/q close.
 */

const OUT_PATH = join(homedir(), ".pi", "agent", "last-system-prompt.md");
const OUT_PATH_TOOLS = join(homedir(), ".pi", "agent", "last-provider-tools.json");

interface PromptSnapshot {
	text: string;
	at: number;
	source: "provider_request" | "turn_start";
	/** The tools array of the captured provider request payload, if present. */
	tools?: unknown[];
}

/** Captures the exact system prompt (and tools) of the most recent LLM call, if any. */
let snapshot: PromptSnapshot | undefined;

/** Extract system-prompt text from a provider request payload (OpenAI-style messages[0] or Anthropic-style system field). */
function extractSystemText(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const blockText = (parts: unknown): string | undefined => {
		if (typeof parts === "string" && parts.length > 0) return parts;
		if (!Array.isArray(parts)) return undefined;
		const text = parts
			.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
			.filter(Boolean)
			.join("\n");
		return text.length > 0 ? text : undefined;
	};
	const record = payload as { messages?: unknown; system?: unknown };
	if (Array.isArray(record.messages)) {
		const sys = record.messages.find(
			(m): m is { content?: unknown } => !!m && typeof m === "object" && (m as { role?: unknown }).role === "system",
		);
		const text = sys && blockText(sys.content);
		if (text) return text;
	}
	return blockText(record.system);
}

/** Extract the tools array from a provider request payload, if present. */
function extractTools(payload: unknown): unknown[] | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const tools = (payload as { tools?: unknown }).tools;
	return Array.isArray(tools) && tools.length > 0 ? tools : undefined;
}

interface ViewerOptions {
	/** Markdown document shown in the overlay. */
	doc: string;
	/** Raw text placed on the clipboard by the y/c key. */
	copyText: string;
	/** Text shown at the footer's tail when no flash message is active. */
	footerTail: string;
}

/** The shared scrollable Markdown overlay (render · copy · jump · page). */
async function openMarkdownViewer(ctx: ExtensionCommandContext, opts: ViewerOptions): Promise<void> {
	const md = new Markdown(opts.doc, 0, 0, getMarkdownTheme());

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const PAD_X = 1;
		const PAD_Y = 1;
		const TITLE = "pi · as sent to the model";
		let scrollTop = 0;
		let lastWidth = 0;
		let flash = "";
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let cachedWidth = -1;
		let cachedLines: string[] = [];

		const mdLines = (width: number): string[] => {
			if (width !== cachedWidth) {
				cachedWidth = width;
				cachedLines = md.render(Math.max(1, width - PAD_X * 2));
			}
			return cachedLines;
		};

		// Reserve 1 title row + 1 spacer row + 1 footer row from the viewport.
		const contentHeight = (): number => {
			const rows = tui.terminal.rows || process.stdout.rows || 24;
			const overlayHeight = Math.max(10, Math.floor(rows * 0.8));
			const vh = Math.max(8, overlayHeight - PAD_Y * 2);
			return Math.max(4, vh - 3);
		};

		const clampScroll = (lines: string[], ch: number): number => {
			const max = Math.max(0, lines.length - ch);
			return Math.max(0, Math.min(scrollTop, max));
		};

		const clearFlash = () => {
			if (flashTimer) clearTimeout(flashTimer);
			flash = "";
		};

		const copyAll = () => {
			if (!opts.copyText) {
				flash = "nothing to copy";
				flashTimer = setTimeout(() => {
					clearFlash();
					tui.requestRender();
				}, 2000);
				tui.requestRender();
				return;
			}
			clearFlash();
			flash = "copying…";
			tui.requestRender();
			void copyToClipboard(opts.copyText)
				.then(() => {
					flash = `copied ${opts.copyText.length} chars to clipboard`;
				})
				.catch(() => {
					flash = "copy FAILED (see clipboard tooling)";
				})
				.finally(() => {
					tui.requestRender();
				});
			flashTimer = setTimeout(() => {
				clearFlash();
				tui.requestRender();
			}, 4000);
		};

		const bg = (s: string) => theme.bg("customMessageBg", s);
		const padLine = (w: number, line: string) => {
			const fill = Math.max(0, w - PAD_X - visibleWidth(line));
			return bg(`${" ".repeat(PAD_X)}${line}${" ".repeat(fill)}`);
		};

		const truncate = (s: string, maxW: number): string => {
			if (visibleWidth(s) <= maxW) return s;
			let out = "";
			for (const ch of s) {
				if (visibleWidth(out + ch) > maxW - 1) return out + "…";
				out += ch;
			}
			return out;
		};

		const titleText = TITLE.toUpperCase().split("").join(" ");
		const titleRow = (w: number) => padLine(w, theme.fg("accent", theme.bold(titleText)));

		const footerRow = (w: number) => {
			const lines = mdLines(w);
			const ch = contentHeight();
			const max = Math.max(0, lines.length - ch);
			const pos = max === 0 ? "all" : `${scrollTop + 1}-${Math.min(scrollTop + ch, lines.length)}/${lines.length}`;
			const tail = flash || opts.footerTail;
			const hint = `y copy  g/G top/end  ↑/↓ PgUp/PgDn  q close  [${pos}]${tail ? `  ${tail}` : ""}`;
			return padLine(w, theme.fg("dim", truncate(hint, Math.max(20, w - PAD_X - 2))));
		};

		const view: Component = {
			render: (w) => {
				lastWidth = w;
				const lines = mdLines(w);
				const ch = contentHeight();
				scrollTop = clampScroll(lines, ch);
				const slice = lines.slice(scrollTop, scrollTop + ch);
				while (slice.length < ch) slice.push("");
				const out: string[] = [titleRow(w), padLine(w, "")];
				for (const line of slice) out.push(padLine(w, line));
				out.push(footerRow(w));
				return out;
			},
			invalidate: () => {
				cachedWidth = -1;
				md.invalidate?.();
			},
			handleInput: (data) => {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
					if (flashTimer) clearTimeout(flashTimer);
					done();
					return;
				}
				clearFlash();
				const lines = mdLines(lastWidth);
				const ch = contentHeight();
				const max = Math.max(0, lines.length - ch);
				if (matchesKey(data, "y") || matchesKey(data, "c")) {
					copyAll();
				} else if (matchesKey(data, "g")) {
					scrollTop = 0;
				} else if (matchesKey(data, "G")) {
					scrollTop = max;
				} else if (matchesKey(data, Key.up)) {
					scrollTop = Math.max(0, scrollTop - 1);
				} else if (matchesKey(data, Key.down)) {
					scrollTop = Math.min(max, scrollTop + 1);
				} else if (matchesKey(data, Key.pageUp)) {
					scrollTop = Math.max(0, scrollTop - ch);
				} else if (matchesKey(data, Key.pageDown)) {
					scrollTop = Math.min(max, scrollTop + ch);
				} else {
					return;
				}
				tui.requestRender();
			},
		};
		return view;
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } });
}

/** Render the captured provider-request tools array as a viewer document + raw JSON. */
function toolsDoc(tools: unknown[], at: number): { doc: string; raw: string } {
	const raw = JSON.stringify(tools, null, 2);
	const entries = tools.map((t) => {
		const tool = t as { type?: unknown; function?: unknown; name?: unknown; description?: unknown; parameters?: unknown };
		const fn = (tool && tool.type === "function" ? tool.function : tool) ?? {};
		const name = typeof fn.name === "string" ? fn.name : "unknown";
		const type = tool && typeof tool.type === "string" ? tool.type : "function";
		const desc = typeof fn.description === "string" ? fn.description : "";
		const schemaChars = fn.parameters !== undefined ? JSON.stringify(fn.parameters).length : 0;
		return `**\`${name}\`** (${type}) — description ${desc.length} chars${schemaChars ? ` · schema ${schemaChars} chars` : ""}\n\n${desc.trim() || "*(no description)*"}`;
	});
	const approx = Math.round(raw.length / 4);
	const header =
		`> **Provider request tools** — captured from the actual provider request at ${new Date(at).toLocaleTimeString()}\n` +
		`> ${tools.length} tools · raw array ${raw.length} chars (~${approx} tok, chars/4) · saved to \`${OUT_PATH_TOOLS}\` (y copies the raw JSON)`;
	return {
		doc: `${header}\n\n${entries.join("\n\n")}\n\n---\n\n\`\`\`json\n${raw}\n\`\`\``,
		raw,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const text = extractSystemText(event.payload);
		const tools = extractTools(event.payload);
		if (text) snapshot = { text, at: Date.now(), source: "provider_request", tools };
	});
	pi.on("turn_start", (_event, ctx) => {
		if (snapshot?.source === "provider_request") return;
		snapshot = { text: ctx.getSystemPrompt(), at: Date.now(), source: "turn_start" };
	});
	pi.on("session_start", () => {
		snapshot = undefined;
	});

	pi.registerCommand("show-prompt", {
		description: "Show the system prompt as sent (/show-prompt) or the provider-request tools array (/show-prompt tools)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const mode = (_args ?? "").trim().toLowerCase();

			if (mode === "tools") {
				const snap = snapshot;
				if (!snap || snap.source !== "provider_request" || !snap.tools) {
					const note =
						"> **Provider request tools** — nothing captured.\n\nEither no LLM call has happened in this session yet, or the captured request payload carried no tools. Send any message first, then run `/show-prompt tools` again.";
					if (!ctx.hasUI) {
						console.log("nothing captured yet — run after any LLM turn");
						return;
					}
					await openMarkdownViewer(ctx, { doc: note, copyText: "", footerTail: "" });
					return;
				}
				const { doc, raw } = toolsDoc(snap.tools, snap.at);
				writeFileSync(OUT_PATH_TOOLS, raw);
				if (!ctx.hasUI) {
					console.log(doc);
					return;
				}
				await openMarkdownViewer(ctx, {
					doc,
					copyText: raw,
					footerTail: `${snap.tools.length} tools · raw ${raw.length} chars`,
				});
				return;
			}

			const livePrompt = ctx.getSystemPrompt();
			const snap = snapshot;
			const prompt = snap?.text ?? livePrompt;
			writeFileSync(OUT_PATH, prompt);

			const rawLines = prompt.split("\n");
			const memoryLine = rawLines.indexOf("## Persistent memory") + 1;
			const approxTokens = Math.round(prompt.length / 4);
			const basis = snap
				? (snap.source === "provider_request" ? "captured from the actual provider request" : "captured at last turn start") +
					` at ${new Date(snap.at).toLocaleTimeString()}`
				: "live state — no LLM call yet this session; the pi-memory block will be injected on your next message";
			const memoryNote =
				memoryLine > 0
					? `memory block: injected (line ${memoryLine})`
					: snap
						? `memory block: MISSING from what was actually sent (check pi-memory config/flags)`
						: `memory block: not in base prompt (expected before the first turn)`;
			const summary = `${memoryNote} · ${rawLines.length} lines · ~${approxTokens} tok · saved to \`${OUT_PATH}\``;

			if (!ctx.hasUI) {
				console.log(basis);
				console.log(summary);
				console.log(prompt);
				return;
			}

			const doc = `> **Effective system prompt** — ${basis}\n> ${summary}\n\n${prompt}`;
			await openMarkdownViewer(ctx, {
				doc,
				copyText: prompt,
				footerTail: `${rawLines.length} lines`,
			});
		},
	});
}

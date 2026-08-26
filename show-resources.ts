import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Key, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * show-resources — list every extension's registered Flag / Command / Tool / Skill
 * and pi's built-in tools.  Run with:  /resources
 *
 * Tools, Commands and Skills come from the live ExtensionAPI (pi.getAllTools,
 * pi.getCommands, ctx.getSystemPromptOptions).  Flags have no public enumeration
 * API, so source files are scanned for registerFlag( calls as a best-effort.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

interface SourceInfo {
	path: string;
	source: string;
	scope?: string;
	origin?: string;
	baseDir?: string;
}

/** Extract a human-readable extension/package name from SourceInfo. */
function sourceLabel(si: SourceInfo): string {
	const { path, source } = si;

	if (source === "builtin") return "pi (built-in)";
	if (source === "sdk") return "pi (sdk)";

	// npm package — extract @scope/pkg or pkg from node_modules path
	if (source === "npm" || path.includes("node_modules/")) {
		const m = path.match(/node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*)/);
		if (m) return m[1];
	}

	// git package — ~/.pi/agent/git/<repo-name>/...
	if (source === "git" || path.includes("/.pi/agent/git/")) {
		const m = path.match(/\.pi\/agent\/git\/([^/]+)/);
		if (m) return m[1];
	}

	// local / temporary — use filename
	return basename(path);
}

/** Read a file safely, returning "" on error. */
function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Extract flag names from source code by matching registerFlag( calls. */
function extractFlags(content: string): string[] {
	const flags: string[] = [];
	// matches: registerFlag("name"  /  registerFlag('name'
	const re = /registerFlag\s*\(\s*["'`]([^"'`]+)["'`]/g;
	for (const raw of content.split("\n")) {
		// strip // line comments so example text in comments isn't picked up
		const line = raw.replace(/\/\/.*$/, "");
		let m: RegExpExecArray | null;
		while ((m = re.exec(line)) !== null) flags.push(m[1]);
	}
	return flags;
}

/** Collect all .ts files under a directory (excluding node_modules, depth-limited). */
function collectTsFiles(dir: string, depth = 0): string[] {
	if (depth > 4) return [];
	const results: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...collectTsFiles(full, depth + 1));
			} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
				results.push(full);
			}
		}
	} catch { /* skip */ }
	return results;
}

/** List immediate subdirectories. */
function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

/** Read the pi.extensions entry-point paths from a package.json. */
function packageEntryFiles(pkgDir: string): string[] {
	const pkgJson = JSON.parse(safeRead(join(pkgDir, "package.json")) || "{}");
	const entries: string[] = [];
	const ext = pkgJson?.pi?.extensions;
	if (Array.isArray(ext)) {
		for (const e of ext) entries.push(join(pkgDir, e));
	}
	return entries.filter((f) => existsSync(f));
}

/**
 * Best-effort: scan all known extension source files for registerFlag() calls.
 * Returns a map of sourceLabel → flagNames[].
 */
function gatherFlags(
	allTools: { sourceInfo: SourceInfo; name: string }[],
	allCommands: { sourceInfo: SourceInfo; name: string }[],
): Map<string, string[]> {
	const result = new Map<string, string[]>();

	// 1. From tools & commands sourceInfo — we already know these extension files
	const knownFiles = new Map<string, string>(); // filePath → sourceLabel
	for (const t of allTools) {
		const label = sourceLabel(t.sourceInfo);
		const path = t.sourceInfo.path;
		if (path && !path.startsWith("<")) knownFiles.set(path, label);
	}
	for (const c of allCommands) {
		const label = sourceLabel(c.sourceInfo);
		const path = c.sourceInfo.path;
		if (path && !path.startsWith("<")) knownFiles.set(path, label);
	}

	for (const [file, label] of knownFiles) {
		const flags = extractFlags(safeRead(file));
		if (flags.length > 0) {
			if (!result.has(label)) result.set(label, []);
			result.get(label)!.push(...flags);
		}
	}

	// 2. Scan local extension files not already covered
	const piDir = join(homedir(), ".pi", "agent");
	const localExtDir = join(piDir, "extensions");
	if (existsSync(localExtDir)) {
		for (const file of collectTsFiles(localExtDir)) {
			if (knownFiles.has(file)) continue;
			const content = safeRead(file);
			const flags = extractFlags(content);
			if (flags.length > 0) {
				const label = basename(file);
				if (!result.has(label)) result.set(label, []);
				result.get(label)!.push(...flags);
			}
		}
	}

	// 3. Scan npm package entry files not already covered
	const npmBase = join(piDir, "npm", "node_modules");
	if (existsSync(npmBase)) {
		for (const orgDir of listDirs(npmBase)) {
			const orgPath = join(npmBase, orgDir);
			if (orgDir.startsWith("@")) {
				for (const pkgDir of listDirs(orgPath)) {
					const fullPkg = `${orgDir}/${pkgDir}`;
					for (const entry of packageEntryFiles(join(orgPath, pkgDir))) {
						if (knownFiles.has(entry)) continue;
						const flags = extractFlags(safeRead(entry));
						if (flags.length > 0) {
							if (!result.has(fullPkg)) result.set(fullPkg, []);
							result.get(fullPkg)!.push(...flags);
						}
					}
				}
			} else {
				for (const entry of packageEntryFiles(orgPath)) {
					if (knownFiles.has(entry)) continue;
					const flags = extractFlags(safeRead(entry));
					if (flags.length > 0) {
						if (!result.has(orgDir)) result.set(orgDir, []);
						result.get(orgDir)!.push(...flags);
					}
				}
			}
		}
	}

	// 4. Scan git packages
	const gitBase = join(piDir, "git");
	if (existsSync(gitBase)) {
		for (const repoDir of listDirs(gitBase)) {
			for (const entry of packageEntryFiles(join(gitBase, repoDir))) {
				if (knownFiles.has(entry)) continue;
				const flags = extractFlags(safeRead(entry));
				if (flags.length > 0) {
					if (!result.has(repoDir)) result.set(repoDir, []);
					result.get(repoDir)!.push(...flags);
				}
			}
		}
	}

	// Deduplicate
	for (const [k, v] of result) {
		result.set(k, [...new Set(v)]);
	}

	return result;
}

// ── main ─────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("resources", {
		description: "Show all registered resources (flags, commands, tools, skills) grouped by extension",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {

			// ── gather data from live API ──
			const allTools = pi.getAllTools() as Array<{
				name: string;
				description: string;
				sourceInfo: SourceInfo;
			}>;
			const allCommands = pi.getCommands() as Array<{
				name: string;
				description?: string;
				source: string;
				sourceInfo: SourceInfo;
			}>;
			const promptOpts = ctx.getSystemPromptOptions();
			const skills = (promptOpts?.skills ?? []) as Array<{
				name: string;
				description: string;
				filePath: string;
				sourceInfo: SourceInfo;
			}>;
			const flagMap = gatherFlags(allTools, allCommands);

			// ── group by source label ──
			interface Entry {
				flags: string[];
				commands: string[];
				tools: string[];
				skills: string[];
			}
			const groups = new Map<string, Entry>();
			const ensure = (label: string): Entry => {
				if (!groups.has(label)) groups.set(label, { flags: [], commands: [], tools: [], skills: [] });
				return groups.get(label)!;
			};

			for (const t of allTools) ensure(sourceLabel(t.sourceInfo)).tools.push(t.name);
			for (const c of allCommands) ensure(sourceLabel(c.sourceInfo)).commands.push(c.name);
			for (const s of skills) ensure(sourceLabel(s.sourceInfo)).skills.push(s.name);
			for (const [label, flags] of flagMap) ensure(label).flags.push(...flags);

			// ── built-in tools (source === "builtin") ──
			const builtins = allTools
				.filter((t) => t.sourceInfo.source === "builtin")
				.map((t) => t.name)
				.sort();

			// ── extension table rows ──
			const sortedLabels = Array.from(groups.keys()).sort((a, b) => {
				if (a === "pi (built-in)") return -1;
				if (b === "pi (built-in)") return 1;
				return a.localeCompare(b);
			});

			const esc = (s: string) => s.replace(/\|/g, "\\|");
			const cell = (s: string) => ` ${esc(s)} `;
			const rows = sortedLabels.map((label) => {
				const e = groups.get(label)!;
				return [
					cell(label),
					cell(e.flags.join(", ") || "—"),
					cell(e.commands.join(", ") || "—"),
					cell(e.tools.join(", ") || "—"),
					cell(e.skills.join(", ") || "—"),
				].join("|");
			});

			const totalTools = allTools.length;
			const totalCmds = allCommands.length;
			const totalSkills = skills.length;
			const totalFlags = Array.from(flagMap.values()).reduce((n, f) => n + f.length, 0);

			const markdown = [
				"## pi built-in tools",
				"",
				builtins.join(", "),
				"",
				"## Extensions",
				"",
				"| Extension | Flag | Command | Tool | Skill |",
				"| --- | --- | --- | --- | --- |",
				...rows,
				"",
				`Total: ${totalTools} tools, ${totalCmds} commands, ${totalSkills} skills, ${totalFlags} flags across ${groups.size} sources`,
			].join("\n");

			if (ctx.hasUI) {
				await ctx.ui.custom((tui, theme, _kb, done) => {
					const md = new Markdown(markdown, 0, 0, getMarkdownTheme());
					// Overlay maxHeight is "80%" of the terminal. The overlay compositor calls
					// render(width) directly and slices off the bottom — ScrollView's scroll is
					// applied by the layout engine, which overlays bypass, so we manage the
					// viewport ourselves: render the Markdown, slice by scrollTop, pad to a fixed
					// height so the popup sizes to the terminal instead of the content.
					const PAD_X = 1;
					const PAD_Y = 1;
					const TITLE = "pi · resources";
					let scrollTop = 0;
					let lastWidth = 0;
					let cachedWidth = -1;
					let cachedLines: string[] = [];

					const mdLines = (width: number): string[] => {
						if (width !== cachedWidth) {
							cachedWidth = width;
							cachedLines = md.render(Math.max(1, width - PAD_X * 2));
						}
						return cachedLines;
					};

					// Reserve 1 title row + 1 spacer row + 1 footer row from the viewport; the middle scrolls.
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

					const bg = (s: string) => theme.bg("customMessageBg", s);
					const padLine = (w: number, line: string) => {
						const fill = Math.max(0, w - PAD_X - visibleWidth(line));
						return bg(`${" ".repeat(PAD_X)}${line}${" ".repeat(fill)}`);
					};

					const mdTheme = getMarkdownTheme();
					// Terminals can't enlarge glyphs, so emulate a bigger title with
					// uppercase + letter-spacing + bold + underline + heading color.
					const titleText = TITLE.toUpperCase().split("").join(" ");
					const titleRow = (w: number) => {
						const label = mdTheme.heading(mdTheme.bold(mdTheme.underline(titleText)));
						return padLine(w, label);
					};
					const footerRow = (w: number) => {
						const lines = mdLines(w);
						const ch = contentHeight();
						const max = Math.max(0, lines.length - ch);
						const pos = max === 0 ? "all" : `${scrollTop + 1}-${Math.min(scrollTop + ch, lines.length)}/${lines.length}`;
						const hint = theme.fg("dim", `↑/↓ scroll  PgUp/PgDn page  Esc/Enter/q close  [${pos}]`);
						return padLine(w, hint);
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
								done();
								return;
							}
							const lines = mdLines(lastWidth);
							const ch = contentHeight();
							const max = Math.max(0, lines.length - ch);
							if (matchesKey(data, Key.up)) {
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
			} else {
				console.log(markdown);
			}
		},
	});
}

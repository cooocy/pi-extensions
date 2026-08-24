import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, ScrollView, Box, matchesKey, Key, type Component } from "@earendil-works/pi-tui";
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
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		flags.push(m[1]);
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
				await ctx.ui.custom((_tui, theme, _kb, done) => {
					const md = new Markdown(markdown, 0, 0, getMarkdownTheme());
					const scroll = new ScrollView(md, { scrollbar: "auto" });
					const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
					box.addChild(scroll);
					const view: Component = {
						render: (w) => box.render(w),
						invalidate: () => box.invalidate(),
						handleInput: (data) => {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
								done();
							} else if (matchesKey(data, Key.up)) {
								scroll.scrollBy(-1);
							} else if (matchesKey(data, Key.down)) {
								scroll.scrollBy(1);
							} else if (matchesKey(data, Key.pageUp)) {
								scroll.scrollBy(-scroll.viewportHeight);
							} else if (matchesKey(data, Key.pageDown)) {
								scroll.scrollBy(scroll.viewportHeight);
							}
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

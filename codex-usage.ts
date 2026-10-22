import { BorderedLoader, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} 格式无效。`);
	}
	return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} 必须是非负数。`);
	}
	return value;
}

async function readCredentials(): Promise<{ access: string; accountId: string }> {
	let text: string;
	try {
		text = await readFile(AUTH_PATH, "utf8");
	} catch {
		throw new Error(`无法读取 ${AUTH_PATH}，请检查文件是否存在以及读取权限。`);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("auth.json 不是有效的 JSON。");
	}
	const auth = object(object(data, "auth.json")["openai-codex"], "openai-codex 凭证");
	if (
		auth.type !== "oauth" ||
		typeof auth.access !== "string" || !auth.access.trim() ||
		typeof auth.accountId !== "string" || !auth.accountId.trim()
	) {
		throw new Error("缺少 openai-codex OAuth access 或 accountId，请通过 /login 登录 OpenAI Codex。");
	}
	return { access: auth.access, accountId: auth.accountId };
}

async function fetchUsage(access: string, accountId: string, cancelSignal?: AbortSignal): Promise<unknown> {
	cancelSignal?.throwIfAborted();
	const timeout = AbortSignal.timeout(15_000);
	const signal = cancelSignal ? AbortSignal.any([cancelSignal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${access}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
			},
			redirect: "error",
			signal,
		});
	} catch {
		cancelSignal?.throwIfAborted();
		throw new Error(timeout.aborted ? "额度查询超时（15 秒）。" : "额度请求失败，请检查网络或代理配置。");
	}
	if (response.status === 401) {
		throw new Error("凭证无效或已过期，请通过 /login 重新登录 OpenAI Codex 后重试。");
	}
	if (response.status === 403) {
		throw new Error("接口拒绝访问（HTTP 403），请检查账户权限或访问限制。");
	}
	if (!response.ok) {
		throw new Error(`额度查询失败（HTTP ${response.status}）。`);
	}
	try {
		return await response.json();
	} catch {
		cancelSignal?.throwIfAborted();
		throw new Error(timeout.aborted ? "额度查询超时（15 秒）。" : "无法读取额度 JSON 响应。");
	}
}

function formatUsage(value: unknown, queriedAt: Date, theme?: Theme, width = 60): string {
	const row = (left: string, right: string) => {
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : `${left}\n${right}`;
	};
	const dim = (text: string) => theme ? theme.fg("dim", text) : text;
	const accent = (text: string) => theme ? theme.fg("accent", theme.bold(text)) : text;
	const usage = object(value, "额度响应");
	if (!("rate_limit" in usage) || !("rate_limit_reset_credits" in usage)) {
		throw new Error("额度响应缺少预期字段，接口格式可能已变更。");
	}
	const limits = usage.rate_limit == null ? undefined : object(usage.rate_limit, "rate_limit");
	const windows = [limits?.primary_window, limits?.secondary_window]
		.filter((window) => window != null)
		.map((window) => {
			const entry = object(window, "额度窗口");
			const seconds = number(entry.limit_window_seconds, "窗口长度");
			const used = number(entry.used_percent, "已用百分比");
			let reset = "未提供";
			if (entry.reset_at != null) {
				const date = new Date(number(entry.reset_at, "重置时间") * 1000);
				if (!Number.isFinite(date.getTime())) throw new Error("重置时间超出有效范围。");
				if (seconds === 18_000) {
					const minutes = Math.max(0, Math.ceil((date.getTime() - queriedAt.getTime()) / 60_000));
					const hours = Math.floor(minutes / 60);
					const remainder = minutes % 60;
					const duration = [hours ? `${hours}h` : "", remainder ? `${remainder}min` : ""].filter(Boolean).join(" ");
					reset = duration ? `${duration} 后` : "即将重置";
				} else {
					reset = date.toLocaleString("zh-CN", { hour12: false });
				}
			}
			return { seconds, used, reset };
		});
	const lines = [accent("CODEX  /  订阅额度"), ""];
	for (const [label, seconds] of [["5 小时窗口", 18_000], ["7 天窗口", 604_800]] as const) {
		const window = windows.find((entry) => entry.seconds === seconds);
		if (!window) {
			lines.push(row(accent(label), dim("未提供")), "");
			continue;
		}
		const color = window.used >= 90 ? "error" : window.used >= 70 ? "warning" : "success";
		const remainingPercent = Math.max(0, 100 - window.used);
		const remaining = `剩余 ${remainingPercent}%`;
		const filled = Math.round(width * remainingPercent / 100);
		const bar = "━".repeat(filled);
		lines.push(
			row(accent(label), theme ? theme.fg(color, theme.bold(remaining)) : remaining),
			`${theme ? theme.fg(color, bar) : bar}${dim("─".repeat(width - filled))}`,
			dim(`${seconds === 18_000 ? "重置：" : "重置于 "}${window.reset}`),
			"",
		);
	}
	if (usage.rate_limit_reset_credits == null) {
		lines.push(dim("重置次数：未提供"));
	} else {
		const credits = object(usage.rate_limit_reset_credits, "rate_limit_reset_credits");
		for (const [label, field] of [
			["可用重置次数", "available_count"],
			["当前可应用次数", "applicable_available_count"],
		] as const) {
			if (credits[field] == null) {
				lines.push(row(label, dim("未提供")));
			} else {
				const count = number(credits[field], field);
				if (!Number.isInteger(count)) throw new Error(`${field} 必须是整数。`);
				lines.push(row(label, accent(String(count))));
			}
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("codex-usage", {
		description: "查询 Codex 订阅的 5 小时、7 天窗口额度和重置次数",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw new Error("/codex-usage 需要支持通知的交互界面。");
			let usage: unknown;
			let queriedAt = new Date();
			let errorMessage: string | undefined;
			try {
				const loadUsage = async (signal?: AbortSignal) => {
					const { access, accountId } = await readCredentials();
					return fetchUsage(access, accountId, signal);
				};
				if (ctx.mode === "tui") {
					type LoadResult = { ok: true; usage: unknown } | { ok: false; error: unknown };
					const result = await ctx.ui.custom<LoadResult | null>((tui, theme, _keys, done) => {
						const loader = new BorderedLoader(tui, theme, "正在查询 Codex 订阅额度…");
						const controller = new AbortController();
						const signal = AbortSignal.any([loader.signal, controller.signal]);
						loader.onAbort = () => done(null);
						void loadUsage(signal).then(
							(usage) => { if (!signal.aborted) done({ ok: true, usage }); },
							(error: unknown) => { if (!signal.aborted) done({ ok: false, error }); },
						);
						return {
							render: (width) => loader.render(width),
							invalidate: () => loader.invalidate(),
							handleInput: (data) => loader.handleInput(data),
							dispose() {
								controller.abort();
								loader.dispose();
							},
						};
					}, { overlay: true, overlayOptions: { width: 64, maxHeight: "80%", anchor: "center" } });
					if (result === null) return;
					if (!result.ok) throw result.error;
					usage = result.usage;
				} else {
					ctx.ui.notify("正在查询 Codex 订阅额度…", "info");
					usage = await loadUsage();
				}
				queriedAt = new Date();
				const summary = formatUsage(usage, queriedAt);
				if (ctx.mode !== "tui") {
					ctx.ui.notify(summary, "info");
					return;
				}
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : "Codex 额度查询失败。";
				if (ctx.mode !== "tui") {
					ctx.ui.notify(errorMessage, "error");
					return;
				}
			}
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				let scrollTop = 0;
				let maxScroll = 0;
				let pageSize = 1;
				return {
					render(width) {
						const padding = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
						const content = errorMessage !== undefined
							? `${theme.fg("error", theme.bold("CODEX  /  查询失败"))}\n\n${errorMessage}`
							: formatUsage(usage, queriedAt, theme, Math.max(1, width - padding * 2));
						const text = new Text(content, padding, 1);
						const lines = text.render(width);
						pageSize = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 1);
						maxScroll = Math.max(0, lines.length - pageSize);
						scrollTop = Math.min(scrollTop, maxScroll);
						const visible = lines.slice(scrollTop, scrollTop + pageSize);
						const hint = maxScroll > 0 ? "↑↓ / PgUp PgDn 滚动 · " : "";
						visible.push(truncateToWidth(theme.fg("dim", ` ${hint}Esc / Enter / q 关闭`), width));
						return visible;
					},
					invalidate() {},
					handleInput(data) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
							done();
							return;
						}
						if (matchesKey(data, Key.up)) scrollTop = Math.max(0, scrollTop - 1);
						else if (matchesKey(data, Key.down)) scrollTop = Math.min(maxScroll, scrollTop + 1);
						else if (matchesKey(data, Key.pageUp)) scrollTop = Math.max(0, scrollTop - pageSize);
						else if (matchesKey(data, Key.pageDown)) scrollTop = Math.min(maxScroll, scrollTop + pageSize);
						else return;
						tui.requestRender();
					},
				};
			}, { overlay: true, overlayOptions: { width: 64, maxHeight: "80%", anchor: "center" } });
		},
	});
}

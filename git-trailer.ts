/**
 * Git Commit Trailer Extension
 *
 * 在 git commit 时自动在 message 底部追加 trailer：
 *   Assisted-by: Pi / <modelName>
 *
 * 例如：
 *   fix: keep model colors stable
 *
 *   Assisted-by: Pi / deepseek-v4-pro
 *
 * 改写策略：
 * - 普通 git commit：在 git commit 子命令末尾追加 `-m "Assisted-by: Pi / <model>"`。
 * - heredoc 形式（git commit -F - <<'EOF' ... EOF）：把 trailer 作为独立段落
 *   注入到 heredoc body 末尾（闭合定界符所在行之前）。因为 `-F -` 从 stdin 读
 *   message，而 heredoc 闭合行之后的 token 属于下一条命令，`-m` 无法再附到
 *   `git commit` 上——trailer 必须进入 heredoc body 才会进入 commit message。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command: string = event.input.command as string;
		if (!command) return;

		// 只处理 git commit
		if (!/\bgit\s+commit\b/.test(command)) return;

		// 已有 trailer 则跳过
		if (/Assisted-by:\s*Pi/i.test(command)) return;

		const modelName = ctx.model?.id ?? "unknown";
		const trailer = `Assisted-by: Pi / ${modelName}`;
		const trailerArg = ` -m "${trailer}"`;

		// 找到 git commit 在命令中的起始位置
		const gcMatch = /\bgit\s+commit\b/.exec(command)!;
		const start = gcMatch.index;

		// 从 git commit 起始位置往后扫描，识别 heredoc 或第一个顶层操作符。
		// 引号状态机只跟踪单/双引号；遇到反斜杠跳过下一字符（含行延续）。
		let inDQ = false; // 双引号内
		let inSQ = false; // 单引号内
		let insertAt = command.length; // 默认插入到命令末尾

		for (let i = start; i < command.length; i++) {
			const ch = command[i];

			// 转义字符：跳过下一个字符
			if (ch === "\\") {
				i++;
				continue;
			}

			// 引号切换
			if (ch === '"' && !inSQ) {
				inDQ = !inDQ;
				continue;
			}
			if (ch === "'" && !inDQ) {
				inSQ = !inSQ;
				continue;
			}

			// 引号内：不检测 heredoc / 操作符
			if (inDQ || inSQ) continue;

			// 重定向以 `<` 开头：区分 heredoc `<<` 与 here-string `<<<`
			if (ch === "<" && command[i + 1] === "<") {
				if (command[i + 2] === "<") {
					// here-string `<<<`：跳过这三个字符，避免把中间的 `<` 当成 heredoc
					i += 2;
					continue;
				}
				const rewritten = injectHeredocTrailer(command, i, trailer);
				if (rewritten === null && ctx.hasUI) {
					// heredoc 结构无法安全解析：不改写，避免把 trailer 插到后续命令上
					ctx.ui.notify(
						"git-trailer: detected git commit heredoc but could not locate its closing delimiter; skipped appending Assisted-by trailer.",
						"warning",
					);
				}
				event.input.command = rewritten ?? command;
				return;
			}

			// 双字符操作符 && / ||
			if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
				insertAt = i;
				break;
			}
			// 单字符操作符 ; | &
			if (ch === ";" || ch === "|" || ch === "&") {
				insertAt = i;
				break;
			}
		}

		// 在 git commit 子命令末尾插入 trailer
		event.input.command =
			command.slice(0, insertAt).trimEnd() + trailerArg + command.slice(insertAt);
	});
}

/**
 * 对 `command` 中位于 `ltLt` 处的 heredoc 重定向，把 `trailer` 作为独立段落
 * 注入到 heredoc body 末尾（闭合定界符所在行之前）。
 *
 * 支持形式：`<<DELIM`、`<<-DELIM`、`<<'DELIM'`、`<<"DELIM"`、`<<-'DELIM'` 等。
 * 返回改写后的命令；若无法确定闭合定界符位置则返回 null（调用方应跳过改写）。
 */
function injectHeredocTrailer(command: string, ltLt: number, trailer: string): string | null {
	const n = command.length;
	let p = ltLt + 2; // 跳过 `<<`

	// `<<-` 会去掉 body 与闭合行的前导 tab
	const dash = command[p] === "-";
	if (dash) p++;

	// 允许 `<< 'EOF'` 这类分隔空白
	while (command[p] === " " || command[p] === "\t") p++;

	// 读取 heredoc 定界符（带引号 / 不带引号）
	let delim = "";
	if (command[p] === "'" || command[p] === '"') {
		const quote = command[p];
		p++;
		while (p < n && command[p] !== quote && command[p] !== "\n") {
			delim += command[p];
			p++;
		}
		if (command[p] === quote) p++;
	} else {
		while (p < n && !/[\s;&|<>()`$\\'"]/.test(command[p])) {
			delim += command[p];
			p++;
		}
	}
	if (!delim) return null;

	// 定位 heredoc body 起始：跳过当前命令行剩余内容到行尾换行。
	// （here-document 始终从含 `<<` 那一行的下一行开始，与同行是否有其它参数无关。）
	let inDQ = false;
	let inSQ = false;
	while (p < n) {
		const c = command[p];
		if (c === "\\") {
			p += 2;
			continue;
		}
		if (c === '"' && !inSQ) {
			inDQ = !inDQ;
			p++;
			continue;
		}
		if (c === "'" && !inDQ) {
			inSQ = !inSQ;
			p++;
			continue;
		}
		if (c === "\n" && !inDQ && !inSQ) break;
		p++;
	}
	if (p >= n) return null; // heredoc body 从未开始
	const bodyStart = p + 1;

	// 逐行寻找闭合定界符所在行
	let lineStart = bodyStart;
	while (lineStart <= n) {
		let nl = command.indexOf("\n", lineStart);
		if (nl === -1) nl = n;
		const line = command.slice(lineStart, nl);

		// `<<-`：闭合行可带前导 tab（仅 tab），去掉后再比较；
		// `<<` ：闭合行必须与定界符完全相等（无前导空白）。
		const candidate = dash ? line.replace(/^\t+/, "") : line;
		if (candidate === delim) {
			// 在闭合行之前插入：换行 + trailer + 换行。
			// 前置换行保证 trailer 与已有 body 间有空行（独立段落）；
			// 后置换行把 trailer 与闭合定界符隔开。
			return command.slice(0, lineStart) + `\n${trailer}\n` + command.slice(lineStart);
		}

		if (nl >= n) return null; // 到末尾仍未闭合
		lineStart = nl + 1;
	}
	return null;
}

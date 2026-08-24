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
		const trailerArg = ` -m "Assisted-by: Pi / ${modelName}"`;

		// 找到 git commit 在命令中的起始位置
		const gcMatch = /\bgit\s+commit\b/.exec(command)!;
		const afterStart = gcMatch.index;

		// 从 git commit 位置往后扫描，找第一个顶层 shell 操作符（; | & && ||）
		// 跳过引号内的内容，避免误判
		let inDQ = false; // 双引号内
		let inSQ = false; // 单引号内
		let insertAt = command.length; // 默认插入到命令末尾

		for (let i = afterStart; i < command.length; i++) {
			const ch = command[i];

			// 转义字符：跳过下一个字符
			if (ch === "\\") {
				i++;
				continue;
			}

			// 引号切换
			if (ch === '"' && !inSQ) {
				inDQ = !inDQ;
			} else if (ch === "'" && !inDQ) {
				inSQ = !inSQ;
			}
			// 只在引号外检查操作符
			else if (!inDQ && !inSQ) {
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
		}

		// 在 git commit 子命令末尾插入 trailer
		event.input.command =
			command.slice(0, insertAt).trimEnd() + trailerArg + command.slice(insertAt);
	});
}

# pi-permission-system 配置解读

> 对应文件：同目录下 `config.json`（全局配置）
> 加载时机：pi 启动时读取，**改动后需重启 pi 生效**

---

## 一、顶部 4 个全局开关

| 字段 | 当前值 | 含义 |
|---|---|---|
| `debugLog` | `false` | 不输出调试日志 |
| `permissionReviewLog` | `true` | 每次拦截/放行/弹窗都记一条审计日志（JSONL，位于本目录 `logs/` 下） |
| `yoloMode` | `false` | **不**跳过所有检查。设为 `true` 等于全放行（危险，别开） |
| `doublePressToConfirm` | `true` | 弹窗快捷键需**按两下**才生效，防误触（如 `yy` 才确认） |

---

## 二、状态语义（三个值贯穿所有规则）

- **`allow`** — 静默放行，无任何提示
- **`ask`** — 弹确认框。快捷键：`y` 允许一次、`s` 本次会话内同类操作都放行、`n` 拒绝、`r` 拒绝并附理由
- **`deny`** — 直接拦截，模型会收到被拒原因并自行调整方案

---

## 三、两层匹配规则（重要）

1. **同一张规则表内："最后匹配的规则胜出"** — 宽泛规则写前面，精确规则写后面覆盖它
2. **不同层之间："最严格的胜出"** — 优先级：`path`（跨工具）→ `external_directory`（越界）→ 单工具规则 → `bash` 命令规则。即使顶层是 `allow`，`path` 层的 `deny` 依然生效

---

## 四、逐块解读

### `"*": "allow"`（顶层默认）

所有工具（内置 + 自定义 + MCP + skill）默认放行。

**关键作用：保护 plan 包（@narumitw/pi-plan-mode）的 `plan_mode_question` / `plan_mode_complete` 不被误拦**，同时日常操作零打扰。危险面全部靠下面三层的窄规则覆盖。

### `path`（跨工具路径门）

同时作用于**所有**文件访问：`read`/`write`/`edit`、bash 命令里的路径、MCP 工具、扩展工具。匹配时同时检查原始路径和 symlink 解析后的真实路径（防软链绕过），相对路径会与 cwd 拼起来匹配。

| 规则 | 命中示例 | 说明 |
|---|---|---|
| `*.env` → **deny** | `.env`、`config/.env`、任意深度的 `.env` | `*` 贪婪跨目录 |
| `*.env.*` → **deny** | `.env.local`、`.env.production` | 变体同样禁止 |
| `*.env.example` → **allow** | 模板文件 | 靠"最后匹配胜出"覆盖前面的 deny，**顺序必须 deny 在前、allow 在后** |
| `~/.ssh/*` → **deny** | `~/.ssh/config`、`~/.ssh/id_rsa` | 读写都禁 |

> ⚠️ `deny` 是**读写都禁**。如偶尔需要让 agent 读 `~/.ssh/config`（排查 SSH 配置），可把 `~/.ssh/*` 改为 `ask`。

### `bash`（命令门）

按完整命令字符串匹配，`*` 贪婪匹配任意字符（含参数间空格），末尾 `" *"` 可选。

**直接拦截（deny）：**

| 规则 | 命中示例 |
|---|---|
| `rm -rf *` | `rm -rf node_modules`、`rm -rf /` |
| `rm --recursive*` | `rm --recursive .` |
| `dd *of=/dev/*` | `dd if=x of=/dev/sda`（毁盘） |
| `mkfs*` | `mkfs.ext4 /dev/sdb1` |
| `shutdown*` / `reboot*` / `halt*` / `poweroff*` | 关机/重启 |
| `curl * \| sh`、`curl * \| bash`、`wget` 同理 | 管道直接执行远程脚本（供应链攻击面） |

**弹窗确认（ask）：**

| 规则 | 命中示例 | 不命中（放行） |
|---|---|---|
| `sudo *` | `sudo apt install` | — |
| `rm -r *` | `rm -r build/`（无 `-f`） | `rm -rf` 已被 deny 拦截 |
| `chmod/chown ... 777*` | `chmod 777 script.sh` | `chmod +x script.sh` |
| `fdisk*` | `fdisk /dev/sda` | — |
| `git push --force*` / `git push -f*` | `git push --force origin main` | 普通 `git push` 放行 |
| `git reset --hard*` | `git reset --hard HEAD~1` | `git reset --soft` 放行 |
| `git clean -*` | `git clean -fd` | — |
| `git rebase*` | `git rebase main` | — |
| `git commit --amend*` | `git commit --amend` | 普通 commit 放行 |
| `npm install*` / `npm i *` / `npm ci*` / `npm uninstall*` | 依赖增删 | `npm run build`、`npm test` 放行 |
| `pnpm install/add/remove*`、`yarn add/install/remove*` | 依赖增删 | 对应 run/test 放行 |

### `external_directory`（越界门）

`"*": "ask"` = 任何工具或命令触及 cwd 之外先弹窗。如：在 `~/QuickRoom/pi-agent` 干活时，agent 想 `ls ~/Downloads`、读 `/etc/hosts`、写 `/tmp`，都会先询问。

> ⚠️ 最容易"吵"的一条：很多合法操作（读家目录配置、缓存）都在 cwd 外。调整方向：
> - 整条改 `"*": "allow"`（关掉越界保护）
> - 或加白名单：`"~/Downloads/*": "allow"`、`"~/.cache/*": "allow"`（放行具体目录，其余仍询问）

---

## 五、典型场景

1. **`/plan` 模式探索**：`git status`、`grep`、`ls` → 全放行无弹窗（顶层 `allow` + bash 窄规则的意义）
2. **实施阶段 `git push --force`**：弹窗 → `y` 允许本次 / `s` 会话内放行
3. **agent 读 `.env`**：直接拦截，模型收到原因后换思路

---

## 六、补充

- 弹窗允许后，同类规则会生成**会话级放行建议**，减少重复确认
- 所有决策（放行/拦截/弹窗结果）进 review 日志，可追溯
- 规则全是 JSON，调整不用动代码；改完重启 pi 生效

### 常用调整速查

| 需求 | 改法 |
|---|---|
| 放开 `~/.ssh` 读取 | `"~/.ssh/*": "deny"` → `"ask"` |
| 普通 `git push` 也要确认 | bash 表加 `"git push *": "ask"` 即可（force 规则同为 ask，无顺序冲突） |
| 越界访问不想问了 | `"external_directory": { "*": "allow" }` |
| 放行某越界目录 | `"external_directory": { "*": "ask", "~/Downloads/*": "allow" }` |
| 临时全放行（危险） | `yoloMode: true` |

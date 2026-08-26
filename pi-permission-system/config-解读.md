# pi-permission-system 配置解读

> 对应文件：同目录下 `config.json`（全局配置，symlink 自 `~/.pi/agent/extensions/pi-permission-system/config.json`）
> 加载时机：pi 启动时读取，**改动后需重启 pi 生效**

---

## 判定原理（先记住这两条）

1. **四层正交，最严者赢** —— `path` → `external_directory` → 单工具规则 → `bash` 命令规则，各判一次，按 `deny > ask > allow` 合成最终结果。**任意一层 deny 即最终 deny**，`ask` 比 `allow` 严所以也能压住它。
2. **层内 last-match-wins** —— 同一张表里，**后写的规则覆盖先写的**。所以 catch-all `"*": "allow"` 永远在最前，精确规则堆在后面。

另外有一条独立快车道 `piInfrastructureReadPaths`，只给只读工具用，绕过 external_directory。详见第三节。

---

## 一、状态语义（三个值贯穿所有规则）

- **`allow`** — 静默放行，无任何提示
- **`ask`** — 弹确认框。快捷键：`y` 允许一次、`s` 本次会话内同类操作都放行、`n` 拒绝、`r` 拒绝并附理由（`doublePressToConfirm` 开启时需按两下，如 `yy` 才确认）
- **`deny`** — 直接拦截，模型会收到被拒原因并自行调整方案

---

## 二、顶部 4 个全局开关

| 字段 | 当前值 | 含义 |
|---|---|---|
| `debugLog` | `false` | 不输出调试日志 |
| `permissionReviewLog` | `false` | **不**写审计日志（不落盘 JSONL）。日后想追溯 agent 动过哪些文件/被拒过哪些命令，改 `true` |
| `yoloMode` | `false` | **不**跳过检查。设为 `true` 等于把所有 `ask` 自动放行（危险，别开）|
| `doublePressToConfirm` | `true` | 弹窗快捷键需**按两下**才生效，防误触（如 `yy` 才确认）|

---

## 三、`piInfrastructureReadPaths`（只读快车道）

```json
"piInfrastructureReadPaths": ["~"]
```

让 `read`/`find`/`grep`/`ls` 这四个**只读工具**读取家目录 `~` 下任意路径时**直接放行，绕过 external_directory 门**。

- 覆盖整个 `~/`（含 `~/.pi`、`~/Downloads`、`~/Documents`、`~/Library`、`~/.config` 等）
- **不覆盖** `write`/`edit` —— 写 ~/ 仍走 external_directory（默认 ask）
- **不覆盖** `bash` —— `cat ~/foo`、`ls ~/somewhere` 等 bash 读命令仍走 external_directory（默认 ask）
- **不覆盖** `path` 层的 deny —— `read ~/.ssh/id_rsa` 仍被 `path` 层拒绝

> 这是实现"~/ 读取放行、~/ 写入询问"的关键机制：只读工具走快车道绕过边界门，写工具仍要过那道 ask 的门。代价是 bash 读 ~/ 仍会问——bash 不走这条快车道。

---

## 四、`permission` 主体 —— 四层规则

### `"*": "allow"`（顶层默认）

所有工具（内置 + 自定义 + MCP + skill）默认放行。

**关键作用：保护 plan 包（@narumitw/pi-plan-mode）的 `plan_mode_question` / `plan_mode_complete` 不被误拦**，同时日常操作零打扰。危险面全部靠下面三层的窄规则覆盖。

### `path`（跨工具路径门 —— deny 永远兜底）

同时作用于**所有**文件访问：`read`/`write`/`edit`、bash 命令里的路径、MCP 工具、扩展工具。匹配时同时检查原始路径和 symlink 解析后的真实路径（防软链绕过），相对路径会与 cwd 拼起来匹配。

| 规则 | 命中示例 | 说明 |
|---|---|---|
| `*` → **allow** | 任何路径 | 兜底放行，必须在最前 |
| `*.env` → **deny** | `.env`、`config/.env`、任意深度的 `.env` | `*` 贪婪跨目录 |
| `*.env.*` → **deny** | `.env.local`、`.env.production` | 变体同样禁止 |
| `*.env.example` → **allow** | 模板文件 | 靠"最后匹配胜出"覆盖前面的 deny，**顺序必须 deny 在前、allow 在后** |
| `~/.ssh/*` → **deny** | `~/.ssh/config`、`~/.ssh/id_rsa` | 读写都禁 |

> ⚠️ `deny` 是**读写都禁**，且跨所有工具+bash，任意一层 deny 即最终 deny。如偶尔需要让 agent 读 `~/.ssh/config`（排查 SSH 配置），可把 `~/.ssh/*` 改为 `ask`。

### `external_directory`（CWD 边界门 —— 只管越界）

只关心一个问题：访问的路径是否在当前工作目录（cwd）之外？cwd 内访问这层**不触发**（等于 allow）。

| 规则 | 命中 | 结果 |
|---|---|---|
| `*` → **ask** | cwd 之外的任何路径 | 询问 |
| `~/Downloads` → **allow** | ~/Downloads 目录本身 | 放行（读写都放）|
| `~/Downloads/*` → **allow** | ~/Downloads 下的内容 | 放行（读写都放）|

> ⚠️ 这层**不区分读写**，一个 pattern = 一个动作。所以"~/Downloads 读写都放行"用 allow；"~/ 写询问"靠默认 `*: ask` 且 ~/ 不在 allow 列表。"~/ 读放行"则由 `piInfrastructureReadPaths` 快车道单独实现（见第三节）。

### 单工具层 —— 未配置

没有配 `read`/`write`/`edit` 等单工具块，全部回落到顶层 `"*": "allow"`。文件读写工具本身无额外限制，靠 `path` 和 `external_directory` 把关。

### `bash`（命令字符串门 —— 与路径内外无关）

按完整命令字符串匹配，`*` 贪婪匹配任意字符（含参数间空格）。命令里的**路径 token** 还会再过一遍 `path` + `external_directory`，但只要路径在 cwd 内、非 `.env`/`.ssh`，那两层都放行。

#### A. 直接拦截（deny）—— 毁灭性 / 远程脚本

| 规则 | 命中示例 |
|---|---|
| `rm -rf *` | `rm -rf node_modules`、`rm -rf /` |
| `rm --recursive*` | `rm --recursive .` |
| `dd *of=/dev/*` | `dd if=x of=/dev/sda`（毁盘）|
| `mkfs*` | `mkfs.ext4 /dev/sdb1` |
| `shutdown*` / `reboot*` / `halt*` / `poweroff*` | 关机/重启 |
| `curl * \| sh`、`curl * \| bash`、`wget` 同理 | 管道直接执行远程脚本（供应链攻击面）|

#### B. 弹窗确认（ask）—— 系统权限 / Git 危险操作 / 依赖安装

| 类别 | 规则 | 不命中（放行）|
|---|---|---|
| 提权 | `sudo *` | — |
| 删除 | `rm -r *`（无 `-f`）| `rm -rf` 已被 deny |
| 权限 | `chmod * 777*`、`chmod 777*`、`chown * 777*` | `chmod +x` |
| 磁盘 | `fdisk*` | — |
| Git 强制 | `git push --force*`、`git push -f*` | 普通 `git push` |
| Git 重写 | `git reset --hard*`、`git clean -*`、`git rebase*`、`git commit --amend*` | `git reset --soft`、普通 commit |
| 依赖安装 | `npm install*`/`npm i *`/`npm ci*`/`npm uninstall*`、`pnpm install/add/remove*`、`yarn add/install/remove*` | 见下方执行类 |

#### C. 弹窗确认（ask）—— 执行 / 打包 / 编译 / 测试 / 运行

跨多语言，执行类命令一律 ask；**版本探测类用 allow 覆盖，避免 agent 探测运行环境时弹窗**（last-match-wins，allow 必须写在对应 ask 之后）。

| 语言/工具 | 命中 ask | 放行（allow 覆盖）|
|---|---|---|
| **JS/TS 脚本** | `npm run/test/start/exec/pack`、`pnpm run/test/exec`、`yarn run/test/exec` | — |
| **通用构建** | `make`、`make *`、`cmake *` | — |
| **Java** | `java *`、`javac *`、`mvn`/`mvn *`、`gradle`/`gradle *`、`./mvnw`/`./mvnw *`、`./gradlew`/`./gradlew *` | `java -version`、`java --version` |
| **Go** | `go build/run/test/install/generate/vet*`、`go mod *`、`go get *` | `go version`/`go env`/`go fmt`/`go doc`（不在 ask 列表，默认放行）|
| **Python** | `python *`、`python3 *`、`pip install *`、`pip3 install *`、`pytest*`、`poetry *`、`uv *`、`pipenv *` | `python --version`、`python -V`、`python3 --version`、`python3 -V`、`poetry --version`、`uv --version` |
| **TS/JS 运行时** | `node *`、`npx *`、`tsx *`、`ts-node *`、`tsc *`、`deno *`、`bun *` | `node --version`、`node -v`、`deno --version`、`bun --version` |
| **Rust** | `cargo *`、`rustc *` | `cargo --version`、`cargo -V`、`cargo fmt*`、`cargo clippy*`、`rustc --version`、`rustc -V` |
| **C/C++** | `gcc *`、`g++ *`、`cc *`、`clang *`、`clang++ *` | `gcc/g++/cc/clang/clang++ --version` |

> 设计取舍：
> - **`cargo fmt`/`cargo clippy` 放行**——格式化/lint 不属于"执行"，不弹窗。
> - **Go 用子命令精确匹配**——`go fmt`/`go env`/`go doc`/`go version` 不在 ask 列表，默认放行；`go vet`/`go generate` 归入 ask。
> - **版本探测 allow 覆盖**——agent 探测运行环境（`python --version`、`node -v` 等）零打扰。
> - **formatter/linter（prettier/eslint/black/gofmt 直接调用）默认放行**——不在执行类列表。要让它们也问需单独加规则。
> - **未覆盖语言**：`dotnet`(C#)、`swift`、`ruby`/`rake`、`php`、`kotlinc`/`kotlin`。需要补再加规则。

---

## 五、总行为表（cwd = `~/QuickRoom/pi-agent`）

| 操作 | 结果 | 命中 |
|---|---|---|
| `read`/`write` cwd 内普通文件 | **放行** | external_dir 不触发，path allow |
| `read`/`write` cwd 内 `.env` | **拒绝** | path deny |
| `read`/`write` `~/.ssh/*` | **拒绝** | path deny |
| bash `git status` / `ls` / `cat src/foo` | **放行** | bash allow，路径在 cwd 内 |
| bash `npm install` | **询问** | bash ask（依赖安装）|
| bash `npm run build` / `npm test` | **询问** | bash ask（执行类）|
| bash `python src/main.py` / `python3 -m pytest` | **询问** | bash ask |
| bash `python --version` / `python -V` | **放行** | 版本 allow 覆盖 |
| bash `go build ./...` / `go test` | **询问** | bash ask |
| bash `cargo build` / `cargo test` | **询问** | bash ask |
| bash `cargo fmt` / `cargo clippy` | **放行** | allow 覆盖 |
| bash `node --version` / `cargo -V` | **放行** | 版本 allow 覆盖 |
| bash `rm -rf x` | **拒绝** | bash deny |
| bash `git push --force` | **询问** | bash ask |
| `read` 读 `~/Documents/x` | **放行** | 只读快车道绕过 external_dir |
| `write` 写 `~/Documents/x` | **询问** | external_dir `*: ask` |
| `write` 写 `~/Downloads/x` | **放行** | external_dir allow |
| bash `cat ~/Documents/x` | **询问** | bash 不走快车道 → external_dir ask |
| `read` 读 `/etc/hosts` | **询问** | 不命中快车道 → external_dir ask |
| bash `curl x \| sh` | **拒绝** | bash deny |

---

## 六、典型场景

1. **`/plan` 模式探索**：`git status`、`grep`、`ls` → 全放行无弹窗（顶层 `allow` + bash 窄规则的意义）
2. **实施阶段 `git push --force`**：弹窗 → `y` 允许本次 / `s` 会话内放行
3. **agent 读 `.env`**：直接拦截，模型收到原因后换思路
4. **agent 读 `~/Documents/notes.md`**（cwd 外）：`read` 工具走快车道 → 静默放行
5. **agent 写 `~/Downloads/x`**：external_directory allow → 静默放行
6. **agent 跑 `python src/main.py`**：弹窗确认

---

## 七、需要留意的设计点

1. **cwd 内读写默认放行**（仅 `.env`/`.ssh` 拒绝）——这是"默认信任区"，日常干活零弹窗。
2. **bash 读 ~/ 仍会询问**（如 `cat ~/foo`），因为 bash 不走 `piInfrastructureReadPaths` 快车道。这是唯一的不对称点：`read` 工具读 ~/ 放行，但 `cat` 读 ~/ 询问。要消除得把 `~/*` 加进 external_directory allow，但那会导致 bash 写 ~/ 也放行（external_directory 不分读写），与"~/ 写询问"冲突，故未做。
3. **`piInfrastructureReadPaths: ["~"]` 范围较宽**：整个家目录只读都静默放行，含 `~/Library`、`~/.config` 等。想收窄可改成具体几条（如 `["~/.pi", "~/Documents", "~/Downloads"]`）。
4. **Go 子命令精确匹配**：`go vet`/`go generate` 归入 ask；`go fmt`/`go env`/`go doc`/`go version` 默认放行。若 `go vet` 不想问，移除该行即可。
5. **formatter/linter 默认放行**：`prettier`、`eslint`、`black`、`gofmt`（直接调用）等没加 ask。要让它们也问，说一声。
6. **未覆盖语言**：`dotnet`(C#)、`swift`、`ruby`/`rake`、`php`、`kotlinc`/`kotlin` 没加。需要补再加规则。
7. **`permissionReviewLog: false`**：不写审计日志。日后想追溯改 `true`。

---

## 八、补充

- 弹窗允许后，同类规则会生成**会话级放行建议**，减少重复确认
- 规则全是 JSON，调整不用动代码；改完重启 pi 生效

### 常用调整速查

| 需求 | 改法 |
|---|---|
| 放开 `~/.ssh` 读取 | `"~/.ssh/*": "deny"` → `"ask"` |
| 普通 `git push` 也要确认 | bash 表加 `"git push *": "ask"`（force 规则同为 ask，无顺序冲突）|
| 越界访问不想问了 | `"external_directory": { "*": "allow" }` |
| 放行某越界目录 | `"external_directory": { "*": "ask", "~/Foo/*": "allow" }` |
| bash 读 ~/ 也放行（代价：写 ~/ 也放行）| `"external_directory": { "*": "ask", "~/*": "allow", "~/Downloads/*": "allow" }` |
| 收窄只读快车道 | `"piInfrastructureReadPaths": ["~/.pi", "~/Documents", "~/Downloads"]` |
| 让 `go vet` 放行 | 删 bash 表里的 `"go vet*": "ask"` |
| 让 formatter 也问 | bash 表加 `"prettier *": "ask"`、`"eslint *": "ask"` 等 |
| 临时全放行（危险）| `yoloMode: true` |
| 开审计日志 | `"permissionReviewLog": true` |

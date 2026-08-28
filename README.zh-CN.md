# pi-extensions

个人的 [pi](https://github.com/earendil-works/pi-coding-agent) agent 扩展集合。这里的每个条目通过 `setup.sh` 软链到 `~/.pi/agent/extensions/`，pi 在启动时（或 `/reload` 后）自动加载。

## 内容

| 条目 | 类型 | 作用 |
| --- | --- | --- |
| `git-trailer.ts` | 扩展 | 拦截 `bash` 工具调用，在 `git commit` 的 message 底部自动追加 `Assisted-by: Pi / <modelName>` trailer。通过 `tool_call` 事件钩子实现。 |
| `show-resources.ts` | 扩展 | `/resources` 命令——以渲染后的 markdown 表格列出所有扩展注册的 flag / command / tool / skill，在 overlay 浮层中展示，带 `customMessageBg` 底色。 |
| `pi-permission-system/` | 配置 | [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) 的配置目录——`config.json` 存放个人的 allow/ask/deny 权限规则。非自建代码。 |
| `rainbow-editor.ts` | 扩展（未安装） | 给输入框里匹配到的正则加彩虹流光高亮，正则来自 `rainbow-editor.json`。为何没装见下方[为什么 rainbow-editor 没装](#为什么-rainbow-editor-没装)。 |

## 前置要求

- 已安装 pi（`@earendil-works/pi-coding-agent`）。扩展从 pi 自带的包中 import，因此本 repo 不需要 `node_modules` 或 `package.json`。

## 安装

任意位置 clone，然后运行 setup 脚本把扩展软链到 `~/.pi/agent/extensions/`：

```bash
git clone git@github.com:cooocy/pi-extensions.git ~/firelink/pi-extensions
cd ~/firelink/pi-extensions
./setup.sh
```

然后在 pi 中：

```
/reload
```

`setup.sh` 是幂等的——重复运行只会补齐缺失或过期的软链。如果目标路径已存在真实文件或目录（例如之前的非软链安装），会在创建软链前备份为 `<name>.bak.<时间戳>`，不会破坏性覆盖。

## 工作原理

- `setup.sh` 把 repo 根目录下每个 `*.ts` / `*.js` 文件、以及每个非隐藏目录软链到 `~/.pi/agent/extensions/`。repo 元数据（`README.md`、`setup.sh`、`.gitignore`、`LICENSE`）会被跳过。
- pi 扫描 `~/.pi/agent/extensions/` 下的 `.ts` 入口作为扩展加载。`pi-permission-system/` 目录由 `@gotgenes/pi-permission-system` 包读取其配置。

## 为什么 rainbow-editor 没装

`rainbow-editor.ts` 放在本 repo 里（输入框正则高亮，可配置），但 **`setup.sh` 不会安装它**，原因有二：

1. **和 `pi-open-tui` 冲突。** 两者都用 `ctx.ui.setEditorComponent` 替换输入框编辑器——只能后加载的那个生效。`pi-open-tui` 是 npm 包，从 `settings.json` 的 `packages` 加载，排在全局 `~/.pi/agent/extensions/` 目录*之后*，所以软链的 rainbow-editor 会被覆盖、高亮完全不生效。改用 `pi install` 安装（让它排在 pi-open-tui 之后）能让高亮生效，但这回轮到它覆盖 `pi-open-tui` 的输入框——丢掉圆角边框、光标样式（`bar`/`underline`）、全屏滚轮行数。
2. **compose 包裹也行不通。** 把 pi-open-tui 的编辑器包在 rainbow-editor 里（让两者都跑）会破坏 `Ctrl+D`（退出）、`/` 命令补全、输入框颜色：这些特性绑定在唯一的*活动*编辑器实例的回调上（`onCtrlD`、`onExtensionShortcut`、补全状态），被包裹的那个实例收不到这些回调。这是 pi 编辑器组件模型的结构性限制，不是任何一方能修的 bug。

所以二者互斥：要么要 rainbow 的高亮（失去 open-tui 输入框特性），要么要 open-tui 的完整输入框（失去高亮）。日常用下来 open-tui 的特性更重要，于是本 repo 把 rainbow-editor 留作**独立、可选**的扩展：代码在、单独能用，但 `setup.sh` 不装它，以免默默把 open-tui 弄坏。

想手动试一下（会失去 open-tui 输入框特性）：

```bash
pi install ~/firelink/pi-extensions/rainbow-editor.ts   # 排在 pi-open-tui 之后加载
# 配置（可选，默认 ["ultrathink"]）：
cp ~/firelink/pi-extensions/rainbow-editor.json ~/.pi/agent/
/reload   # 在 pi 里
```

事后卸载：`pi uninstall ~/firelink/pi-extensions/rainbow-editor.ts`（如果拷过配置，删掉 `~/.pi/agent/rainbow-editor.json`）。

## 注意

- `pi-permission-system/config.json` 含个人权限规则（路径模式、deny/ask 列表）。若本 repo 公开，会暴露你的目录结构和策略——建议设为私有 repo，或将该 config 加入 `.gitignore` 单机管理。
- 软链是绝对路径，移动 repo 后重新跑 `./setup.sh` 即可刷新。

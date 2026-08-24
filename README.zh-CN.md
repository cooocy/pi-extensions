# pi-extensions

个人的 [pi](https://github.com/earendil-works/pi-coding-agent) agent 扩展集合。这里的每个条目通过 `setup.sh` 软链到 `~/.pi/agent/extensions/`，pi 在启动时（或 `/reload` 后）自动加载。

## 内容

| 条目 | 类型 | 作用 |
| --- | --- | --- |
| `git-trailer.ts` | 扩展 | 拦截 `bash` 工具调用，在 `git commit` 的 message 底部自动追加 `Assisted-by: Pi / <modelName>` trailer。通过 `tool_call` 事件钩子实现。 |
| `show-resources.ts` | 扩展 | `/resources` 命令——以渲染后的 markdown 表格列出所有扩展注册的 flag / command / tool / skill，在 overlay 浮层中展示，带 `customMessageBg` 底色。 |
| `pi-permission-system/` | 配置 | [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) 的配置目录——`config.json` 存放个人的 allow/ask/deny 权限规则。非自建代码。 |

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

## 注意

- `pi-permission-system/config.json` 含个人权限规则（路径模式、deny/ask 列表）。若本 repo 公开，会暴露你的目录结构和策略——建议设为私有 repo，或将该 config 加入 `.gitignore` 单机管理。
- 软链是绝对路径，移动 repo 后重新跑 `./setup.sh` 即可刷新。

# dsh-move-to-workspace · 移动到工作区

[English](./README.md) · [中文](./README.zh-CN.md)

把已有会话**移动到另一个工作区**，或在同一对话框里新建工作区目录；原会话完整复制后归档，可随时恢复。

## 快速开始

```sh
dsh plugin --profile web add dsh-move-to-workspace
```

重启 Harness（或刷新 Web 界面）。每条会话的 **…** 菜单里会多出 **Move to workspace…**。

## 功能

- **移动会话**：复制完整历史到目标工作区，标题与内容不变，之后在那里继续。
- **新建工作区目录**：在同一个选择器里注册新文件夹，不用先去别处建。
- **原会话归档而非删除**：可恢复，失败时原件保持可见。
- **批量整理**：一次把一个文件夹下的会话分配到对应工作区，先出预览再执行。
- **重命名与删除会话**：删除前有确认，会永久移除日志。
- **注册表体检**：`npm run registry-doctor` 可检测并修复重复的工作区归属。

## 要求

DeepSeek Harness `>=0.2.1-rc.3 <0.3.0-0`，Web profile（桌面版或 Web 界面）

## 相关链接

- 英文说明（完整细节）：[README.md](./README.md)
- npm：<https://www.npmjs.com/package/dsh-move-to-workspace>
- 更新记录：[CHANGELOG.md](./CHANGELOG.md)

<sub>同系列插件：[情绪板](https://github.com/Stijnus/dsh-moodboard) · [输入补全](https://github.com/Stijnus/dsh-composer-predictions) · [移动到工作区](https://github.com/Stijnus/dsh-move-to-workspace) · [工作区状态](https://github.com/Stijnus/dsh-workspace-status) · [提示词改写](https://github.com/Stijnus/dsh-prompt-optimizer)</sub>

<sub>⭐ 如果它帮你省了一步，点个 star 能让更多 DSH 用户发现它。</sub>

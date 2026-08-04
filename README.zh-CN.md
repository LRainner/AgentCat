# Agent Cat

<p align="center">
  <img src="assets/app-icon.svg" width="128" height="128" alt="Agent Cat 图标" />
</p>

<p align="center">
  <strong>为 AI Agent 打造的动画桌面伴侣。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

Agent Cat 用动画桌面宠物和实时状态，让 AI Agent 的工作过程变得直观而有趣。项目目标是不局限于某个 Agent 或操作系统；目前已实现 macOS 和 Windows 上的 Codex 与 Claude Code 集成。

<p align="center">
  <a href="docs/images/agent-cat-overview.png">
    <img src="docs/images/agent-cat-overview.png" width="92%" alt="Agent Cat 桌面宠物与重叠的 Codex 状态气泡" />
  </a>
</p>

> **当前状态：** Agent Cat 正在积极开发中。当前版本支持 macOS 12 及以上系统和 Windows 10 及以上系统，并已集成 Codex 与 Claude Code；更多 Agent 和操作系统仍在规划中。

## 下载

请从 [GitHub Releases](https://github.com/LRainner/AgentCat/releases/latest) 下载最新版本。

当前 macOS 版本没有使用 Apple Developer ID 进行公证。如果首次启动被 macOS 阻止，请右键点击 Agent Cat 并选择**打开**，或前往**系统设置 → 隐私与安全性**允许打开。请仅安装从本仓库下载的版本。

当前 Windows 版本尚未进行代码签名，首次启动时 Windows SmartScreen 可能显示警告；请只运行从本仓库下载的安装包。

## 主要功能

- 桌面宠物动画，支持单击、双击、拖动、空闲动作和跟随鼠标视线
- 在宠物旁实时显示 Agent 状态，同时不扩大宠物的鼠标点击区域
- 可调节宠物大小、透明度、始终置顶、鼠标穿透和位置锁定
- 提供系统托盘控制、登录时启动、设置窗口和动画测试器
- 兼容 Codex v1/v2 宠物包，支持九种标准动画和 v2 的 16 个观察方向
- 可从已安装的 ChatGPT/Codex App、`~/.codex/pets` 和用户指定目录发现宠物
- 按需读取本机已有宠物资源，不复制或重新分发这些资源
- 找不到兼容宠物包时，使用项目原创的内置 fallback 宠物

## Agent 集成

### Codex

Agent Cat 通过 command Hook 响应 Codex 会话。你可以在设置窗口中安装、修复、测试或卸载集成；这一过程会保留其他工具已经配置的 Hook。

当前集成可识别会话开始/退出、用户提示、工具调用、子 Agent、上下文压缩、权限请求、完成和任务中断事件。实时状态和任务摘要可以分别开关。

### Claude Code

Agent Cat 会将 command Hook 安装到 `~/.claude/settings.json`，并保留用户已有的 Claude Code 设置和其他 Hook。当前观察 13 个与宠物状态有关的事件，覆盖会话、用户提示、工具执行与失败、子 Agent、上下文压缩、权限请求、任务完成和 API 错误。Claude Code 与 Codex 的安装、测试、暂停、修复和卸载互不影响。

## 宠物包

每个宠物使用一个独立目录，其中包含 `pet.json` 和 PNG 或 WebP 格式的 spritesheet：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "可选的宠物描述",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.png"
}
```

当前渲染器支持与 Codex 兼容的精灵图布局：

- 单格尺寸：`192 × 208`
- v1 精灵图：`8 × 9` 格（`1536 × 1872`）
- v2 精灵图：`8 × 11` 格（`1536 × 2288`）
- `spriteVersionNumber` 可为 `1` 或 `2`；省略时按 v1 处理

你可以把自定义宠物包放入 `~/.codex/pets`，也可以在设置中添加其他目录。

## 本地开发

### 环境要求

- macOS 12 或更高版本，或 Windows 10 及以上系统
- Node.js 20.19 或更高版本
- 稳定版 Rust 工具链
- macOS 需要 Xcode Command Line Tools
- Windows 需要 Microsoft Edge WebView2 Runtime（安装程序可按需下载）

### 运行

```bash
npm install
npm run tauri -- dev
```

右键点击宠物可以打开设置。也可以通过命令行打开辅助窗口：

```bash
agent-cat --settings
agent-cat --pet-debug
```

### 测试与构建

首次运行浏览器测试或重新生成截图前，需要安装 Playwright Chromium：

```bash
npx playwright install chromium
```

```bash
npm test
npm run test:e2e
npm run screenshots
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

`npm run screenshots` 会使用固定的本地模拟数据，重新生成 `docs/images` 中的项目截图。

在 Windows 上只构建 NSIS 安装包可运行 `npm run build:windows`；在 macOS 上可用 `npm run build:macos` 构建 app bundle。

## 项目结构

```text
assets/       原创应用图标和菜单栏图标
docs/         为 README 自动生成的项目截图
e2e/          浏览器测试和固定截图生成器
fixtures/     自动化测试使用的固定宠物样本
src/          HTML、TypeScript、CSS 和前端测试
src-tauri/    Rust 后端、Tauri 配置和各平台图标
```

## 隐私

Agent Cat 在本地处理 Codex 与 Claude Code 事件。Hook 辅助进程从载荷中提取生命周期标识、Hook 事件名称和经过清理的工具名称，通过 macOS 本地 Unix Domain Socket 或 Windows 回环连接发送后立即退出。仅对 Codex，为识别 Esc 中断还会接收当前 transcript 路径，只在任务执行期间读取新增记录，并在检查生命周期元数据后丢弃原始记录；Agent Cat 不观察 Claude Code transcript。

开启任务摘要后，Agent Cat 只在内存中保留用户提示的首个非空行，最多 80 个字符，用于实时展示。摘要不会写入配置、日志或历史记录。

Agent Cat 不持久化完整提示词、工具参数、文件内容、transcript、终端输出、token 用量或模型信息，不建立活动历史数据库，也不会将这些数据发送到远程服务。

## 规划

- 适配更多 AI Agent
- 支持 Linux
- 提供有文档说明、与具体 Agent 无关的事件适配接口
- 建立独立的宠物包规范和制作流程

项目仍在逐步成形，欢迎贡献代码和想法。

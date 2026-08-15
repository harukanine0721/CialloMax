# CialloMax

`CialloMax` 是一个 pi 扩展，包含两个 UI 功能：

- 启动时在会话顶部显示一行欢迎字：`Ciallo～(∠・ω< )⌒★`（一次性开局提示，不发送给模型）。
- 思考强度从其他级别切换到 `max` 时，在输入框上方播放一次 Codex effort ignition 风格的三行点火动画：蓝紫色波带从中间向两侧扩散（前缘尖锐、后缘软尾，波带过后中间变暗），同时 `Ciallo～(∠・ω< )⌒★` 从散开的大间距字母向中间收敛（中间字母先出现、两边字母后出现，从小变大），最后整体淡出。

波带（Pulse 环、`crest` 衰减、无内部填充）、文字收敛（`effort_status_line.rs` 的 gap 权重与 stagger）、envelope 包络、`33ms` 帧间隔、缓入缓出都直接移植自 Codex 的 `effort_ignition.rs` / `effort_ignition_styles.rs` / `effort_status_line.rs`（Ultra 档 hue `(186,130,255)`/`(255,120,220)`/`(120,170,255)`），总时长 1.6 秒，用真彩色 `48;2` 背景 + `38;2` 前景直接输出，不受主题影响。

## 直接试用

在此目录执行：

```bash
pi -e ./index.ts
```

启动后会话顶部会出现欢迎字。使用 `/ciallomax-preview` 可随时预览一次动画。

动画只在“从其他级别切换到 `max`”时触发。如果 `settings.json` 里的 `defaultThinkingLevel` 本身就是 `max`，一开始就是 max、不会触发；先按 `Shift+Tab` 切到别的级别再切回 `max`，或直接用 `/ciallomax-preview`。

欢迎字用会话条目（entry）渲染、动画用带 key 的临时挂件（widget）渲染，都不占用 Header/Footer，因此可以和接管了 Header/Footer 的扩展（例如 `pi-open-tui`）共存。动画参考 Codex CLI 公开实现：[Animate Max and Ultra reasoning effort changes](https://github.com/openai/codex/pull/34365)，过渡文案替换为 Ciallo 欢迎字。

## 安装

### npm 发布版

```bash
pi install npm:ciallomax
```

或手动加入 `~/.pi/agent/settings.json` 的 `packages`：

```json
"packages": [..., "npm:ciallomax"]
```

### 本地源码

把当前目录作为本地 pi 包安装：

```bash
pi install -l /Users/nineharuka/Documents/vscodeProjects/CialloMax
```

也可以将目录放入项目的 `.pi/extensions/CialloMax/`，或在 `settings.json` 的 `packages` / `extensions` 中引用它。安装后执行 `/reload`，或者重启 pi。

## 检查

扩展不需要单独编译，pi 会直接加载 TypeScript。若本地已安装 pi 的类型依赖，可以运行：

```bash
npm run check
```

## 发布

### 首次发布（手动，需要 OTP）

```bash
npm publish
```

账号开启了 2FA，首次发布会要求一次性密码（OTP）。

### 后续发布（自动，Trusted Publisher）

GitHub Actions 已配置 `publish.yml`：推 `v*` tag 即自动执行类型检查并通过 **npm Trusted Publisher**（OIDC）发布，无需任何 token。

```bash
git tag v0.1.1
git push origin v0.1.1
```

前提：在 npm 网站配置 Trusted Publisher（见下方）。

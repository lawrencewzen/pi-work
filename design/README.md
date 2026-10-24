# Weft 设计稿（已确认）

- 默认主题：**white**（纯白，中性灰，状态色只用很淡的小圆点）。主稿：`mockup-v2-white.png`
- 主题：white / claude / codex / grok / cursor，每个都有 light 和 dark。变量在 `themes/themes.css`，切换方式是 `<html data-theme="white-light">`；色值在 `themes/palettes.json`；所有主题对比见 `themes/mockup-themes-contact-sheet.png`
- 多语言：zh（默认）/ en，英文版见 `mockup-v2-white-en.png`
- 侧边栏：工作区 > 对话 > Agent。同一个对话里的 Agent 平铺显示（状态点 + 名称 + 进度），主 Agent 不加特殊标记。设置按钮在左下角
- 设置弹窗的标签页：通用（语言、主题、浅色/深色/跟随系统）、模型（服务商、Base URL、API Key、每个角色的默认模型）、插件（搜索、卡片、开关、导入）、Skills（搜索、卡片）、关于。截图在 `settings/`
- 所有 PNG 都是 4K：1440x900 视口，deviceScaleFactor 2.6667，输出 3840x2400

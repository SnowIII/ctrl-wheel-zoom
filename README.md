# 界面缩放（Ctrl+滚轮）

给 TauriTavern 的等比界面缩放：**按住 Ctrl 用鼠标滚轮**即可像浏览器那样整页缩放，
`Ctrl+0` 复位、`Ctrl+=` 放大、`Ctrl+-` 缩小。

- 扩展目录名：`ctrl-wheel-zoom`
- 显示名：界面缩放（Ctrl+滚轮）
- 版本：1.0.0
- 依赖：无（不引用酒馆内部模块，纯 DOM + ESM）

---

## 1. 用法

| 操作 | 效果 |
| --- | --- |
| `Ctrl` + 滚轮上/下 | 按浏览器档位放大/缩小（25% → 500%） |
| `Ctrl+0` | 回到 100% |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小一档 |
| 扩展面板 | 总开关、档位滑条、100/125/150/200% 快捷按钮、三个子开关 |

档位表与浏览器一致：`25 33 50 67 75 80 90 100 110 125 150 175 200 250 300 400 500`。
缩放级别按设备保存在 `localStorage`（`tt-ctrl-wheel-zoom`），与浏览器缩放一样属于本机显示偏好。

滚轮只在按住 `Ctrl`（macOS 上 `Cmd`）时被接管；普通滚轮行为完全不变。
被接管时事件会被 `preventDefault`，避免同时触发酒馆自身的滚轮处理（例如滑条数值跟随滚轮增减）。

## 2. 安装

两种位置任选，同名时 local 优先（与 TauriTavern 文档一致）：

| 类型 | 目录 |
| --- | --- |
| 全局（global） | `<数据根目录>/extensions/third-party/ctrl-wheel-zoom/` |
| 单用户（local） | `<数据根目录>/default-user/extensions/ctrl-wheel-zoom/` |

Windows 下 TauriTavern 的数据根目录通常是：

```
%APPDATA%\com.tauritavern.client\data
```

即完整路径形如 `…\data\extensions\third-party\ctrl-wheel-zoom\`。
放好文件后**重新加载页面/重启 TauriTavern**，在「扩展」面板里即可看到本扩展（默认启用）。

## 3. 为什么是 CSS 模拟，而不是真正的 WebView 缩放

真正的"浏览器级"缩放在这里拿不到，原因有两个，都已核对过源码：

1. **用户缩放被关掉**：Windows 上 Tauri 的 `zoomHotkeysEnabled` 对应 WebView2 的
   `IsZoomControlEnabled`，TauriTavern 的 `tauri.conf.json` 未开启它，所以 `Ctrl+滚轮`
   在 WebView 层面本来就不会缩放。
2. **页面脚本也调不到**：Tauri 的 `core:webview:default` 只包含 getter
   （`allow-get-all-webviews` / `allow-webview-position` / `allow-webview-size` /
   `allow-internal-toggle-devtools`），**不含** `allow-set-webview-zoom`；
   TauriTavern 的 capability 用的是 `core:default`，因此
   `plugin:webview|set_webview_zoom` 会被 ACL 拒绝。

所以本扩展用 CSS `zoom` 施加在 `<html>` 上：它参与布局，百分比宽度、flex、
`position: fixed` 都会一起缩放，视觉效果与浏览器缩放一致。

### 3.1 必须补的坑：视口单位

Chromium 的 `zoom` **不会**重算视口单位。实测（真实酒馆页面，1280×860）：

| 处理 | 200% 时 `--sheldWidth: 50vw` 的后果 |
| --- | --- |
| 直接 `html { zoom: 2 }` | 聊天列占满整屏、横向滚动条溢出约 993px |
| 本扩展（改写成 `calc(50vw / 2)`） | 聊天列仍为半屏、横向溢出 0 |

内核会把文档里所有含视口单位（`vw/vh/dvw/dvh/svw/svh/lvw/lvh`）的长度改写成
`calc(<原值> / 缩放倍数)`，覆盖两类来源：

- 样式表规则（含 `@media` / `@supports` / `@import` 递归；跨源表跳过）
- **内联样式**——酒馆本体就是把 `--sheldWidth: <n>vw` 写在 `:root` 的内联样式上的

每条属性都登记了"作者原值"，所以：外部改写会被识别为新基准（不会被本扩展覆盖回去），
反复缩放不会层层叠加 `calc`，回到 100% 时原值精确还原（实测：`--sheldWidth` 回到 `50vw`，
`style` 里无残留）。

## 4. 让卡片前端也一起缩放：JS 视口 / 坐标兼容

CSS 单位补好了，但**卡片前端**（HUD、小游戏、状态面板这类由前端脚本注入的界面）往往不写
`vw`，而是读窗口像素再写内联样式，例如实测到的：

```html
<div id="linjiang-hud-stage" style="position:fixed; width:1280px; height:700px">
```

CSS `zoom` 不改 JS 的报告值，所以这类元素会变成 `倍数` 倍大、顶出横向滚动条。
**JS 视口/坐标兼容**（默认开）解决这个问题：它把下面这些接口统一改按"缩放后的布局坐标"
报告——与真实浏览器缩放下的语义一致：

| 接口 | 处理 |
| --- | --- |
| `window.innerWidth / innerHeight`、`visualViewport.width / height` | ÷ 倍数 |
| 根元素 `clientWidth / clientHeight` | ÷ 倍数（`body.clientWidth`、`offsetWidth`、`getComputedStyle` 本来就是布局坐标，不动） |
| `Element/Range.getBoundingClientRect / getClientRects` | 坐标与尺寸 ÷ 倍数 |
| `MouseEvent` 的 `clientX/Y`、`pageX/Y`、`offsetX/Y`、`movementX/Y`、`x/y` | ÷ 倍数 |
| `document.elementFromPoint / elementsFromPoint` 入参 | × 倍数（入参是视觉坐标） |
| 缩放变化后 | 派发一次 `resize`，让"监听 resize 重排"的前端脚本重新适配 |

效果（lab 实测，1280 宽窗口 + 200%）：

| 场景 | 兼容开 | 兼容关 |
| --- | --- | --- |
| 前端按 `innerWidth` 写尺寸的浮层 | 视觉宽 1258px = 正好满屏 | 2516px，溢出 |
| 拖拽（`style.left += clientX 位移`） | 光标与元素偏移恒定（精确跟随） | 元素移动速度是光标的 2 倍 |
| 100% 时 | 补丁全部卸掉，接口还原 | — |

副作用与排查：极少数扩展会假设 `rect` 就是"屏幕像素"，缩放≠100% 时其定位可能偏移；
遇到就把这个开关关掉（CSS 部分照常工作），或用下一节的 `--cwz-zoom` 精确补偿。

## 5. 已知边界

- **只测一次窗口尺寸的前端脚本**：兼容模式让 `innerWidth` 变小，但一个"只在加载时量一次、
  之后不监听 resize"的脚本仍会保留旧值。此时在目标缩放下**重新进入聊天/刷新一次**即可让它
  按当前倍数适配；若不想刷新，可用 `--cwz-zoom` 精确补偿：

  ```css
  #linjiang-hud-stage {
      width: calc(100vw / var(--cwz-zoom, 1)) !important;
      height: calc(100dvh / var(--cwz-zoom, 1)) !important;
  }
  ```

  内核会把当前倍数写到 `:root` 的 `--cwz-zoom`（100% 时为 `1`）；凡是用到它的声明内核
  不再插手（避免二次折算），扩展未加载时 `var(--cwz-zoom, 1)` 的兜底值保证样式仍然有效。
- **跨源样式表无法折算**（`cssRules` 读不到，只能跳过）。实测 TauriTavern 页面里确实存在
  这种表（酒馆自己的 `dynamic-styles.js` 也会因此打印 SecurityError 警告），
  但其中不含视口单位规则，所以不影响布局。
- **CSS `@media` 条件不折算**：`vw` 这类长度是内核改写的，媒体查询却不是（改不了）。
  酒馆的移动端判定走的是 UA（`isMobile()` 读 `navigator.platform`），所以不会因此误判；
  但如果你有脚本按 `matchMedia('(max-width: …)')` 做布局分支，它会沿用未缩放的视口答案。
- 跨源 iframe 内的滚轮事件不会触发缩放（顶层文档收不到）。
- 缩放级别按设备保存，不进入酒馆的 `settings.json`，因此不随 TT-Sync 同步。

## 6. 如果要真正的原生缩放

给 TauriTavern 本体加两处即可（扩展无法代劳）：

1. `tauri.conf.json` 的窗口配置（或 Rust 侧 `WebviewWindowBuilder`）加上
   `"zoomHotkeysEnabled": true`；
2. 若还要让脚本控制缩放，capability 里补 `core:webview:allow-set-webview-zoom`。

在那之后本扩展可以直接停用（`Ctrl+滚轮` 由 WebView 原生处理，效果与浏览器完全一致，
连兼容开关都不需要：原生缩放本来就缩小 CSS 像素并把 `innerWidth` 一起改小）。


## 7. 文件与开发

```
zoom-core.js   缩放内核：视口单位补偿、JS 视口/坐标兼容、滚轮/快捷键、提示浮层（无酒馆依赖）
index.js       扩展外壳：localStorage 持久化、设置面板、诊断入口
style.css      设置面板样式（纯 px）
manifest.json  扩展清单
```

诊断：控制台执行 `__ctrlWheelZoom.getState()`，或 `__ctrlWheelZoom.controller.setZoom(150)`。

内核可在普通浏览器里独立驱动，本次开发就是用 headless Chromium + CDP 加载真实酒馆页面
（`public/index.html` 的真实 CSS 与 DOM）跑的回归：

- 档位 150/200/300/75/50/100：横向溢出恒为 0，`#sheld` 视觉宽度恒为 629px（= 50vw），
  缩放比例与档位一致
- `Ctrl+滚轮` 经真实输入管线：3 格向上 100% → 150%，6 格向下 150% → 75%；
  不带 Ctrl 的滚轮不影响缩放
- 快捷键：`Ctrl+=` → 110%，`Ctrl+-`×2 → 90%，`Ctrl+0` → 100%
- 连续 10 次改档共 10–20ms（每档约 1–2ms；首次扫描样式表约 30–50ms）
- 兼容模式：按 `innerWidth` 写尺寸的前端浮层在 200% 下视觉宽 1258px（正好满屏）、
  拖拽偏移恒定；关掉兼容后同场景分别是溢出与 2 倍过冲；100% 时补丁全部卸净
- 动态场景：缩放中新增/替换样式表、酒馆改写内联 `--sheldWidth`、往返缩放，均不叠加
  `calc`、100% 时精确还原（`--sheldWidth` 回到作者原值，无残留）
- 真机（TauriTavern 2.3.0 + 你的扩展/聊天）：`#sheld` 视觉宽恒为 60vw、`Ctrl+0` 精确还原、
  扩展自身零异常

## 8. 许可

MIT，见 [LICENSE](LICENSE)。

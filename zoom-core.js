/**
 * Ctrl+滚轮 等比缩放 —— 纯 DOM 内核，不依赖 SillyTavern / TauriTavern。
 *
 * ## 为什么不是"直接调用 WebView 缩放"
 *   - WebView2 的用户缩放开关由 Tauri 的 `zoomHotkeysEnabled` 控制，TauriTavern 未开启；
 *   - Tauri 的 ACL 也没有授予 `core:webview:allow-set-webview-zoom`（`core:default` 只含 getter）。
 *   所以页面脚本唯一可行的等比缩放是 CSS `zoom`：它参与布局，百分比宽度、flex 与
 *   `position: fixed` 都会一起缩放，这正是浏览器式的"等比"。
 *
 * ## 必须补的那个坑：视口单位不会跟着重算
 *   Chromium 的 `zoom` 只缩放渲染，不重算视口单位：`50vw` 仍按未缩放的视口解析，
 *   于是 200% 时本该占半屏的聊天列会占满整屏，还会撑出横向滚动条。
 *   本内核把文档里所有含视口单位（vw/vh/dvw/dvh/svw/svh/lvw/lvh）的长度改写成
 *   `calc(<原值> / 缩放倍数)`，并登记原始值：外部（主题、酒馆本体、其它扩展）改写过的值
 *   会被识别为新的基准，不会被本内核覆盖回去。
 *
 * ## 已知边界
 *   CSS `zoom` 不改鼠标事件的坐标空间，而 `style.left/top` 等按缩放前的布局像素解释。
 *   于是缩放≠100% 时，依赖"鼠标位移 → 像素偏移"的拖拽会比预期移动得更快
 *   （浏览器原生缩放没有这个问题，因为它改变的是 CSS 像素本身）。
 */

export const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
export const DEFAULT_ZOOM = 100;

/** 匹配 CSS 长度里的视口单位，避开 `overflow` 之类的普通标识符。 */
const VIEWPORT_UNIT_RE = /(-?(?:\d+\.?\d*|\.\d+))((?:d|s|l)?v[wh])(?![a-z0-9_-])/gi;

/**
 * 作者自己用 `--cwz-zoom` 折算过的声明，本内核不再插手。
 * 这是留给"脚本按 window.innerWidth 写死 px 尺寸"那类元素的逃生阀，见 README。
 */
const SELF_SCALED_RE = /--cwz-zoom/;
const ZOOM_VAR = '--cwz-zoom';

/** 一个滚轮"格"的像素量（deltaMode 0）。 */
const NOTCH_PX = 100;
const NOTCH_LINES = 3;
const NOTCH_PAGES = 1;

function containsViewportUnit(text) {
    if (!text || text.indexOf('v') === -1) return false;
    VIEWPORT_UNIT_RE.lastIndex = 0;
    let match;
    while ((match = VIEWPORT_UNIT_RE.exec(text)) !== null) {
        const value = parseFloat(match[1]);
        if (Number.isFinite(value) && value !== 0) return true;
    }
    return false;
}

function divideViewportUnits(text, zoom) {
    VIEWPORT_UNIT_RE.lastIndex = 0;
    return text.replace(VIEWPORT_UNIT_RE, (whole, value, unit) => {
        const numeric = parseFloat(value);
        if (!Number.isFinite(numeric) || numeric === 0) return whole;
        return `calc(${value}${unit} / ${zoom})`;
    });
}

/** 取档位表里最接近的百分比。 */
export function nearestZoom(percent) {
    const numeric = Number(percent);
    if (!Number.isFinite(numeric)) return DEFAULT_ZOOM;
    let best = ZOOM_LEVELS[0];
    let bestDelta = Infinity;
    for (const level of ZOOM_LEVELS) {
        const delta = Math.abs(level - numeric);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = level;
        }
    }
    return best;
}

/**
 * 创建缩放控制器。
 * @param {object} [options]
 * @param {boolean} [options.enabled] 总开关
 * @param {number}  [options.zoom] 初始百分比（会被吸附到档位表）
 * @param {boolean} [options.wheel] 是否响应 Ctrl+滚轮
 * @param {boolean} [options.hotkeys] 是否响应 Ctrl+0 / Ctrl+= / Ctrl+-
 * @param {boolean} [options.indicator] 是否显示缩放提示浮层
 */
export function createZoomController(options = {}) {
    const state = {
        enabled: true,
        zoom: DEFAULT_ZOOM,
        wheel: true,
        hotkeys: true,
        indicator: true,
        compat: true,
    };
    for (const key of Object.keys(state)) {
        if (options[key] !== undefined && options[key] !== null) state[key] = options[key];
    }
    state.enabled = Boolean(state.enabled);
    state.wheel = Boolean(state.wheel);
    state.hotkeys = Boolean(state.hotkeys);
    state.indicator = Boolean(state.indicator);
    state.compat = Boolean(state.compat);
    state.zoom = nearestZoom(state.zoom);

    /** 真正施加到 <html> 上的倍数 */
    let factor = 1;
    let wheelAccumulator = 0;
    let destroyed = false;
    let started = false;
    let compensationError = null;
    let layoutOverflow = false;
    let overflowTimer = 0;
    let indicatorEl = null;
    let indicatorTimer = 0;
    let resyncTimer = 0;
    let viewportTimer = 0;
    const inlineElements = new Set();
    let lastPassMs = 0;
    let lastPassSheets = 0;

    const listeners = new Set();

    /** 内核自己的量测：绕开 compat 补丁（见「JS 视口/坐标兼容」） */
    const nativeGet = {
        clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get,
        scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')?.get,
    };
    function layoutViewportWidth(root) {
        try {
            return nativeGet.clientWidth.call(root);
        } catch {
            return root.clientWidth;
        }
    }
    function layoutScrollWidth(root) {
        try {
            return nativeGet.scrollWidth.call(root);
        } catch {
            return root.scrollWidth;
        }
    }

    /* ================= 视口单位补偿 ================= */

    /** CSSStyleDeclaration -> Map<property, {source, applied, priority}> */
    const declarationBuckets = new WeakMap();
    /** CSSStyleSheet -> 需要跟随缩放的声明列表 */
    const sheetDeclarations = new Map();
    const dirtySheets = new Set();
    /** 读不到 cssRules 的跨源样式表：跳过，不再反复抛异常 */
    const blockedSheets = new Set();
    let observer = null;

    function bucketOf(declaration) {
        let bucket = declarationBuckets.get(declaration);
        if (!bucket) {
            bucket = new Map();
            declarationBuckets.set(declaration, bucket);
        }
        return bucket;
    }

    /**
     * 把一条声明在当前倍数下改写；返回真正生效的值（读回值），返回 null 表示这条属性已不需要补偿。
     * `entry.source` 始终保存"作者写下的原值"，所以反复缩放不会层层叠加。
     */
    function applyEntry(declaration, property, entry, zoom) {
        const current = declaration.getPropertyValue(property);
        if (current !== entry.applied) {
            // 外部改写过它（主题切换、酒馆本体、其它扩展）——以新值为基准
            entry.source = current;
            entry.priority = declaration.getPropertyPriority(property);
        }
        if (!containsViewportUnit(entry.source)) return null;
        // 作者用 --cwz-zoom 自己折算，说明他不需要内核代劳
        if (SELF_SCALED_RE.test(entry.source)) return null;

        const next = zoom === 1 ? entry.source : divideViewportUnits(entry.source, zoom);
        if (next === current) return current;
        try {
            declaration.setProperty(property, next, entry.priority);
        } catch {
            return null;
        }
        // 浏览器会归一化写入值（实测：`calc(100vw / 2)` 读回是 `calc(50vw)`）。
        // 必须以读回值为准，否则下一轮会把归一化结果误判成"外部改写"而再折算一次。
        return declaration.getPropertyValue(property);
    }

    /** 只刷新已登记的属性（缩放变化时的快路径）。 */
    function refreshDeclaration(declaration, zoom) {
        const bucket = declarationBuckets.get(declaration);
        if (!bucket || bucket.size === 0) return;
        for (const [property, entry] of bucket) {
            const applied = applyEntry(declaration, property, entry, zoom);
            if (applied === null) bucket.delete(property);
            else entry.applied = applied;
        }
    }

    /** 登记一条声明里所有含视口单位的属性（首次扫描 / 内容变化后）。 */
    function discoverDeclaration(declaration) {
        const text = declaration.cssText;
        if (!text || text.indexOf('v') === -1 || !containsViewportUnit(text)) {
            return declarationBuckets.has(declaration);
        }
        const bucket = bucketOf(declaration);
        const properties = [];
        for (let i = 0; i < declaration.length; i++) properties.push(declaration[i]);
        for (const property of properties) {
            const value = declaration.getPropertyValue(property);
            if (!containsViewportUnit(value)) continue;
            // 按属性判断，而不是按整条声明：`:root` 内联样式里既有内核写入的 --cwz-zoom，
            // 也有酒馆的 --sheldWidth，粗粒度跳过会连 --sheldWidth 一起漏掉。
            if (SELF_SCALED_RE.test(value)) continue;
            if (!bucket.has(property)) {
                bucket.set(property, {
                    source: value,
                    applied: value,
                    priority: declaration.getPropertyPriority(property),
                });
            }
        }
        return bucket.size > 0;
    }

    /**
     * 收集规则里所有声明。
     * 每一步都必须能容忍跨源样式表：TauriTavern 页面里就存在读取 `cssRules` 会抛
     * SecurityError 的样式表（@import 到别源），裸读会让整个扩展在求值阶段崩掉。
     */
    function collectDeclarations(rules, out) {
        for (let i = 0; i < rules.length; i++) {
            let rule = null;
            try {
                rule = rules[i];
            } catch {
                continue;
            }
            if (!rule) continue;
            const style = rule.style;
            if (style && style.length) out.push(style);

            let nested = null;
            try {
                if (rule.cssRules && rule.cssRules.length) nested = rule.cssRules;
                else if (rule.styleSheet && rule.styleSheet.cssRules && rule.styleSheet.cssRules.length) {
                    // @import 的旧式访问路径
                    nested = rule.styleSheet.cssRules;
                }
            } catch {
                nested = null;
            }
            if (nested) collectDeclarations(nested, out);
        }
    }

    /** 扫描一张样式表；返回 false 表示这次读不到（跨源 / 还没加载完）。 */
    function scanSheet(sheet, zoom) {
        if (blockedSheets.has(sheet)) return false;
        let rules = null;
        try {
            rules = sheet.cssRules;
        } catch {
            // 跨源样式表：我们没有补偿它的可能，也不该反复抛异常
            blockedSheets.add(sheet);
            return false;
        }
        if (!rules || rules.length === 0) return false;

        const declarations = [];
        collectDeclarations(rules, declarations);
        const kept = [];
        for (const declaration of declarations) {
            if (discoverDeclaration(declaration)) {
                refreshDeclaration(declaration, zoom);
                kept.push(declaration);
            }
        }
        sheetDeclarations.set(sheet, kept);
        return true;
    }

    function syncSheets(zoom) {
        const sheets = document.styleSheets;
        const seen = new Set();
        for (let i = 0; i < sheets.length; i++) {
            const sheet = sheets[i];
            seen.add(sheet);
            if (sheetDeclarations.has(sheet) && !dirtySheets.has(sheet)) continue;
            dirtySheets.delete(sheet);
            scanSheet(sheet, zoom);
        }
        for (const sheet of Array.from(sheetDeclarations.keys())) {
            if (!seen.has(sheet)) sheetDeclarations.delete(sheet);
        }
    }

    function refreshSheets(zoom) {
        for (const declarations of sheetDeclarations.values()) {
            for (const declaration of declarations) refreshDeclaration(declaration, zoom);
        }
    }

    /**
     * 内联样式同样需要补偿：SillyTavern 就是把 `--sheldWidth: <n>vw` 写在 `:root` 的
     * 内联样式上的，漏掉它会让聊天列在缩放后占满整屏。
     * `:root` 与 `body` 每次必定检查（外部改写由 applyEntry 识别）；
     * 其余元素由观察器增量发现，避免每次缩放都全文档扫描。
     */
    function refreshInline(zoom) {
        const root = document.documentElement;
        if (root) {
            discoverDeclaration(root.style);
            refreshDeclaration(root.style, zoom);
        }
        if (document.body) {
            discoverDeclaration(document.body.style);
            refreshDeclaration(document.body.style, zoom);
        }

        for (const element of inlineElements) {
            if (!element.isConnected) {
                declarationBuckets.delete(element.style);
                inlineElements.delete(element);
                continue;
            }
            discoverDeclaration(element.style);
            refreshDeclaration(element.style, zoom);
            const bucket = declarationBuckets.get(element.style);
            if (!bucket || bucket.size === 0) {
                // 这条内联样式已不含视口单位：停止跟踪（再次出现时观察器会重新加入）
                declarationBuckets.delete(element.style);
                inlineElements.delete(element);
            }
        }
    }

    function syncDeclarations(zoom) {
        const startedAt = performance.now();
        syncSheets(zoom);
        refreshSheets(zoom);
        refreshInline(zoom);
        lastPassMs = performance.now() - startedAt;
        lastPassSheets = sheetDeclarations.size;
    }

    /* ---------- 增量失效：只重扫真正变过的样式表 ---------- */

    const INLINE_SELECTOR = '[style*="vw" i],[style*="vh" i]';

    function matchesInlineStyle(element) {
        try {
            return element.matches(INLINE_SELECTOR);
        } catch {
            return false;
        }
    }

    /** 找到节点所属的样式表（<style>/<link> 自身、其后代，或文本节点所在的 <style>）。 */
    function sheetOfNode(node) {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE) return node.parentElement?.sheet ?? null;
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        if (node.sheet) return node.sheet;
        return node.querySelector?.('style, link[rel="stylesheet"]')?.sheet ?? null;
    }

    function trackInlineFrom(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const root = document.documentElement;
        if (node !== root && node !== document.body && matchesInlineStyle(node)) inlineElements.add(node);
        for (const element of node.querySelectorAll(INLINE_SELECTOR)) {
            if (element === root || element === document.body) continue;
            inlineElements.add(element);
        }
    }

    function seedInlineElements() {
        for (const element of document.querySelectorAll(INLINE_SELECTOR)) {
            if (element === document.documentElement || element === document.body) continue;
            inlineElements.add(element);
        }
    }

    function scheduleResync() {
        if (destroyed || resyncTimer) return;
        resyncTimer = window.setTimeout(() => {
            resyncTimer = 0;
            if (destroyed) return;
            try {
                syncDeclarations(factor);
            } catch (error) {
                console.error('[ctrl-wheel-zoom] 视口单位补偿失败', error);
                compensationError = String(error);
            }
            emit();
        }, 150);
    }

    function startObserver() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver((records) => {
            let relevant = false;
            for (const record of records) {
                if (record.type === 'characterData') {
                    // <style> 文本被替换（主题切换）→ 只作废这张表
                    const sheet = sheetOfNode(record.target);
                    if (sheet) dirtySheets.add(sheet);
                    relevant = true;
                    continue;
                }
                if (record.type === 'attributes') {
                    // style 属性变化：可能新增/改写了含视口单位的内联样式
                    // （:root 与 body 每次都会检查，这里跳过以免重复登记）
                    const element = record.target;
                    if (element !== document.documentElement && element !== document.body && matchesInlineStyle(element)) {
                        inlineElements.add(element);
                    }
                    relevant = true;
                    continue;
                }
                for (const node of record.addedNodes) {
                    const sheet = sheetOfNode(node);
                    if (sheet) dirtySheets.add(sheet);
                    trackInlineFrom(node);
                    relevant = true;
                }
                for (const node of record.removedNodes) {
                    const sheet = sheetOfNode(node);
                    if (sheet) dirtySheets.add(sheet);
                    relevant = true;
                }
            }
            if (relevant) scheduleResync();
        });

        const head = document.head ?? document.documentElement;
        if (head) observer.observe(head, { childList: true, subtree: true, characterData: true });
        // :root 的内联样式（--sheldWidth）由酒馆本体改写，必须能立刻察觉
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style'],
            });
        }
    }

    /* ================= JS 视口 / 坐标兼容 ================= */
    // CSS `zoom` 只改渲染，不改 JS 看到的坐标空间：innerWidth、getBoundingClientRect、
    // 鼠标事件仍然是"缩放前"的视觉坐标。后果有两个：
    //   ① 按 window 像素写死尺寸的前端脚本（卡片 HUD 之类）不会跟着缩放；
    //   ② 拖拽位移被放大 z 倍。
    // 打开兼容后，这些接口统一改按"布局坐标"报告——与真实浏览器缩放下的语义一致
    // （真实缩放下 innerWidth 会变小、rect 与 style px 同一坐标系）。
    // 实测依据：body.clientWidth / offsetWidth / getComputedStyle 本来就是布局坐标，
    // 所以只补 innerWidth/innerHeight、根 clientWidth/clientHeight、visualViewport、
    // 元素与 Range 的 rect、以及鼠标事件坐标，避免重复折算。

    const compatPatches = [];
    let compatInstalled = false;

    function registerCompatRestore(restore) {
        compatPatches.push(restore);
    }

    /** 给一个已有的 getter 套上换算；属性若在原型链上，就在实例上定义自己的 getter。 */
    function patchGetter(target, property, transform) {
        const own = Object.getOwnPropertyDescriptor(target, property);
        const hasOwnGetter = Boolean(own && typeof own.get === 'function');
        let source = hasOwnGetter ? own.get : null;
        if (!source) {
            // 沿原型链找（例如 documentElement 的 clientWidth 在 Element.prototype 上，
            // 而 HTMLHtmlElement.prototype 并没有自己的定义）
            for (let proto = Object.getPrototypeOf(target); proto && !source; proto = Object.getPrototypeOf(proto)) {
                const descriptor = Object.getOwnPropertyDescriptor(proto, property);
                if (descriptor && typeof descriptor.get === 'function') source = descriptor.get;
            }
        }
        if (typeof source !== 'function') return false;
        Object.defineProperty(target, property, {
            configurable: true,
            enumerable: hasOwnGetter ? own.enumerable : true,
            get() {
                return transform(source.call(this));
            },
        });
        registerCompatRestore(() => {
            try {
                if (hasOwnGetter) Object.defineProperty(target, property, own);
                else delete target[property];
            } catch {
                /* 还原失败也无碍：下次安装会重新覆盖 */
            }
        });
        return true;
    }

    function patchFunction(target, property, wrapper) {
        const original = target[property];
        if (typeof original !== 'function') return false;
        target[property] = wrapper(original);
        registerCompatRestore(() => {
            try {
                target[property] = original;
            } catch {
                /* ignore */
            }
        });
        return true;
    }

    function scaleRect(rect, z) {
        return new DOMRect(rect.x / z, rect.y / z, rect.width / z, rect.height / z);
    }

    function installCompat() {
        if (compatInstalled || factor === 1) return;
        compatInstalled = true;
        const z = () => factor;
        const scale = (value) => (factor === 1 ? value : value / factor);

        // 视口尺寸（脚本按窗口像素算尺寸的主要来源）
        patchGetter(window, 'innerWidth', scale);
        patchGetter(window, 'innerHeight', scale);
        // 根元素的 clientWidth/clientHeight 也报告视口；body.clientWidth 本来就是布局坐标
        patchGetter(document.documentElement, 'clientWidth', scale);
        patchGetter(document.documentElement, 'clientHeight', scale);
        if (window.visualViewport) {
            patchGetter(window.visualViewport, 'width', scale);
            patchGetter(window.visualViewport, 'height', scale);
        }

        // 元素 / Range 的矩形
        patchFunction(Element.prototype, 'getBoundingClientRect', (original) => function () {
            const rect = original.call(this);
            return z() === 1 ? rect : scaleRect(rect, z());
        });
        const patchRects = (original) => function () {
            const list = original.call(this);
            if (z() === 1 || !list) return list;
            const rects = Array.from(list, (rect) => scaleRect(rect, z()));
            rects.item = (index) => rects[index] ?? null;
            return rects;
        };
        patchFunction(Element.prototype, 'getClientRects', patchRects);
        patchFunction(Range.prototype, 'getBoundingClientRect', (original) => function () {
            const rect = original.call(this);
            return z() === 1 ? rect : scaleRect(rect, z());
        });
        patchFunction(Range.prototype, 'getClientRects', patchRects);

        // 鼠标/指针坐标（PointerEvent 从 MouseEvent 继承这些 getter，不会重复折算）
        for (const property of ['clientX', 'clientY', 'pageX', 'pageY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'x', 'y']) {
            patchGetter(MouseEvent.prototype, property, scale);
        }

        // 命中测试的入参是视觉坐标：乘回去
        const hitTest = (original) => function (x, y) {
            return z() === 1 ? original.call(this, x, y) : original.call(this, x * z(), y * z());
        };
        patchFunction(Document.prototype, 'elementFromPoint', hitTest);
        patchFunction(Document.prototype, 'elementsFromPoint', hitTest);
    }

    function uninstallCompat() {
        if (!compatInstalled) return;
        compatInstalled = false;
        while (compatPatches.length) {
            const restore = compatPatches.pop();
            try {
                restore();
            } catch {
                /* ignore */
            }
        }
    }

    function syncCompat() {
        if (state.compat && state.enabled && factor !== 1) installCompat();
        else uninstallCompat();
    }

    /** 通知脚本"视口变了"，让按窗口像素重排的前端脚本重新适配 */
    function notifyViewportChanged() {
        if (viewportTimer) return;
        viewportTimer = window.setTimeout(() => {
            viewportTimer = 0;
            if (destroyed) return;
            try {
                window.dispatchEvent(new Event('resize'));
            } catch {
                /* ignore */
            }
            // 前端重排后再复查一次溢出，避免把"还没来得及重排"误报成"没跟随缩放"
            scheduleOverflowCheck(250);
        }, 60);
    }

    /* ================= 缩放提示浮层 ================= */

    function ensureIndicator() {
        if (indicatorEl && indicatorEl.isConnected) return indicatorEl;
        if (!document.body) return null;
        indicatorEl = document.createElement('div');
        indicatorEl.className = 'cwz-indicator';
        indicatorEl.setAttribute('role', 'status');
        indicatorEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(indicatorEl);
        return indicatorEl;
    }

    function paintIndicator() {
        const element = ensureIndicator();
        if (!element) return;
        // 浮层自身也在被缩放的文档里：尺寸除以倍数，视觉大小才恒定
        const k = 1 / (factor > 0 ? factor : 1);
        const style = element.style;
        style.position = 'fixed';
        style.left = '50%';
        style.top = `${8 * k}px`;
        style.transform = 'translateX(-50%)';
        style.zIndex = '2147483000';
        style.pointerEvents = 'none';
        style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
        style.fontSize = `${13 * k}px`;
        style.lineHeight = '1.4';
        style.fontWeight = '600';
        style.letterSpacing = `${0.3 * k}px`;
        style.color = '#ffffff';
        style.background = 'rgba(18, 18, 22, 0.86)';
        style.border = `${Math.max(1 * k, 1)}px solid rgba(255, 255, 255, 0.16)`;
        style.borderRadius = `${999 * k}px`;
        style.padding = `${5 * k}px ${13 * k}px`;
        style.boxShadow = `0 ${2 * k}px ${8 * k}px rgba(0, 0, 0, 0.35)`;
        style.transition = 'opacity 160ms ease';
        style.opacity = '1';
        element.textContent = `${state.zoom}%`;
    }

    function showIndicator() {
        if (!state.enabled || !state.indicator || !document.body) return;
        paintIndicator();
        window.clearTimeout(indicatorTimer);
        indicatorTimer = window.setTimeout(() => {
            if (indicatorEl) indicatorEl.style.opacity = '0';
        }, 900);
    }

    /* ================= 应用 / 状态 ================= */

    function emit() {
        for (const listener of listeners) {
            try {
                listener(getState());
            } catch (error) {
                console.error('[ctrl-wheel-zoom] 订阅者抛错', error);
            }
        }
    }

    /**
     * 施加缩放。
     * 视口单位补偿一旦失败就整体回退，绝不留下"放大了但布局溢出"的半残状态。
     */
    /**
     * 检查是否有元素被自己的 px 尺寸顶出视口。
     * 读 scrollWidth 会强制重排，真机 DOM 很大，所以延后做、不占缩放的热路径；
     * 用 setTimeout 而不是 rAF：窗口被遮挡时 rAF 会被挂起，会让告警永远不更新。
     */
    function scheduleOverflowCheck(delay = 250) {
        if (overflowTimer || destroyed) return;
        overflowTimer = window.setTimeout(() => {
            overflowTimer = 0;
            if (destroyed) return;
            const root = document.documentElement;
            // 按视口比例判断（并留 24px 下限）：酒馆页面本身就有几像素溢余（滚动条/边框），
            // 缩放后会等比放大（实测 6px → 9px → 12px），不该拿它当"没跟随缩放"的告警
            const overflow = Math.max(0, layoutScrollWidth(root) - layoutViewportWidth(root));
            const threshold = Math.max(24, layoutViewportWidth(root) * 0.05);
            const flagged = overflow > threshold;
            if (flagged !== layoutOverflow) {
                layoutOverflow = flagged;
                emit();
            }
        }, delay);
    }

    function apply(zoom) {
        const root = document.documentElement;
        if (!root) return;
        const next = state.enabled ? zoom : 1;
        try {
            if (next === 1) root.style.removeProperty('zoom');
            else root.style.setProperty('zoom', String(next));
            // 暴露当前倍数：脚本按 window 像素写死尺寸的元素，可以自己用
            // `calc(100vw / var(--cwz-zoom, 1))` 折算（见 README「已知边界」）
            root.style.setProperty(ZOOM_VAR, String(next));
            syncDeclarations(next);
            factor = next;
            compensationError = null;
            syncCompat();
            scheduleOverflowCheck();
            notifyViewportChanged();
        } catch (error) {
            console.error('[ctrl-wheel-zoom] 视口单位补偿失败，已回退缩放', error);
            compensationError = String((error && error.message) || error);
            factor = 1;
            state.zoom = DEFAULT_ZOOM;
            layoutOverflow = false;
            uninstallCompat();
            try {
                root.style.removeProperty('zoom');
                root.style.setProperty(ZOOM_VAR, '1');
            } catch {
                /* 已经尽力回退 */
            }
        }
    }

    function getState() {
        return {
            started,
            enabled: state.enabled,
            zoom: state.zoom,
            factor,
            wheel: state.wheel,
            hotkeys: state.hotkeys,
            indicator: state.indicator,
            compat: state.compat,
            compatActive: compatInstalled,
            error: compensationError,
            layoutOverflow,
            passMs: Number(lastPassMs.toFixed(2)),
            sheetCount: lastPassSheets,
        };
    }

    function setZoom(percent, { announce = true } = {}) {
        const zoom = nearestZoom(percent);
        const changed = zoom !== state.zoom || (state.enabled && factor !== zoom / 100);
        state.zoom = zoom;
        apply(zoom / 100);
        if (announce && changed) showIndicator();
        emit();
        return state.zoom;
    }

    function step(delta) {
        const index = ZOOM_LEVELS.indexOf(state.zoom);
        const nextIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + delta));
        if (nextIndex === index) {
            showIndicator();
            return state.zoom;
        }
        return setZoom(ZOOM_LEVELS[nextIndex]);
    }

    function setEnabled(enabled) {
        state.enabled = Boolean(enabled);
        apply(state.zoom / 100);
        emit();
    }

    function setOption(key, value) {
        if (!(key in state)) return;
        state[key] = typeof state[key] === 'boolean' ? Boolean(value) : value;
        if (!state.enabled) apply(1);
        else apply(state.zoom / 100);
        emit();
    }

    /* ================= 输入处理 ================= */

    function notchSize(event) {
        if (event.deltaMode === 1) return NOTCH_LINES;
        if (event.deltaMode === 2) return NOTCH_PAGES;
        return NOTCH_PX;
    }

    function onWheel(event) {
        if (destroyed || !state.enabled || !state.wheel) return;
        if (!event.ctrlKey && !event.metaKey) return;
        // 浏览器里 Ctrl+滚轮是"缩放"，所以这里吃掉事件，不让页面滚动或其它监听器插手
        event.preventDefault();
        event.stopImmediatePropagation();

        const unit = notchSize(event);
        wheelAccumulator += event.deltaY / unit;
        let changed = false;
        while (wheelAccumulator <= -1) {
            wheelAccumulator += 1;
            const before = state.zoom;
            step(1);
            if (state.zoom !== before) changed = true;
        }
        while (wheelAccumulator >= 1) {
            wheelAccumulator -= 1;
            const before = state.zoom;
            step(-1);
            if (state.zoom !== before) changed = true;
        }
        wheelAccumulator = Math.max(-1, Math.min(1, wheelAccumulator));
        if (!changed) showIndicator();
    }

    function onKeyDown(event) {
        if (destroyed || !state.enabled || !state.hotkeys) return;
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.altKey) return;

        const code = event.code;
        if (code === 'Digit0' || code === 'Numpad0') {
            event.preventDefault();
            setZoom(DEFAULT_ZOOM);
            return;
        }
        if (code === 'Equal' || code === 'NumpadAdd') {
            event.preventDefault();
            step(1);
            return;
        }
        if (code === 'Minus' || code === 'NumpadSubtract') {
            event.preventDefault();
            step(-1);
        }
    }

    /* ================= 生命周期 ================= */

    function start() {
        if (destroyed) return;
        // 先做一次同步：只有补偿真的能工作，才装上会改变缩放的事件监听。
        // 否则会出现"滚轮放大了、视口单位却没跟着折算"的半残状态。
        try {
            seedInlineElements();
            const initial = state.enabled ? state.zoom / 100 : 1;
            const root = document.documentElement;
            if (initial === 1) root.style.removeProperty('zoom');
            else root.style.setProperty('zoom', String(initial));
            root.style.setProperty(ZOOM_VAR, String(initial));
            syncDeclarations(initial);
            factor = initial;
            started = true;
            syncCompat();
            scheduleOverflowCheck();
            notifyViewportChanged();
        } catch (error) {
            console.error('[ctrl-wheel-zoom] 初始化失败，已停用以避免破坏布局', error);
            compensationError = String((error && error.message) || error);
            try {
                document.documentElement.style.removeProperty('zoom');
                document.documentElement.style.setProperty(ZOOM_VAR, '1');
            } catch {
                /* 已经尽力回退 */
            }
            return;
        }

        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('keydown', onKeyDown, { capture: true });
        startObserver();
        window.addEventListener('resize', scheduleResync);
        const onLoad = () => {
            // 迟到的 <link> 样式表此时才有 cssRules；同步一次并把状态广播出去
            try {
                syncDeclarations(factor);
            } catch (error) {
                console.error('[ctrl-wheel-zoom] 载入后同步失败', error);
                compensationError = String((error && error.message) || error);
            }
            emit();
        };
        if (document.readyState === 'complete') window.setTimeout(onLoad, 0);
        else window.addEventListener('load', onLoad, { once: true });
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        started = false;
        window.removeEventListener('wheel', onWheel, { capture: true });
        window.removeEventListener('keydown', onKeyDown, { capture: true });
        observer?.disconnect();
        observer = null;
        uninstallCompat();
        window.clearTimeout(indicatorTimer);
        window.clearTimeout(resyncTimer);
        window.clearTimeout(viewportTimer);
        window.clearTimeout(overflowTimer);
        indicatorEl?.remove();
        indicatorEl = null;
        document.documentElement?.style.removeProperty('zoom');
        document.documentElement?.style.removeProperty(ZOOM_VAR);
        layoutOverflow = false;
        for (const declarations of sheetDeclarations.values()) {
            for (const declaration of declarations) refreshDeclaration(declaration, 1);
        }
        sheetDeclarations.clear();
        if (document.documentElement) refreshDeclaration(document.documentElement.style, 1);
        if (document.body) refreshDeclaration(document.body.style, 1);
        for (const element of inlineElements) refreshDeclaration(element.style, 1);
        inlineElements.clear();
        listeners.clear();
    }

    start();

    return {
        getState,
        setZoom,
        step,
        reset: () => setZoom(DEFAULT_ZOOM),
        setEnabled,
        setOption,
        destroy,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** 诊断用：立刻重扫全部样式表与内联样式 */
        resync: () => {
            blockedSheets.clear();
            for (const sheet of sheetDeclarations.keys()) dirtySheets.add(sheet);
            inlineElements.clear();
            seedInlineElements();
            try {
                syncDeclarations(factor);
                compensationError = null;
            } catch (error) {
                console.error('[ctrl-wheel-zoom] 重新同步失败', error);
                compensationError = String((error && error.message) || error);
            }
            emit();
        },
    };
}

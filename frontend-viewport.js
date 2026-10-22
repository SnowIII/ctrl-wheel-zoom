/**
 * 卡片前端"虚拟视口"：让渲染 iframe 的逻辑宽度刚好越过卡片自己的响应式断点。
 *
 * 为什么需要：酒馆助手把每楼前端渲染在 `<iframe id="TH-message-…">` 里，宽度跟着聊天列走
 * （实测：窗口 1707 → 聊天列 1024 → iframe 967）。卡片前端常见的 `@media (max-width: 1000px)`
 * 一命中，就切到"手机版"（变窄变长、填不满聊天框）。
 *
 * 做法：读到 iframe 自己样式表里的断点，算出"要越过它需要多宽"，把 iframe 的 CSS 宽度设成这个值，
 * 再用 `zoom = 原宽 / 目标宽` 缩回原视觉宽度：
 *   - 只抬高到刚够用：967 → 1001 只缩 3.4%，几乎看不出来（而不是粗暴地拉到 1200 缩 20%）；
 *   - 卡片没有大断点（例如固定 550px 的手机壳设计）就完全不碰它，避免无意义地缩小；
 *   - `zoom` 参与布局（不像 transform），父容器高度会自动跟着收敛，无需手工记账；
 *   - 实测：`innerWidth` 967 → 1200、`matchMedia('(max-width:1000px)')` 由 true → false；
 *   - 视觉宽度不变，配合本扩展的 Ctrl+滚轮缩放可再把内容放大回来。
 */

const RENDER_FRAME_SELECTOR = '.TH-render iframe, iframe[id^="TH-message--"]';
const BREAKPOINT_PATTERNS = [
    /max-width\s*:\s*([\d.]+)\s*px/gi,
    /width\s*<=\s*([\d.]+)\s*px/gi,
    /min-width\s*:\s*([\d.]+)\s*px/gi,
    /width\s*>=\s*([\d.]+)\s*px/gi,
];

function parentContentWidth(frame) {
    const parent = frame.parentElement;
    if (!parent) return frame.offsetWidth;
    const style = getComputedStyle(parent);
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    return Math.max(0, parent.clientWidth - pad);
}

function scanRules(rules, state) {
    for (const rule of rules) {
        // 4 = CSSMediaRule
        if (rule.type === 4 && rule.conditionText) {
            for (const pattern of BREAKPOINT_PATTERNS) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(rule.conditionText))) {
                    const px = Number(match[1]);
                    if (Number.isFinite(px) && px > state.max && px < 4000) state.max = px;
                }
            }
            try {
                scanRules(rule.cssRules, state);
            } catch {
                /* 忽略 */
            }
        }
    }
}

/** 读出这个 iframe 样式表里最大的宽度断点；读不到（跨域样式表）就返回 0。 */
function readBreakpoint(frame) {
    let doc;
    try {
        doc = frame.contentDocument;
    } catch {
        return 0;
    }
    if (!doc) return 0;
    const state = { max: 0 };
    for (const sheet of [...doc.styleSheets]) {
        let rules;
        try {
            rules = sheet.cssRules;
        } catch {
            continue; // 跨域样式表（CDN 的字体图标之类）
        }
        try {
            scanRules(rules, state);
        } catch {
            /* 忽略 */
        }
    }
    return state.max;
}

export function createFrontendViewportKeeper({ enabled = true, minWidth = 1200, onChange = null } = {}) {
    const state = { enabled, minWidth };
    const applied = new WeakMap(); // frame -> { target, zoom }
    const seen = new WeakMap(); // frame -> 上一次量到的宽度
    const breakpoints = new WeakMap(); // frame -> { value, at }
    const skipped = new Map(); // frameId -> 断点（说明为什么没动它）
    let observer = null;
    const timers = new Set();
    let destroyed = false;

    function clearFrame(frame) {
        if (!applied.has(frame)) return;
        frame.style.removeProperty('width');
        frame.style.removeProperty('zoom');
        frame.removeAttribute('data-cwz-fw');
        applied.delete(frame);
    }

    function cachedBreakpoint(frame) {
        const hit = breakpoints.get(frame);
        if (hit && Date.now() - hit.at < 4000) return hit.value;
        const value = readBreakpoint(frame);
        // 0 表示"还没读到"或"确实没有断点"，都别缓存，下次重扫再读
        if (value > 0) breakpoints.set(frame, { value, at: Date.now() });
        else breakpoints.delete(frame);
        return value;
    }

    function applyFrame(frame) {
        if (!(frame instanceof HTMLIFrameElement) || !frame.isConnected) return;
        const natural = parentContentWidth(frame);
        if (natural <= 0) return;

        // 第一次量到的宽度可能是布局还没稳定的瞬时值（重渲染、抽屉动画等），
        // 所以要连续两次量到同一个宽度才动手。
        const previous = seen.get(frame);
        seen.set(frame, natural);
        if (!applied.has(frame) && previous !== natural) return;

        if (!state.enabled || !(state.minWidth > 0)) {
            clearFrame(frame);
            return;
        }

        // 卡片自己写着 `@media (max-width: Npx)` / `(min-width: Npx)`：
        // 至少要 N+1 宽才不会命中手机版；没有断点（或断点比现有宽度还小）就不动它。
        const breakpoint = cachedBreakpoint(frame);
        const needed = breakpoint > 0 ? Math.ceil(breakpoint) + 1 : 0;

        if (!needed || needed <= natural) {
            skipped.delete(frame.id);
            clearFrame(frame);
            return;
        }
        // 断点超出允许的宽度上限（默认 1200）：不动它，否则只会白白缩小内容
        if (needed > state.minWidth + 1) {
            skipped.set(frame.id, breakpoint);
            clearFrame(frame);
            return;
        }
        skipped.delete(frame.id);
        const target = needed;

        const zoom = natural / target;
        const done = applied.get(frame);
        if (done && done.target === target && Math.abs(done.zoom - zoom) < 0.0005) return;

        frame.style.setProperty('width', `${target}px`, 'important');
        frame.style.setProperty('zoom', String(zoom), 'important');
        frame.setAttribute('data-cwz-fw', String(target));
        applied.set(frame, { target, zoom });
    }

    function pass() {
        if (destroyed) return;
        for (const frame of document.querySelectorAll(RENDER_FRAME_SELECTOR)) applyFrame(frame);
    }

    function schedule(delay = 150) {
        if (destroyed) return;
        const timer = window.setTimeout(() => {
            timers.delete(timer);
            pass();
        }, delay);
        timers.add(timer);
    }

    /** 卡片样式是异步加载的，断点可能晚几秒才出现，所以分几档重扫。 */
    function scheduleBursts() {
        for (const delay of [120, 500, 1500, 3500]) schedule(delay);
    }

    function start() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length)) {
                    scheduleBursts();
                    return;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', () => schedule(120));
        scheduleBursts();
    }

    function stop() {
        destroyed = true;
        observer?.disconnect();
        observer = null;
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
        for (const frame of document.querySelectorAll(RENDER_FRAME_SELECTOR)) clearFrame(frame);
    }

    function setEnabled(value) {
        state.enabled = Boolean(value);
        for (const frame of document.querySelectorAll(RENDER_FRAME_SELECTOR)) breakpoints.delete(frame);
        pass();
        onChange?.(getState());
    }

    function setMinWidth(value) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) state.minWidth = Math.round(numeric);
        pass();
        onChange?.(getState());
    }

    function getState() {
        const frames = [...document.querySelectorAll(RENDER_FRAME_SELECTOR)];
        return {
            enabled: state.enabled,
            minWidth: state.minWidth,
            frames: frames.length,
            applied: frames
                .filter((frame) => applied.has(frame))
                .map((frame) => ({ id: frame.id, target: applied.get(frame).target, breakpoint: cachedBreakpoint(frame) })),
            // 断点比上限还宽、只能放着不管的楼层
            tooWide: [...skipped.entries()].map(([id, breakpoint]) => ({ id, breakpoint })),
        };
    }

    start();
    return { setEnabled, setMinWidth, getState, refresh: () => scheduleBursts(), stop };
}

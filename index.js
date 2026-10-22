/**
 * 界面缩放（Ctrl+滚轮）—— TauriTavern / SillyTavern 扩展外壳。
 *
 * 缩放内核在 zoom-core.js（纯 DOM，可独立测试）；本文件只负责：
 *   1. 设置持久化（localStorage，与浏览器缩放一样按设备保存）
 *   2. 在扩展设置面板里挂 UI
 *   3. 暴露诊断入口 window.__ctrlWheelZoom
 */

import { createZoomController, ZOOM_LEVELS, DEFAULT_ZOOM } from './zoom-core.js';
import { createFrontendViewportKeeper } from './frontend-viewport.js';

export const EXTENSION_ID = 'ctrl-wheel-zoom';
export const VERSION = '1.1.0';

const STORAGE_KEY = 'tt-ctrl-wheel-zoom';
const PANEL_CONTAINERS = ['#extensions_settings2', '#extensions_settings', '#extensionsMenu'];

// frontendWidth：卡片前端 iframe 的逻辑宽度下限（0 = 关闭）。默认 1200 是为了越过
// 卡片前端里常见的 `@media (max-width: 1000px)` 断点，让它保持桌面版布局。
const DEFAULTS = Object.freeze({
    enabled: true,
    zoom: DEFAULT_ZOOM,
    wheel: true,
    hotkeys: true,
    indicator: true,
    compat: true,
    frontendEnabled: true,
    frontendWidth: 1200,
});

function loadSettings() {
    const settings = { ...DEFAULTS };
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            for (const key of Object.keys(DEFAULTS)) {
                if (parsed && parsed[key] !== undefined && parsed[key] !== null) settings[key] = parsed[key];
            }
        }
    } catch (error) {
        console.warn('[ctrl-wheel-zoom] 读取设置失败，使用默认值', error);
    }
    return settings;
}

function persist(controller) {
    const state = controller.getState();
    const payload = {
        enabled: state.enabled,
        zoom: state.zoom,
        wheel: state.wheel,
        hotkeys: state.hotkeys,
        indicator: state.indicator,
        compat: state.compat,
        frontendEnabled: frontendKeeper.getState().enabled,
        frontendWidth: frontendKeeper.getState().minWidth,
    };
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
        console.warn('[ctrl-wheel-zoom] 保存设置失败', error);
    }
}

const isTauriTavern = Boolean(window.__TAURITAVERN__);

const initialSettings = loadSettings();
const controller = createZoomController(initialSettings);

function applyFrontendWidth(value) {
    const numeric = Number(value);
    const width = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
    frontendKeeper.setEnabled(width > 0);
    frontendKeeper.setMinWidth(width > 0 ? width : DEFAULTS.frontendWidth);
}

let notifyPanel = null;

const frontendKeeper = createFrontendViewportKeeper({
    enabled: initialSettings.frontendEnabled !== false,
    minWidth: initialSettings.frontendWidth > 0 ? initialSettings.frontendWidth : DEFAULTS.frontendWidth,
    onChange: () => notifyPanel?.(),
});

// 诊断入口：控制台里可以 __ctrlWheelZoom.getState() / setZoom(150)
window.__ctrlWheelZoom = {
    version: VERSION,
    controller,
    frontendKeeper,
    getState: () => ({ ...controller.getState(), frontend: frontendKeeper.getState() }),
    setFrontendWidth: applyFrontendWidth,
};

controller.subscribe(() => persist(controller));

/* ================= 设置面板 ================= */

const PANEL_HTML = `
<div class="cwz-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>界面缩放（Ctrl+滚轮）</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label" for="cwz_enabled">
        <input type="checkbox" id="cwz_enabled">
        <span>启用界面缩放</span>
      </label>

      <div class="cwz-block">
        <div class="cwz-block-head">
          <span>缩放比例</span>
          <span class="cwz-level-value" id="cwz_level_value">100%</span>
        </div>
        <input type="range" id="cwz_level" class="neo-range-slider" min="0" max="${ZOOM_LEVELS.length - 1}" step="1" value="${ZOOM_LEVELS.indexOf(DEFAULT_ZOOM)}">
        <div class="cwz-presets">
          <div class="menu_button" data-cwz-preset="100">100%</div>
          <div class="menu_button" data-cwz-preset="125">125%</div>
          <div class="menu_button" data-cwz-preset="150">150%</div>
          <div class="menu_button" data-cwz-preset="200">200%</div>
        </div>
      </div>

      <label class="checkbox_label" for="cwz_wheel">
        <input type="checkbox" id="cwz_wheel">
        <span>按住 Ctrl 用鼠标滚轮缩放</span>
      </label>
      <label class="checkbox_label" for="cwz_hotkeys">
        <input type="checkbox" id="cwz_hotkeys">
        <span>快捷键：Ctrl+0 复位、Ctrl+= 放大、Ctrl+- 缩小</span>
      </label>
      <label class="checkbox_label" for="cwz_indicator">
        <input type="checkbox" id="cwz_indicator">
        <span>缩放时显示百分比提示</span>
      </label>
      <label class="checkbox_label" for="cwz_compat">
        <input type="checkbox" id="cwz_compat">
        <span>JS 视口/坐标兼容（卡片前端、拖拽一起缩放）</span>
      </label>

      <label class="checkbox_label" for="cwz_frontend">
        <input type="checkbox" id="cwz_frontend">
        <span>卡片前端保持桌面版（按卡片断点给渲染 iframe 更宽的逻辑视口）</span>
      </label>
      <div class="cwz-block" id="cwz_frontend_block">
        <div class="cwz-block-head">
          <span>逻辑视口宽度上限</span>
          <span class="cwz-level-value" id="cwz_frontend_value">1200px</span>
        </div>
        <input type="range" id="cwz_frontend_width" class="neo-range-slider" min="800" max="1920" step="20" value="1200">
      </div>

      <div class="cwz-note">
        缩放走的是 CSS <code>zoom</code>：内核会把文档里的视口单位（<code>vw</code>/<code>vh</code>）
        折算成 <code>calc(原值 / 倍数)</code>，所以百分比布局、flex 与固定定位元素都会等比缩放。
        <br>
        <b>JS 视口/坐标兼容</b>（默认开）：把 <code>innerWidth</code>、元素矩形、鼠标坐标
        统一改按"缩放后的布局坐标"报告——和真实浏览器缩放一致。卡片前端（HUD 之类）
        按窗口像素算出来的尺寸因此会跟着缩放，拖拽也精确；关掉它则这两项都会偏离
        （拖拽会放大 <i>倍数</i> 倍）。若某个扩展在缩放后定位异常，可先关掉这个开关排查。
        <br>
        <b>卡片前端保持桌面版</b>（默认开）：酒馆助手把每一楼的前端渲染在 iframe 里，
        它只有聊天列那么宽（约 950–1000px），常会命中卡片自带的手机版断点，于是变窄变长、
        填不满聊天框。打开后扩展会读卡片自己的 <code>@media</code> 断点，把 iframe 的逻辑视口
        抬到刚好越过断点（例如 967 → 1001，只缩 3%），再用 <code>zoom</code> 缩回原视觉宽度：
        卡片按桌面版排版，看起来几乎和原来一样大。没有大断点的卡片（固定宽度设计）不会被碰。
        断点比上面的宽度上限还宽时，把那根滑块往右拉即可。排版反而乱了就关掉这项。
      </div>

      <div class="cwz-status" id="cwz_status"></div>
    </div>
  </div>
</div>`;

function findContainer() {
    for (const selector of PANEL_CONTAINERS) {
        const element = document.querySelector(selector);
        if (element) return element;
    }
    return null;
}

function buildPanel() {
    if (document.getElementById('cwz_enabled')) return;

    const container = findContainer();
    if (!container) {
        console.warn('[ctrl-wheel-zoom] 没找到扩展设置容器，缩放功能仍可用，但设置面板未挂载');
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML.trim();
    const panel = wrapper.firstElementChild;
    container.append(panel);

    const $ = (selector) => panel.querySelector(selector);
    const enabled = $('#cwz_enabled');
    const wheel = $('#cwz_wheel');
    const hotkeys = $('#cwz_hotkeys');
    const indicator = $('#cwz_indicator');
    const compat = $('#cwz_compat');
    const frontend = $('#cwz_frontend');
    const frontendBlock = $('#cwz_frontend_block');
    const frontendSlider = $('#cwz_frontend_width');
    const frontendValue = $('#cwz_frontend_value');
    const slider = $('#cwz_level');
    const levelValue = $('#cwz_level_value');
    const status = $('#cwz_status');

    const render = () => {
        const state = controller.getState();
        enabled.checked = state.enabled;
        wheel.checked = state.wheel;
        hotkeys.checked = state.hotkeys;
        indicator.checked = state.indicator;
        compat.checked = state.compat;
        const frontendState = frontendKeeper.getState();
        frontend.checked = frontendState.enabled;
        frontendSlider.value = String(frontendState.minWidth);
        frontendValue.textContent = `${frontendState.minWidth}px`;
        frontendBlock.classList.toggle('cwz-block-off', !frontendState.enabled);
        frontendSlider.disabled = !frontendState.enabled;
        slider.value = String(Math.max(0, ZOOM_LEVELS.indexOf(state.zoom)));
        levelValue.textContent = `${state.zoom}%`;
        panel.classList.toggle('cwz-disabled', !state.enabled);
        status.classList.toggle('cwz-status-error', Boolean(state.error));
        if (state.error) {
            status.textContent = `⚠ 视口单位补偿失败，缩放已自动停用：${state.error}`;
        } else {
            const parts = [
                isTauriTavern ? 'TauriTavern' : 'SillyTavern',
                'CSS 模拟缩放',
                `改写 ${state.sheetCount} 张样式表`,
                `最近一次 ${state.passMs}ms`,
            ];
            if (state.layoutOverflow && state.zoom !== 100) {
                parts.push('有元素未跟随缩放（脚本按窗口像素写死尺寸，见 README 的 --cwz-zoom）');
            }
            if (frontendState.enabled && frontendState.applied.length) {
                const targets = [...new Set(frontendState.applied.map((item) => item.target))];
                parts.push(`前端虚拟视口 ${targets.join('/')}px（${frontendState.applied.length} 楼）`);
            }
            if (frontendState.tooWide?.length) {
                const widest = Math.max(...frontendState.tooWide.map((item) => item.breakpoint));
                parts.push(`有楼层断点在 ${widest}px，比宽度上限还宽，把滑块往右拉`);
            }
            status.textContent = parts.join(' · ');
        }
    };

    enabled.addEventListener('change', () => controller.setEnabled(enabled.checked));
    wheel.addEventListener('change', () => controller.setOption('wheel', wheel.checked));
    hotkeys.addEventListener('change', () => controller.setOption('hotkeys', hotkeys.checked));
    indicator.addEventListener('change', () => controller.setOption('indicator', indicator.checked));
    compat.addEventListener('change', () => controller.setOption('compat', compat.checked));

    frontend.addEventListener('change', () => {
        frontendKeeper.setEnabled(frontend.checked);
        persist(controller);
        render();
    });

    frontendSlider.addEventListener('input', () => {
        applyFrontendWidth(Number(frontendSlider.value));
        persist(controller);
        render();
    });

    slider.addEventListener('input', () => {
        const zoom = ZOOM_LEVELS[Number(slider.value)] ?? DEFAULT_ZOOM;
        controller.setZoom(zoom);
    });

    for (const button of panel.querySelectorAll('[data-cwz-preset]')) {
        button.addEventListener('click', () => controller.setZoom(Number(button.dataset.cwzPreset)));
    }

    controller.subscribe(render);
    notifyPanel = render;
    render();
}

function whenReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
        callback();
    }
}

whenReady(() => {
    buildPanel();
    // 扩展面板可能在更晚的阶段才渲染出来，稍后再补一次
    setTimeout(buildPanel, 1500);
});

console.log(`[ctrl-wheel-zoom] v${VERSION} 已加载（${isTauriTavern ? 'TauriTavern' : 'SillyTavern'}），当前缩放 ${controller.getState().zoom}%`);

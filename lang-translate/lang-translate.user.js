// ==UserScript==
// @name         X/Twitter & Discord 实时翻译
// @name:zh-CN   X/Twitter & Discord 实时翻译
// @name:en      X/Twitter & Discord Realtime Translator
// @namespace    https://github.com/wxmyyds
// @version      2.0.0
// @description  在 X/Twitter、Discord、Patreon、Ko-fi 上实时翻译外文内容：用译文替换原文，右下角图标显示进度（翻译中旋转 / 失败黄色感叹号），点图标可切换原文与译文。合并请求 + 双层缓存 + 并发队列 + 失败重试 + 视口懒翻译 + 长文分片。
// @description:en  Replaces foreign posts with translations on X/Twitter, Discord, Patreon and Ko-fi. A corner icon spins while translating, turns into a yellow warning on failure, and toggles original/translation on click.
// @author       wxmyyds
// @icon         https://www.google.com/s2/favicons?sz=64&domain=translate.google.com
// @homepageURL  https://github.com/wxmyyds/UserScripts
// @supportURL   https://github.com/wxmyyds/UserScripts/issues
// @license      MIT
// @match        *://twitter.com/*
// @match        *://x.com/*
// @match        *://pro.x.com/*
// @match        *://discord.com/*
// @match        *://ptb.discord.com/*
// @match        *://canary.discord.com/*
// @match        *://www.patreon.com/*
// @match        *://ko-fi.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @run-at       document-end
// @noframes
// ==/UserScript==

/* ============================================================================
 * X/Twitter & Discord 实时翻译
 *
 * 灵感来自 greasyfork 577969（furina-cute 的「极速优化版」），在其思路上重写：
 *
 *   1. 请求层
 *      - 原版：每个元素一个请求，固定 3 并发，失败不重试，缓存只在内存里。
 *      - 现在：队列按「距视口远近」定优先级、同文本去重、指数退避重试；
 *        同一元素的多个短片段以及多个元素的单行文本会被合并成一次请求
 *        （用 \n 分隔，按返回行数校验，对不齐自动退回逐条请求，不会串行错位）；
 *        缓存分内存 LRU 与 GM 持久化两层，带 TTL 与容量上限，刷新后不重复请求。
 *   2. 调度层
 *      - 原版：MutationObserver 里给每个元素挂 setTimeout(300ms)。
 *      - 现在：整批 DOM 变更合并后统一扫描（去抖 160ms、持续变动最长等待 1.2s，
 *        避免扫描被无限推迟饿死），元素进入视口才翻译（IntersectionObserver，
 *        默认上下各外扩 400px），离屏内容不再浪费配额。
 *   3. 过滤
 *      - 原版：长度 < 4 或中文占比 ≥ 30% 直接跳过（纯日/韩/泰文全部漏译）。
 *      - 现在：最小长度、中文占比阈值、「仅翻译含拉丁字母文本」开关均可配置，
 *        需要时能翻日文、韩文、俄文等。
 *   4. 长文本按段落 / 句子边界分片，不再被 3000 字符静默截断。
 *   5. 样式用 CSS 变量集中管理，auto / light / dark 三态；设置面板中英双语，
 *      按站点分别保存，并自动迁移旧版 ling_config_<host> 配置。
 *   6. 保留原版的可用行为并修掉其中问题：Discord 分段 + spoiler 遮罩
 *      （遮罩状态下仍可选中复制）、X「显示更多」展开后重译、搜索页强制 Latest。
 * ========================================================================== */

(() => {
    'use strict';

    const VERSION = '2.0.0';
    const STYLE_ID = 'lt-style';
    const LOG_PREFIX = '[lang-translate]';

    /* #region 站点与默认配置 */

    const SITES = {
        twitter: { key: 'twitter', name: 'X / Twitter' },
        discord: { key: 'discord', name: 'Discord' },
        patreon: { key: 'patreon', name: 'Patreon' },
        kofi: { key: 'kofi', name: 'Ko-fi' }
    };

    function detectSite() {
        const host = location.hostname;
        if (/(^|\.)(x|twitter)\.com$/.test(host)) return SITES.twitter;
        if (/(^|\.)discord\.com$/.test(host)) return SITES.discord;
        if (/(^|\.)patreon\.com$/.test(host)) return SITES.patreon;
        if (/(^|\.)ko-fi\.com$/.test(host)) return SITES.kofi;
        return null;
    }

    const SITE = detectSite();

    const DEFAULT_CONFIG = {
        enabled: true,
        theme: 'auto',              // auto | light | dark
        accentColor: '#00E676',

        targetLang: 'zh-CN',
        minLength: 4,               // 短于该长度不翻译
        latinOnly: true,            // 仅翻译含拉丁字母的文本（关掉后可译日/韩/泰等）
        cjkSkipRatio: 0.3,          // 中日韩字符占比达到该比例视为无需翻译
        chunkChars: 1200,           // 单个请求片段最大字符数
        maxTextChars: 6000,         // 单条正文翻译上限，超出截断
        translatePlaceholders: true,

        lazyViewport: true,         // 只翻译进入视口的内容
        lazyMarginPx: 400,

        maxConcurrent: 3,
        batchWindowMs: 60,          // 合批等待窗口
        batchMaxChars: 2400,        // 合批后单次请求上限
        maxRetries: 2,
        requestTimeoutMs: 8000,

        cacheEntries: 2000,
        cacheTtlDays: 14,

        doNotTranslate: []          // 命中即跳过的关键词
    };

    const STYLE_TEXT = `
:root {
    --lt-accent: #00e676;
    --lt-warn: #eab308;
    --lt-radius: 6px;
    --lt-box-bg: #ffffff;
    --lt-box-fg: #0f1419;
    --lt-inline-bg: rgba(255, 255, 255, 0.92);
    --lt-muted: #6b7280;
    --lt-panel-bg: #ffffff;
    --lt-panel-fg: #0f1419;
    --lt-panel-line: #e5e7eb;
    --lt-input-bg: #f9fafb;
    --lt-input-line: #d1d5db;
    --lt-shadow: 0 18px 48px rgba(15, 20, 25, 0.28);
}

/* 未显式指定主题时跟随系统 */
@media (prefers-color-scheme: dark) {
    :root:not([data-lt-theme='light']) {
        --lt-box-bg: #1b1f24;
        --lt-box-fg: #e6e8eb;
        --lt-inline-bg: rgba(27, 31, 36, 0.92);
        --lt-muted: #9aa4b2;
        --lt-panel-bg: #1b1f24;
        --lt-panel-fg: #e6e8eb;
        --lt-panel-line: #2f353c;
        --lt-input-bg: #23282e;
        --lt-input-line: #3a4149;
        --lt-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
    }
}

:root[data-lt-theme='dark'] {
    --lt-box-bg: #1b1f24;
    --lt-box-fg: #e6e8eb;
    --lt-inline-bg: rgba(27, 31, 36, 0.92);
    --lt-muted: #9aa4b2;
    --lt-panel-bg: #1b1f24;
    --lt-panel-fg: #e6e8eb;
    --lt-panel-line: #2f353c;
    --lt-input-bg: #23282e;
    --lt-input-line: #3a4149;
    --lt-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
}

/* ==================== 译文 / 原文切换 ==================== */

/* 被翻译的正文容器：只改必要项，尽量继承宿主站点的排版 */
.lt-anchor {
    position: relative;
    overflow-wrap: anywhere;
}

/*
 * 译文态才接管换行：译文里的换行由 renderResult 显式转成 <br>，
 * 所以这里的 white-space 用 normal，避免 HTML 源码里的缩进被放大。
 *
 * 原文态（data-lt-state='original'）刻意不设置 white-space ——
 * X / Discord 的正文换行靠它们自己的 white-space: pre-wrap，
 * 在这里写 normal 会把原文的换行一起弄没。
 */
.lt-anchor[data-lt-state='translated'] {
    white-space: normal;
    padding-bottom: 18px;
}

/* 右下角图标：只有图标、没有文字 */
.lt-badge {
    position: absolute;
    right: 0;
    bottom: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--lt-accent);
    cursor: pointer;
    user-select: none;
    z-index: 2;
    opacity: 0.85;
    transition: transform 0.15s ease, opacity 0.15s ease;
}

.lt-badge:hover {
    opacity: 1;
    transform: scale(1.15);
}

.lt-badge svg {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
}

/* 翻译中：图标循环旋转 */
.lt-badge--busy svg {
    animation: lt-spin 1s linear infinite;
    transform-origin: 50% 50%;
}

@keyframes lt-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

/* 正在显示译文：图标淡一点，提示再点会回到原文 */
.lt-badge--translated {
    opacity: 0.55;
}

/* 翻译失败：黄色感叹号 */
.lt-badge--error {
    color: var(--lt-warn);
    opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
    .lt-badge--busy svg {
        animation-duration: 2s;
    }
}

/* 译文分片 */
.lt-part {
    display: inline;
}

.lt-part + .lt-part {
    margin-left: 0.25em;
}

.lt-anchor .lt-spoiler {
    margin: 0 0.1em;
}

/* Discord spoiler：默认遮罩，点击展开，两种状态下都可选中复制 */
.lt-spoiler {
    display: inline-block;
    padding: 1px 4px;
    border-radius: 4px;
    background: #6e6e6e;
    color: transparent;
    cursor: pointer;
    user-select: text;
    vertical-align: bottom;
}

.lt-spoiler--open {
    background: rgba(110, 110, 110, 0.22);
    color: inherit;
    cursor: default;
}

/* 全局开关：挂在 <html> 上，避免反复增删 DOM */
html.lt-off .lt-badge {
    display: none !important;
}

/* 同一份样式也会注入 Ko-fi 的 shadow root，那里没有 <html> 可选，
   改为由脚本在 shadow host 上打标记（文档里 :host 选择器无效，会被丢弃） */
:host([data-lt-off]) .lt-badge {
    display: none !important;
}

/* ==================== 设置面板 ==================== */

.lt-panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.55);
}

.lt-panel {
    box-sizing: border-box;
    width: min(430px, 100%);
    max-height: min(86vh, 760px);
    overflow: auto;
    padding: 18px;
    border: 1px solid var(--lt-panel-line);
    border-radius: 14px;
    background: var(--lt-panel-bg);
    color: var(--lt-panel-fg);
    box-shadow: var(--lt-shadow);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.lt-panel__title {
    margin: 0 0 2px;
    font-size: 16px;
    font-weight: 600;
}

.lt-panel__subtitle {
    margin: 0 0 14px;
    font-size: 12px;
    color: var(--lt-muted);
}

.lt-panel__group {
    margin: 0 0 12px;
    padding: 10px 12px;
    border: 1px solid var(--lt-panel-line);
    border-radius: 10px;
}

.lt-panel__group-title {
    margin-bottom: 6px;
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--lt-muted);
}

.lt-panel__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
}

.lt-panel__row--block {
    cursor: default;
}

.lt-panel__label {
    flex: 1 1 auto;
    min-width: 0;
}

.lt-panel__hint {
    flex: 1 1 100%;
    margin: 0;
    font-size: 11px;
    color: var(--lt-muted);
}

.lt-panel select,
.lt-panel input[type='number'],
.lt-panel input[type='text'] {
    box-sizing: border-box;
    max-width: 150px;
    padding: 4px 6px;
    border: 1px solid var(--lt-input-line);
    border-radius: 6px;
    background: var(--lt-input-bg);
    color: inherit;
    font: inherit;
}

.lt-panel input[type='color'] {
    width: 42px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--lt-input-line);
    border-radius: 6px;
    background: none;
}

.lt-panel input[type='checkbox'] {
    width: 16px;
    height: 16px;
    accent-color: var(--lt-accent);
}

.lt-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.lt-btn {
    flex: 1 1 110px;
    padding: 8px 12px;
    border: 1px solid var(--lt-input-line);
    border-radius: 8px;
    background: var(--lt-input-bg);
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.lt-btn:hover {
    border-color: var(--lt-accent);
}

.lt-btn--primary {
    border-color: var(--lt-accent);
    background: var(--lt-accent);
    color: #06231a;
    font-weight: 600;
}

.lt-btn--danger {
    color: #dc2626;
}

.lt-toast {
    position: fixed;
    left: 50%;
    bottom: 32px;
    z-index: 2147483647;
    transform: translateX(-50%);
    padding: 8px 14px;
    border: 1px solid var(--lt-panel-line);
    border-radius: 999px;
    background: var(--lt-panel-bg);
    color: var(--lt-panel-fg);
    box-shadow: var(--lt-shadow);
    font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif;
}
`;

    const TARGET_LANGS = [
        ['zh-CN', '简体中文 / Chinese (Simplified)'],
        ['zh-TW', '繁體中文 / Chinese (Traditional)'],
        ['en', 'English'],
        ['ja', '日本語 / Japanese'],
        ['ko', '한국어 / Korean'],
        ['ru', 'Русский / Russian'],
        ['fr', 'Français / French'],
        ['de', 'Deutsch / German'],
        ['es', 'Español / Spanish'],
        ['pt', 'Português / Portuguese'],
        ['it', 'Italiano / Italian'],
        ['ar', 'العربية / Arabic'],
        ['th', 'ไทย / Thai'],
        ['vi', 'Tiếng Việt / Vietnamese'],
        ['id', 'Bahasa Indonesia'],
        ['tr', 'Türkçe / Turkish'],
        ['hi', 'हिन्दी / Hindi']
    ];

    /* #endregion */

    /* #region 小工具 */

    const now = () => Date.now();

    function clamp(value, min, max, fallback) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.min(max, Math.max(min, num));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    function hash32(str) {
        let hash = 2166136261;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    const DEBUG = (() => {
        try {
            return localStorage.getItem('lt:debug') === '1'
                || new URLSearchParams(location.search).has('lt-debug');
        } catch (error) {
            return false;
        }
    })();

    function debug(...args) {
        if (DEBUG) console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    const LATIN_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0370-\u03FF]/;
    const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
    const MEANINGLESS_RE = /^[\s\d\p{P}\p{S}]+$/u;

    /* #endregion */

    /* #region 配置与存储 */

    const STORAGE_KEY = 'lt:cfg';

    const store = {
        read(key, fallback) {
            try {
                if (typeof GM_getValue !== 'function') return fallback;
                const raw = GM_getValue(key, null);
                if (raw === null || raw === undefined) return fallback;
                return JSON.parse(raw);
            } catch (error) {
                return fallback;
            }
        },
        write(key, value) {
            try {
                if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
            } catch (error) {
                warn('配置写入失败', error);
            }
        },
        remove(key) {
            try {
                if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
            } catch (error) { /* ignore */ }
        }
    };

    function configKey() {
        return `${STORAGE_KEY}:${SITE ? SITE.key : 'default'}`;
    }

    let config = loadConfig();

    function loadConfig() {
        const stored = store.read(configKey(), null);
        const merged = Object.assign({}, DEFAULT_CONFIG, stored && typeof stored === 'object' ? stored : {});
        merged.doNotTranslate = Array.isArray(merged.doNotTranslate) ? merged.doNotTranslate : [];
        if (!stored) migrateLegacyConfig(merged);
        return sanitizeConfig(merged);
    }

    /** 迁移旧版（原脚本 ling_config_<hostname>）配置，迁移后删除旧键 */
    function migrateLegacyConfig(target) {
        const legacy = store.read(`ling_config_${location.hostname}`, null);
        if (!legacy || typeof legacy !== 'object') return;
        if (typeof legacy.transColor === 'string') target.accentColor = legacy.transColor;
        store.write(configKey(), target);
        store.remove(`ling_config_${location.hostname}`);
        debug('已迁移旧版配置');
    }

    function sanitizeConfig(cfg) {
        cfg.enabled = cfg.enabled !== false;
        cfg.latinOnly = cfg.latinOnly !== false;
        cfg.translatePlaceholders = cfg.translatePlaceholders !== false;
        cfg.lazyViewport = cfg.lazyViewport !== false;
        cfg.theme = ['auto', 'light', 'dark'].includes(cfg.theme) ? cfg.theme : 'auto';
        cfg.accentColor = /^#[0-9a-fA-F]{6}$/.test(cfg.accentColor) ? cfg.accentColor : DEFAULT_CONFIG.accentColor;

        cfg.minLength = clamp(cfg.minLength, 1, 200, DEFAULT_CONFIG.minLength);
        cfg.cjkSkipRatio = clamp(cfg.cjkSkipRatio, 0, 1, DEFAULT_CONFIG.cjkSkipRatio);
        cfg.chunkChars = clamp(cfg.chunkChars, 200, 4500, DEFAULT_CONFIG.chunkChars);
        cfg.maxTextChars = clamp(cfg.maxTextChars, 200, 20000, DEFAULT_CONFIG.maxTextChars);
        cfg.batchMaxChars = clamp(cfg.batchMaxChars, cfg.chunkChars, 4500, DEFAULT_CONFIG.batchMaxChars);
        cfg.maxConcurrent = clamp(cfg.maxConcurrent, 1, 8, DEFAULT_CONFIG.maxConcurrent);
        cfg.maxRetries = clamp(cfg.maxRetries, 0, 5, DEFAULT_CONFIG.maxRetries);
        cfg.cacheEntries = clamp(cfg.cacheEntries, 100, 10000, DEFAULT_CONFIG.cacheEntries);
        cfg.cacheTtlDays = clamp(cfg.cacheTtlDays, 0, 365, DEFAULT_CONFIG.cacheTtlDays);
        cfg.lazyMarginPx = clamp(cfg.lazyMarginPx, 0, 2000, DEFAULT_CONFIG.lazyMarginPx);
        if (!TARGET_LANGS.some(lang => lang[0] === cfg.targetLang)) cfg.targetLang = DEFAULT_CONFIG.targetLang;
        cfg.doNotTranslate = (Array.isArray(cfg.doNotTranslate) ? cfg.doNotTranslate : [])
            .map(word => String(word).trim())
            .filter(Boolean)
            .slice(0, 100);

        return cfg;
    }

    let saveTimer = null;
    function saveConfig() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            store.write(configKey(), config);
        }, 250);
    }

    /* #endregion */

    /* #region 样式与主题 */

    function ensureDocumentStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        (document.head || document.documentElement).appendChild(style);
    }

    const styledShadowRoots = new WeakSet();
    function ensureShadowStyle(root) {
        if (!root || styledShadowRoots.has(root)) return;
        styledShadowRoots.add(root);
        const style = document.createElement('style');
        style.textContent = STYLE_TEXT;
        root.appendChild(style);
    }

    function applyTheme() {
        const html = document.documentElement;
        if (config.theme === 'auto') html.removeAttribute('data-lt-theme');
        else html.setAttribute('data-lt-theme', config.theme);
        html.style.setProperty('--lt-accent', config.accentColor);
        html.classList.toggle('lt-off', !config.enabled);

        // shadow DOM 里的译文框需要靠 host 标记来跟随开关
        for (const host of shadowHosts) {
            host.toggleAttribute('data-lt-off', !config.enabled);
        }
    }

    /* #endregion */

    /* #region 翻译请求层：缓存 / 队列 / 合批 / 重试 */

    const memoryCache = new Map();      // `${lang}\u0000${text}` -> 译文（LRU）
    const inFlight = new Map();         // 同上 -> Promise，同文本同语言去重
    const persistIndex = new Map();     // 持久化键 -> 过期时间戳
    let persistDirty = false;
    let persistTimer = null;
    /** 递增即作废在途请求对缓存的所有写入（清空缓存时用） */
    let cacheEpoch = 0;

    /* 缓存键一律带上语言：请求在途时切换目标语言，结果不会写进新语言的键 */
    const cacheKey = (lang, text) => `${lang}\u0000${text}`;
    const persistKey = (lang, text) => `lt:cache:${lang}:${text.length}:${hash32(text)}`;

    function cacheGet(lang, text) {
        const key = cacheKey(lang, text);
        if (memoryCache.has(key)) {
            const value = memoryCache.get(key);
            memoryCache.delete(key);
            memoryCache.set(key, value);   // LRU：命中后移到末尾
            return value;
        }

        const pKey = persistKey(lang, text);
        const expiry = persistIndex.get(pKey);
        if (expiry === undefined || expiry < now()) return null;

        const entry = store.read(pKey, null);
        if (!entry || entry.s !== text || typeof entry.t !== 'string') {
            persistIndex.delete(pKey);
            markPersistDirty();
            return null;
        }
        memoryCache.set(key, entry.t);
        return entry.t;
    }

    function cacheSet(lang, text, translated, epoch) {
        if (!translated || translated === text) return;
        // 缓存已被清空：在途请求的结果不能再写回去
        if (epoch !== cacheEpoch) return;

        memoryCache.set(cacheKey(lang, text), translated);
        while (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value);

        if (config.cacheTtlDays <= 0) return;
        const pKey = persistKey(lang, text);
        store.write(pKey, { s: text, t: translated });
        persistIndex.set(pKey, now() + config.cacheTtlDays * 86400000);
        markPersistDirty();
    }

    function markPersistDirty() {
        persistDirty = true;
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            flushPersistIndex();
        }, 3000);
    }

    /** 持久化缓存索引：先按容量上限淘汰，再剔除过期项 */
    function flushPersistIndex() {
        if (!persistDirty) return;
        persistDirty = false;

        const entries = [...persistIndex.entries()].sort((a, b) => a[1] - b[1]);
        const dropped = [];
        while (entries.length > config.cacheEntries) dropped.push(entries.shift()[0]);

        const deadline = now();
        const kept = [];
        for (const [key, expiry] of entries) {
            if (expiry < deadline) dropped.push(key);
            else kept.push([key, expiry]);
        }

        for (const key of dropped) {
            persistIndex.delete(key);
            store.remove(key);
        }
        store.write('lt:cache:index', kept);
        debug(`缓存索引已保存：${kept.length} 条，清理 ${dropped.length} 条`);
    }

    function loadPersistIndex() {
        const list = store.read('lt:cache:index', []);
        if (!Array.isArray(list)) return;
        const deadline = now();
        for (const item of list) {
            if (Array.isArray(item) && typeof item[0] === 'string'
                && typeof item[1] === 'number' && item[1] > deadline) {
                persistIndex.set(item[0], item[1]);
            }
        }
    }

    /* ---------------------------- 队列 ---------------------------- */

    /** @type {{text: string, lang: string, epoch: number, priority: number, atomic: boolean, attempt: number, resolve: (v: string) => void}[]} */
    const queue = [];
    let activeCount = 0;
    let pumpTimer = null;
    let pumpDeadline = 0;
    const stats = { requests: 0, cached: 0, failed: 0, batched: 0, reused: 0 };

    /**
     * 请求一段文本的翻译（自动走缓存 / 去重 / 队列）。
     * 文本语言在入队时就固定下来，之后即使用户切换目标语言，在途结果也只会写进
     * 原来的语言缓存，不会污染新语言的缓存。
     * @param {string} text
     * @param {number} priority 越大越先发出（按距视口距离计算）
     * @param {{atomic?: boolean, lang?: string}} [options]
     * @returns {Promise<string>}
     */
    function requestText(text, priority = 0, options = {}) {
        const lang = options.lang || config.targetLang;
        const atomic = options.atomic === true;

        const cached = cacheGet(lang, text);
        if (cached !== null) {
            stats.cached++;
            return Promise.resolve(cached);
        }

        const key = cacheKey(lang, text);
        const pending = inFlight.get(key);
        if (pending) {
            stats.reused++;
            return pending;
        }

        const promise = new Promise((resolve) => {
            queue.push({ text, lang, epoch: cacheEpoch, priority, atomic, attempt: 0, resolve });
            schedulePump();
        });
        inFlight.set(key, promise);
        promise.finally(() => inFlight.delete(key));
        return promise;
    }

    /** 合批窗口：不断有新任务时最多顺延到 250ms，避免请求被无限推迟 */
    function schedulePump() {
        if (!pumpDeadline) pumpDeadline = now() + 250;
        if (pumpTimer) clearTimeout(pumpTimer);

        const wait = now() >= pumpDeadline ? 0 : config.batchWindowMs;
        pumpTimer = setTimeout(() => {
            pumpTimer = null;
            pumpDeadline = 0;
            pump();
        }, wait);
    }

    function pump() {
        if (!queue.length || activeCount >= config.maxConcurrent) return;

        // 距视口越近越先取，保证「滚到哪里译到哪里」
        if (queue.length > 1) queue.sort((a, b) => b.priority - a.priority);

        for (const job of takeJobs()) {
            activeCount++;
            runJob(job).finally(() => {
                activeCount--;
                if (queue.length) schedulePump();
            });
        }
        if (queue.length && activeCount < config.maxConcurrent) schedulePump();
    }

    /** 从队首取任务：可合批的单行文本并成一次请求，多行/atomic 单独成任务 */
    function takeJobs() {
        const jobs = [];
        while (queue.length && activeCount + jobs.length < config.maxConcurrent) {
            const head = queue.shift();
            const group = [head];
            let length = head.text.length;

            if (!head.atomic && !head.text.includes('\n')) {
                for (let i = 0; i < queue.length;) {
                    const candidate = queue[i];
                    const mergeable = !candidate.atomic
                        && candidate.lang === head.lang        // 不同语言不能合并
                        && !candidate.text.includes('\n')
                        && length + candidate.text.length + 1 <= config.batchMaxChars
                        && group.length < 12;
                    if (!mergeable) {
                        i++;
                        continue;
                    }
                    group.push(candidate);
                    length += candidate.text.length + 1;
                    queue.splice(i, 1);
                }
            }
            jobs.push({ items: group, text: group.map(item => item.text).join('\n') });
        }
        return jobs;
    }

    async function runJob(job) {
        const { items, text } = job;

        if (items.length === 1) {
            items[0].resolve(await fetchTranslation(text, items[0].lang, items[0].epoch, items[0].attempt));
            return;
        }

        stats.batched++;
        const lines = splitAligned(
            await fetchTranslation(text, items[0].lang, items[0].epoch, 0), items.length);
        if (lines) {
            for (let i = 0; i < items.length; i++) items[i].resolve(lines[i]);
            return;
        }

        // 合并请求的返回行数对不上（换行被 API 吞掉/合并）：逐条单独请求，避免错位。
        // 注意：这里必须直接发请求，不能再走 requestText —— 这几个文本的 inFlight 条目
        // 就是当前这个刚刚失败的合批 Promise，复用它会拿到永不结算的 Promise 而死锁。
        debug('合批结果行数不符，退回逐条请求', { expected: items.length });
        await Promise.all(items.map(async (item) => {
            item.resolve(await fetchTranslation(item.text, item.lang, item.epoch, item.attempt));
        }));
    }

    /** 按 \n 拆行；行数与预期不符返回 null，由调用方退回逐条请求 */
    function splitAligned(translated, expected) {
        if (!translated) return new Array(expected).fill('');
        if (expected === 1) return [translated.trim()];
        const lines = translated.split('\n').map(line => line.trim());
        while (lines.length > expected && lines[lines.length - 1] === '') lines.pop();
        return lines.length === expected ? lines : null;
    }

    /** 真正发起一次 HTTP 请求，带指数退避重试 */
    async function fetchTranslation(text, lang, epoch, attempt = 0) {
        const url = 'https://translate.googleapis.com/translate_a/single'
            + `?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t`
            + `&q=${encodeURIComponent(text)}`;

        try {
            stats.requests++;
            const translated = parseTranslation(await httpGet(url, config.requestTimeoutMs)) || '';
            if (translated && translated !== text) cacheSet(lang, text, translated, epoch);
            return translated;
        } catch (error) {
            if (attempt < config.maxRetries && isRetryable(error)) {
                const delay = 400 * Math.pow(2, attempt);
                debug(`请求失败，${delay}ms 后第 ${attempt + 1} 次重试`, error && error.message);
                await sleep(delay);
                return fetchTranslation(text, lang, epoch, attempt + 1);
            }
            stats.failed++;
            debug('翻译失败', error && error.message);
            return '';
        }
    }

    function isRetryable(error) {
        const status = error && error.status;
        if (status === 429) return true;
        if (status >= 500 && status < 600) return true;
        return !status;    // 网络错误 / 超时
    }

    function httpGet(url, timeout) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest 不可用'));
                return;
            }

            let handle = null;
            const timer = setTimeout(() => {
                try {
                    if (handle && typeof handle.abort === 'function') handle.abort();
                } catch (error) { /* ignore */ }
                reject(new Error('timeout'));
            }, timeout + 500);

            const finish = (fn, arg) => {
                clearTimeout(timer);
                fn(arg);
            };

            try {
                handle = GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout,
                    headers: { Accept: 'application/json,text/plain,*/*' },
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            finish(resolve, res.responseText);
                        } else {
                            const error = new Error(`HTTP ${res.status}`);
                            error.status = res.status;
                            finish(reject, error);
                        }
                    },
                    onerror: () => finish(reject, new Error('network error')),
                    ontimeout: () => finish(reject, new Error('timeout')),
                    onabort: () => finish(reject, new Error('aborted'))
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    function parseTranslation(raw) {
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
        return data[0].map(part => (Array.isArray(part) ? part[0] || '' : '')).join('');
    }

    /* ---------------------------- 文本处理 ---------------------------- */

    function shouldTranslate(rawText) {
        const text = (rawText || '').trim();
        if (!text) return false;
        if (text.length < config.minLength) return false;
        if (MEANINGLESS_RE.test(text)) return false;

        const cjkCount = (text.match(CJK_RE) || []).length;
        if (cjkCount / text.length >= config.cjkSkipRatio) return false;   // 基本已是中日韩文
        if (config.latinOnly && !LATIN_RE.test(text)) return false;        // 纯日/韩/泰等

        for (const keyword of config.doNotTranslate) {
            if (text.includes(keyword)) return false;
        }
        return true;
    }

    /** 在段落 / 句子边界处切分长文本 */
    function splitText(text, max) {
        if (text.length <= max) return [text];

        const parts = [];
        let buffer = '';
        const flush = () => {
            if (buffer) {
                parts.push(buffer);
                buffer = '';
            }
        };

        for (let block of text.split(/\n{2,}/)) {
            while (block.length > max) {
                const cut = findBreak(block, max);
                flush();
                parts.push(block.slice(0, cut).trim());
                block = block.slice(cut);
            }
            if (!block) continue;
            if (buffer && buffer.length + block.length + 2 > max) flush();
            buffer = buffer ? `${buffer}\n\n${block}` : block;
        }
        flush();
        return parts.filter(Boolean);
    }

    /**
     * 把一段文本拆成「原子」（以源文本的行为单位，超长行再按句子切分）。
     *
     * 原子的边界就是行边界：
     *   - breakBefore 标记该原子是否是新的一行 —— 渲染时还原成 <br>；
     *   - 合批请求用 \n 连接，返回行数由 splitAligned 校验，对不上就逐行重试。
     * 因此即使翻译服务把换行吞掉，排版也能原样重建。
     */
    function splitIntoAtoms(text, maxChars) {
        const atoms = [];
        text.split('\n').forEach((line, lineIndex) => {
            const parts = line.length <= maxChars ? [line] : splitText(line, maxChars);
            parts.forEach((part, partIndex) => {
                atoms.push({ text: part, breakBefore: lineIndex > 0 && partIndex === 0 });
            });
        });
        return atoms;
    }

    function findBreak(str, max) {
        const window = str.slice(0, max);
        const min = Math.floor(max * 0.5);
        const re = /[。！？!?；;：:，,、\s)\]}】》」』"'…]/g;
        let best = -1;
        let match;
        while ((match = re.exec(window)) !== null) {
            if (match.index + 1 >= min) best = match.index + 1;
        }
        return best > 0 ? best : max;
    }

    /* #endregion */

    /* #region 视口懒翻译 */

    const visibility = (() => {
        let observer = null;
        const callbacks = new WeakMap();

        function ensure() {
            if (observer || typeof IntersectionObserver !== 'function') return;
            observer = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const callback = callbacks.get(entry.target);
                    callbacks.delete(entry.target);
                    observer.unobserve(entry.target);
                    if (callback) callback();
                }
            }, { rootMargin: `${config.lazyMarginPx}px 0px ${config.lazyMarginPx}px 0px` });
        }

        return {
            whenVisible(element, callback) {
                if (!config.lazyViewport || typeof IntersectionObserver !== 'function') {
                    callback();
                    return;
                }
                ensure();
                callbacks.set(element, callback);
                observer.observe(element);
            },
            stop(element) {
                if (!observer) return;
                callbacks.delete(element);
                observer.unobserve(element);
            }
        };
    })();

    function viewportPriority(element) {
        try {
            const rect = element.getBoundingClientRect();
            const viewport = window.innerHeight || 800;
            return -Math.abs(rect.top + rect.height / 2 - viewport / 2);
        } catch (error) {
            return 0;
        }
    }

    /* #endregion */

    /* #region 站点适配器 */

    const shadowHosts = new Set();
    /** 已挂上 shadow 观察器的 host（ShadowRoot 没有 dataset，用 WeakSet 记录） */
    const observedShadowHosts = new WeakSet();

    /** Ko-fi 的正文在 shadow DOM 里：注入样式、同步开关、并监听后续内容 */
    function bindShadowHost(host) {
        const shadow = host.shadowRoot;
        if (!shadow) return false;
        shadowHosts.add(host);
        host.toggleAttribute('data-lt-off', !config.enabled);
        ensureShadowStyle(shadow);

        if (observedShadowHosts.has(host)) return true;
        observedShadowHosts.add(host);
        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) scan(node);
                }
            }
        }).observe(shadow, { childList: true, subtree: true });
        return true;
    }

    /**
     * Ko-fi 的 .article-host 是自定义元素，shadow root 可能在脚本首次扫描之后
     * 才挂载（而且挂载 shadow root 不会产生 DOM 变更事件）。首次扫描时若
     * shadow root 还不存在，就在这里有限次数地重试。
     */
    const pendingShadowHosts = new Set();

    function watchShadowHost(host, attempt = 0) {
        if (bindShadowHost(host)) {
            pendingShadowHosts.delete(host);
            host.shadowRoot.querySelectorAll('.fr-view p').forEach(p => scheduleElement(p));
            return;
        }

        pendingShadowHosts.add(host);
        if (attempt >= 20) {
            pendingShadowHosts.delete(host);
            return;
        }
        setTimeout(() => {
            if (host.isConnected) watchShadowHost(host, attempt + 1);
            else pendingShadowHosts.delete(host);
        }, 250 * Math.min(attempt + 1, 4));
    }

    /**
     * 适配器接口：
     *   selector                      锚点元素选择器
     *   scanRoots(node) -> Element[]  在新增子树中找出待翻译锚点
     *   expand(root, list)            补充锚点（如 Ko-fi 的 shadow DOM）
     *   segments(element) -> seg[]    kind: text | spoiler | break
     *   文本来源必须排除脚本自己写入的节点（.lt-part / .lt-badge）
     */
    const adapter = createAdapter();

    /** 会强制换行的标签（用于从 DOM 还原出排版结构） */
    const BLOCK_TAGS = new Set([
        'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
        'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
        'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
    ]);

    /**
     * 从 DOM 里按「排版结构」提取文本。
     *
     * 换行有三个来源，全部要保留：
     *   1. 文本节点里真实的 \n —— X、Discord 的正文靠它换行，配 white-space: pre-wrap 显示；
     *      （早期版本在这里把 \n 替换成了空格，导致多行推文被压成一行送给翻译）
     *   2. <br> 标签
     *   3. 块级元素的边界（<p>、<div> 等）
     * 只折叠行内的连续空白（空格 / 制表符 / 不断行空格 / 3 个以上连续换行），不动单个换行。
     *
     * 不能用 textContent —— 它会把 <br> 与块级边界全部吃掉；
     * 也不能用 innerText —— 译文态下那是译文，且依赖布局。
     */
    function extractText(root) {
        const lines = [];
        let buffer = '';

        /** 换行：一定占一行（连续 <br> / 空行因此得以保留） */
        const breakLine = () => {
            lines.push(buffer.replace(/[\t\u00a0 ]+/g, ' ').trim());
            buffer = '';
        };

        /** 块级边界：只在有内容时收尾（避免 <p> 之间凭空多出空行） */
        const endBlock = () => {
            const line = buffer.replace(/[\t\u00a0 ]+/g, ' ').trim();
            if (line) lines.push(line);
            buffer = '';
        };

        const visit = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                // 文本节点里真实的 \n 就是排版（X / Discord 靠它换行），必须保留
                (node.nodeValue || '').split('\n').forEach((part, index) => {
                    if (index > 0) breakLine();
                    buffer += part.replace(/[\t\u00a0 ]+/g, ' ');
                });
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            // 跳过脚本自己写入的译文与图标
            if (node.classList?.contains('lt-part') || node.classList?.contains('lt-badge')) return;

            if (node.tagName === 'BR') {
                breakLine();
                return;
            }
            if (BLOCK_TAGS.has(node.tagName)) {
                endBlock();
                node.childNodes.forEach(visit);
                endBlock();
                return;
            }
            node.childNodes.forEach(visit);
        };

        root.childNodes.forEach(visit);
        endBlock();

        return lines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')    // 最多保留一个空行
            .replace(/\n+$/, '')            // 去掉尾部空行
            .replace(/^\n+/, '');           // 去掉首部空行
    }

    /**
     * 取出元素的「原文」文本（保留换行结构）。
     * 脚本把译文写进了同一个容器，所以必须排除自己的节点。
     */
    function readableText(element) {
        const current = extractText(element);
        if (current) return current;

        // 译文态下若当前内容已被清空，回退到原文快照
        const state = element.__lt;
        if (state && Array.isArray(state.originalNodes)) {
            const holder = document.createElement('div');
            for (const node of state.originalNodes) holder.appendChild(node.cloneNode(true));
            return extractText(holder);
        }
        return '';
    }

    function createAdapter() {
        if (SITE === SITES.twitter) {
            return {
                selector: 'div[data-testid="tweetText"], div[data-testid^="message-text-"]',
                scanRoots(node) {
                    const list = [];
                    if (node.matches?.(this.selector)) list.push(node);
                    node.querySelectorAll?.(this.selector).forEach(el => list.push(el));
                    return list;
                },
                segments(element) {
                    return [{ kind: 'text', text: readableText(element) }];
                }
            };
        }

        if (SITE === SITES.discord) {
            return {
                selector: 'div[id^="message-content-"], div[class*="embedDescription"], div[class*="embedTitle"], div[class*="embedFieldValue"]',
                scanRoots(node) {
                    const list = [];
                    if (node.matches?.(this.selector)) list.push(node);
                    node.querySelectorAll?.(this.selector).forEach(el => list.push(el));
                    // 只保留最外层容器：内层 embed 的文字会随外层一起被分段译出。
                    // （反过来取“没有匹配后代的元素”会丢掉外层自身的直接文本节点）
                    return list.filter(el => !el.parentElement?.closest(this.selector));
                },
                segments(element) {
                    return discordSegments(element);
                }
            };
        }

        if (SITE === SITES.patreon) {
            return {
                selector: '[data-tag="post-title"], [data-tag="post-content"] p, [class*="cm-gBCCZY"] p',
                scanRoots(node) {
                    const list = [];
                    if (node.matches?.(this.selector)) list.push(node);
                    node.querySelectorAll?.(this.selector).forEach(el => list.push(el));
                    return list;
                },
                segments(element) {
                    return [{ kind: 'text', text: readableText(element) }];
                }
            };
        }

        if (SITE === SITES.kofi) {
            return {
                selector: '.caption-pdg, .post-story-text, .kfds-top-mrgn-8',
                scanRoots(node) {
                    const list = [];
                    if (node.matches?.(this.selector)) list.push(node);
                    node.querySelectorAll?.(this.selector).forEach(el => list.push(el));
                    return list.filter(el => !(el.matches('.kfds-top-mrgn-8') && !el.closest('.kfds-lt-column')));
                },
                expand(root, list) {
                    const hosts = [];
                    if (root.matches?.('.article-host')) hosts.push(root);
                    root.querySelectorAll?.('.article-host').forEach(host => hosts.push(host));

                    for (const host of hosts) {
                        if (host.shadowRoot) {
                            bindShadowHost(host);
                            host.shadowRoot.querySelectorAll('.fr-view p').forEach(p => list.push(p));
                        } else {
                            watchShadowHost(host);   // shadow root 可能稍后才挂载
                        }
                    }
                },
                segments(element) {
                    return [{ kind: 'text', text: readableText(element) }];
                }
            };
        }

        return null;
    }

    /**
     * Discord 消息分段：文本节点 + spoiler（遮罩）节点；
     * 跳过时间戳与屏幕阅读器隐藏节点（否则会把「剧透内容」等提示一起译出来）。
     */
    /**
     * Discord 消息分段。
     *
     * Discord 的正文是这样的：换行是文本节点里的真实 \n，而行内元素（<strong>、
     * <a>、<em>、自定义 emoji 等）会把一句话切成好几个文本节点。
     * 因此不能用“一个文本节点 = 一段”的模型 —— 那样 "a <b>bold</b> c" 会被拆成
     * "a" / "bold" / "c" 三段当成三行送翻译，再靠补空格拼回来（空格位置就错了）。
     *
     * 正确模型：连续的行内内容累积成同一条文本，只有 \n / <br> / 块级边界才切段；
     * spoiler 单独成段（它有自己的遮罩交互）。
     */
    function discordSegments(message) {
        const segments = [];
        const seen = new Set();
        let buffer = '';

        const isSpoiler = (node) => node.classList && (
            node.classList.contains('obscured')
            || [...node.classList].some(name => name.includes('spoilerContent'))
        );

        const isSkipped = (node) => {
            if (!node.classList) return false;
            if (node.matches?.('time')) return true;
            return [...node.classList].some(name =>
                name.includes('timestamp') || name.includes('hiddenVisually') || name.includes('sr-only'));
        };

        // 行内空白折叠，但不动换行本身；保留首尾空格的位置信息
        const normalizeInline = (text) => (text || '').replace(/[\t\u00a0 ]+/g, ' ');

        /**
         * 收尾当前段：把累积的正文推成一个 segment。
         * 注意：换行是当作 '\n' 累积在段内的，而不是把每行切成独立的 segment。
         * 因为下游（splitIntoAtoms）靠段内 '\n' 生成 breakBefore 来还原排版；
         * 如果这里就把行切成多段，每段只有一个原子、breakBefore 全为 false，
         * 渲染时就只能靠“补空格”拼回去，换行就丢了。
         */
        const flush = () => {
            // 去掉行尾多余空白，以及首尾空行，但保留内部换行
            const text = buffer
                .replace(/[\t\u00a0 ]+$/gm, '')
                .replace(/^\n+/, '')
                .replace(/\n+$/, '')
                .trim();
            buffer = '';
            if (text) segments.push({ kind: 'text', text });
        };

        const walk = (node) => {
            if (!node || seen.has(node)) return;
            seen.add(node);

            if (node.nodeType === Node.TEXT_NODE) {
                // 文本节点里的 \n 就是排版，原样累积进当前段
                buffer += normalizeInline(node.nodeValue);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            if (isSkipped(node)) return;
            // 跳过脚本自己写入的译文与图标
            if (node.classList?.contains('lt-part') || node.classList?.contains('lt-badge')) return;

            if (node.tagName === 'BR') {
                buffer += '\n';
                return;
            }
            if (isSpoiler(node)) {
                const text = extractText(node);
                flush();                       // 遮罩前的文字先收尾
                if (text) segments.push({ kind: 'spoiler', text });
                return;
            }

            node.childNodes?.forEach(walk);
        };

        walk(message);
        flush();
        return segments;
    }

    /* #endregion */

    /* #region 渲染 */

    /** 取直接子节点里的图标（:scope > 在 shadow DOM 下不可靠，改为遍历子节点） */
    function directBadge(element) {
        return [...element.children].find(node => node.classList?.contains('lt-badge')) || null;
    }

    /**
     * 把元素恢复成「未被脚本接管」的样子：还原原文、去掉图标与状态标记。
     * 原文快照存在 element.__lt 上，必须在丢弃状态前放回去，否则原文会永久丢失。
     */
    function restoreElement(element) {
        const originals = restoreOriginalChildren(element);
        const badge = directBadge(element);
        if (badge) badge.remove();
        element.classList.remove('lt-anchor', 'lt-translated');
        element.removeAttribute('data-lt-state');
        delete element.__lt;
        return originals;
    }

    /**
     * 把元素内容还原为原文快照（若有）。
     * 注意：replaceChildren 的每个参数都是节点，必须把数组展开，
     * 直接传数组会被当成字符串插进去（变成 [object HTMLSpanElement]）。
     */
    function restoreOriginalChildren(element) {
        const state = element.__lt;
        if (!state) return null;
        if (state.showing === 'translated') {
            const badge = directBadge(element);
            if (badge) element.replaceChildren(...state.originalNodes, badge);
            else element.replaceChildren(...state.originalNodes);
        }
        return state.originalNodes;
    }

    /** 构造右下角图标（只有图标，没有文字） */
    /**
     * 图标用 Material Icons Round 的 translate 字形（ligature），
     * 这里直接内联官方 SVG 路径 —— 不引字体文件、不发网络请求、不受站点 CSP 限制。
     * 另两个状态（翻译中 / 失败）用简洁自绘图形，与它同一套 24×24 网格。
     */
    const MATERIAL_TRANSLATE_PATH =
        'M12.65 15.67c.14-.36.05-.77-.23-1.05l-2.09-2.06.03-.03c1.74-1.94 2.98-4.17 3.71-6.53h1.94c.54 0 '
        + '.99-.45.99-.99v-.02c0-.54-.45-.99-.99-.99H10V3c0-.55-.45-1-1-1s-1 .45-1 1v1H1.99c-.54 0-.99.45-.99.99 '
        + '0 .55.45.99.99.99h10.18C11.5 7.92 10.44 9.75 9 11.35c-.81-.89-1.49-1.86-2.06-2.88-.16-.29-.45-.47-.78-.47'
        + '-.69 0-1.13.75-.79 1.35.63 1.13 1.4 2.21 2.3 3.21L3.3 16.87c-.4.39-.4 1.03 0 1.42.39.39 1.02.39 1.42 0'
        + 'L9 14l2.02 2.02c.51.51 1.38.32 1.63-.35zM17.5 10c-.6 0-1.14.37-1.35.94l-3.67 9.8c-.24.61.22 1.26.87 1.26'
        + '.39 0 .74-.24.88-.61l.89-2.39h4.75l.9 2.39c.14.36.49.61.88.61.65 0 1.11-.65.88-1.26l-3.67-9.8c-.22-.57-.76-.94-1.36-.94'
        + 'zm-1.62 7l1.62-4.33L19.12 17h-3.24z';

    const BADGE_ICON = {
        spinner: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
            + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/>'
            + '<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
        translate: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${MATERIAL_TRANSLATE_PATH}"/></svg>`,
        warn: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
            + '<path d="M12 3.2 1.9 20.8h20.2L12 3.2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
            + '<path d="M12 9.5v4.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
            + '<circle cx="12" cy="17.4" r="1.15" fill="currentColor"/></svg>'
    };

    function setBadge(badge, kind, title) {
        badge.className = `lt-badge lt-badge--${kind}`;
        badge.innerHTML = kind === 'busy' ? BADGE_ICON.spinner
            : kind === 'error' ? BADGE_ICON.warn
            : BADGE_ICON.translate;
        badge.title = title || '';
        badge.setAttribute('aria-label', title || 'translation');
    }

    /** 把译文按分段结构拼成一个文档片段（带 spoiler 交互） */
    /**
     * 把译文按分段结构拼成 DOM。
     * 译文里的换行要显式转成 <br>：宿主站点（X / Discord）对正文内部换行的
     * 处理不一致，依赖 white-space 在部分主题下会被覆盖掉。
     */
    function renderResult(plan, atoms, translated) {
        const box = document.createElement('span');
        box.className = 'lt-part';

        /** 把译文写进去，内部换行一律还原为 <br> */
        const appendText = (parent, text) => {
            String(text).split('\n').forEach((line, index) => {
                if (index > 0) parent.appendChild(document.createElement('br'));
                if (line) parent.appendChild(document.createTextNode(line));
            });
        };

        let wroteAnything = false;

        for (const segment of plan) {
            if (segment.kind === 'break') {
                box.appendChild(document.createElement('br'));
                wroteAnything = true;
                continue;
            }
            if (segment.kind === 'skip') continue;

            segment.atomIds.forEach((atomId) => {
                const chunk = translated[atomId];

                // 原子边界就是源文本的换行：无论该行有没有译文都要断行，
                // 否则空行会被吞掉（原文 "a\n\nb" 变成 "a<br>b"）。
                if (atoms[atomId].breakBefore) {
                    box.appendChild(document.createElement('br'));
                }
                if (!chunk) return;

                if (!atoms[atomId].breakBefore && wroteAnything) {
                    // 同一行内的分片之间补一个空格，避免词被粘在一起
                    const prev = box.lastChild;
                    const needSpace = prev && (prev.nodeType === Node.TEXT_NODE
                        ? !/\s$/.test(prev.nodeValue)
                        : prev.nodeName !== 'BR');
                    if (needSpace) box.appendChild(document.createTextNode(' '));
                }

                if (segment.kind === 'spoiler') {
                    const node = document.createElement('span');
                    node.className = 'lt-spoiler';
                    node.title = '点击显示译文 / Click to reveal';
                    node.addEventListener('click', (event) => {
                        event.stopPropagation();
                        node.classList.add('lt-spoiler--open');
                    });
                    appendText(node, chunk);
                    box.appendChild(node);
                } else {
                    appendText(box, chunk);
                }
                wroteAnything = true;
            });
        }

        return box;
    }

    /** 翻译失败：在右下角挂黄色感叹号，点击可重试 */
    function renderError(element, retry) {
        const badge = ensureBadge(element);
        setBadge(badge, 'error', '翻译失败，点击重试 / Translation failed, click to retry');
        badge.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            setBadge(badge, 'busy', '翻译中 / Translating');
            retry();
        };
    }

    function ensureBadge(element) {
        let badge = directBadge(element);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'lt-badge';
            const state = element.__lt;
            if (state) setupBadgeClick(element, badge, state);
            element.appendChild(badge);
        }
        return badge;
    }

    function setupBadgeClick(element, badge, state) {
        badge.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleTranslation(element, badge, state);
        };
    }

    /** 点击图标：译文 ⇄ 原文 切换（只切这一条） */
    function toggleTranslation(element, badge, state) {
        if (state.showing === 'original') {
            state.showing = 'translated';
            element.replaceChildren(state.translatedNodes[0], badge);
            element.setAttribute('data-lt-state', 'translated');
            element.classList.add('lt-translated');
            setBadge(badge, 'translated', '正在显示译文，点击查看原文 / Showing translation, click for original');
        } else {
            state.showing = 'original';
            element.replaceChildren(...state.originalNodes, badge);
            element.setAttribute('data-lt-state', 'original');
            element.classList.remove('lt-translated');
            setBadge(badge, 'original', '正在显示原文，点击查看译文 / Showing original, click for translation');
        }
    }

    function renderTranslation(element, plan, atoms, translated) {
        // 若元素已处于译文态（例如重译），先还原成原文再快照，
        // 否则会把上一次的译文当成原文存进快照。
        const restored = restoreOriginalChildren(element);
        // 快照里不能包含脚本自己的图标（翻译中的 busy 图标也在此列）
        const originalNodes = (restored || [...element.childNodes])
            .filter(node => !(node.nodeType === Node.ELEMENT_NODE
                && node.classList?.contains('lt-badge')));
        restoreElement(element);

        element.classList.add('lt-anchor', 'lt-translated');
        element.setAttribute('data-lt-state', 'translated');

        const state = {
            originalNodes,
            translatedNodes: [renderResult(plan, atoms, translated)],
            showing: 'translated'
        };
        element.__lt = state;

        const badge = document.createElement('span');
        badge.className = 'lt-badge';
        setupBadgeClick(element, badge, state);

        element.replaceChildren(state.translatedNodes[0], badge);
        setBadge(badge, 'translated', '正在显示译文，点击查看原文 / Showing translation, click for original');
    }

    /* #endregion */

    /** 翻译一个锚点元素：分段 → 分片 → 合批请求 → 按序渲染 */
    async function translateElement(element) {
        if (!adapter || !element.isConnected || !config.enabled) return;

        // 标记进行中：重扫时不会对同一元素并发发起第二次翻译
        if (element.hasAttribute('data-lt-busy')) return;
        element.setAttribute('data-lt-busy', '1');
        try {
            await doTranslateElement(element);
        } finally {
            element.removeAttribute('data-lt-busy');
        }
    }

    async function doTranslateElement(element) {
        const segments = adapter.segments(element)
            .filter(seg => seg.kind === 'break' || (seg.text || '').trim().length > 0);
        if (!segments.some(seg => seg.kind !== 'break' && shouldTranslate(seg.text))) return;

        const atoms = [];
        const plan = segments.map((seg) => {
            if (seg.kind === 'break') return { kind: 'break', atomIds: [] };
            if (!shouldTranslate(seg.text)) return { kind: 'skip', atomIds: [] };

            const text = seg.text.length > config.maxTextChars
                ? seg.text.slice(0, config.maxTextChars)
                : seg.text;
            const atomIds = splitIntoAtoms(text, config.chunkChars).map((atom) => {
                atoms.push(atom);
                return atoms.length - 1;
            });
            return { kind: seg.kind, atomIds };
        });
        if (!atoms.length) return;

        // 译文就绪前不动原文，只在右下角转图标（避免空白闪烁）
        showBusyBadge(element);

        const priority = viewportPriority(element);
        const translated = new Array(atoms.length).fill('');

        try {
            await Promise.all(packAtoms(atoms).map(async (group) => {
                const results = await translateGroup(group, atoms, priority);
                group.forEach((atomId, index) => {
                    translated[atomId] = results[index] || '';
                });
            }));
        } catch (error) {
            if (DEBUG) warn('翻译出错', error);
        }

        if (!element.isConnected) return;

        if (!translated.some(Boolean)) {
            // 翻译失败：黄色感叹号，点击重试
            renderError(element, () => {
                element.removeAttribute('data-lt-done');
                scheduleElement(element);
            });
            return;
        }

        if (!config.enabled) return;
        // 指纹必须在替换原文之前算，否则会记下「译文」的指纹，
        // 导致下次 DOM 变动时被误判为新内容而反复重译。
        element.setAttribute('data-lt-done', sourceFingerprint(element));
        renderTranslation(element, plan, atoms, translated);
    }

    /** 在正文没被接管时，也能挂一个临时旋转图标 */
    /** 译文未就绪：先挂一个旋转图标，原文照旧显示 */
    function showBusyBadge(element) {
        if (element.hasAttribute('data-lt-state')) return;   // 已接管，交给切换逻辑
        const badge = ensureBadge(element);
        setBadge(badge, 'busy', '翻译中 / Translating');
        badge.onclick = null;
        element.classList.add('lt-anchor');
    }

    /**
     * 把原子下标打包成若干次请求（控制单次字符数与行数）。
     * 空行（空原子）不发请求，但它在 renderResult 里仍会占一行。
     */
    function packAtoms(atoms) {
        const groups = [];
        let current = [];
        let length = 0;

        atoms.forEach((atom, index) => {
            if (!atom.text) return;                  // 空行无需翻译
            if (current.length && (length + atom.text.length + 1 > config.batchMaxChars || current.length >= 6)) {
                groups.push(current);
                current = [];
                length = 0;
            }
            current.push(index);
            length += atom.text.length + 1;
        });
        if (current.length) groups.push(current);
        return groups;
    }

    /**
     * 一次请求译完一组原子；行数不符时逐条重试。
     * 组内各原子用 \n 连接，返回按行对应到各自原子（splitAligned 会校验行数）。
     */
    async function translateGroup(group, atoms, priority) {
        if (group.length === 1) {
            return [await requestText(atoms[group[0]].text, priority)];
        }

        const joined = group.map(id => atoms[id].text).join('\n');
        const lines = splitAligned(await requestText(joined, priority), group.length);
        if (lines) return lines;

        debug('组内行数不符，逐条重试', { expected: group.length });
        // 行数对不上：逐条单独请求（atomic 禁止再次合批）
        return Promise.all(group.map(id => requestText(atoms[id].text, priority, { atomic: true })));
    }

    /** 移除某锚点元素上的接管痕迹 */
    /** 将某锚点元素恢复成原文（并清掉进行中标记） */
    function removeBoxesFor(element) {
        restoreElement(element);
    }

    /* #endregion */

    /* #region 扫描与监听 */

    const MAX_FLUSH_ROOTS = 600;
    const pendingRoots = new Set();
    let flushTimer = null;
    let flushDeadline = 0;
    let isFlushing = false;

    function scan(root) {
        if (!adapter || !root) return;
        const type = root.nodeType;
        if (type !== Node.ELEMENT_NODE && type !== Node.DOCUMENT_FRAGMENT_NODE) return;
        if (type === Node.ELEMENT_NODE) {
            if (root.closest?.('.lt-panel')) return;
        }

        let anchors = adapter.scanRoots(root);
        if (adapter.expand) {
            anchors = anchors.slice();
            adapter.expand(root, anchors);
        }
        for (const element of anchors) scheduleElement(element);
        if (config.translatePlaceholders) scanPlaceholders(root);
    }

    function scheduleElement(element) {
        if (!element || !element.isConnected) return;
        if (element.hasAttribute('data-lt-pending')) return;

        // X 等虚拟列表会回收复用 DOM 节点：节点仍在但内容已换，
        // 只靠 data-lt-done 会漏译，因此记录当时的源文本指纹做比对。
        const source = sourceFingerprint(element);
        if (element.getAttribute('data-lt-done') === source) return;
        if (source) element.setAttribute('data-lt-done', '');

        element.setAttribute('data-lt-pending', '1');
        visibility.whenVisible(element, () => {
            element.removeAttribute('data-lt-pending');
            if (!element.isConnected || !config.enabled) return;
            translateElement(element).catch((error) => {
                if (DEBUG) warn('翻译元素失败', error);
            });
        });
    }

    /** 用于判断元素内容是否被复用替换（基于原文，排除脚本写入的节点） */
    function sourceFingerprint(element) {
        const text = readableText(element).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return `${text.length}:${hash32(text)}`;
    }

    function onMutations(mutations) {
        let added = false;
        for (const mutation of mutations) {
            // 节点被复用时内容可能原地替换（不产生 addedNode），需按目标节点重新排队
            if (mutation.type === 'characterData') {
                const parent = mutation.target.parentElement;
                if (parent) {
                    pendingRoots.add(parent);
                    added = true;
                }
                continue;
            }
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    pendingRoots.add(node);
                    added = true;
                } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
                    pendingRoots.add(node.parentElement);
                    added = true;
                }
            }
        }
        if (added) scheduleFlush();
    }

    /** DOM 持续变动时先消化一批（最长等待 1.2s），避免扫描被无限推迟 */
    function scheduleFlush() {
        if (!flushDeadline) flushDeadline = now() + 1200;
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
            if (pendingRoots.size) scheduleFlush();
        }, 160);
    }

    function flush() {
        if (isFlushing || !pendingRoots.size) return;
        isFlushing = true;
        try {
            let budget = MAX_FLUSH_ROOTS;
            for (const root of pendingRoots) {
                pendingRoots.delete(root);
                if (root.isConnected) scan(root);
                if (--budget <= 0) break;
            }
        } catch (error) {
            warn('扫描出错', error);
        } finally {
            isFlushing = false;
        }
        if (!pendingRoots.size) flushDeadline = 0;
    }

    /** 输入框提示语翻译（低优先级，只处理一次） */
    function scanPlaceholders(root) {
        const nodes = [];
        if (root.matches?.('[placeholder], [aria-placeholder]')) nodes.push(root);
        root.querySelectorAll?.('[placeholder], [aria-placeholder]').forEach(el => nodes.push(el));

        for (const el of nodes) {
            if (el.closest?.('.lt-panel')) continue;
            for (const attr of ['placeholder', 'aria-placeholder']) {
                const value = el.getAttribute(attr);
                if (!value || el.hasAttribute(`data-lt-ph-${attr}`)) continue;
                if (!shouldTranslate(value)) continue;
                el.setAttribute(`data-lt-ph-${attr}`, value);
                requestText(value, -1000)
                    .then((translated) => {
                        if (translated && el.isConnected) el.setAttribute(attr, translated);
                    })
                    .catch(() => { /* ignore */ });
            }
        }
    }

    /* #endregion */

    /* #region X/Twitter 专属：展开后重译 + 搜索页 Latest */

    const SHOW_MORE_RE = /显示更多|show more|show additional|read more/i;
    const TWITTER_HOST_RE = /(^|\.)(x|twitter)\.com$/;
    let timelineSortDone = false;

    function handleTwitterClick(event) {
        const button = event.target.closest?.('button, a, [role="button"]');
        if (!button) return;
        const label = (button.innerText || button.textContent || '').trim();
        if (!SHOW_MORE_RE.test(label)) return;

        const article = button.closest('article') || button.closest('[data-testid="tweet"]');
        if (!article) return;
        const tweetText = article.querySelector('div[data-testid="tweetText"]');
        if (!tweetText) return;

        removeBoxesFor(tweetText);          // 还原成原文，展开后的新文本才能被抓到
        tweetText.removeAttribute('data-lt-done');
        visibility.stop(tweetText);
        setTimeout(() => {
            if (tweetText.isConnected) scheduleElement(tweetText);
        }, 900);
    }

    /** 搜索页强制 Latest，否则刚发布的推文会被「热门」排序挡住 */
    function forceSearchLatest() {
        if (!TWITTER_HOST_RE.test(location.hostname)) return false;
        if (!location.pathname.startsWith('/search')) return false;
        const params = new URLSearchParams(location.search);
        if (params.get('f') === 'live') return false;
        params.set('f', 'live');
        location.replace(`${location.pathname}?${params.toString()}${location.hash}`);
        return true;
    }

    const compactText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, '');

    function isSortMenu(menu) {
        const text = compactText(menu);
        return text.includes('排序方式') || text.includes('Sortby') || text.includes('Sortorder');
    }

    function menuItemSelected(item) {
        return item.getAttribute('aria-checked') === 'true' || !!item.querySelector('svg');
    }

    function enforceLatestSort(root = document) {
        let applied = false;
        root.querySelectorAll?.('div[role="menu"]').forEach((menu) => {
            if (!isSortMenu(menu) || menu.dataset.ltSortHandled === '1') return;
            const latest = [...menu.querySelectorAll('div[role="menuitem"]')].find((item) => {
                const text = compactText(item);
                return text.includes('最近') || text.includes('Latest') || text.includes('Recent');
            });
            if (!latest) return;
            if (!menuItemSelected(latest)) latest.click();
            menu.dataset.ltSortHandled = '1';
            applied = true;
        });
        if (applied) timelineSortDone = true;
        return applied;
    }

    function findSortTrigger(root = document) {
        const selector = 'button[aria-haspopup="menu"], div[role="button"][aria-haspopup="menu"]';
        for (const item of root.querySelectorAll?.(selector) || []) {
            const attrs = `${item.getAttribute('aria-label') || ''} ${item.getAttribute('title') || ''} ${compactText(item)}`.toLowerCase();
            if (/sort|order|timeline|排序/.test(attrs)) return item;
        }
        return null;
    }

    function scheduleTimelineSort(maxRetry = 12, delay = 500) {
        let retry = 0;
        const runner = () => {
            if (timelineSortDone) return;
            if (enforceLatestSort(document)) return;

            const trigger = findSortTrigger(document);
            if (trigger) {
                trigger.click();
                setTimeout(() => enforceLatestSort(document), 120);
            }
            if (++retry < maxRetry && !timelineSortDone) setTimeout(runner, delay);
        };
        setTimeout(runner, delay);
    }

    /* #endregion */

    /* #region 设置面板 */

    let panelElement = null;

    function toast(message) {
        const el = document.createElement('div');
        el.className = 'lt-toast';
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2000);
    }

    function closePanel() {
        document.removeEventListener('keydown', onPanelKeydown, true);
        if (!panelElement) return;
        panelElement.remove();
        panelElement = null;
    }

    function onPanelKeydown(event) {
        if (event.key === 'Escape') closePanel();
    }

    function openPanel() {
        if (panelElement) {
            closePanel();
            return;
        }

        const cfg = config;
        const backdrop = document.createElement('div');
        backdrop.className = 'lt-panel-backdrop';
        backdrop.innerHTML = `
            <div class="lt-panel" role="dialog" aria-label="翻译设置 / Translation settings">
                <h2 class="lt-panel__title">翻译设置 <span style="opacity:.5;font-size:12px">Translation</span></h2>
                <p class="lt-panel__subtitle">v${VERSION} · ${escapeHtml(SITE ? SITE.name : location.hostname)} · 设置按站点保存</p>

                <div class="lt-panel__group">
                    <div class="lt-panel__group-title">基础 / Basics</div>
                    <label class="lt-panel__row"><input type="checkbox" data-cfg="enabled" ${cfg.enabled ? 'checked' : ''}><span class="lt-panel__label">启用翻译 / Enable</span></label>
                    <label class="lt-panel__row lt-panel__row--block"><span class="lt-panel__label">目标语言 / Target language</span>
                        <select data-cfg="targetLang">${TARGET_LANGS.map(([value, label]) =>
                            `<option value="${value}"${cfg.targetLang === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
                    </label>
                    <label class="lt-panel__row lt-panel__row--block"><span class="lt-panel__label">主题 / Theme</span>
                        <select data-cfg="theme">
                            <option value="auto"${cfg.theme === 'auto' ? ' selected' : ''}>跟随系统 / Auto</option>
                            <option value="light"${cfg.theme === 'light' ? ' selected' : ''}>亮色 / Light</option>
                            <option value="dark"${cfg.theme === 'dark' ? ' selected' : ''}>暗色 / Dark</option>
                        </select>
                    </label>
                    <label class="lt-panel__row"><span class="lt-panel__label">强调色 / Accent color</span><input type="color" data-cfg="accentColor" value="${cfg.accentColor}"></label>
                </div>

                <div class="lt-panel__group">
                    <div class="lt-panel__group-title">翻译范围 / Scope</div>
                    <label class="lt-panel__row"><input type="checkbox" data-cfg="latinOnly" ${cfg.latinOnly ? 'checked' : ''}><span class="lt-panel__label">仅翻译含拉丁字母的文本 / Latin only</span></label>
                    <p class="lt-panel__hint">关闭后日文、韩文、泰文等非拉丁语种也会被翻译。</p>
                    <label class="lt-panel__row"><input type="checkbox" data-cfg="translatePlaceholders" ${cfg.translatePlaceholders ? 'checked' : ''}><span class="lt-panel__label">翻译输入框提示语 / Placeholders</span></label>
                    <label class="lt-panel__row"><input type="checkbox" data-cfg="lazyViewport" ${cfg.lazyViewport ? 'checked' : ''}><span class="lt-panel__label">仅翻译可见内容 / Viewport only</span></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">最短翻译长度 / Min length</span><input type="number" min="1" max="200" data-cfg="minLength" value="${cfg.minLength}"></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">单条正文上限 / Max chars</span><input type="number" min="200" max="20000" step="100" data-cfg="maxTextChars" value="${cfg.maxTextChars}"></label>
                    <label class="lt-panel__row lt-panel__row--block"><span class="lt-panel__label">忽略关键词 / Skip keywords（逗号分隔）</span>
                        <input type="text" data-cfg="doNotTranslate" value="${escapeHtml(cfg.doNotTranslate.join(', '))}">
                    </label>
                </div>

                <div class="lt-panel__group">
                    <div class="lt-panel__group-title">性能 / Performance</div>
                    <label class="lt-panel__row"><span class="lt-panel__label">并发请求数 / Concurrency</span><input type="number" min="1" max="8" data-cfg="maxConcurrent" value="${cfg.maxConcurrent}"></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">分片大小 / Chunk size</span><input type="number" min="200" max="4500" step="100" data-cfg="chunkChars" value="${cfg.chunkChars}"></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">失败重试次数 / Retries</span><input type="number" min="0" max="5" data-cfg="maxRetries" value="${cfg.maxRetries}"></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">缓存条数 / Cache entries</span><input type="number" min="100" max="10000" step="100" data-cfg="cacheEntries" value="${cfg.cacheEntries}"></label>
                    <label class="lt-panel__row"><span class="lt-panel__label">缓存天数 / Cache TTL (days)</span><input type="number" min="0" max="365" data-cfg="cacheTtlDays" value="${cfg.cacheTtlDays}"></label>
                </div>

                <div class="lt-panel__actions">
                    <button class="lt-btn lt-btn--primary" data-action="close">完成 / Done</button>
                    <button class="lt-btn" data-action="retranslate">重译本页 / Retranslate</button>
                    <button class="lt-btn" data-action="clear-cache">清空缓存 / Clear cache</button>
                    <button class="lt-btn lt-btn--danger" data-action="reset">恢复默认 / Reset</button>
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);
        panelElement = backdrop;

        backdrop.addEventListener('click', (event) => {
            const action = event.target.dataset?.action;
            if (action) {
                handlePanelAction(action);
                return;
            }
            if (event.target === backdrop) closePanel();
        });

        backdrop.addEventListener('change', (event) => {
            const field = event.target;
            const key = field.dataset.cfg;
            if (!key) return;
            readFieldValue(field, key);
            saveConfig();
            applyTheme();
            if (key === 'enabled') {
                if (!config.enabled) restoreAllTranslations();
                else retranslatePage();
            } else if (['latinOnly', 'minLength', 'maxTextChars', 'lazyViewport', 'doNotTranslate', 'targetLang']
                .includes(key)) {
                retranslatePage();
            }
            toast('已保存 / Saved');
        });

        backdrop.addEventListener('input', (event) => {
            const field = event.target;
            if (field.dataset.cfg !== 'accentColor') return;
            config.accentColor = field.value;
            applyTheme();
            saveConfig();
        });

        document.addEventListener('keydown', onPanelKeydown, true);
    }

    function handlePanelAction(action) {
        switch (action) {
            case 'close':
                closePanel();
                break;
            case 'retranslate':
                retranslatePage();
                closePanel();
                toast('已重新翻译 / Retranslating');
                break;
            case 'clear-cache':
                clearCache();
                toast('缓存已清空 / Cache cleared');
                break;
            case 'reset':
                config = sanitizeConfig(Object.assign({}, DEFAULT_CONFIG));
                saveConfig();
                applyTheme();
                closePanel();
                retranslatePage();
                toast('已恢复默认 / Reset');
                break;
            default:
                break;
        }
    }

    function readFieldValue(field, key) {
        if (field.type === 'checkbox') config[key] = field.checked;
        else if (field.type === 'number') config[key] = Number(field.value);
        else if (key === 'doNotTranslate') {
            config[key] = field.value.split(/[,，]/).map(word => word.trim()).filter(Boolean);
        } else config[key] = field.value;
        config = sanitizeConfig(config);
    }

    function clearCache() {
        for (const key of persistIndex.keys()) store.remove(key);
        persistIndex.clear();
        memoryCache.clear();
        store.write('lt:cache:index', []);
        stats.cached = 0;
        // 作废在途请求的写入权限，否则旧结果又会把缓存写回来
        cacheEpoch++;
        debug('缓存已清空');
    }

    /** 清掉本页已译标记并重新扫描（设置变更 / 手动触发） */
    function retranslatePage() {
        if (!adapter) return;
        const cleared = (root, selector) => {
            root.querySelectorAll(selector).forEach((el) => {
                removeBoxesFor(el);            // 先把译文还原成原文
                el.removeAttribute('data-lt-done');
                el.removeAttribute('data-lt-pending');
                visibility.stop(el);
            });
        };

        cleared(document, '[data-lt-done], [data-lt-pending]');
        for (const host of shadowHosts) {
            if (host.shadowRoot) cleared(host.shadowRoot, '[data-lt-done], [data-lt-pending]');
        }

        // 占位符是一次性替换的，重译时必须恢复原文，否则会停留在旧语言的译文上
        const placeholderRoots = [document, ...[...shadowHosts].map(h => h.shadowRoot).filter(Boolean)];
        for (const root of placeholderRoots) {
            root.querySelectorAll('[data-lt-ph-placeholder], [data-lt-ph-aria-placeholder]').forEach((el) => {
                for (const attr of ['placeholder', 'aria-placeholder']) {
                    const original = el.getAttribute(`data-lt-ph-${attr}`);
                    if (original === null) continue;
                    el.setAttribute(attr, original);
                    el.removeAttribute(`data-lt-ph-${attr}`);
                }
            });
        }

        scan(document.body);
    }

    /** 把页面上所有译文还原成原文（关闭翻译时用） */
    function restoreAllTranslations() {
        const roots = [document, ...[...shadowHosts].map(host => host.shadowRoot).filter(Boolean)];
        for (const root of roots) {
            root.querySelectorAll('.lt-anchor').forEach((element) => {
                // 先还原原文；随后去掉图标，彻底回到未接管状态
                restoreElement(element);
            });
        }
    }

    /* #endregion */

    /* #region 启动 */

    let siteObserver = null;
    let clickBound = false;

    function startObserver() {
        if (siteObserver || !adapter) return;
        siteObserver = new MutationObserver(onMutations);
        siteObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('⚙️ 翻译设置 / Settings', openPanel);
        GM_registerMenuCommand('🔁 重译本页 / Retranslate', () => {
            retranslatePage();
            toast('已重新翻译 / Retranslating');
        });
        GM_registerMenuCommand('🧹 清空翻译缓存 / Clear cache', () => {
            clearCache();
            toast('缓存已清空 / Cache cleared');
        });
        GM_registerMenuCommand('🌓 切换主题 / Toggle theme', () => {
            config.theme = config.theme === 'dark' ? 'light' : config.theme === 'light' ? 'auto' : 'dark';
            applyTheme();
            saveConfig();
            toast(`主题 / Theme: ${config.theme}`);
        });
    }

    function init() {
        if (!adapter) {
            debug('当前站点无需处理', location.hostname);
            return;
        }

        ensureDocumentStyle();
        applyTheme();
        loadPersistIndex();

        startObserver();
        scan(document.body);

        if (SITE === SITES.twitter) {
            if (!clickBound) {
                clickBound = true;
                document.addEventListener('click', handleTwitterClick, true);
            }
            if (forceSearchLatest()) return;
            scheduleTimelineSort();
        }

        registerMenus();
        window.addEventListener('pagehide', flushPersistIndex);

        if (DEBUG) {
            window.__lt = { config, stats, cache: memoryCache, queue, retranslatePage, clearCache };
        }
        console.log(`${LOG_PREFIX} v${VERSION} 已启动 @ ${SITE.name}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    /* #endregion */
})();

// ==UserScript==
// @name         GitHub 高速下载
// @namespace    https://github.com/wxmyyds
// @version      4.4.1
// @description  GitHub 下载加速：Release文件、源码包、Raw文件一键提速
// @author       wxmyyds
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @homepageURL  https://github.com/wxmyyds/UserScripts
// @supportURL   https://github.com/wxmyyds/UserScripts/issues
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ==================== 配置与规则 ==================== */
    const PROXY_LIST = [
        { url: 'https://ghfast.top/', name: '🚀 主镜像' },
        { url: 'https://gh-proxy.com/', name: '⚡ 备用1' },
        { url: 'https://moeyy.cn/gh-proxy/', name: '🛡️ 备用2' }
    ];

    const WHITE_LIST = [
        'github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com',
        'gist.github.com', 'codeload.github.com'
    ];

    const DOWNLOAD_PATTERNS = [
        '/releases/download/', 'github-production-release-asset', 'release-assets.githubusercontent.com',
        '/archive/', '/zipball/', '/tarball/', '/raw/', 'raw.githubusercontent.com'
    ];

    const EXT_PATTERNS = [
        '.zip', '.7z', '.rar', '.tar.gz', '.tgz', '.tar.xz', '.tar.bz2',
        '.exe', '.msi', '.deb', '.rpm', '.dmg', '.pkg', '.apk', '.appimage',
        '.iso', '.img', '.bin', '.jar', '.whl', '.nupkg'
    ];

    const SCAN_BATCH_LIMIT = 500;   // 单次扫描上限，防止超大页面卡顿
    const SCAN_DEBOUNCE_MS = 150;   // DOM 变动后的扫描去抖
    const SCAN_MAX_WAIT_MS = 2000;  // 持续变动时扫描最长推迟时间
    const PROBE_TIMEOUT_MS = 5000;  // 镜像测速超时

    /* ==================== 状态 ==================== */
    let currentProxyIndex = clampIndex(Number(GM_getValue('proxyIndex', 0)));
    let initialized = false;
    let mainObserver = null;
    let scanTimer = null;
    let scanning = false;
    let scanPending = false;
    let lastScanTime = 0;

    /* ==================== 工具函数 ==================== */

    function clampIndex(i) {
        return Number.isInteger(i) && i >= 0 && i < PROXY_LIST.length ? i : 0;
    }

    // 严格匹配域名，避免 includes() 误中形如 evil-github.com 的域名
    function isGithubHost(hostname) {
        return WHITE_LIST.some(d => hostname === d || hostname.endsWith('.' + d));
    }

    function hasDownloadExt(href) {
        const lower = href.toLowerCase();
        return EXT_PATTERNS.some(ext => lower.endsWith(ext));
    }

    function isDownloadLink(link) {
        try {
            const href = link.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;

            // 1. 白名单检查：确保是 GitHub 相关域名
            const urlObj = new URL(href, window.location.origin);
            if (!isGithubHost(urlObj.hostname)) return false;

            // 2. 已经是代理链接则跳过
            if (PROXY_LIST.some(p => href.startsWith(p.url))) return false;

            // 3. 排除 releases/tag/ 导航页（但允许以压缩包后缀结尾的直链）
            if (href.includes('/releases/tag/') && !href.includes('/download/') && !hasDownloadExt(href)) return false;

            // 4. 排除导航与查看逻辑
            if (href.includes('/blob/') && !urlObj.searchParams.has('raw')) return false;
            if (link.closest('nav, .AppHeader, .tabnav, .ActionList')) return false;

            // 5. 命中下载模式
            return DOWNLOAD_PATTERNS.some(p => href.includes(p)) || hasDownloadExt(href);
        } catch (e) { return false; }
    }

    /* ==================== 核心处理 ==================== */

    function applyProxy(link) {
        const original = link.getAttribute('data-original-href');
        const proxy = PROXY_LIST[currentProxyIndex].url;

        // 避免重复拼接
        link.href = original.startsWith(proxy) ? original : proxy + original;
        if (!link.hasAttribute('download')) link.setAttribute('download', '');
        link.setAttribute('data-accel-ready', '1');

        // 视觉提示
        if (!link.querySelector('.accel-mini')) {
            const mini = document.createElement('span');
            mini.className = 'accel-mini';
            mini.textContent = '⚡';
            mini.style.cssText = 'margin-left:2px;font-size:10px;opacity:.4;pointer-events:none;';
            link.appendChild(mini);
        }
    }

    function processLink(link) {
        try {
            if (!isDownloadLink(link)) {
                link.setAttribute('data-accel-skip', '1'); // 标记非下载链接，避免重复检测
                return;
            }

            // 存储原始 URL（只存一次，防止代理地址被二次拼接）
            if (!link.hasAttribute('data-original-href')) {
                const rawHref = link.getAttribute('href');
                let fullUrl = rawHref;
                if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl;
                else if (fullUrl.startsWith('/')) fullUrl = window.location.origin + fullUrl;
                link.setAttribute('data-original-href', fullUrl);
            }

            applyProxy(link);
        } catch (e) {
            console.debug('[GHDown] Error processing link:', e);
        }
    }

    function scanDownloadLinks() {
        if (scanning) { scanPending = true; return; } // 扫描进行中有新请求，结束后补扫

        const links = Array.prototype.slice.call(
            document.querySelectorAll('a[href]:not([data-accel-ready]):not([data-accel-skip])'),
            0, SCAN_BATCH_LIMIT
        );
        if (links.length === 0) return;

        scanning = true;
        lastScanTime = Date.now();
        let i = 0;

        const step = (deadline) => {
            while (i < links.length && (!deadline || deadline.timeRemaining() > 1)) {
                processLink(links[i++]);
            }
            if (i < links.length) {
                scheduleIdle(step); // 空闲时间不足时分片续扫，防止链接被丢弃（修复旧版缺陷）
            } else {
                scanning = false;
                if (scanPending) { scanPending = false; scanDownloadLinks(); }
            }
        };
        scheduleIdle(step);
    }

    function scheduleIdle(cb) {
        if (window.requestIdleCallback) requestIdleCallback(cb, { timeout: 500 });
        else setTimeout(() => cb(null), 16);
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        // 连续 DOM 变动时也不能无限推迟扫描
        if (Date.now() - lastScanTime > SCAN_MAX_WAIT_MS) scanDownloadLinks();
        else scanTimer = setTimeout(scanDownloadLinks, SCAN_DEBOUNCE_MS);
    }

    /* ==================== 监听增强 ==================== */

    function setupObservers() {
        const startObserve = () => {
            if (mainObserver) mainObserver.disconnect();
            mainObserver = new MutationObserver((mutations) => {
                let meaningful = false;
                for (const m of mutations) {
                    if (m.type === 'attributes') {
                        // 页面改写了被跳过链接的 href：清除标记，重新检测
                        const el = m.target;
                        if (el instanceof HTMLAnchorElement && el.hasAttribute('data-accel-skip')) {
                            el.removeAttribute('data-accel-skip');
                            meaningful = true;
                        }
                        continue;
                    }
                    // childList：忽略脚本自身插入/移除 ⚡ 徽章造成的变动，避免自触发循环
                    const nodes = [...m.addedNodes, ...m.removedNodes];
                    if (nodes.some(n => n.nodeType === 1 && !n.classList?.contains('accel-mini'))) {
                        meaningful = true;
                        break;
                    }
                }
                if (meaningful) scheduleScan();
            });
            if (document.body) {
                mainObserver.observe(document.body, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['href']
                });
            }
        };

        // 监听 Body 替换（应对某些极端的 SPA 框架行为）
        const rootObserver = new MutationObserver(() => {
            if (document.body && (!mainObserver || !document.body.contains(mainObserver.target))) {
                startObserve();
                scanDownloadLinks();
            }
        });
        rootObserver.observe(document.documentElement, { childList: true });

        startObserve();

        // 兼容所有 GitHub 导航事件
        ['turbo:load', 'turbo:render', 'pjax:success', 'pjax:end'].forEach(event => {
            document.addEventListener(event, () => setTimeout(scanDownloadLinks, 200));
        });
    }

    /* ==================== 镜像切换与测速 ==================== */

    function resetAllLinks() {
        document.querySelectorAll('[data-accel-ready]').forEach(el => {
            el.removeAttribute('data-accel-ready');
            if (el.hasAttribute('data-original-href')) {
                el.href = el.getAttribute('data-original-href');
            }
            const mini = el.querySelector('.accel-mini');
            if (mini) mini.remove();
        });
    }

    function switchProxy(index) {
        currentProxyIndex = index;
        GM_setValue('proxyIndex', index);
        resetAllLinks();
        scanDownloadLinks();
        console.log(`[GHDown] Switched to: ${PROXY_LIST[index].name}`);
    }

    function probe(url, index) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const start = performance.now();
        return fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal })
            .then(() => ({ index, ms: Math.round(performance.now() - start) }))
            .catch(() => ({ index, ms: Infinity }))
            .finally(() => clearTimeout(timer));
    }

    async function pickFastestProxy() {
        console.log('[GHDown] Probing mirrors...');
        const testFile = 'https://raw.githubusercontent.com/wxmyyds/UserScripts/main/LICENSE';
        const results = await Promise.all(PROXY_LIST.map((p, i) => probe(p.url + testFile, i)));
        const reachable = results.filter(r => r.ms !== Infinity).sort((a, b) => a.ms - b.ms);
        if (!reachable.length) {
            console.warn('[GHDown] All mirrors unreachable, keeping current.');
            return;
        }
        switchProxy(reachable[0].index);
        console.log(`[GHDown] Fastest mirror: ${PROXY_LIST[reachable[0].index].name} (${reachable[0].ms}ms)`);
    }

    function registerMenus() {
        PROXY_LIST.forEach((proxy, index) => {
            GM_registerMenuCommand(`切换到: ${proxy.name}`, () => switchProxy(index));
        });
        GM_registerMenuCommand('🏁 自动选择最快镜像', pickFastestProxy);
    }

    /* ==================== 初始化 ==================== */

    function init() {
        if (initialized) return;
        initialized = true;

        scanDownloadLinks();
        setupObservers();
        registerMenus();
    }

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})();
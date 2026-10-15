// ==UserScript==
// @name         GitHub Release Asset Highlighter
// @namespace    https://github.com/wxmyyds
// @version      2.4.0
// @description  给 GitHub 发行版产物做高亮区分：架构(32/64位, x86/ARM/MIPS/PPC/s390x)、平台(Win/Mac/Linux/Android/BSD)、发行版(Arch/Debian/Fedora/openSUSE/Alpine/NixOS/Gentoo/Void/Solus/OpenWrt/Flatpak/Snap/AppImage/Archive)
// @author       wxmyyds
// @match        https://github.com/*
// @homepageURL  https://github.com/wxmyyds/GHDown
// @supportURL   https://github.com/wxmyyds/GHDown/issues
// @license      MIT
// @grant        GM_addStyle
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const DOWNLOAD_MARKER = '/releases/download/';
    const LINK_SELECTOR = `a[href*="${DOWNLOAD_MARKER}"]:not([data-ghra])`;
    const ROW_SELECTOR = '.Box-row, li';

    // 只在 Releases 页面生效。仓库首页/README、Issues、Code、gist 等页面
    // 同样可能出现 /releases/download/ 直链（README 里的固定下载按钮最常见），
    // 在那里加左边框/徽章属于误伤，必须按路径排除。
    // 覆盖：/owner/repo/releases、/releases/tag/<tag>、/releases/latest、
    //       /releases/expanded_assets/<tag>（产物列表是懒加载片段，路径同源）
    const RELEASE_PAGE_RE = /^\/[^/]+\/[^/]+\/releases(?:\/(?:tag\/[^/]+|latest|expanded_assets\/[^/]+))?\/?$/;
    let cachedPath = null;
    let cachedIsRelease = false;
    function isReleasePage() {
        const path = location.pathname;
        if (path !== cachedPath) {
            cachedPath = path;
            cachedIsRelease = RELEASE_PAGE_RE.test(path);
        }
        return cachedIsRelease;
    }

    // ==================== 配置 ====================
    // c/fg：浅色；cDark/fgDark：深色。徽章是实心 pill，
    // 深色下用更亮的底 + 深色字，保证在深色页面的对比度和观感。
    const PLATFORM = {
        windows: { label: 'Windows', c: '#0078D4', fg: '#fff',    cDark: '#2f81f7', fgDark: '#fff'    },
        linux:   { label: 'Linux',   c: '#E95420', fg: '#fff',    cDark: '#f05133', fgDark: '#fff'    },
        android: { label: 'Android', c: '#3DDC84', fg: '#052e16', cDark: '#238636', fgDark: '#fff'    },
        macos:   { label: 'MacOS',   c: '#6e7681', fg: '#fff',    cDark: '#8b949e', fgDark: '#0d1117' },
        freebsd: { label: 'FreeBSD', c: '#AB2B28', fg: '#fff',    cDark: '#E57373', fgDark: '#2D0605' },
        openbsd: { label: 'OpenBSD', c: '#E8B400', fg: '#111',    cDark: '#F5C518', fgDark: '#201A00' },
        netbsd: { label: 'NetBSD', c: '#D6542C', fg: '#fff',    cDark: '#F08A5D', fgDark: '#331104' },
        dragonfly: { label: 'DragonFly', c: '#2E7D6F', fg: '#fff', cDark: '#5BC8B4', fgDark: '#06302A' },
    };

    const ARCH_BADGE = {
        'ARM':       { k: 'arch-arm',   bg: '#047857', fg: '#fff',    bgDark: '#34d399', fgDark: '#052e1b' },
        'x86':       { k: 'arch-x86',   bg: '#9333EA', fg: '#fff',    bgDark: '#a78bfa', fgDark: '#2e1065' },
        '64-bit':    { k: 'arch-64',    bg: '#2563EB', fg: '#fff',    bgDark: '#60a5fa', fgDark: '#172554' },
        '32-bit':    { k: 'arch-32',    bg: '#D97706', fg: '#fff',    bgDark: '#fbbf24', fgDark: '#451a03' },
        'RISC-V':    { k: 'arch-riscv', bg: '#0D9488', fg: '#fff',    bgDark: '#2dd4bf', fgDark: '#042f2b' },
        'PPC':       { k: 'arch-ppc',   bg: '#BE123C', fg: '#fff',    bgDark: '#FDA4AF', fgDark: '#4C0519' },
        's390x':     { k: 'arch-s390x', bg: '#0F62FE', fg: '#fff',    bgDark: '#A6C8FF', fgDark: '#001D6C' },
        'MIPS':      { k: 'arch-mips',  bg: '#0E7490', fg: '#fff',    bgDark: '#67E8F9', fgDark: '#083344' },
        'Loong':     { k: 'arch-loong', bg: '#4F46E5', fg: '#fff',    bgDark: '#818cf8', fgDark: '#1e1b4b' },
        'Universal': { k: 'arch-univ',  bg: '#57534E', fg: '#fff',    bgDark: '#a8a29e', fgDark: '#1c1917' },
    };

    // label：徽章上显示的发行版/格式名；k：CSS 类名后缀。
    const PKG_BADGE = {
        arch:     { label: 'Arch',     k: 'pkg-arch',     bg: '#1793D1', fg: '#fff', bgDark: '#53c1f5', fgDark: '#082f49' },
        debian:   { label: 'Debian',   k: 'pkg-debian',   bg: '#D70A53', fg: '#fff', bgDark: '#f472a0', fgDark: '#4c0519' },
        fedora:   { label: 'Fedora',   k: 'pkg-fedora',   bg: '#294172', fg: '#fff', bgDark: '#7cb3e8', fgDark: '#0b2440' },
        suse:     { label: 'openSUSE', k: 'pkg-suse',     bg: '#73BA25', fg: '#1a2e05', bgDark: '#a3d65c', fgDark: '#16290a' },
        alpine:   { label: 'Alpine',   k: 'pkg-alpine',   bg: '#0D47A1', fg: '#fff', bgDark: '#6ea8f2', fgDark: '#0a2050' },
        nixos:    { label: 'NixOS',    k: 'pkg-nixos',    bg: '#5277C3', fg: '#fff', bgDark: '#a8c6f0', fgDark: '#1e2c55' },
        gentoo:   { label: 'Gentoo',   k: 'pkg-gentoo',   bg: '#54487A', fg: '#fff', bgDark: '#b3a8e0', fgDark: '#241f42' },
        void:     { label: 'Void',     k: 'pkg-void',     bg: '#478061', fg: '#fff', bgDark: '#7fc9a4', fgDark: '#0c2b1f' },
        solus:    { label: 'Solus',    k: 'pkg-solus',    bg: '#55606C', fg: '#fff', bgDark: '#a7b8c6', fgDark: '#1f2933' },
        openwrt:  { label: 'OpenWrt',  k: 'pkg-openwrt',  bg: '#0098C8', fg: '#fff', bgDark: '#5cd2f0', fgDark: '#083344' },
        flatpak:  { label: 'Flatpak',  k: 'pkg-flatpak',  bg: '#4A90D9', fg: '#fff', bgDark: '#8abdf0', fgDark: '#0d2742' },
        snap:     { label: 'Snap',     k: 'pkg-snap',     bg: '#77216F', fg: '#fff', bgDark: '#c184e0', fgDark: '#2d0a35' },
        appimage: { label: 'AppImage', k: 'pkg-appimage', bg: '#CA8A04', fg: '#111', bgDark: '#facc15', fgDark: '#422006' },
        tarball:  { label: 'Tarball',  k: 'pkg-tarball',  bg: '#4B5563', fg: '#fff', bgDark: '#9ca3af', fgDark: '#111827' },
        archive:  { label: 'Archive',  k: 'pkg-archive',  bg: '#78716C', fg: '#fff', bgDark: '#A8A29E', fgDark: '#1C1917' },
    };

    // ==================== 规则表（输入均为小写文件名） ====================
    // 用 (?<![a-z0-9]) / (?![a-z0-9]) 代替 \b，
    // 因为 \b 在 "_" 与字母之间不算边界，"x86_64" 会漏判。
    // 注意顺序：64 位规则必须在 32 位之前（x86 会是 x86_64 的子串）。
    const RE_ARCH = [
        [/aarch64|arm64|armv[89]/,                                          ['ARM', '64-bit']],
        [/armv[5-7]|(?<![a-z0-9])arm(?:hf|eabi)?(?![a-z0-9])/,              ['ARM', '32-bit']],
        [/(?<![a-z0-9])(?:amd64|x86[_-]?64|x64|win64|ia64)(?![a-z0-9])/,    ['x86', '64-bit']],
        [/(?<![a-z0-9])(?:i?[3-6]86|win32|ia32|(?<![a-z0-9])x86(?![a-z0-9]))(?![a-z0-9])/, ['x86', '32-bit']],
        [/riscv64/,                                                         ['RISC-V', '64-bit']],
        [/mips64(?:el|le)?|mipsn32/,                                        ['MIPS', '64-bit']],
        [/(?<![a-z0-9])mips(?:el|le)?(?![a-z0-9])/,                         ['MIPS', '32-bit']],
        [/ppc64(?:el|le)?|powerpc64/,                                       ['PPC', '64-bit']],
        [/(?<![a-z0-9])(?:ppc|powerpc)(?![a-z0-9])/,                        ['PPC', '32-bit']],
        [/s390x/,                                                           ['s390x', '64-bit']],
        [/loong(?:arch)?64/,                                                 ['Loong', '64-bit']],
        [/universal2?|fatbin/,                                               ['Universal']],
        [/64[_-]?bit/,                                                       ['64-bit']],
        [/32[_-]?bit/,                                                       ['32-bit']],
    ];

    const RE_PLATFORM = [
        // Alpine 的 .apk 与安卓 APK 同后缀：先按 alpine 标记 / -rN 修订号判为 Linux
        [/alpine|\d[\-_\s]r\d+(?![a-z0-9])[^/]*\.apk$/,                                    'linux'],
        [/android|\.apk$|\.aab$/,                                                        'android'],
        [/(?<![a-z0-9])mac(?:osx?)?(?![a-z0-9])|darwin|\.dmg$/,                           'macos'],
        [/(?<![a-z0-9])win(?:dows)?(?:32|64|11)?(?![a-z0-9])|\.(?:exe|msi|msix)$/,        'windows'],
        [/(?<![a-z0-9])freebsd\d*(?![a-z0-9])/,                                        'freebsd'],
        [/(?<![a-z0-9])openbsd\d*(?![a-z0-9])/,                                         'openbsd'],
        [/(?<![a-z0-9])netbsd\d*(?![a-z0-9])/,                                          'netbsd'],
        [/(?<![a-z0-9])dragonfly\d*(?![a-z0-9])/,                                       'dragonfly'],
        [/linux|archlinux|pacman|flatpak|nixos|nixpkgs|gentoo|alpine|openwrt|\.(?:deb|rpm|pacman|appimage|flatpak|flatpakref|snap|ebuild|xbps|ipk|eopkg|tar\.(?:gz|xz|bz2|zst)|t(?:gz|xz|bz2|zst)|tbz2?)$/, 'linux'],
    ];

    // 通用压缩包徽章（Tarball/Archive）：发行版无关。
    // detectAll 的逻辑：Linux/BSD 先查 RE_PKG_DISTRO，命中则返回发行版，
    // 未命中再回退到本表；无平台标记的文件名也查本表，保证纯压缩包至少有个格式徽章；
    // Windows/macOS/Android 不查，避免 .zip 安装包之类的噪音。
    const RE_PKG_GENERIC = [
        [/\.(?:tar\.(?:gz|xz|bz2|zst)|t(?:gz|xz|bz2|zst)|tbz2?)$/, 'tarball'],
        // 裸 .gz/.xz 等单层压缩包（mihomo 这类 go 项目常用）：归为通用 Archive
        [/\.(?:zip|7z|rar|gz|bz2|xz|zst|lz4)$/, 'archive'],
    ];
    // 发行版徽章：顺序即优先级。文件名带发行版标记的优先命中；
    // 裸 .rpm 无法区分归属，按最常见的 Fedora 系兜底（openSUSE 系已在前面按标记分流）。
    const RE_PKG_DISTRO = [
        [/\.pkg\.tar\.(?:zst|xz|gz)$|\.pacman$|archlinux|(?<![a-z0-9])arch(?!-linux-gnu)(?![a-z0-9])/, 'arch'],
        [/\.deb$|debian|ubuntu|(?<![a-z0-9])mint(?![a-z0-9])|(?<![a-z0-9])pop[_\-]?os(?![a-z0-9])|raspbian|(?<![a-z0-9])kali(?![a-z0-9])/, 'debian'],
        [/opensuse|(?<![a-z0-9])suse(?![a-z0-9])|sles|tumbleweed|(?<![a-z0-9])leap(?![a-z0-9])/, 'suse'],
        [/fedora|(?<![a-z0-9])rhel(?![a-z0-9])|red[_\-]?hat|centos|rocky|(?<![a-z0-9])alma(?:linux)?(?![a-z0-9])|oraclelinux|amazonlinux|\.rpm$/, 'fedora'],
        [/alpine|\d[\-_\s]r\d+(?![a-z0-9])[^/]*\.apk$|\.apk$/,                            'alpine'],
        [/nixos|nixpkgs|(?<![a-z0-9])nix(?![a-z0-9])/,                                     'nixos'],
        [/gentoo|\.ebuild$/,                                                              'gentoo'],
        [/(?<![a-z0-9])void(?![a-z0-9])|\.xbps$/,                                          'void'],
        [/(?<![a-z0-9])solus(?![a-z0-9])|\.eopkg$/,                                        'solus'],
        [/openwrt|\.ipk$/,                                                                'openwrt'],
        [/flatpak|\.flatpak(?:ref)?$/,                                                    'flatpak'],
        [/(?<![a-z0-9])snap(?![a-z0-9])|\.snap$/,                                          'snap'],
        [/\.appimage$/,                                                                   'appimage'],
    ];
    const RE_PKG = RE_PKG_DISTRO.concat(RE_PKG_GENERIC);

    // ==================== 检测（一次遍历返回全部结果） ====================
    function firstMatch(rules, s) {
        for (let i = 0; i < rules.length; i++) {
            if (rules[i][0].test(s)) return rules[i][1];
        }
        return null;
    }

    function detectAll(s) {
        const platform = firstMatch(RE_PLATFORM, s);
        const arch = firstMatch(RE_ARCH, s);
        // 发行版徽章只对 Linux/BSD 有意义；无平台标记的纯压缩包回退给 Tarball/Archive 通用徽章；
        // Windows/macOS/Android 不查，避免 .zip 安装包之类的噪音
        const pkg = platform
            ? (platform === 'windows' || platform === 'macos' || platform === 'android'
                ? null : firstMatch(RE_PKG, s))
            : firstMatch(RE_PKG_GENERIC, s);
        return { platform, arch, pkg };
    }

    // ==================== 样式（只注入一次） ====================
    // 深浅色：GitHub 用 html[data-color-mode] 标记主题（light/dark/auto 跟随系统），
    // 徽章/标签全部走 CSS 类 + CSS 变量，由 html 属性自动切换，
    // 无需 JS 监听主题、无需给每个徽章写行内 style。
    // dark 直接命中；auto 时再看系统 prefers-color-scheme。
    const DARK_HTML = 'html[data-color-mode="dark"]';
    const AUTO_HTML = 'html[data-color-mode="auto"]';

    function darkRule(selector, body) {
        return `        ${DARK_HTML} ${selector} { ${body} }\n` +
            `        @media (prefers-color-scheme: dark) {\n` +
            `            ${AUTO_HTML} ${selector} { ${body} }\n` +
            `        }\n`;
    }

    function badgeVars(map) {
        let s = '';
        let d = '';
        for (const key of Object.keys(map)) {
            const b = map[key];
            s += `        .ghra-${b.k} { --ghra-bg: ${b.bg}; --ghra-fg: ${b.fg}; }\n`;
            d += darkRule(`.ghra-${b.k}`, `--ghra-bg: ${b.bgDark}; --ghra-fg: ${b.fgDark};`);
        }
        return s + d;
    }

    function platformVars() {
        let s = '';
        let d = '';
        for (const key of Object.keys(PLATFORM)) {
            const p = PLATFORM[key];
            s += `        .ghra-pt-${key} { --ghra-bg: ${p.c}; --ghra-fg: ${p.fg}; }\n`;
            d += darkRule(`.ghra-pt-${key}`, `--ghra-bg: ${p.cDark}; --ghra-fg: ${p.fgDark};`);
        }
        return s + d;
    }

    function rowVars() {
        let s = '';
        let d = '';
        for (const key of Object.keys(PLATFORM)) {
            s += `        .ghra-platform-${key} { --ghra-row: ${PLATFORM[key].c}; }\n`;
            d += darkRule(`.ghra-platform-${key}`, `--ghra-row: ${PLATFORM[key].cDark};`);
        }
        return s + d;
    }

    const CSS = `
        .ghra-row { padding-left: 8px !important; transition: filter .15s; }
        .ghra-row:hover { filter: brightness(.97); }
        ${darkRule('.ghra-row:hover', 'filter: brightness(1.15);')}
        .ghra-platform-windows,
        .ghra-platform-linux,
        .ghra-platform-android,
        .ghra-platform-macos,
        .ghra-platform-freebsd,
        .ghra-platform-openbsd,
        .ghra-platform-netbsd,
        .ghra-platform-dragonfly { border-left: 4px solid var(--ghra-row) !important; }
${rowVars()}
        .ghra-platform-tag,
        .ghra-badge {
            display: inline-block;
            font-size: 11px;
            font-weight: 600;
            padding: 1px 6px;
            border-radius: 10px;
            vertical-align: middle;
            line-height: 1.6;
            white-space: nowrap;
            letter-spacing: .02em;
            background: var(--ghra-bg);
            color: var(--ghra-fg);
        }
        .ghra-platform-tag {
            padding-left: 8px;
            padding-right: 8px;
            margin-right: 8px;
        }
${platformVars()}${badgeVars(ARCH_BADGE)}${badgeVars(PKG_BADGE)}
        .ghra-badge-wrap {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            margin-left: 6px;
            vertical-align: middle;
            /* 避免划词/悬停翻译插件误抓 */
            pointer-events: none;
        }
    `;

    if (typeof GM_addStyle === 'function') {
        GM_addStyle(CSS);
    } else {
        const style = document.createElement('style');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ==================== DOM 工具 ====================
    function makeEl(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text != null) el.textContent = text;
        // 阻止翻译插件改写（多种标记一次加全）
        el.setAttribute('translate', 'no');
        el.classList.add('notranslate');
        el.setAttribute('data-notranslate', 'true');
        return el;
    }

    function makeBadge(text, cfg) {
        return makeEl('span', 'ghra-badge ghra-' + cfg.k, text);
    }

    function makePlatformTag(platform) {
        const cfg = PLATFORM[platform];
        return makeEl('span', 'ghra-platform-tag ghra-pt-' + platform, cfg.label);
    }

    function getFilename(linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const i = href.indexOf(DOWNLOAD_MARKER);
        if (i !== -1) {
            const rest = href.slice(i + DOWNLOAD_MARKER.length);
            const slash = rest.indexOf('/');
            if (slash !== -1) {
                const name = rest.slice(slash + 1).split(/[?#]/, 1)[0];
                try { return decodeURIComponent(name); }
                catch (_) { return name; }
            }
        }
        return (linkEl.textContent || '').trim();
    }

    function findRow(linkEl) {
        return linkEl.closest(ROW_SELECTOR) || linkEl.parentElement;
    }

    function decorateRow(row, platform, linkEl) {
        row.classList.add('ghra-row');
        if (!platform) return;
        // 同一行多链接时：第一个无平台的链接先占位，后续有平台的链接补上标签
        if (row.dataset.ghraPlatform) return;
        row.dataset.ghraPlatform = platform;
        row.classList.add('ghra-platform-' + platform);
        const container = linkEl.closest('.d-flex') || row;
        container.insertBefore(makePlatformTag(platform), container.firstChild);
    }

    // ==================== 单条处理 ====================
    function processLink(linkEl) {
        if (linkEl.dataset.ghra) return;
        linkEl.dataset.ghra = '1'; // 先标记，避免异常重试时重复插入

        const filename = getFilename(linkEl);
        if (!filename) return;

        const { platform, arch, pkg } = detectAll(filename.toLowerCase());

        const row = findRow(linkEl);
        if (row) decorateRow(row, platform, linkEl);

        if (!arch && !pkg) return;

        const wrap = makeEl('span', 'ghra-badge-wrap');
        if (arch) {
            for (const t of arch) {
                const c = ARCH_BADGE[t];
                if (c) wrap.appendChild(makeBadge(t, c));
            }
        }
        if (pkg) {
            const c = PKG_BADGE[pkg];
            if (c) wrap.appendChild(makeBadge(c.label, c));
        }
        if (wrap.childNodes.length) {
            linkEl.insertAdjacentElement('afterend', wrap);
        }
    }

    // ==================== 扫描与调度 ====================
    function scanRoot(root) {
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        // root 本身可能就是链接（observer 增量路径）
        if (root.nodeType === 1 && typeof root.matches === 'function' && root.matches(LINK_SELECTOR)) {
            processLink(root);
        }
        const links = root.querySelectorAll ? root.querySelectorAll(LINK_SELECTOR) : null;
        if (links) for (const link of links) processLink(link);
    }

    function scanAll() {
        if (!isReleasePage()) return;
        scanRoot(document);
    }

    // observer 已做批量合并，这里只需 rAF 合并同一帧内的多次回调；
    // 后台标签页 rAF 被节流时用 setTimeout 兜底。
    let scheduled = false;
    function scheduleScan() {
        if (scheduled) return;
        scheduled = true;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            scheduled = false;
            scanAll();
        };
        if (typeof requestAnimationFrame === 'function' && !document.hidden) {
            requestAnimationFrame(run);
        }
        setTimeout(run, 80);
    }

    // 增量处理：只扫描新增子树，忽略自己插入的徽章节点。
    // 注意：单条记录内可能既有链接又有徽章节点，不能遇到徽章就 continue 整条，
    // 必须逐节点判断；徽章节点本身不含下载链接，天然不会触发扫描。
    function handleMutations(records) {
        // 非 Releases 页面完全不做增量扫描（README/Issues 里的直链不处理），
        // 但 observer 仍需存活：Turbo 导航到 Releases 后可立即接管。
        if (!isReleasePage()) return;
        for (const r of records) {
            const added = r.addedNodes;
            for (let i = 0; i < added.length; i++) {
                const node = added[i];
                if (node.nodeType !== 1 || typeof node.matches !== 'function') continue;
                if (node.matches(LINK_SELECTOR) ||
                    (node.querySelector && node.querySelector(LINK_SELECTOR))) {
                    scheduleScan();
                    return;
                }
            }
        }
    }

    // ==================== 初始化 ====================
    function init() {
        scanAll();

        // 观察 documentElement：Turbo 替换 body 也不会失效；
        // 回调内过滤新增节点，自身插入的徽章不会触发重扫。
        const observer = new MutationObserver(handleMutations);
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // Turbo SPA 导航：load/render 已覆盖绝大多数场景，popstate 兜底
        const onNav = () => {
            scheduleScan();
            setTimeout(scheduleScan, 400);
        };
        for (const ev of ['turbo:load', 'turbo:render', 'popstate']) {
            document.addEventListener(ev, onNav);
        }
        window.addEventListener('popstate', onNav);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

# UserScripts 仓库

我的个人 GreasyFork 用户脚本合集，每个脚本一个独立目录。

## 📦 脚本列表

| 脚本 | 说明 | 安装 |
| --- | --- | --- |
| [GitHub 高速下载](GHDown/GHDown.user.js) | GitHub 下载加速：Release 文件、源码包、Raw 文件一键提速，支持多镜像切换 | [GreasyFork](https://greasyfork.org/scripts/568823) / [源码](https://raw.githubusercontent.com/wxmyyds/UserScripts/main/GHDown/GHDown.user.js) |
| [GitHub Release Asset Highlighter](github-release-asset-highlighter/github-release-asset-highlighter.user.js) | 给 GitHub Release 产物按架构、平台、发行版做高亮徽章区分（仅在 Releases 页面生效） | 暂无 / [源码](https://raw.githubusercontent.com/wxmyyds/UserScripts/main/github-release-asset-highlighter/github-release-asset-highlighter.user.js) |
| [X/Twitter & Discord 实时翻译](lang-translate/lang-translate.user.js) | X/Twitter、Discord、Patreon、Ko-fi 实时翻译：用译文替换原文，右下角图标显示进度（翻译中旋转 / 失败黄色感叹号），点图标切换原文与译文 | 暂无 / [源码](https://raw.githubusercontent.com/wxmyyds/UserScripts/main/lang-translate/lang-translate.user.js) |

## 📥 安装方法

1. 安装浏览器用户脚本管理器（推荐 [Tampermonkey](https://www.tampermonkey.net/)）
2. 打开上表中任意脚本的 **源码** 链接安装，或直接从 GreasyFork 页面安装
3. 脚本自动生效

## 🗂️ 目录结构

```
├── GHDown/                          # GitHub 高速下载
│   └── GHDown.user.js
├── github-release-asset-highlighter/ # Release 产物高亮
│   └── github-release-asset-highlighter.user.js
├── lang-translate/                  # X/Twitter & Discord 实时翻译
│   └── lang-translate.user.js
└── README.md
```

## 🔄 更新维护

- 本仓库为唯一源码，脚本代码以此为准
- 已发布到 GreasyFork 的脚本，发布新版本时需同步更新 GreasyFork
- 问题反馈请到 [Issues](https://github.com/wxmyyds/UserScripts/issues)

## 📄 开源协议

[MIT](LICENSE) © wxmyyds
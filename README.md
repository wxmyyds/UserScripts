# UserScripts 仓库

我的个人 GreasyFork 用户脚本合集，每个脚本一个独立目录。

## 📦 脚本列表

| 脚本 | 说明 | 安装 |
| --- | --- | --- |
| [GitHub 高速下载](GHDown/GHDown.user.js) | GitHub 下载加速：Release 文件、源码包、Raw 文件一键提速，支持多镜像切换 | [GreasyFork](https://greasyfork.org/) / [源码](https://raw.githubusercontent.com/wxmyyds/GHDown/main/GHDown/GHDown.user.js) |
| [GitHub Release Asset Highlighter](github-release-asset-highlighter/github-release-asset-highlighter.user.js) | 给 GitHub Release 产物按架构、平台、发行版做高亮徽章区分（仅在 Releases 页面生效） | [GreasyFork](https://greasyfork.org/) / [源码](https://raw.githubusercontent.com/wxmyyds/GHDown/main/github-release-asset-highlighter/github-release-asset-highlighter.user.js) |

## 📥 安装方法

1. 安装浏览器用户脚本管理器（推荐 [Tampermonkey](https://www.tampermonkey.net/)）
2. 打开上表中任意脚本的 **源码** 链接，或通过 GreasyFork 页面安装
3. 脚本自动生效

## 🗂️ 目录结构

```
├── GHDown/                          # GitHub 高速下载
│   └── GHDown.user.js
├── github-release-asset-highlighter/ # Release 产物高亮
│   └── github-release-asset-highlighter.user.js
└── README.md
```

## 🔄 更新维护

- 脚本代码与 GreasyFork 发布版保持同步，以本仓库为源码
- 问题反馈请到 [Issues](https://github.com/wxmyyds/GHDown/issues)

## 📄 开源协议

[MIT](LICENSE) © wxmyyds
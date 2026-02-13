# RedKit - 小红书笔记内容&评论下载器

![Version](https://img.shields.io/badge/version-1.2-red.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

**RedKit** 是一个基于 Tampermonkey (油猴脚本) 开发的轻量级、高效的小红书网页端数据提取与素材下载工具。它旨在帮助自媒体运营人员和内容创作者快速采集爆款笔记数据，支持评论抓取、媒体打包下载及基于 AI 的内容分析。

## 🚀 核心功能

- **📝 笔记详情采集**：一键提取标题、正文、标签、互动数据（点赞/收藏/评论数）、IP 属地及发布日期。
- **💬 全量评论爬取**：支持自动滚动加载主评论及子评论（回复），并保持层级关联。
- **📥 素材逐个下载**：自动识别笔记内的高清图片与视频，支持一键触发浏览器原生下载。
- **📋 复制素材链接**：一键提取所有高清素材地址，方便配合 IDM 等工具使用。
- **🔍 搜索结果抓取**：在搜索结果页批量提取可见笔记的基础信息及链接。
- **📊 结构化导出**：支持将所有提取的数据导出为兼容 Excel 的 CSV 报表。

## 🛠️ 技术栈

- **引擎**：Tampermonkey
- **语言**：Vanilla JavaScript
- **请求**：`GM_xmlhttpRequest` (跨域支持)

## 📦 安装与使用

### 方式 A：通过 URL 自动安装 (推荐)
1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。
2. 点击下方链接，并在弹出的油猴界面点击“安装”：
   [点击安装 RedKit 下载器](https://raw.githubusercontent.com/wuhongchen/RedKit/main/xhs_downloader.user.js)

### 方式 B：手动安装
1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 创建新脚本，将 `xhs_downloader.user.js` 的内容复制进去并保存。

### 使用方法
1. 访问 [小红书网页版](https://www.xiaohongshu.com/)。
2. 在页面详情页或搜索页右下角找到控制面板即可开始使用。

## 🗺️ 路线图 (Roadmap)

- [ ] **自动化互动**：集成自动点赞、收藏功能（基于 `indai.js`）。
- [ ] **多页面连抓**：支持在搜索页自动翻页并持续采集。
- [ ] **数据云同步**：将采集的数据同步至个人云端数据库。

## 📄 开源协义

本项目基于 [MIT License](LICENSE) 协议。

---
*本项目仅供学习和研究使用，请遵守小红书平台相关协议。*

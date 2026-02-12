// ==UserScript==
// @name         小红书笔记内容&评论下载器
// @namespace    https://github.com/wuhongchen/RedKit
// @version      1.2
// @description  在小红书笔记详情页一键提取帖子内容、评论，导出 CSV 表格，或打包下载全部图片/视频素材。
// @author       whc
// @match        https://www.xiaohongshu.com/explore*
// @match        https://www.xiaohongshu.com/search_result*
// @icon         https://fe-video-qc.xhscdn.com/fe-platform/ed8fe781ce9e16c1bfac2cd962f0721edabe2e49.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ========== 工具函数 ==========
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 封装 GM_xmlhttpRequest 为 Promise，用于跨域请求
    function gmFetch(url) {
        return new Promise((resolve, reject) => {
            if (!url) return reject(new Error('Empty URL'));

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                timeout: 15000, // 增加超时控制
                onload: (res) => {
                    if (res.status === 200) {
                        resolve(res.response);
                    } else {
                        reject(new Error(`HTTP ${res.status} for ${url}`));
                    }
                },
                onerror: (err) => {
                    console.error('[XHS-DL] Network Error:', err, url);
                    reject(new Error('Network Error'));
                },
                ontimeout: () => {
                    console.error('[XHS-DL] Request Timeout:', url);
                    reject(new Error('Timeout'));
                }
            });
        });
    }

    // 将小红书相对时间转换为精确的 YYYY-MM-DD HH:mm:ss
    function parseXHSTime(rawText) {
        if (!rawText) return '';
        const text = rawText.trim();
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) =>
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        // "刚刚"
        if (text === '刚刚') return fmt(now);

        // "X分钟前"
        let m = text.match(/^(\d+)\s*分钟前/);
        if (m) { now.setMinutes(now.getMinutes() - parseInt(m[1])); return fmt(now); }

        // "X小时前"
        m = text.match(/^(\d+)\s*小时前/);
        if (m) { now.setHours(now.getHours() - parseInt(m[1])); return fmt(now); }

        // "X天前"
        m = text.match(/^(\d+)\s*天前/);
        if (m) { now.setDate(now.getDate() - parseInt(m[1])); return fmt(now); }

        // "今天 08:10" (可能带地区，如 "今天 08:10 北京")
        m = text.match(/^今天\s+(\d{1,2}):(\d{2})/);
        if (m) {
            now.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
            return fmt(now);
        }

        // "昨天 20:33"
        m = text.match(/^昨天\s+(\d{1,2}):(\d{2})/);
        if (m) {
            now.setDate(now.getDate() - 1);
            now.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
            return fmt(now);
        }

        // "前天 14:05"
        m = text.match(/^前天\s+(\d{1,2}):(\d{2})/);
        if (m) {
            now.setDate(now.getDate() - 2);
            now.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
            return fmt(now);
        }

        // "01-15" 或 "01-15 08:10" (当年，月-日)
        m = text.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
        if (m && !text.match(/^\d{4}-/)) {
            const d = new Date(now.getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]),
                m[3] ? parseInt(m[3]) : 0, m[4] ? parseInt(m[4]) : 0, 0);
            // 如果日期在未来，说明是去年
            if (d > now) d.setFullYear(d.getFullYear() - 1);
            return fmt(d);
        }

        // "2025-01-15" 或 "2025-01-15 08:10"
        m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
        if (m) {
            const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
                m[4] ? parseInt(m[4]) : 0, m[5] ? parseInt(m[5]) : 0, 0);
            return fmt(d);
        }

        // "X周前"
        m = text.match(/^(\d+)\s*周前/);
        if (m) { now.setDate(now.getDate() - parseInt(m[1]) * 7); return fmt(now); }

        // "X个月前"
        m = text.match(/^(\d+)\s*个?月前/);
        if (m) { now.setMonth(now.getMonth() - parseInt(m[1])); return fmt(now); }

        // "X年前"
        m = text.match(/^(\d+)\s*年前/);
        if (m) { now.setFullYear(now.getFullYear() - parseInt(m[1])); return fmt(now); }

        // 无法识别，返回原始文本
        return text;
    }

    // ========== 状态管理 ==========
    const state = {
        noteData: null,   // 当前提取的笔记数据
        comments: [],     // 当前提取的评论列表
        searchResults: [], // 搜索页提取的笔记列表
        isExtracting: false,
    };

    // 判断所在页面
    const isSearchPage = () => window.location.href.includes('/search_result');
    const isExplorePage = () => window.location.href.includes('/explore');

    // ========== UI 模块 ==========
    function createUI() {
        // 主面板容器
        const panel = document.createElement('div');
        panel.id = 'xhs-dl-panel';
        panel.innerHTML = `
      <style>
        #xhs-dl-panel {
          position: fixed; right: 20px; bottom: 80px; z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px; user-select: none;
        }
        #xhs-dl-toggle {
          width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
          background: linear-gradient(135deg, #ff2442 0%, #ff6a00 100%);
          color: #fff; font-size: 12px; font-weight: 700;
          box-shadow: 0 4px 15px rgba(255,36,66,.4);
          display: flex; align-items: center; justify-content: center;
          transition: transform .2s, box-shadow .2s;
        }
        #xhs-dl-toggle:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(255,36,66,.55); }
        #xhs-dl-menu {
          display: none; position: absolute; right: 0; bottom: 62px;
          background: #fff; border-radius: 14px;
          box-shadow: 0 8px 32px rgba(0,0,0,.15); padding: 14px; width: 210px;
        }
        #xhs-dl-menu.show { display: block; }
        #xhs-dl-menu h3 {
          margin: 0 0 10px; font-size: 14px; color: #333;
          border-bottom: 1px solid #eee; padding-bottom: 8px;
        }
        .xdl-btn {
          display: block; width: 100%; padding: 9px 0; margin: 6px 0;
          border: none; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 600; transition: all .15s;
        }
        .xdl-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
        .xdl-btn.primary { background: linear-gradient(135deg,#ff2442,#ff6a00); color:#fff; }
        .xdl-btn.secondary { background: #f0f0f0; color: #333; }
        .xdl-btn.success { background: linear-gradient(135deg,#00c853,#00e676); color:#fff; }
        .xdl-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
        #xdl-status {
          margin-top: 10px; padding: 8px; border-radius: 8px;
          background: #f8f8f8; color: #666; font-size: 12px;
          max-height: 80px; overflow-y: auto; line-height: 1.5;
          display: none;
        }
        #xdl-status.show { display: block; }
      </style>

      <div id="xhs-dl-menu">
        <h3>📥 笔记下载器</h3>
        <div id="xdl-detail-tools" style="${isExplorePage() ? '' : 'display:none'}">
          <button class="xdl-btn primary"   id="xdl-extract-note">📝 提取笔记内容</button>
          <button class="xdl-btn primary"   id="xdl-extract-comments">💬 提取全部评论</button>
          <button class="xdl-btn secondary" id="xdl-download-media">📦 打包下载素材</button>
        </div>
        <div id="xdl-search-tools" style="${isSearchPage() ? '' : 'display:none'}">
          <button class="xdl-btn primary"   id="xdl-extract-search">🔍 抓取搜索结果</button>
        </div>
        <button class="xdl-btn success"   id="xdl-export-csv" style="margin-top:10px;">📊 导出 CSV 表格</button>
        <div id="xdl-status"></div>
      </div>
      <button id="xhs-dl-toggle">笔记<br>下载</button>
    `;
        document.body.appendChild(panel);

        // 面板展开/收起
        document.getElementById('xhs-dl-toggle').onclick = () => {
            document.getElementById('xhs-dl-menu').classList.toggle('show');
        };

        // 按钮绑定
        if (document.getElementById('xdl-extract-note')) document.getElementById('xdl-extract-note').onclick = extractNote;
        if (document.getElementById('xdl-extract-comments')) document.getElementById('xdl-extract-comments').onclick = extractComments;
        if (document.getElementById('xdl-extract-search')) document.getElementById('xdl-extract-search').onclick = extractSearchResults;
        document.getElementById('xdl-export-csv').onclick = exportCSV;
        document.getElementById('xdl-download-media').onclick = downloadMedia;
    }

    // 状态更新
    function setStatus(msg) {
        const el = document.getElementById('xdl-status');
        if (el) {
            el.textContent = msg;
            el.classList.add('show');
        }
        console.log('[XHS-DL]', msg);
    }

    // ========== 笔记内容提取 ==========
    async function extractNote() {
        const container = document.querySelector('#noteContainer');
        if (!container) {
            setStatus('❌ 未检测到笔记详情，请先打开一篇笔记');
            return;
        }

        setStatus('⏳ 正在提取笔记内容...');

        // 提取笔记ID（从URL）
        const urlMatch = window.location.href.match(/\/explore\/([a-f0-9]+)/);
        const noteId = urlMatch ? urlMatch[1] : 'unknown';

        // 标题
        const titleEl = document.querySelector('#detail-title');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // 正文
        const descEl = document.querySelector('#detail-desc');
        const desc = descEl ? descEl.innerText.trim() : '';

        // 标签（从正文中提取 # 标签）
        const tagEls = descEl ? descEl.querySelectorAll('a.tag, a[href*="search_result"]') : [];
        const tags = Array.from(tagEls).map((t) => t.innerText.trim()).filter(Boolean);

        // 图片（高清URL）— 从 swiper 幻灯片和媒体容器中提取
        const imgEls = document.querySelectorAll(
            '.media-container .swiper-slide img, .note-content img, #noteContainer .note-slider-img'
        );
        const images = Array.from(imgEls)
            .map((img) => {
                // 优先取原始高清地址
                let src = img.getAttribute('data-origin-src')
                    || img.getAttribute('data-src')
                    || img.src
                    || '';
                // 去掉 imageView2 等压缩参数，获取最高分辨率
                src = src.split('?')[0];
                return src;
            })
            .filter((s) => s && (s.includes('xhscdn') || s.includes('sns-img') || s.includes('sns-webpic')))
            // 去重（同一张图可能出现多次）
            .filter((v, i, a) => a.indexOf(v) === i);

        // 视频
        const videoEl = document.querySelector('.media-container video, .note-content video, #noteContainer video');
        const video = videoEl ? (videoEl.src || videoEl.querySelector('source')?.src || '') : '';

        // 作者
        const authorEl = document.querySelector('.author-wrapper .name, .author-wrapper a');
        const author = authorEl ? authorEl.innerText.trim() : '';

        // 互动数据
        const engageBar = document.querySelector('.engage-bar');
        let likes = '', collects = '', commentsCount = '';
        if (engageBar) {
            const spans = engageBar.querySelectorAll('.count, span[class*="count"]');
            const likeBtn = engageBar.querySelector('.like-wrapper .count, .like-wrapper span');
            const collectBtn = engageBar.querySelector('.collect-wrapper .count, .collect-wrapper span');
            const commentBtn = engageBar.querySelector('.chat-wrapper .count, .chat-wrapper span');
            likes = likeBtn ? likeBtn.innerText.trim() : '';
            collects = collectBtn ? collectBtn.innerText.trim() : '';
            commentsCount = commentBtn ? commentBtn.innerText.trim() : '';
        }

        // 发布日期
        const dateEl = document.querySelector('#noteContainer .date, #noteContainer .bottom-container .date');
        const publishDate = dateEl ? dateEl.innerText.trim() : '';

        // IP 属地
        const ipEl = document.querySelector('#noteContainer .ip-container, #noteContainer .location');
        const ipLocation = ipEl ? ipEl.innerText.trim() : '';

        state.noteData = {
            noteId,
            title,
            desc,
            tags,
            images,
            video,
            author,
            likes,
            collects,
            commentsCount,
            publishDate,
            ipLocation,
            extractedAt: new Date().toISOString(),
            url: window.location.href,
        };

        setStatus(
            `✅ 笔记提取完成！\n📝 标题：${title.substring(0, 30)}...\n🖼️ 图片：${images.length} 张\n❤️ 点赞：${likes} | ⭐ 收藏：${collects}`
        );
    }

    // ========== 评论批量提取 ==========
    async function extractComments() {
        const container = document.querySelector('#noteContainer');
        if (!container) {
            setStatus('❌ 未检测到笔记详情，请先打开一篇笔记');
            return;
        }

        if (state.isExtracting) {
            setStatus('⚠️ 正在提取中，请稍候...');
            return;
        }

        state.isExtracting = true;
        state.comments = [];
        setStatus('⏳ 开始提取评论，自动滚动加载中...');

        const scroller = document.querySelector('.note-scroller');
        if (!scroller) {
            setStatus('❌ 未找到评论滚动区域');
            state.isExtracting = false;
            return;
        }

        // 已收集的评论ID集合（用于去重）
        const seenSet = new Set();
        let noNewCount = 0;
        const MAX_NO_NEW = 5; // 连续5次没有新评论就停止

        while (noNewCount < MAX_NO_NEW) {
            // 提取当前可见的评论
            const commentEls = document.querySelectorAll('.comments-el .parent-comment, .comments-el .comment-item');
            let newFound = 0;

            commentEls.forEach((el) => {
                // 生成唯一标识
                const nameEl = el.querySelector('a.name, .name');
                const contentEl = el.querySelector('.content, .note-text');
                const dateEl = el.querySelector('.date');
                const likeEl = el.querySelector('.like-count, .count');

                const name = nameEl ? nameEl.innerText.trim() : '';
                const content = contentEl ? contentEl.innerText.trim() : '';
                const date = parseXHSTime(dateEl ? dateEl.innerText.trim() : '');
                const likeCount = likeEl ? likeEl.innerText.trim() : '';

                if (!content) return; // 跳过空评论

                const key = `${name}|${content}`;
                if (seenSet.has(key)) return;
                seenSet.add(key);
                newFound++;

                // 提取子评论（回复）
                const subComments = [];
                const subEls = el.querySelectorAll('.sub-comment-item, .reply-item');
                subEls.forEach((sub) => {
                    const subName = sub.querySelector('a.name, .name')?.innerText?.trim() || '';
                    const subContent = sub.querySelector('.content, .note-text')?.innerText?.trim() || '';
                    const subDate = parseXHSTime(sub.querySelector('.date')?.innerText?.trim() || '');
                    const subKey = `${subName}|${subContent}`;
                    if (!seenSet.has(subKey) && subContent) {
                        seenSet.add(subKey);
                        subComments.push({ user: subName, content: subContent, date: subDate });
                    }
                });

                state.comments.push({
                    user: name,
                    content,
                    date,
                    likes: likeCount,
                    replies: subComments,
                });
            });

            if (newFound === 0) {
                noNewCount++;
            } else {
                noNewCount = 0;
            }

            setStatus(`⏳ 已提取 ${state.comments.length} 条评论，滚动加载中...`);

            // 向下滚动加载更多评论（随机 3~5 秒间隔，模拟人类操作）
            scroller.scrollTop = scroller.scrollHeight;
            const scrollDelay = 3000 + Math.floor(Math.random() * 2000);
            await sleep(scrollDelay);

            // 检查是否有"展开更多评论"的按钮并点击
            const expandBtns = document.querySelectorAll('.show-more, [class*="expand"], .more-comment');
            expandBtns.forEach((btn) => {
                try { btn.click(); } catch (e) { /* ignore */ }
            });
            await sleep(1500 + Math.floor(Math.random() * 1000));
        }

        state.isExtracting = false;
        setStatus(`✅ 评论提取完成！共 ${state.comments.length} 条评论`);
    }

    // ========== 搜索结果提取 ==========
    async function extractSearchResults() {
        if (!isSearchPage()) {
            setStatus('❌ 请在搜索结果页使用此功能');
            return;
        }

        setStatus('⏳ 正在提取搜索结果...');
        const cards = document.querySelectorAll('section.note-item');
        let count = 0;
        const seenIds = new Set(state.searchResults.map(r => r.id));

        cards.forEach(card => {
            const titleEl = card.querySelector('.title');
            const authorEl = card.querySelector('.author');
            const nameEl = authorEl ? (authorEl.querySelector('.name') || authorEl.querySelector('div div')) : null;
            const likeEl = card.querySelector('.count');
            const linkEl = card.querySelector('a.cover');

            const title = titleEl ? titleEl.innerText.trim() : '';
            const author = nameEl ? nameEl.innerText.trim() : '';
            const authorLink = authorEl ? authorEl.href : '';
            const likes = likeEl ? likeEl.innerText.trim() : '';
            const url = linkEl ? linkEl.href : '';
            const id = url.match(/\/explore\/([a-f0-9]+)/)?.[1] || url;

            if (id && !seenIds.has(id)) {
                state.searchResults.push({ id, title, author, authorLink, likes, url });
                seenIds.add(id);
                count++;
            }
        });

        setStatus(`✅ 提取完成！本次新增 ${count} 条，总计 ${state.searchResults.length} 条笔记`);
    }

    // ========== CSV 工具函数 ==========
    function csvEscape(val) {
        if (val == null) return '';
        const str = String(val).replace(/\r?\n/g, ' '); // 换行替换为空格
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function buildCSVRow(fields) {
        return fields.map(csvEscape).join(',');
    }

    // ========== 导出 CSV 表格 ==========
    function exportCSV() {
        if (!state.noteData && state.comments.length === 0 && state.searchResults.length === 0) {
            setStatus('❌ 没有数据可导出，请先提取笔记内容、评论或搜索结果');
            return;
        }

        const rows = [];
        const note = state.noteData || {};

        if (state.noteData || state.comments.length > 0) {
            // ---- 笔记信息区 ----
            rows.push(buildCSVRow(['=== 笔记详情信息 ===', '', '', '', '']));
            rows.push(buildCSVRow(['笔记ID', note.noteId || '']));
            rows.push(buildCSVRow(['标题', note.title || '']));
            rows.push(buildCSVRow(['作者', note.author || '']));
            rows.push(buildCSVRow(['发布日期', note.publishDate || '']));
            rows.push(buildCSVRow(['IP属地', note.ipLocation || '']));
            rows.push(buildCSVRow(['点赞', note.likes || '', '收藏', note.collects || '', '评论数', note.commentsCount || '']));
            rows.push(buildCSVRow(['正文', note.desc || '']));
            rows.push(buildCSVRow(['标签', (note.tags || []).join(' ')]));
            rows.push(buildCSVRow(['图片链接', (note.images || []).join(' | ')]));
            if (note.video) rows.push(buildCSVRow(['视频链接', note.video]));
            rows.push(buildCSVRow(['原文链接', note.url || '']));
            rows.push(buildCSVRow(['提取时间', note.extractedAt || new Date().toISOString()]));
            rows.push(''); // 空行分隔
        }

        // ---- 评论明细区 ----
        rows.push(buildCSVRow(['=== 评论明细 ===', '', '', '', '']));
        rows.push(buildCSVRow(['序号', '用户', '评论内容', '评论时间', '点赞数', '类型']));

        let idx = 1;
        state.comments.forEach((c) => {
            rows.push(buildCSVRow([idx++, c.user, c.content, c.date, c.likes || '', '主评论']));
            // 子评论/回复
            if (c.replies && c.replies.length > 0) {
                c.replies.forEach((r) => {
                    rows.push(buildCSVRow([idx++, r.user, r.content, r.date, '', '↳ 回复']));
                });
            }
        });

        // 添加统计行
        rows.push('');
        rows.push(buildCSVRow(['合计评论数', state.comments.length]));

        // ---- 搜索结果区 ----
        if (state.searchResults.length > 0) {
            rows.push('');
            rows.push(buildCSVRow(['=== 搜索结果列表 ===', '', '', '', '', '']));
            rows.push(buildCSVRow(['序号', '笔记ID', '标题', '作者', '点赞数', '链接']));
            state.searchResults.forEach((item, i) => {
                rows.push(buildCSVRow([i + 1, item.id, item.title, item.author, item.likes, item.url]));
            });
        }

        rows.push('');
        rows.push(buildCSVRow(['导出时间', new Date().toISOString()]));

        const fileName = note.noteId
            ? `xhs_${note.noteId}_${(note.title || '').substring(0, 20).replace(/[\\/:*?"<>|]/g, '_')}.csv`
            : `xhs_search_export_${Date.now()}.csv`;

        // BOM + CSV 内容（确保 Excel 正确识别 UTF-8）
        const BOM = '\uFEFF';
        const csvContent = BOM + rows.join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setStatus(`✅ 已导出表格 ${fileName}（共 ${state.comments.length} 条评论）`);
    }

    // ========== 素材信息提取（独立于文案提取） ==========
    // ========== 笔记内容提取 ==========
    function collectMediaInfo() {
        const container = document.querySelector('#noteContainer');
        if (!container) return null;

        // 笔记ID
        const urlMatch = window.location.href.match(/\/explore\/([a-f0-9]+)/);
        const noteId = urlMatch ? urlMatch[1] : 'unknown';

        // 标题
        const titleEl = document.querySelector('#detail-title');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // 图片
        const imgEls = document.querySelectorAll(
            '.media-container .swiper-slide img, .note-content img, #noteContainer .note-slider-img'
        );
        const images = Array.from(imgEls)
            .map((img) => {
                let src = img.getAttribute('data-origin-src')
                    || img.getAttribute('data-src')
                    || img.src || '';
                if (!src) return '';
                // 统一协议
                if (src.startsWith('//')) src = 'https:' + src;
                // 如果是 HTTP 且不是 localhost，尝试 HTTPS（顺应浏览器 Mixed Content 策略）
                if (src.startsWith('http://') && !src.includes('127.0.0.1')) {
                    src = src.replace('http://', 'https://');
                }
                return src;
            })
            .filter((s) => s && (s.includes('xhscdn.com') || s.includes('sns-img') || s.includes('sns-webpic')))
            .filter((v, i, a) => a.indexOf(v) === i);

        // 视频（支持 media-container.video-player-media 和其他视频容器）
        const videos = [];
        const videoEls = document.querySelectorAll(
            '.media-container video, .media-container source, .note-content video, #noteContainer video, #noteContainer source'
        );
        videoEls.forEach((el) => {
            let src = el.src || el.currentSrc || '';
            if (src) {
                if (src.startsWith('//')) src = 'https:' + src;
                if (src.startsWith('http://') && !src.includes('127.0.0.1')) {
                    src = src.replace('http://', 'https://');
                }
                if (!videos.includes(src)) videos.push(src);
            }
        });
        // 备选：从 video 标签的 poster 属性获取封面
        // 也检查 xgplayer 等播放器的 data 属性
        document.querySelectorAll('.media-container video[src], .media-container video').forEach((v) => {
            let s = v.src || v.currentSrc || '';
            if (s) {
                if (s.startsWith('//')) s = 'https:' + s;
                if (s.startsWith('http://') && !s.includes('127.0.0.1')) {
                    s = s.replace('http://', 'https://');
                }
                if (!videos.includes(s)) videos.push(s);
            }
        });

        // 日期
        const dateEl = document.querySelector('#noteContainer .date, #noteContainer .bottom-container .date');
        const publishDate = dateEl ? dateEl.innerText.trim().replace(/[\s:]/g, '').substring(0, 10) : '';

        return { noteId, title, images, videos, publishDate };
    }

    // 清理文件名中的特殊字符
    function sanitize(str, maxLen = 30) {
        return (str || '').replace(/[\\/:*?"<>|\n\r]/g, '_').substring(0, maxLen).trim() || 'untitled';
    }

    // ========== 打包下载素材（图片 + 视频 → ZIP） ==========
    // ========== 打包下载素材（图片 + 视频 → ZIP） ==========
    async function downloadMedia() {
        const media = collectMediaInfo();
        if (!media) {
            setStatus('❌ 未检测到笔记详情，请先打开一篇笔记');
            return;
        }

        const totalImages = media.images.length;
        const totalVideos = media.videos.length;
        const totalFiles = totalImages + totalVideos;

        if (totalFiles === 0) {
            setStatus('❌ 未找到可下载的图片或视频');
            return;
        }

        setStatus(`⏳ 检测到 ${totalImages} 张图片 + ${totalVideos} 个视频，开始打包...`);

        // 检查 JSZip 是否可用，兼容 window.JSZip
        let JSZipConstructor = window.JSZip;
        if (typeof JSZip !== 'undefined') {
            JSZipConstructor = JSZip;
        }

        if (!JSZipConstructor) {
            setStatus('⏳ 正在加载压缩库...');
            try {
                await loadJSZip();
                JSZipConstructor = window.JSZip; // 再次尝试获取
            } catch (e) {
                setStatus('❌ 压缩库加载失败，无法打包');
                console.error(e);
                return;
            }
        }

        if (!JSZipConstructor) {
            setStatus('❌ JSZip 未定义，无法启动压缩');
            return;
        }

        const zip = new JSZipConstructor();
        let downloaded = 0;

        // 下载图片
        for (let i = 0; i < totalImages; i++) {
            const url = media.images[i];
            const ext = url.includes('.png') ? 'png' : 'jpg';
            const fileName = `img_${i + 1}.${ext}`;
            try {
                // 使用 GM_xmlhttpRequest 获取 ArrayBuffer
                const buffer = await gmFetch(url);
                if (buffer && buffer.byteLength > 0) {
                    zip.file(fileName, new Uint8Array(buffer)); // 关键修复：包装为 Uint8Array
                    downloaded++;
                    setStatus(`⏳ 下载中 ${downloaded}/${totalFiles}...`);
                } else {
                    throw new Error('Empty buffer');
                }
            } catch (e) {
                console.warn('[XHS-DL] 图片下载失败:', url, e);
                setStatus(`⚠️ 图片 ${i + 1} 下载失败，跳过`);
            }
            await sleep(300);
        }

        // 下载视频
        for (let i = 0; i < totalVideos; i++) {
            const url = media.videos[i];
            const ext = url.includes('.mp4') ? 'mp4' : (url.includes('.webm') ? 'webm' : 'mp4');
            const fileName = `video_${i + 1}.${ext}`;
            try {
                setStatus(`⏳ 下载视频 ${i + 1}/${totalVideos}（文件较大，请稍候）...`);
                const buffer = await gmFetch(url);
                if (buffer && buffer.byteLength > 0) {
                    zip.file(fileName, new Uint8Array(buffer)); // 关键修复：包装为 Uint8Array
                    downloaded++;
                    setStatus(`⏳ 下载中 ${downloaded}/${totalFiles}...`);
                } else {
                    throw new Error('Empty buffer');
                }
            } catch (e) {
                console.warn('[XHS-DL] 视频下载失败:', url, e);
                setStatus(`⚠️ 视频 ${i + 1} 下载失败，跳过`);
            }
        }

        if (downloaded === 0) {
            setStatus('❌ 所有文件下载失败');
            return;
        }

        // 生成 ZIP 并触发下载
        console.log('[XHS-DL] 开始生成 ZIP blob...');
        setStatus('⏳ 正在压缩打包...');
        const today = new Date();
        const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        const zipName = `${media.noteId}_${sanitize(media.title)}_${dateStr}.zip`;

        try {
            const zipBlob = await zip.generateAsync({
                type: 'blob',
                compression: 'STORE' // 关键修复：仅存储不压缩，提高稳定性和速度
            }, (meta) => {
                const percent = Math.round(meta.percent);
                if (percent % 20 === 0) console.log(`[XHS-DL] 压缩进度: ${percent}%`);
                setStatus(`⏳ 压缩中 ${percent}%...`);
            });

            console.log('[XHS-DL] ZIP生成成功, 大小:', zipBlob.size);

            const blobUrl = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = zipName;
            a.style.display = 'none';
            document.body.appendChild(a);
            console.log('[XHS-DL] 触发模拟点击下载:', zipName);
            a.click();

            // 延时清理
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
                console.log('[XHS-DL] 清理临时资源');
            }, 30000);

            setStatus(`✅ 打包完成！${downloaded} 个文件 → ${zipName}`);
        } catch (e) {
            console.error('[XHS-DL] 压缩打包关键错误:', e);
            setStatus(`❌ 打包失败: ${e.message || '未知错误'}`);
            alert('打包过程出错，详细错误请看控制台：\n' + e.stack);
        }
    }

    // 动态加载 JSZip（备用，以防 @require 未生效）
    function loadJSZip() {
        return new Promise((resolve, reject) => {
            if (window.JSZip || typeof JSZip !== 'undefined') return resolve(); // 已经有了
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('JSZip 加载失败'));
            document.head.appendChild(s);
        });
    }

    // ========== 初始化 ==========
    // 等待页面加载完成后注入UI
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
})();

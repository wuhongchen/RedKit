// ==UserScript==
// @name         小红书笔记内容&评论下载器
// @namespace    https://github.com/wuhongchen/RedKit
// @version      1.4
// @description  在小红书笔记详情页一键提取帖子内容、评论，导出 CSV 表格，支持逐个或链接复制素材下载。
// @author       whc
// @match        https://www.xiaohongshu.com/
// @match        https://www.xiaohongshu.com/?*
// @match        https://www.xiaohongshu.com/explore*
// @match        https://www.xiaohongshu.com/search_result*
// @match        https://www.xiaohongshu.com/user/profile/*
// @icon         https://fe-video-qc.xhscdn.com/fe-platform/ed8fe781ce9e16c1bfac2cd962f0721edabe2e49.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
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
        autoExtractedNotes: [], // 自动提取的笔记列表
        isAutoExtracting: false, // 标记是否正在自动提取
        autoExtractIndex: 0, // 当前提取到的索引
    };

    // 判断所在页面
    const isSearchPage = () => window.location.href.includes('/search_result');
    const isNoteDetailPage = () => {
        // 只有 /explore/ 后跟 ID 的才是详情页，排除 /explore?channel_id=xx
        return /\/explore\/[a-zA-Z0-9]+/.test(window.location.href) && !window.location.href.includes('/explore?');
    };
    const isProfilePage = () => window.location.href.includes('/user/profile');
    const isHomePage = () => {
        const href = window.location.href;
        // 如果是 /explore 但不是详情页，视为首页/列表页
        if (href.includes('/explore') && !isNoteDetailPage()) return true;

        return href === 'https://www.xiaohongshu.com/' ||
            href === 'https://www.xiaohongshu.com' ||
            (href.includes('xiaohongshu.com') && !href.includes('/explore') && !href.includes('/search_result') && !href.includes('/user/profile'));
    };
    const isListPage = () => isSearchPage() || isProfilePage() || isHomePage();

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
        /* 进度条样式 */
        .xdl-btn.loading {
            position: relative;
            background: #eee !important;
            color: #999 !important;
            overflow: hidden;
        }
        .xdl-btn.loading::after {
            content: '';
            position: absolute; left: 0; top: 0; bottom: 0;
            width: var(--progress, 0%);
            background: linear-gradient(135deg, #00c853 0%, #00e676 100%);
            transition: width 0.3s;
            z-index: 0;
            opacity: 0.3;
        }
        .xdl-btn.loading span { position: relative; z-index: 1; }
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
        <div id="xdl-detail-tools" style="${isNoteDetailPage() ? '' : 'display:none'}">
          <button class="xdl-btn primary"   id="xdl-extract-note"><span>📝 提取笔记内容</span></button>
          <button class="xdl-btn primary"   id="xdl-extract-comments"><span>💬 提取全部评论</span></button>
          <div style="display: flex; gap: 5px;">
            <button class="xdl-btn secondary" id="xdl-download-direct" style="flex:1" title="确认下载所有检测出的图片和视频"><span>📥 逐个下载素材</span></button>
          </div>
          <button class="xdl-btn success"   id="xdl-copy-links"><span>📋 复制素材链接</span></button>
        </div>
        <div id="xdl-search-tools" style="${isListPage() ? '' : 'display:none'}">
          <button class="xdl-btn primary"   id="xdl-extract-search">
            ${isProfilePage() ? '👤 提取笔记列表' : isHomePage() ? '🏠 提取首页笔记' : '🔍 抓取搜索结果'}
          </button>
          <button class="xdl-btn primary"   id="xdl-auto-extract">
            <span>🔄 逐个提取笔记</span>
          </button>
          <button class="xdl-btn secondary" id="xdl-stop-auto" style="display:none">
            <span>⏹ 停止提取</span>
          </button>
        </div>
        <div style="display:flex; gap:5px; margin-top:10px;">
            <button class="xdl-btn success" id="xdl-export-csv" style="flex:2">📊 导出 CSV</button>
            <button class="xdl-btn secondary" id="xdl-clear-data" style="flex:1" title="清空缓存">🗑</button>
        </div>
        <div id="xdl-status"></div>
      </div>
      <button id="xhs-dl-toggle">笔记<br>下载</button>
    `;
        document.body.appendChild(panel);

        // 初始化更新数据计数
        updateStorageStatus();

        // 面板展开/收起
        document.getElementById('xhs-dl-toggle').onclick = () => {
            const menu = document.getElementById('xhs-dl-menu');
            if (menu) {
                // 打开菜单时根据当前页面更新工具显示
                if (!menu.classList.contains('show')) {
                    const detailTools = document.getElementById('xdl-detail-tools');
                    const searchTools = document.getElementById('xdl-search-tools');
                    const searchBtn = document.getElementById('xdl-extract-search');

                    if (detailTools) detailTools.style.display = isNoteDetailPage() ? 'block' : 'none';
                    if (searchTools) searchTools.style.display = isListPage() ? 'block' : 'none';
                    if (searchBtn) {
                        searchBtn.innerHTML = isProfilePage() ? '👤 提取笔记列表' : isHomePage() ? '🏠 提取首页笔记' : '🔍 抓取搜索结果';
                    }
                }
                menu.classList.toggle('show');
            }
        };

        // 按钮绑定
        if (document.getElementById('xdl-extract-note')) document.getElementById('xdl-extract-note').onclick = extractNote;
        if (document.getElementById('xdl-extract-comments')) document.getElementById('xdl-extract-comments').onclick = extractComments;
        if (document.getElementById('xdl-extract-search')) document.getElementById('xdl-extract-search').onclick = extractSearchResults;
        if (document.getElementById('xdl-download-direct')) document.getElementById('xdl-download-direct').onclick = individualDownload;
        if (document.getElementById('xdl-copy-links')) document.getElementById('xdl-copy-links').onclick = copyMediaUrls;
        document.getElementById('xdl-export-csv').onclick = exportCSV;
        document.getElementById('xdl-clear-data').onclick = clearStoredData;
        if (document.getElementById('xdl-auto-extract')) document.getElementById('xdl-auto-extract').onclick = autoExtractNotes;
        if (document.getElementById('xdl-stop-auto')) document.getElementById('xdl-stop-auto').onclick = stopAutoExtract;
    }

    // ========== 数据持久化存储 ==========
    const Storage = {
        getKey: () => 'xhs_saved_notes',
        getAll: () => {
            const json = GM_getValue(Storage.getKey(), '[]');
            try { return JSON.parse(json); } catch (e) { return []; }
        },
        save: (noteData) => {
            if (!noteData || !noteData.noteId) return;
            const list = Storage.getAll();
            // 查重并更新
            const idx = list.findIndex(n => n.noteId === noteData.noteId);
            if (idx > -1) {
                // 如果旧数据有评论而新数据没有，保留旧评论
                if ((!noteData.comments || noteData.comments.length === 0) && list[idx].comments && list[idx].comments.length > 0) {
                    noteData.comments = list[idx].comments;
                }
                list[idx] = noteData;
            } else {
                list.push(noteData);
            }
            GM_setValue(Storage.getKey(), JSON.stringify(list));
            updateStorageStatus();
        },
        clear: () => {
            GM_deleteValue(Storage.getKey());
            state.autoExtractedNotes = [];
            state.noteData = null;
            state.comments = [];
            updateStorageStatus();
        },
        getCount: () => {
            return Storage.getAll().length;
        }
    };

    function updateStorageStatus() {
        const count = Storage.getCount();
        const exportBtn = document.getElementById('xdl-export-csv');
        const clearBtn = document.getElementById('xdl-clear-data');
        if (exportBtn) {
            exportBtn.innerHTML = count > 0 ? `📊 导出全部数据 (${count})` : `📊 导出 CSV 表格`;
        }
    }

    function clearStoredData() {
        if (confirm('确定要清空所有已提取的缓存数据吗？')) {
            Storage.clear();
            setStatus('🗑 数据已清空');
        }
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
        const urlMatch = window.location.href.match(/\/(?:explore|profile\/[a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/);
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

        // 互动数据采集优化：优先从页面状态获取真值 (100% 准确)
        let likes = '0', collects = '0', commentsCount = '0';
        try {
            const stateData = typeof unsafeWindow !== 'undefined' ? unsafeWindow.__INITIAL_STATE__ : null;
            if (stateData && stateData.note && stateData.note.noteDetailMap) {
                const detail = stateData.note.noteDetailMap[noteId] || Object.values(stateData.note.noteDetailMap)[0];
                if (detail && detail.note && detail.note.interactInfo) {
                    const info = detail.note.interactInfo;
                    likes = info.likedCount || '0';
                    collects = info.collectedCount || '0';
                    commentsCount = info.commentCount || '0';
                    console.log('[XHS-DL] 从状态库获取互动数据成功:', { likes, collects, commentsCount });
                }
            }
        } catch (e) {
            console.warn('[XHS-DL] 从状态库获取数据失败，尝试 DOM 取值:', e);
        }

        // 如果状态库取值失败，回退到 DOM 方案
        if (likes === '0') {
            const engageBar = document.querySelector('.engage-bar, .interaction-container, .interact-container');
            if (engageBar) {
                const getVal = (selector) => {
                    const el = engageBar.querySelector(selector);
                    if (!el) return null;
                    const val = el.innerText.trim();
                    return (val === '点赞' || val === '赞' || val === '收藏' || !val) ? '0' : val;
                };
                likes = getVal('.like-wrapper .count, .like-active .count') || likes;
                collects = getVal('.collect-wrapper .count, .star-wrapper .count') || collects;
                commentsCount = getVal('.chat-wrapper .count, .chat-container .count') || commentsCount;
            }
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

        // 自动保存
        Storage.save(state.noteData);
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

        // 自动提取笔记基本内容
        await extractNote();

        state.isExtracting = true;
        state.comments = [];

        const btn = document.getElementById('xdl-extract-comments');
        const exportBtn = document.getElementById('xdl-export-csv');
        if (btn) btn.classList.add('loading');
        if (exportBtn) exportBtn.disabled = true;

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
                let likeCount = likeEl ? likeEl.innerText.trim() : '0';
                // 修复：如果点赞数为 0 时展示 0 而不是展示赞字
                if (likeCount === '赞' || !likeCount) likeCount = '0';

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
                    let subLikes = sub.querySelector('.count, .like-count')?.innerText?.trim() || '0';
                    if (subLikes === '赞' || !subLikes) subLikes = '0';

                    const subKey = `${subName}|${subContent}`;
                    if (!seenSet.has(subKey) && subContent) {
                        seenSet.add(subKey);
                        subComments.push({ user: subName, content: subContent, date: subDate, likes: subLikes });
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

            // 更新进度条（由于不知道总数，按滚动次数模拟步进，每发现一些就推一点，最高到95%）
            const progress = Math.min(95, (seenSet.size / 50) * 10);
            if (btn) btn.style.setProperty('--progress', `${progress}%`);

            setStatus(`⏳ 已提取 ${state.comments.length} 条评论，滚动加载中...`);

            // 检查是否已经到达底部或达到 200 条限制
            const isBottom = document.querySelector('.end-container, .no-more, .comments-el .end-container');
            if (isBottom) {
                console.log('[XHS-DL] 检测到评论到底了');
                break;
            }
            if (state.comments.length >= 200) {
                console.log('[XHS-DL] 达到 200 条评论限制，停止抓取');
                break;
            }

            // 向下滚动加载更多评论（随机 3~5 秒间隔，模拟人类操作）
            scroller.scrollTop = scroller.scrollHeight;
            const scrollDelay = 2000 + Math.floor(Math.random() * 2000); // 稍微加快一点点
            await sleep(scrollDelay);

            // 检查是否有"展开更多评论"的按钮并点击
            const expandBtns = document.querySelectorAll('.show-more, [class*="expand"], .more-comment');
            expandBtns.forEach((btn) => {
                try { btn.click(); } catch (e) { /* ignore */ }
            });
            await sleep(1500 + Math.floor(Math.random() * 1000));
        }

        state.isExtracting = false;
        if (btn) {
            btn.classList.remove('loading');
            btn.style.setProperty('--progress', '100%');
        }
        if (exportBtn) exportBtn.disabled = false;

        setStatus(`✅ 评论提取完成！共 ${state.comments.length} 条评论`);

        // 更新并保存数据
        if (state.noteData) {
            state.noteData.comments = state.comments;
            Storage.save(state.noteData);
        }
    }

    // ========== 搜索结果提取 ==========
    async function extractSearchResults() {
        if (!isListPage()) {
            setStatus('❌ 请在首页、搜索结果页或用户主页使用此功能');
            return;
        }

        const isProfile = isProfilePage();
        const isHome = isHomePage();
        setStatus(`⏳ 正在提取${isHome ? '首页' : isProfile ? '主页笔记' : '搜索结果'}...`);

        // 首页和其他页面可能使用不同的卡片选择器
        let cards = document.querySelectorAll('section.note-item');
        if (cards.length === 0) {
            // 尝试其他可能的卡片选择器（首页）
            cards = document.querySelectorAll('.note-card, .feed-item, [class*="note-item"], .item');
        }
        let count = 0;
        const seenIds = new Set(state.searchResults.map(r => r.id));

        cards.forEach(card => {
            const titleEl = card.querySelector('.title');
            const authorEl = card.querySelector('.author');
            const nameEl = authorEl ? (authorEl.querySelector('.name') || authorEl.querySelector('div div')) : null;
            const likeEl = card.querySelector('.count');
            const linkEl = card.querySelector('a.cover');
            const url = linkEl ? linkEl.href : '';

            const title = titleEl ? titleEl.innerText.trim() : '';
            const author = nameEl ? nameEl.innerText.trim() : '';
            const authorLink = authorEl ? authorEl.href : '';
            const likes = likeEl ? likeEl.innerText.trim() : '';
            let id = '';
            const exploreMatch = url.match(/\/explore\/([a-zA-Z0-9]+)/);
            if (exploreMatch) {
                id = exploreMatch[1];
            } else {
                // 处理用户主页链接格式: /user/profile/[user_id]/[note_id]
                const parts = url.split('/');
                id = parts[parts.length - 1].split('?')[0];
            }

            if (id && !seenIds.has(id)) {
                state.searchResults.push({ id, title, author, authorLink, likes, url });
                seenIds.add(id);
                count++;
            }
        });

        setStatus(`✅ 提取完成！本次新增 ${count} 条，总计 ${state.searchResults.length} 条笔记`);
    }

    // ========== 自动逐个提取笔记 ==========
    async function autoExtractNotes() {
        if (!isListPage()) {
            setStatus('❌ 请在首页、搜索结果页或用户主页使用此功能');
            return;
        }

        const cards = document.querySelectorAll('section.note-item');
        if (cards.length === 0) {
            setStatus('❌ 未找到笔记列表，请确保在首页、搜索结果页或用户主页');
            return;
        }

        if (state.isAutoExtracting) {
            setStatus('⚠️ 正在提取中，请先点击停止按钮');
            return;
        }

        state.isAutoExtracting = true;
        state.autoExtractedNotes = [];
        state.autoExtractIndex = 0;

        document.getElementById('xdl-auto-extract').style.display = 'none';
        document.getElementById('xdl-stop-auto').style.display = 'block';

        setStatus(`⏳ 开始自动提取，共 ${cards.length} 个笔记...`);

        const btn = document.getElementById('xdl-auto-extract');
        if (btn) btn.classList.add('loading');

        for (let i = 0; i < cards.length; i++) {
            if (!state.isAutoExtracting) break;

            state.autoExtractIndex = i;
            const card = cards[i];

            const linkEl = card.querySelector('a.cover');
            if (!linkEl) continue;

            const noteUrl = linkEl.href;
            const noteIdMatch = noteUrl.match(/\/explore\/([a-zA-Z0-9]+)/);
            if (!noteIdMatch) continue;

            const noteId = noteIdMatch[1];

            const titleEl = card.querySelector('.title');
            const likeEl = card.querySelector('.count');
            const title = titleEl ? titleEl.innerText.trim() : '';
            const likes = likeEl ? likeEl.innerText.trim() : '0';

            const progress = Math.round(((i + 1) / cards.length) * 100);
            if (btn) btn.style.setProperty('--progress', `${progress}%`);

            setStatus(`⏳ 正在提取第 ${i + 1}/${cards.length} 个: ${title.substring(0, 15)}...`);

            linkEl.click();

            await sleep(3000);

            let waitCount = 0;
            while (!document.querySelector('#noteContainer') && waitCount < 10) {
                await sleep(500);
                waitCount++;
            }

            if (!document.querySelector('#noteContainer')) {
                console.warn(`[XHS-DL] 第${i + 1}个笔记加载失败，跳过`);
                window.history.back();
                await sleep(2000);
                continue;
            }

            await extractNote();

            await extractComments();



            const noteObj = {
                index: i + 1,
                noteId: state.noteData?.noteId || noteId,
                title: state.noteData?.title || title,
                author: state.noteData?.author || '',
                likes: state.noteData?.likes || likes,
                collects: state.noteData?.collects || '0',
                commentsCount: state.noteData?.commentsCount || '0',
                desc: state.noteData?.desc || '',
                tags: state.noteData?.tags || [],
                images: state.noteData?.images || [],
                video: state.noteData?.video || '',
                comments: [...state.comments],
                url: noteUrl,
                extractedAt: new Date().toISOString()
            };

            state.autoExtractedNotes.push(noteObj);
            // 实时保存
            Storage.save(noteObj);

            window.history.back();

            await sleep(2500);
        }

        state.isAutoExtracting = false;

        if (btn) {
            btn.classList.remove('loading');
            btn.style.setProperty('--progress', '100%');
        }

        document.getElementById('xdl-auto-extract').style.display = 'block';
        document.getElementById('xdl-stop-auto').style.display = 'none';

        setStatus(`✅ 自动提取完成！共提取 ${state.autoExtractedNotes.length} 个笔记`);
    }

    // ========== 停止自动提取 ==========
    function stopAutoExtract() {
        state.isAutoExtracting = false;
        setStatus(`⏹ 已停止提取，已提取 ${state.autoExtractedNotes.length} 个笔记`);
        const btn = document.getElementById('xdl-auto-extract');
        if (btn) {
            btn.classList.remove('loading');
            btn.style.setProperty('--progress', '0%');
        }
        document.getElementById('xdl-auto-extract').style.display = 'block';
        document.getElementById('xdl-stop-auto').style.display = 'none';
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
        const storedNotes = Storage.getAll();

        if (storedNotes.length === 0 && !state.noteData && state.searchResults.length === 0) {
            setStatus('❌ 没有数据可导出，请先提取');
            return;
        }

        const rows = [];
        const isBatchExport = storedNotes.length > 0;

        // 如果有缓存数据，优先导出缓存数据（包含当前提取的）
        const notesToExport = isBatchExport ? storedNotes : (state.noteData ? [state.noteData] : []);

        if (notesToExport.length > 0) {
            notesToExport.forEach((note, index) => {
                if (index > 0) rows.push(''); // 笔记间空行
                // ---- 笔记信息区 ----
                rows.push(buildCSVRow([`=== 笔记 ${index + 1}: ${note.title.substring(0, 15)}... ===`, '', '', '', '']));
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

                // ---- 评论明细区 ----
                if (note.comments && note.comments.length > 0) {
                    rows.push(buildCSVRow(['>>> 评论列表', '', '', '', '']));
                    rows.push(buildCSVRow(['序号', '用户', '评论内容', '评论时间', '点赞数', '类型']));

                    let cIdx = 1;
                    note.comments.forEach((c) => {
                        rows.push(buildCSVRow([cIdx++, c.user, c.content, c.date, c.likes || '', '主评论']));
                        if (c.replies && c.replies.length > 0) {
                            c.replies.forEach((r) => {
                                rows.push(buildCSVRow([cIdx++, r.user, r.content, r.date, '', '↳ 回复']));
                            });
                        }
                    });
                    rows.push(buildCSVRow(['本篇评论数', note.comments.length]));
                } else {
                    rows.push(buildCSVRow(['(无评论数据)']));
                }
            });
        }
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

    // ---- 搜索结果区 (独立导出) ----
    if (state.searchResults.length > 0) {
        rows.push('');
        rows.push(buildCSVRow(['=== 搜索/列表结果 ===', '', '', '', '', '']));
        rows.push(buildCSVRow(['序号', '笔记ID', '标题', '作者', '点赞数', '链接']));
        state.searchResults.forEach((item, i) => {
            rows.push(buildCSVRow([i + 1, item.id, item.title, item.author, item.likes, item.url]));
        });
    }

    rows.push('');
    rows.push(buildCSVRow(['导出时间', new Date().toISOString()]));

    const fileName = isBatchExport
        ? `xhs_batch_export_${Storage.getCount()}_notes_${Date.now()}.csv`
        : state.searchResults.length > 0
            ? `xhs_search_list_${Date.now()}.csv`
            : `xhs_export_${Date.now()}.csv`;

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
    const urlMatch = window.location.href.match(/\/(?:explore|profile\/[a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/);
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

    // 视频检测增强：尝试从 el.src 获取，若为 blob 则尝试从 unsafeWindow 提取
    const videos = [];
    document.querySelectorAll('.media-container video, .media-container source, #noteContainer video').forEach((el) => {
        let src = el.src || el.currentSrc || '';
        if (src && !src.startsWith('blob:') && !videos.includes(src)) {
            if (src.startsWith('//')) src = 'https:' + src;
            if (src.startsWith('http://') && !src.includes('127.0.0.1')) {
                src = src.replace('http://', 'https://');
            }
            videos.push(src);
        }
    });

    // 如果 DOM 中没找到直链，尝试从页面深度状态中提取 (针对使用了 MSE 播放器的视频)
    try {
        const state = typeof unsafeWindow !== 'undefined' ? unsafeWindow.__INITIAL_STATE__ : null;
        if (state && state.note && state.note.noteDetailMap) {
            const detail = state.note.noteDetailMap[noteId] || Object.values(state.note.noteDetailMap)[0];
            if (detail && detail.note && detail.note.video) {
                const stream = detail.note.video.media.stream;
                // 尝试获取 h264 或 h265 最高的清晰度
                const videoUrls = [
                    ...(stream.h264 || []),
                    ...(stream.h265 || []),
                    ...(stream.av1 || [])
                ].map(v => v.masterUrl).filter(Boolean);

                videoUrls.forEach(url => {
                    let s = url;
                    if (s.startsWith('//')) s = 'https:' + s;
                    if (!videos.includes(s)) videos.push(s);
                });
            }
        }
    } catch (e) {
        console.warn('[XHS-DL] 尝试从状态抓取视频链接失败:', e);
    }

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
// ========== 替代下载方案 (逐个下载) ==========
async function individualDownload() {
    const media = collectMediaInfo();
    if (!media || (media.images.length === 0 && media.videos.length === 0)) {
        setStatus('❌ 未找到可下载的素材');
        return;
    }

    setStatus(`⏳ 准备逐个下载 ${media.images.length + media.videos.length} 个文件...`);

    let count = 0;
    const total = media.images.length + media.videos.length;

    // 下载图片
    for (let i = 0; i < media.images.length; i++) {
        const url = media.images[i];
        const ext = url.includes('.png') ? 'png' : 'jpg';
        const fileName = `${media.noteId}_img_${i + 1}.${ext}`;
        GM_download({
            url: url,
            name: fileName,
            onload: () => console.log('[XHS-DL] 下载成功:', fileName),
            onerror: (err) => console.error('[XHS-DL] 下载失败:', fileName, err)
        });
        count++;
        setStatus(`📥 正在触发下载 ${count}/${total}...`);
        await sleep(500); // 间隔一下，防止浏览器弹窗频率限制
    }

    // 下载视频
    for (let i = 0; i < media.videos.length; i++) {
        let url = media.videos[i];
        const fileName = `${media.noteId}_video_${i + 1}.mp4`;

        console.log('[XHS-DL] 尝试下载视频:', url);
        GM_download({
            url: url,
            name: fileName,
            onload: () => {
                console.log('[XHS-DL] 视频下载成功:', fileName);
                setStatus(`✅ 视频下载成功: ${fileName}`);
            },
            onerror: (err) => {
                console.error('[XHS-DL] 视频下载异常:', err, url);
                setStatus(`❌ 视频下载失败: ${err.error || '未知原因'}`);
                // 如果 GM_download 失败，尝试在新标签页打开链接让用户手动下载
                if (confirm(`视频下载被拦截或失败，是否尝试在浏览器新标签页手动打开并保存？\n\n错误：${err.error}`)) {
                    window.open(url, '_blank');
                }
            }
        });
        count++;
        setStatus(`📥 正在触发下载 ${count}/${total}...`);
        await sleep(1000); // 增加间隔，给浏览器更长的响应时间
    }

    setStatus(`✅ 已触发 ${count} 个文件的下载请求`);
}

// ========== 替代下载方案 (复制链接) ==========
function copyMediaUrls() {
    const media = collectMediaInfo();
    if (!media || (media.images.length === 0 && media.videos.length === 0)) {
        setStatus('❌ 未找到素材链接');
        return;
    }

    const allUrls = [...media.images, ...media.videos].join('\n');

    // 使用创建文本域的方式复制，兼容性更好
    const textArea = document.createElement('textarea');
    textArea.value = allUrls;
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        setStatus(`✅ 已成功复制 ${media.images.length + media.videos.length} 个链接`);
        alert('素材链接已复制到剪贴板，您可以粘贴到 IDM 或其他下载工具中。');
    } catch (err) {
        console.error('复制失败:', err);
        setStatus('❌ 复制链接失败，请手动查看控制台');
        console.log('--- 素材链接列表 ---');
        console.log(allUrls);
    }
    document.body.removeChild(textArea);
}

// ========== 初始化 ==========
// 等待页面加载完成后注入UI
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
} else {
    createUI();
}
}) ();

'use strict';
/**
 * citations.js — 来源引用（Citations）支持
 *  - 在 AI 回复中识别 [1]、[2] 形式的引用标记，渲染为可点击上标
 *  - 消息底部展示引用来源列表（编号、来源名、可点击跳转）
 *  - 点击上标 → 高亮对应来源并滚动到它
 * 数据约定：msg.citations = [{id, title, url}]，正文中用 [n] 引用
 */

(function () {
  const C = {};

  /**
   * 在渲染后的消息内容里把 [n] 转换为可点击引用徽标
   * @param {HTMLElement} root 消息渲染根节点
   * @param {Array} citations [{id,title,url}]
   */
  C.enhanceCitations = function (root, citations) {
    if (!root || !citations || !citations.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue || '';
      if (!/\[\d+\]/.test(text)) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      const re = /\[(\d+)\]/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const idx = parseInt(m[1], 10);
        const cite = citations[idx - 1];
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (cite) {
          const badge = document.createElement('sup');
          badge.className = 'cite-badge';
          badge.textContent = m[0];
          badge.dataset.citeId = cite.id || String(idx);
          badge.title = cite.title || '';
          badge.addEventListener('click', () => {
            highlightCitation(cite, root);
          });
          frag.appendChild(badge);
        } else {
          frag.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  };

  /**
   * 在消息下方渲染来源列表
   * @param {HTMLElement} msgEl 消息节点
   * @param {Array} citations
   */
  // 引用地址来自上游搜索结果,属于第三方数据。escapeHtml 挡得住属性逃逸,
  // 挡不住 javascript: 协议 —— 这里只放行 http(s) 与站内相对地址,其余不生成链接。
  function safeUrl(v) {
    const s = String(v || '').trim();
    return /^(https?:\/\/|\/)/i.test(s) ? s : '';
  }

  C.renderSources = function (msgEl, citations) {
    if (!msgEl || !citations || !citations.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'cite-sources';
    const title = document.createElement('div');
    title.className = 'cite-sources-title';
    title.textContent = '来源 ' + citations.length + ' 个';
    wrap.appendChild(title);
    citations.forEach((cite, i) => {
      const row = document.createElement('a');
      row.className = 'cite-source';
      const href = safeUrl(cite && cite.url);
      if (href) {
        row.href = href;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
      } else {
        // 无可用地址:降级为不可点的文本行,避免把可疑值挂上 href
        row.className = 'cite-source cite-source-static';
      }
      row.innerHTML = '<span class="cite-num">' + (i + 1) + '</span><span class="cite-text">' + escapeHtml(cite.title || cite.url || '来源') + '</span>';
      wrap.appendChild(row);
    });
    msgEl.appendChild(wrap);
  };

  // 高亮来源 + 滚动
  function highlightCitation(cite, root) {
    const msgEl = root ? root.closest('.msg') : null;
    if (msgEl) {
      const rows = msgEl.querySelectorAll('.cite-source');
      rows.forEach((r) => {
        r.classList.remove('flash');
        if (cite && cite.title && r.textContent.includes(cite.title.slice(0, 12))) r.classList.add('flash');
      });
      const sources = msgEl.querySelector('.cite-sources');
      if (sources) sources.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.OCCitations = C;
})();
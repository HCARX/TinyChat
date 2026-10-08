'use strict';
/**
 * multimodal.js — 多模态与高级能力
 *  - 图片上传 + 预览
 *  - 文件上传（PDF/TXT/CSV/MD）+ 文件卡片 + 提取信息
 *  - Artifacts 面板（类 Claude：代码/网页预览独立面板）
 *  - Follow-up 建议问题
 *  - 语音输入接口（预留）
 */

(function () {
  const M = {};

  // ============ 文件类型与图标(线性 SVG) ============
  const FILE_META = {
    image: { svg: window.OC.icon('image', 16), color: '#8b5cf6', label: '图片' },
    pdf: { svg: window.OC.icon('pdf', 16), color: '#ef4444', label: 'PDF' },
    doc: { svg: window.OC.icon('paper', 16), color: '#2563eb', label: '文档' },
    sheet: { svg: window.OC.icon('table', 16), color: '#10b981', label: '表格' },
    slides: { svg: window.OC.icon('file', 16), color: '#f97316', label: '演示' },
    txt: { svg: window.OC.icon('paper', 16), color: '#64748b', label: '文本' },
    csv: { svg: window.OC.icon('table', 16), color: '#10b981', label: '表格' },
    md: { svg: window.OC.icon('markdown', 16), color: '#3b82f6', label: 'Markdown' },
    json: { svg: window.OC.icon('json', 16), color: '#f59e0b', label: 'JSON' },
    code: { svg: window.OC.icon('code', 16), color: '#6366f1', label: '代码' },
    other: { svg: window.OC.icon('file', 16), color: '#94a3b8', label: '文件' },
  };

  function fileTypeInfo(file) {
    const name = file.name || '';
    const ext = name.split('.').pop().toLowerCase();
    if (/png|jpe?g|gif|webp|svg|bmp|avif|jp2/.test(ext)) return { ...FILE_META.image, ext };
    if (ext === 'pdf') return { ...FILE_META.pdf, ext };
    if (/docx?|html?/.test(ext)) return { ...FILE_META.doc, ext };
    if (/xlsx?/.test(ext)) return { ...FILE_META.sheet, ext };
    if (/pptx?/.test(ext)) return { ...FILE_META.slides, ext };
    if (ext === 'txt') return { ...FILE_META.txt, ext };
    if (ext === 'csv') return { ...FILE_META.csv, ext };
    if (ext === 'md' || ext === 'markdown') return { ...FILE_META.md, ext };
    if (ext === 'json') return { ...FILE_META.json, ext };
    if (/js|ts|py|java|c|cpp|go|rs|html|css|php|rb|sh|sql/.test(ext)) return { ...FILE_META.code, ext };
    return { ...FILE_META.other, ext };
  }


  const PARSE_EXT = /^(pdf|png|jpe?g|jp2|webp|gif|bmp|docx?|pptx?|xlsx?|html?)$/;
  function mineruMode() {
    const tools = window.OCState && window.OCState.tools;
    const parse = tools && tools.parse;
    if (parse && parse.source === 'own' && parse.allowOwn) return parse.hasToken ? 'precise' : 'lite';
    const m = (window.OCState && window.OCState.mineru) || {};
    return m.mode === 'precise' ? 'precise' : 'lite';
  }
  function needsMineru(file) {
    const ext = ((file && file.name) || '').split('.').pop().toLowerCase();
    return PARSE_EXT.test(ext);
  }
  function mineruLimitText() {
    if (mineruMode() === 'precise') return '精准解析单文件不超过 200MB、200 页。';
    const own = window.OCState && window.OCState.tools && window.OCState.tools.parse && window.OCState.tools.parse.source === 'own';
    return own
      ? '当前使用你自己的轻量解析：单文件不超过 10MB、20 页。超出时请拆分文件，或填入自己的 MinerU Token。'
      : '当前使用平台轻量解析：单文件不超过 10MB、20 页，同一 IP 每分钟有次数限制。超出时请拆分文件。';
  }
  function mineruTooBig(file) {
    const max = mineruMode() === 'precise' ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
    return file && file.size > max;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /**
   * 读取文件并返回结构化内容（供消息上下文使用）
   * @returns {Promise<{type, name, size, content, dataUrl?, previewUrl?}>}
   */
  async function readFile(file) {
    const meta = fileTypeInfo(file);
    const isImage = meta.ext && /png|jpe?g|gif|webp|svg|bmp|avif/.test(meta.ext);
    if (isImage) {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      // dataUrl 是「给上游模型/给对话页看的那一份」(原图),previewUrl 是「内联进 content 的小图」。
      // 两者为什么必须分开,见下面 buildMessageContent 的长注释。
      const previewUrl = await makePreview(dataUrl);
      return { type: 'image', name: file.name, size: file.size, dataUrl, previewUrl, mediaType: file.type || '', meta };
    }
    // 文本类文件提取内容; PDF / 过大文件只保留文件名
    let content = '';
    const isTextish = meta.ext && /^(txt|csv|md|markdown|json|js|ts|py|java|c|cpp|go|rs|html|css|php|rb|sh|sql)$/.test(meta.ext);
    if (isTextish && file.size < 4 * 1024 * 1024) {
      try {
        content = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = rej;
          fr.readAsText(file);
        });
      } catch (e) { content = ''; }
    }
    return { type: 'file', name: file.name, size: file.size, content, meta };
  }

  /**
   * 构建上传文件的 Markdown 片段（附加到用户消息）
   */
  function toMarkdown(attach) {
    if (attach.type === 'image') {
      return `![${attach.name}](${attach.dataUrl})`;
    }
    const ext = (attach.meta && attach.meta.ext) || '';
    return `**[附件] ${attach.name}**(大小 ${formatSize(attach.size)})\n\n\`\`\`${ext}\n${(attach.content || '').slice(0, 20000)}\n\`\`\``;
  }

  // ============ 内联进消息正文的图片:只能放缩略图 ============
  // 同一张图在消息里有两个去处,用途完全不同,不能混:
  //   - attachments[].dataUrl:原图。对话页据此渲染气泡(见 app.js userMsgDisplay)、
  //     发给上游模型(见 toApiContent)、云同步也带着它(服务端上限 8MB)。
  //   - content 里的 ![](data:...):正文里的内联副本。**聊天分享只带走 role+content**
  //     (服务端 tc_sanitize_share_messages),所以分享页能拿到的图只有这一份 —— 不能省。
  // 但 content 在服务端有 200000 字符上限(见 tc_sanitize_chats),一张 3MB 的图内联进来
  // 就是 400 万字符:既会让每次云同步推上去的载荷凭空大几 MB(服务端随后又把大半截掉),
  // 又会让分享页因为整段被切掉而**完全没有图**。
  // 所以这里内联的是长边 ≤1280 的缩略图(约 100KB 字符),原图仍走 attachments:
  // 分享页有图可看、对话页按原图渲染、云同步载荷与本地副本一起瘦下来。
  const PREVIEW_MAX_EDGE = 1024;
  const PREVIEW_MAX_CHARS = 140000;      // 单张缩略图上限(约 105KB 二进制)
  const CONTENT_IMAGE_BUDGET = 160000;   // 一条消息里内联图片的总上限,给服务端 200000 留余量
  // 缩略图档位:从「够清晰」往下退,命中即停。真实照片第一档就够了;
  // 退到最后一档还超预算(照片类噪声图几乎压不动)才放弃内联。
  const PREVIEW_STEPS = [[1024, 0.7], [1024, 0.5], [768, 0.55], [640, 0.45], [512, 0.4], [384, 0.32], [256, 0.3]];

  let webpOk = null;
  function supportsWebp() {
    if (webpOk !== null) return webpOk;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      // 不支持时浏览器会退回 png,按返回的 mime 判断即可
      webpOk = /^data:image\/webp/i.test(c.toDataURL('image/webp', 0.5));
    } catch (e) { webpOk = false; }
    return webpOk;
  }

  function encodeScaled(img, maxEdge, quality, mime) {
    let w = img.naturalWidth || img.width || 0;
    let h = img.naturalHeight || img.height || 0;
    if (!w || !h) return '';                    // 尺寸读不到(SVG 未声明宽高等):放弃缩略图
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    // JPEG 没有透明通道:先铺白底,免得透明 PNG 转出来是黑块
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    try { return c.toDataURL(mime, quality) || ''; } catch (e) { return ''; }
  }

  /**
   * 生成可内联进 content 的缩略图。返回 '' 表示这次拿不到缩略图,
   * 调用方就**不内联**(分享页少一张图,总好过一屏 base64 乱码)。
   */
  function makePreview(dataUrl) {
    return new Promise((resolve) => {
      const src = String(dataUrl || '');
      if (!/^data:image\//i.test(src)) return resolve('');
      if (src.length <= PREVIEW_MAX_CHARS) return resolve(src);  // 本来就小:原样内联(保真,动图还能动)
      if (/^data:image\/gif/i.test(src)) return resolve('');     // 动图重编码只剩一帧,不如不动它
      const img = new Image();
      img.onload = () => {
        try {
          const mime = supportsWebp() ? 'image/webp' : 'image/jpeg';
          for (const step of PREVIEW_STEPS) {
            const out = encodeScaled(img, step[0], step[1], mime);
            if (out && out.length <= PREVIEW_MAX_CHARS && /^data:image\/(webp|jpeg)/i.test(out)) return resolve(out);
          }
          resolve('');
        } catch (e) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }

  /** 内联用的图片片段:优先缩略图;拿不到缩略图就不内联(返回空串) */
  function toMarkdownPreview(attach) {
    if (!attach || attach.type !== 'image') return toMarkdown(attach);
    const url = attach.previewUrl || '';
    if (!url) return '';
    return `![${attach.name}](${url})`;
  }

  /**
   * 组装一条用户消息的 content:正文 + 附件片段(图片用缩略图,并在总预算内)。
   * 预算按「正文长度 + 已内联图片」实时扣减,保证整条 content 不超过服务端 200000 的
   * 截断线 —— 否则尾部的图片会被服务端整段切掉,分享页就看不到图了。
   */
  function buildMessageContent(text, attachments, opts) {
    opts = opts || {};
    const parts = [];
    const head = String(text || '').trim();
    if (head) parts.push(head);
    let budget = (typeof opts.inlineBudget === 'number' ? opts.inlineBudget : CONTENT_IMAGE_BUDGET) - head.length;
    (Array.isArray(attachments) ? attachments : []).forEach((a) => {
      if (!a) return;
      if (a.type === 'image') {
        const md = toMarkdownPreview(a);
        // 空串 = 没缩略图;超预算 = 内联它会挤掉后面的图。两种都不内联:
        // 对话页照旧从 attachments 还原原图,用户看到的内容不受影响。
        if (!md || md.length > budget) return;
        budget -= md.length;
        parts.push(md);
        return;
      }
      parts.push(toMarkdown(a));
    });
    return parts.join('\n\n') || (opts.fallback || '（附件）');
  }

  function imageMediaType(attach) {
    if (attach.mediaType && /^image\//i.test(attach.mediaType)) return attach.mediaType;
    const ext = ((attach.meta && attach.meta.ext) || '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'avif') return 'image/avif';
    const m = String(attach.dataUrl || '').match(/^data:([^;]+);/);
    return (m && m[1]) || 'image/png';
  }

  function fileExcerpt(attach) {
    const ext = (attach.meta && attach.meta.ext) || '';
    return '【附件 ' + (attach.name || 'file') + '，大小 ' + formatSize(attach.size || 0) + '】\n```' + ext + '\n' + String(attach.content || '').slice(0, 20000) + '\n```';
  }

  /**
   * 把文本 + 附件转成上游 API 的 content。
   * 有图片时走多模态数组；只有文本/文件时仍返回字符串。
   */
  function toApiContent(text, attachments, format) {
    const atts = Array.isArray(attachments) ? attachments : [];
    // imageAsText:图片已经过 MinerU 提取文字(当前模型不支持图片输入),按文本附件发送
    const images = atts.filter((a) => a && a.type === 'image' && a.dataUrl && !a.imageAsText);
    const files = atts.filter((a) => a && (a.type !== 'image' || a.imageAsText));
    const fileText = files.map(fileExcerpt).join('\n\n');
    const prompt = [String(text || '').trim(), fileText].filter(Boolean).join('\n\n');
    if (!images.length) return prompt || '请查看附件';

    if (format === 'completions') {
      const names = images.map((img) => '[图片 ' + (img.name || 'image') + ']').join('\n');
      return [prompt, names].filter(Boolean).join('\n\n');
    }

    if (format === 'anthropic') {
      const parts = [];
      if (prompt) parts.push({ type: 'text', text: prompt });
      images.forEach((img) => {
        const raw = String(img.dataUrl).replace(/^data:[^;]+;base64,/, '');
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: imageMediaType(img), data: raw },
        });
      });
      return parts;
    }

    if (format === 'responses') {
      const parts = [];
      if (prompt) parts.push({ type: 'input_text', text: prompt });
      images.forEach((img) => {
        parts.push({ type: 'input_image', image_url: img.dataUrl });
      });
      return parts;
    }

    const parts = [];
    if (prompt) parts.push({ type: 'text', text: prompt });
    images.forEach((img) => {
      parts.push({
        type: 'image_url',
        image_url: { url: img.dataUrl },
      });
    });
    return parts;
  }

  // ============ 上传按钮界面 ============
  function createUploadButton(onAttach) {
    const btn = document.createElement('div');
    btn.className = 'attach-btn' + (navigator.maxTouchPoints ? '' : '');
    btn.title = '上传图片或文件';
    btn.innerHTML = window.OC.icon('paperclip', 22);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf,.txt,.csv,.md,.json,.js,.ts,.py,.html,.css,.sql,.doc,.docx,.ppt,.pptx,.xls,.xlsx';
    input.multiple = true;
    input.style.display = 'none';
    btn.appendChild(input);

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.value = '';
      for (const f of files) {
        try {
          const attach = await readFile(f);
          if (onAttach) await onAttach(attach, f);
        } catch (e) {
          console.error('读取文件失败', e);
          if (window.toast) window.toast('读取文件失败: ' + f.name, true);
        }
      }
    });
    return { btn, input };
  }

  // ============ Artifacts 面板 ============
  /**
   * 打开 Artifacts 面板（类 Claude Canvas）
   * @param {{type:'html'|'code'|'svg'|'text', title, content}} artifact
   */
  function openArtifact(artifact) {
    let panel = document.querySelector('.artifact-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'artifact-panel';
      document.body.appendChild(panel);
    }
    const type = artifact.type || 'html';
    let body = '';
    if (type === 'html' || type === 'svg') {
      // SVG 与 HTML 走同一条沙箱路径:两者都是「可执行文档」。
      // 此前 SVG 分支把模型内容直接拼进 innerHTML,而渲染管线的消毒白名单刻意不放行
      // SVG 命名空间(SVG 里的事件如 <animate onbegin=…> 只在 SVG 生效,是 mXSS 的经典载体),
      // 于是它成了唯一绕过消毒的注入点。放进 sandbox 的 iframe 后,脚本拿不到同源上下文,
      // 也碰不到父页面。不给 allow-same-origin,避免内容读写父页的存储与 DOM。
      // 注意整个文档都要按属性转义(srcdoc 是属性值),否则内层的引号会截断属性。
      const doc = type === 'svg'
        ? '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%}</style>'
          + (artifact.content || '')
        : (artifact.content || '');
      body = '<iframe class="artifact-frame" sandbox="allow-scripts" srcdoc="' + escapeAttr(doc) + '"></iframe>';
    } else if (type === 'code') {
      body = '<pre class="artifact-code">' + escapeHtml(artifact.content || '') + '</pre>';
    } else {
      body = '<div class="artifact-text">' + escapeHtml(artifact.content || '') + '</div>';
    }
    panel.innerHTML = '<div class="artifact-header"><span class="artifact-title">' + escapeHtml(artifact.title || 'Artifact')
      + '</span><div class="artifact-actions">'
      + '<button class="artifact-btn" data-copy>复制</button>'
      + '<button class="artifact-btn" data-download>下载</button>'
      + '<button class="artifact-btn" data-close>关闭</button></div></div>'
      + '<div class="artifact-body">' + body + '</div>';
    panel.classList.add('show');

    panel.querySelector('[data-close]').addEventListener('click', () => panel.classList.remove('show'));
    panel.querySelector('[data-copy]').addEventListener('click', async () => {
      const text = artifact.content || '';
      try { await navigator.clipboard.writeText(text); if (window.toast) window.toast('已复制'); }
      catch (e) { window.toast('复制失败', true); }
    });
    panel.querySelector('[data-download]').addEventListener('click', () => {
      const blob = new Blob([artifact.content || ''], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (artifact.title || 'artifact').replace(/[^\w.\-]+/g, '_') + '.' + (type === 'html' ? 'html' : 'txt');
      a.click();
      URL.revokeObjectURL(a.href);
    });

    // 渲染内部组件
    if (type !== 'html') {
      const bodyEl = panel.querySelector('.artifact-body');
      if (window.OCRenderer) OCRenderer.enhance(bodyEl);
    }
  }

  // ============ Artifact 检测与快捷打开 ============
  /**
   * 扫描消息容器中的代码块，为 HTML/SVG 代码附加「在 Artifacts 中打开」按钮
   * @param {HTMLElement} container
   */
  function enhanceArtifactButtons(container) {
    if (!container) return;
    container.querySelectorAll('.code-block').forEach((block) => {
      const lang = block.getAttribute('data-lang') || '';
      if (lang !== 'html' && lang !== 'svg') return;
      if (block.querySelector('.artifact-open-btn')) return;
      const pre = block.querySelector('pre');
      if (!pre) return;
      const btn = document.createElement('button');
      btn.className = 'artifact-open-btn';
      btn.textContent = lang === 'html' ? '在 Artifacts 中预览' : '在 Artifacts 中查看';
      btn.addEventListener('click', () => {
        openArtifact({
          type: lang === 'html' ? 'html' : 'svg',
          title: lang.toUpperCase() + ' Artifact',
          content: pre.textContent,
        });
      });
      const header = block.querySelector('.code-header');
      if (header) header.appendChild(btn);
    });
  }

  // ============ Follow-up 建议问题 ============
  function renderFollowUps(container, suggestions, onPick) {
    if (!suggestions || !suggestions.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'follow-ups';
    const label = document.createElement('div');
    label.className = 'follow-ups-label';
    label.textContent = '相关追问';
    wrap.appendChild(label);
    suggestions.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'follow-up-btn';
      btn.textContent = s;
      btn.addEventListener('click', () => { if (onPick) onPick(s); });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  }

  // ============ 语音输入（预留接口） ============
  const VoiceInput = {
    supported: typeof window.SpeechRecognition !== 'undefined' || typeof window.webkitSpeechRecognition !== 'undefined',
    _recognition: null,
    _onResult: null,
    start(onResult) {
      if (!this.supported) { if (window.toast) window.toast('当前浏览器不支持语音输入', true); return; }
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      this._recognition = new SR();
      this._recognition.lang = 'zh-CN';
      this._recognition.continuous = false;
      this._recognition.interimResults = false;
      this._onResult = onResult;
      this._recognition.onresult = (e) => {
        const text = e.results[0][0].transcript;
        if (this._onResult) this._onResult(text);
      };
      this._recognition.onerror = () => { if (window.toast) window.toast('语音识别失败', true); };
      try { this._recognition.start(); } catch (e) {}
    },
    stop() {
      if (this._recognition) { try { this._recognition.stop(); } catch (e) {} }
    },
  };

  // ============ 暴露 ============
  window.OCMultimodal = {
    readFile, toMarkdown, toApiContent, formatSize, fileTypeInfo, createUploadButton,
    needsMineru, mineruLimitText, mineruTooBig, mineruMode,
    openArtifact, enhanceArtifactButtons, renderFollowUps, VoiceInput,
    // 正文内联图片相关:toMarkdownPreview 单张, buildMessageContent 整条(带预算)
    toMarkdownPreview, buildMessageContent, makePreview,
    PREVIEW_MAX_CHARS, CONTENT_IMAGE_BUDGET,
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
})();
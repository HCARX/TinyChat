/* 模型/供应商图标解析:按关键词匹配 static/logo 下的 SVG。
 * 用法:
 *   OC.modelLogo('deepseek/deepseek-v4-flash') -> 'static/logo/deepseek-color.svg'
 *   OC.providerLogo(provider.models, provider.name) -> 命中关键词最多的图标
 *   OC.chatLogo(chat) -> 会话最近使用的模型图标
 *
 * 匹配机制:
 *   - 关键词在「原文小写」与「去掉分隔符的紧凑形式」两路各匹配一次,
 *     因此 agnes-ai / Agnes AI / agnes_ai 都能命中 agnes;
 *   - 规则可带第三个字段「优先级」,默认 0,数值大者优先;
 *     公司层 / 聚合层图标(anthropic、google、bytedance 等)标为 -1,
 *     这样 "claude-... Anthropic" 显示 Claude 而不是 Anthropic 图标;
 *   - 同优先级下取「最长关键词」,更具体者优先;
 *   - 规则目标文件必须真实存在(见 FILES),写错文件名不会静默回退到站点 logo,
 *     而是跳过该规则并在控制台告警,避免「改了名字却一直是默认图」这类问题;
 *   - 只有纯字母数字的关键词才走紧凑匹配,含 - . _ 的关键词(如 o1- / seed-oss / gen-4)
 *     只在原文里匹配,防止误伤。
 */
(function () {
  'use strict';
  const BASE = 'static/logo/';

  // static/logo 下现有的图标文件清单:用于校验规则目标是否存在。
  // 新增图标时把文件名补进来即可(缺失会在控制台告警,并在 CI 的 logos 校验里直接失败)。
  const FILES = {
    'agnesai.svg': 1, 'aihubmix-color.svg': 1, 'aimass-color.svg': 1,
    'anthropic.svg': 1, 'antigravity-color.svg': 1, 'app-icon.svg': 1, 'apple.svg': 1,
    'azureai-color.svg': 1, 'baichuan-color.svg': 1, 'baidu-color.svg': 1, 'bocha-color.svg': 1,
    'brave-color.svg': 1, 'bytedance-color.svg': 1, 'claude-color.svg': 1,
    'cohere-color.svg': 1, 'copilot-color.svg': 1, 'dalle-color.svg': 1, 'deepmind-color.svg': 1,
    'deepseek-color.svg': 1, 'doubao-color.svg': 1, 'fastgpt-color.svg': 1, 'fireworks-color.svg': 1,
    'flux.svg': 1, 'gemini-color.svg': 1, 'gemma-color.svg': 1, 'google-color.svg': 1,
    'grok.svg': 1, 'groq.svg': 1, 'huggingface-color.svg': 1, 'hunyuan-color.svg': 1,
    'kimi-color.svg': 1, 'kling-color.svg': 1, 'longcat-color.svg': 1, 'luma-color.svg': 1,
    'meta-color.svg': 1, 'microsoft-color.svg': 1, 'midjourney.svg': 1, 'minimax-color.svg': 1,
    'mistral-color.svg': 1, 'monica-color.svg': 1, 'nanobanana-color.svg': 1, 'ollama.svg': 1,
    'openai.svg': 1, 'openrouter-color.svg': 1, 'perplexity-color.svg': 1, 'picture.svg': 1, 'qingyan-color.svg': 1,
    'qwen-color.svg': 1, 'replicate.svg': 1, 'runway.svg': 1, 'searxng-color.svg': 1,
    'stability-color.svg': 1, 'suno.svg': 1, 'tavily-color.svg': 1, 'tiangong-color.svg': 1,
    'together-color.svg': 1, 'vertexai-color.svg': 1, 'wenxin-color.svg': 1, 'xiaomimimo.svg': 1,
    'yi-color.svg': 1, 'yuanbao-color.svg': 1, 'zai.svg': 1, 'zhipu-color.svg': 1, 'zhipu-glm-color.svg': 1,
    // 功能图标与登录方式图标:虽不参与关键词匹配,但需登记,否则会被当成缺失文件
    'video-camera.svg': 1, 'qq.svg': 1, 'weixin.svg': 1,
  };

  // [关键词, 图标文件, 优先级?];优先级默认 0,数值大者优先。
  // 标记 -1 的是「公司层 / 聚合层」图标:当同一段文本也命中具体模型品牌时让位,
  // 例如 "claude-3-5-sonnet … Anthropic" 应显示 Claude 图标而非 Anthropic。
  const COMPANY = -1;
  const RULES = [
    ['deepseek', 'deepseek-color.svg'],
    ['kimi', 'kimi-color.svg'],
    ['moonshot', 'kimi-color.svg'],
    ['chatglm', 'zhipu-glm-color.svg'],
    ['zhipu', 'zhipu-color.svg'],
    ['glm', 'zhipu-color.svg'],
    ['zai', 'zai.svg', COMPANY],
    ['claude', 'claude-color.svg'],
    ['sonnet', 'claude-color.svg'],
    ['opus', 'claude-color.svg'],
    ['haiku', 'claude-color.svg'],
    ['anthropic', 'anthropic.svg', COMPANY],
    ['gemini', 'gemini-color.svg'],
    ['gemma', 'gemma-color.svg'],
    ['vertex', 'vertexai-color.svg'],
    ['deepmind', 'deepmind-color.svg', COMPANY],
    ['google', 'google-color.svg', COMPANY],
    ['dall-e', 'dalle-color.svg'],
    ['dalle', 'dalle-color.svg'],
    ['openai', 'openai.svg'],
    ['chatgpt', 'openai.svg'],
    ['codex', 'openai.svg'],
    ['sora', 'openai.svg'],
    ['o4-', 'openai.svg'],
    ['o3-', 'openai.svg'],
    ['o1-', 'openai.svg'],
    ['gpt', 'openai.svg'],
    ['qwen', 'qwen-color.svg'],
    ['qwq', 'qwen-color.svg'],
    ['qvq', 'qwen-color.svg'],
    ['tongyi', 'qwen-color.svg'],
    ['doubao', 'doubao-color.svg'],
    ['seedance', 'doubao-color.svg'],
    ['seedream', 'doubao-color.svg'],
    ['seed-oss', 'doubao-color.svg'],
    ['bytedance', 'bytedance-color.svg', COMPANY],
    ['minimax', 'minimax-color.svg'],
    ['abab', 'minimax-color.svg'],
    ['hunyuan', 'hunyuan-color.svg'],
    ['yuanbao', 'yuanbao-color.svg'],
    ['wenxin', 'wenxin-color.svg'],
    ['ernie', 'wenxin-color.svg'],
    ['qingyan', 'qingyan-color.svg'],
    ['baidu', 'baidu-color.svg', COMPANY],
    ['mistral', 'mistral-color.svg'],
    ['mixtral', 'mistral-color.svg'],
    ['llama', 'meta-color.svg'],
    ['meta-', 'meta-color.svg', COMPANY],
    ['phi-', 'microsoft-color.svg'],
    ['microsoft', 'microsoft-color.svg', COMPANY],
    ['azure', 'azureai-color.svg'],
    ['copilot', 'copilot-color.svg'],
    ['grok', 'grok.svg'],
    ['groq', 'groq.svg'],
    ['command-r', 'cohere-color.svg'],
    ['command', 'cohere-color.svg'],
    ['coral', 'cohere-color.svg'],
    ['cohere', 'cohere-color.svg'],
    ['perplexity', 'perplexity-color.svg'],
    ['sonar', 'perplexity-color.svg'],
    ['stable-diffusion', 'stability-color.svg'],
    ['stability', 'stability-color.svg'],
    ['sdxl', 'stability-color.svg'],
    ['sd3', 'stability-color.svg'],
    ['flux', 'flux.svg'],
    ['midjourney', 'midjourney.svg'],
    ['niji', 'midjourney.svg'],
    ['runway', 'runway.svg'],
    ['gen-3', 'runway.svg'],
    ['gen-4', 'runway.svg'],
    ['luma', 'luma-color.svg'],
    ['ray-2', 'luma-color.svg'],
    ['kling', 'kling-color.svg'],
    ['suno', 'suno.svg'],
    ['nano-banana', 'nanobanana-color.svg'],
    ['nanobanana', 'nanobanana-color.svg'],
    ['baichuan', 'baichuan-color.svg'],
    ['tiangong', 'tiangong-color.svg'],
    ['longcat', 'longcat-color.svg'],
    ['xiaomi', 'xiaomimimo.svg', COMPANY],
    ['mimo', 'xiaomimimo.svg'],
    ['lingyi', 'yi-color.svg'],
    ['yi-', 'yi-color.svg'],
    ['ollama', 'ollama.svg'],
    ['openrouter', 'openrouter-color.svg', COMPANY],
    ['huggingface', 'huggingface-color.svg', COMPANY],
    ['together', 'together-color.svg', COMPANY],
    ['fireworks', 'fireworks-color.svg', COMPANY],
    ['hubmix', 'aihubmix-color.svg'],
    ['bocha', 'bocha-color.svg'],
    ['brave', 'brave-color.svg'],
    ['tavily', 'tavily-color.svg'],
    ['searx', 'searxng-color.svg'],
    ['fastgpt', 'fastgpt-color.svg'],
    ['monica', 'monica-color.svg'],
    ['antigravity', 'antigravity-color.svg'],
    ['apple', 'apple.svg'],
    ['aimass', 'aimass-color.svg'],
    ['agnesai', 'agnesai.svg'],
    ['agnes', 'agnesai.svg'],
    ['replicate', 'replicate.svg', COMPANY],
  ];

  // 紧凑形式:去掉分隔符,便于 agnes-ai / Agnes AI / agnes_ai 统一匹配
  const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const isPlain = (kw) => /^[a-z0-9]+$/.test(kw);

  // 校验规则目标文件存在;缺失时跳过并告警,避免静默错误
  const VALID = [];
  const missing = [];
  RULES.forEach((r) => {
    if (!FILES[r[1]]) { missing.push(r[0] + ' -> ' + r[1]); return; }
    VALID.push({ kw: r[0], file: r[1], prio: typeof r[2] === 'number' ? r[2] : 0, plain: isPlain(r[0]) });
  });
  if (missing.length && typeof console !== 'undefined' && console.warn) {
    console.warn('[logos] 以下规则指向不存在的图标,已跳过:', missing.join(', '));
  }

  // 返回文本命中的最具体图标文件:先比优先级,再比关键词长度;未命中返回 ''
  function matchRule(text) {
    const raw = String(text || '').toLowerCase();
    if (!raw) return '';
    const cmp = compact(raw);
    let best = null;
    for (let i = 0; i < VALID.length; i++) {
      const r = VALID[i];
      if (best && r.prio < best.prio) continue;                       // 优先级更低,跳过
      if (best && r.prio === best.prio && r.kw.length <= best.len) continue;
      const hit = r.plain ? (raw.indexOf(r.kw) >= 0 || cmp.indexOf(r.kw) >= 0) : (raw.indexOf(r.kw) >= 0);
      if (hit) best = { file: r.file, prio: r.prio, len: r.kw.length };
    }
    return best ? best.file : '';
  }

  const url = (file) => (file ? BASE + file : '');
  const cache = new Map();
  // 未命中任何关键词时回退到站点 logo(HTML 由 OC.logoImg 输出,深浅主题自动切换)
  const SITE_LOGO = ':site:';
  // 生图模型统一使用 picture.svg 作为头像/图标
  const IMAGE_LOGO = url('picture.svg');
  // 生视频模型统一使用 video-camera.svg 作为头像/图标
  const VIDEO_LOGO = url('video-camera.svg');

  function modelLogo(text) {
    const key = String(text || '').toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const file = matchRule(key);
    const u = file ? url(file) : SITE_LOGO;
    cache.set(key, u);
    return u;
  }

  // 供渲染端统一生成 <img>:普通 URL 单图;站点 logo 输出深浅双图,靠 brand-logo-light/dark 类随主题切换
  function logoImg(icon, cls) {
    if (!icon) return '';
    if (icon === SITE_LOGO) {
      return '<img class="' + cls + ' brand-logo-light" src="./logo.svg" alt="" loading="lazy">'
        + '<img class="' + cls + ' brand-logo-dark" src="./logo-dark.svg" alt="" loading="lazy">';
    }
    return '<img class="' + cls + '" src="' + icon + '" alt="" loading="lazy">';
  }

  const modelText = (m) => {
    if (typeof m === 'string') return m;
    if (!m || typeof m !== 'object') return '';
    return String(m.id || m.name || '') + ' ' + String(m.name || '');
  };

  // 供应商图标:每个模型只投一票给「最具体」的图标,统计票数取最高者;
  // 一个都没命中时,退回按供应商名匹配。
  function providerLogo(models, providerName) {
    const counts = new Map();
    (Array.isArray(models) ? models : []).forEach((m) => {
      const file = matchRule(modelText(m));
      if (file) counts.set(file, (counts.get(file) || 0) + 1);
    });
    let bestFile = '';
    let bestN = 0;
    counts.forEach((n, file) => {
      if (n > bestN || (n === bestN && file < bestFile)) { bestFile = file; bestN = n; }
    });
    if (bestFile) return url(bestFile);
    return modelLogo(providerName || '');
  }

  // 模型优先、供应商兜底:先用模型 id/名匹配,未命中才退回供应商名。
  // 避免把两者拼成一段文本后,供应商品牌的关键词比模型更长而「盖过」具体模型
  // (例如供应商叫 "Agnes AI"、模型是 claude-3-5-sonnet 时应显示 Claude)。
  function modelLogoWithFallback(modelText, providerName) {
    const file = matchRule(modelText);
    if (file) return url(file);
    if (providerName) return modelLogo(providerName);
    return SITE_LOGO;
  }

  // 会话图标:取最后一条带模型信息的消息;生图/生视频会话分别用 picture.svg / video-camera.svg,
  // 其余按模型名匹配品牌图标;没有模型信息或未命中时用站点 logo
  function chatLogo(chat) {
    const msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const model = m && typeof m === 'object' ? String(m.model || '') : '';
      if (!model) continue;
      if (/\(视频\)\s*$/.test(model)) return VIDEO_LOGO;
      if (/\(图像\)\s*$/.test(model)) return IMAGE_LOGO;
      return modelLogo(model);
    }
    return SITE_LOGO;
  }

  // 图标选择:生图模型统一用 picture.svg,生视频统一用 video-camera.svg;否则按模型名匹配品牌图标。
  // isImage / isVideo 未显式传入时,回退到 OC.isImageModelName / OC.isVideoModelName(由 components.js 提供)按名称判断。
  function modelIcon(text, providerName, isImage, isVideo) {
    const imgFlag = isImage !== undefined
      ? !!isImage
      : !!(window.OC && window.OC.isImageModelName && window.OC.isImageModelName(text));
    if (imgFlag) return IMAGE_LOGO;
    const vidFlag = isVideo !== undefined
      ? !!isVideo
      : !!(window.OC && window.OC.isVideoModelName && window.OC.isVideoModelName(text));
    if (vidFlag) return VIDEO_LOGO;
    return modelLogoWithFallback(text, providerName);
  }

  window.OC = window.OC || {};
  window.OC.modelLogo = modelLogo;
  window.OC.modelLogoWithFallback = modelLogoWithFallback;
  window.OC.modelIcon = modelIcon;
  window.OC.imageLogo = () => IMAGE_LOGO;
  window.OC.videoLogo = () => VIDEO_LOGO;
  window.OC.siteLogo = () => SITE_LOGO;
  window.OC.providerLogo = providerLogo;
  window.OC.chatLogo = chatLogo;
  window.OC.logoImg = logoImg;
  // 供测试/排查使用:命中的图标文件(不含前缀),未命中为 ''
  window.OC.logoMatch = matchRule;
  window.OC.logoMissingRules = missing.slice();
})();

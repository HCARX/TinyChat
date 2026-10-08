<?php
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/api.php';

function tc_endpoints() {
    return array(
        'chat' => '/chat/completions',
        'completions' => '/completions',
        'responses' => '/responses',
        'anthropic' => '/messages',
    );
}

function tc_upstream_path($baseUrl, $format) {
    $ends = tc_endpoints();
    $endpoint = isset($ends[$format]) ? $ends[$format] : $ends['chat'];
    return tc_api_url($baseUrl, $endpoint);
}

// 出站前的统一 SSRF 闸门。凡是把「用户/管理员填写的地址」交给 tc_http_request 的地方
// 都必须先过这里:供应商 Base URL、用户自备检索源、生图/生视频地址等。
// 之前只有对话与连通性测试两处做了检查,生图/生视频/获取模型列表/用户自备 SearXNG
// 都漏了,等于把「读内网服务」的能力交给任何能填地址的人(云上可直取 169.254.169.254)。
// 失败一律按 400 处理并给出可行动的文案。
function tc_upstream_guard($url, $what = '供应商地址') {
    if (!tc_upstream_url_is_safe($url)) {
        tc_fail(400, $what . '不可用:不允许请求内网或保留地址(仅支持 80/443/8080/8443 的公网地址)');
    }
    return $url;
}

// 拼一个上游接口地址:baseUrl 已带版本段(如 /v1)就直接拼,否则补上 /v1。
// 生图、获取模型等路径都必须走这里,否则用户按平台文档填「不带 /v1 的 Base URL」时会拼错路径(404)。
function tc_api_url($baseUrl, $path) {
    $base = rtrim(trim((string) $baseUrl), '/');
    if ($base === '') return (string) $path;
    $p = '/' . ltrim((string) $path, '/');
    // 已含版本段(/v1、/v1beta、/v2…):直接拼接
    if (preg_match('#/v\d+[a-z]*$#i', $base)) return $base . $p;
    // 若 base 尾部已包含要拼的路径段(如用户填了 .../v1/images/generations),不再重复
    if (preg_match('#/images/generations$#i', $base) && stripos($p, 'images/generations') !== false) return $base;
    if (preg_match('#/models$#i', $base) && stripos($p, 'models') !== false) return $base;
    if (preg_match('#/chat/completions$#i', $base) && stripos($p, 'chat/completions') !== false) return $base;
    return $base . '/v1' . $p;
}

define('TC_MINERU_LITE', 'https://mineru.net/api/v1/agent');
define('TC_MINERU_PRECISE', 'https://mineru.net/api/v4');

function tc_mineru_ext($name) {
    $base = strtolower(pathinfo((string) $name, PATHINFO_EXTENSION));
    return preg_replace('/[^a-z0-9]/', '', $base);
}

function tc_mineru_parseable($name) {
    return in_array(tc_mineru_ext($name), array('pdf', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html', 'htm'), true);
}

function tc_mineru_safe_name($name) {
    $base = basename(str_replace(chr(92), '/', (string) $name));
    $base = preg_replace('/[^\p{L}\p{N}._\- ()]+/u', '_', $base);
    $base = trim((string) $base, " ._");
    if ($base === '' || $base === '.' || $base === '..') $base = 'document.pdf';
    if (function_exists('mb_substr')) $base = mb_substr($base, 0, 120, 'UTF-8');
    else $base = substr($base, 0, 120);
    return $base;
}

function tc_mineru_json($url, $method, $headers, $body, $timeoutMs) {
    $res = tc_http_request($url, $method, $headers, $body, $timeoutMs);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    $json = json_decode(isset($res['body']) ? $res['body'] : '', true);
    if (!is_array($json)) {
        if ($status === 429) return array('ok' => false, 'error' => 'MinerU 请求过于频繁，请稍后再试', 'code' => 429);
        return array('ok' => false, 'error' => 'MinerU 返回无法解析 (HTTP ' . $status . ')', 'code' => 502);
    }
    $code = isset($json['code']) ? (int) $json['code'] : 0;
    if ($status === 429 || $code === 429) return array('ok' => false, 'error' => 'MinerU 请求过于频繁，请稍后再试', 'code' => 429);
    if ($status >= 400 || $code !== 0) {
        $msg = isset($json['msg']) ? (string) $json['msg'] : '';
        if ($msg === '' && isset($json['message'])) $msg = (string) $json['message'];
        if ($msg === '') $msg = 'MinerU 请求失败 (HTTP ' . $status . ')';
        return array('ok' => false, 'error' => $msg, 'code' => $status >= 400 ? $status : 502);
    }
    return array('ok' => true, 'data' => isset($json['data']) && is_array($json['data']) ? $json['data'] : array());
}

function tc_mineru_put_file($url, $bytes, $timeoutMs) {
    $res = tc_http_request($url, 'PUT', array(), $bytes, $timeoutMs, false, null, false);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    if ($status < 200 || $status >= 300) return array('ok' => false, 'error' => '文件上传到 MinerU 失败 (HTTP ' . $status . ')', 'code' => 502);
    return array('ok' => true);
}

function tc_mineru_state_of($data, $batch) {
    if (!$batch) return isset($data['state']) ? (string) $data['state'] : '';
    $rows = isset($data['extract_result']) && is_array($data['extract_result']) ? $data['extract_result'] : array();
    $row = isset($rows[0]) && is_array($rows[0]) ? $rows[0] : array();
    return isset($row['state']) ? (string) $row['state'] : '';
}

function tc_mineru_poll($url, $headers, $deadline, $batch) {
    $sleep = 1;
    while (time() < $deadline) {
        $res = tc_mineru_json($url, 'GET', $headers, null, 20000);
        if (empty($res['ok'])) return $res;
        $data = $res['data'];
        $state = tc_mineru_state_of($data, $batch);
        if ($state === 'done') {
            if ($batch) {
                $rows = $data['extract_result'];
                $zip = isset($rows[0]['full_zip_url']) ? (string) $rows[0]['full_zip_url'] : '';
                if ($zip === '') return array('ok' => false, 'error' => 'MinerU 已完成但没有返回结果包', 'code' => 502);
                return array('ok' => true, 'url' => $zip, 'zip' => true);
            }
            $md = isset($data['markdown_url']) ? (string) $data['markdown_url'] : '';
            if ($md === '') return array('ok' => false, 'error' => 'MinerU 已完成但没有返回 Markdown', 'code' => 502);
            return array('ok' => true, 'url' => $md, 'zip' => false);
        }
        if ($state === 'failed') {
            $msg = '';
            if ($batch && isset($data['extract_result'][0]['err_msg'])) $msg = (string) $data['extract_result'][0]['err_msg'];
            if ($msg === '' && isset($data['err_msg'])) $msg = (string) $data['err_msg'];
            if ($msg === '') $msg = '文档解析失败';
            return array('ok' => false, 'error' => $msg, 'code' => 422);
        }
        sleep($sleep);
        if ($sleep < 3) $sleep++;
    }
    return array('ok' => false, 'error' => '文档解析超时，请稍后重试或缩小文件', 'code' => 504);
}

function tc_zip_slice($b, $o, $n) { return substr($b, $o, $n); }
function tc_zip_u16($b, $o) { $v = unpack("v", tc_zip_slice($b, $o, 2)); return $v ? (int) $v[1] : 0; }
function tc_zip_u32($b, $o) { $v = unpack("V", tc_zip_slice($b, $o, 4)); return $v ? (int) $v[1] : 0; }

function tc_zip_read_stored($b, $offset, $nameLen, $extraLen, $size) {
    $start = $offset + 30 + $nameLen + $extraLen;
    return substr($b, $start, $size);
}

function tc_zip_inflate($bytes) {
    $out = @gzinflate($bytes);
    if ($out !== false) return $out;
    return @gzuncompress($bytes);
}

function tc_zip_find_markdown($b) {
    $len = strlen($b);
    $pos = 0;
    $best = '';
    $full = '';
    while ($pos + 30 <= $len) {
        if (substr($b, $pos, 4) !== "PK") break;
        $method = tc_zip_u16($b, $pos + 8);
        $comp = tc_zip_u32($b, $pos + 20);
        $nameLen = tc_zip_u16($b, $pos + 28);
        $extraLen = tc_zip_u16($b, $pos + 30);
        if ($nameLen < 0 || $extraLen < 0 || $comp < 0) break;
        $nameAt = $pos + 32;
        if ($nameAt + $nameLen + $extraLen + $comp > $len) break;
        $name = substr($b, $nameAt, $nameLen);
        $data = substr($b, $nameAt + $nameLen + $extraLen, $comp);
        $pos = $nameAt + $nameLen + $extraLen + $comp;
        if (!preg_match('/\.md$/i', $name)) continue;
        if ($method === 0) $text = $data;
        elseif ($method === 8) $text = tc_zip_inflate($data);
        else continue;
        if (!is_string($text) || trim($text) === '') continue;
        if (preg_match('#(^|/)full\.md$#i', $name)) { $full = $text; break; }
        if ($best === '' || strlen($text) > strlen($best)) $best = $text;
    }
    $text = $full !== '' ? $full : $best;
    if (trim($text) === '') return array('ok' => false, 'error' => '结果包里没有 Markdown', 'code' => 502);
    return array('ok' => true, 'markdown' => $text);
}

function tc_mineru_fetch_text($url) {
    if (!preg_match('#^https://#i', (string) $url)) return array('ok' => false, 'error' => '解析结果地址无效', 'code' => 502);
    $res = tc_http_request($url, 'GET', array('Accept' => '*/*'), null, 30000);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    if ($status < 200 || $status >= 300) return array('ok' => false, 'error' => '下载解析结果失败 (HTTP ' . $status . ')', 'code' => 502);
    $body = isset($res['body']) ? (string) $res['body'] : '';
    if (strncmp($body, "PK\x03\x04", 4) === 0) return tc_zip_find_markdown($body);
    if (trim($body) === '') return array('ok' => false, 'error' => '解析结果是空的', 'code' => 502);
    return array('ok' => true, 'markdown' => $body);
}

function tc_mineru_clip($markdown) {
    $markdown = str_replace(chr(0), '', (string) $markdown);
    if (strlen($markdown) > 80000) {
        $markdown = substr($markdown, 0, 80000) . chr(10) . chr(10) . '[文档过长，已截断]';
    }
    return $markdown;
}

function tc_mineru_parse_lite($name, $bytes, $deadline) {
    $signed = tc_mineru_json(TC_MINERU_LITE . '/parse/file', 'POST', array('Content-Type' => 'application/json', 'Accept' => 'application/json'), tc_json_encode(array(
        'file_name' => $name,
        'language' => 'ch',
        'enable_table' => true,
        'is_ocr' => false,
        'enable_formula' => true,
    )), 20000);
    if (empty($signed['ok'])) return $signed;
    $data = $signed['data'];
    $taskId = isset($data['task_id']) ? (string) $data['task_id'] : '';
    $fileUrl = isset($data['file_url']) ? (string) $data['file_url'] : '';
    if ($taskId === '' || $fileUrl === '') return array('ok' => false, 'error' => '轻量解析没有返回上传地址', 'code' => 502);
    $put = tc_mineru_put_file($fileUrl, $bytes, 40000);
    if (empty($put['ok'])) return $put;
    $polled = tc_mineru_poll(TC_MINERU_LITE . '/parse/' . rawurlencode($taskId), array('Accept' => 'application/json'), $deadline, false);
    if (empty($polled['ok'])) return $polled;
    $text = tc_mineru_fetch_text($polled['url']);
    if (empty($text['ok'])) return $text;
    return array('ok' => true, 'markdown' => tc_mineru_clip($text['markdown']), 'mode' => 'lite', 'name' => $name);
}

function tc_mineru_parse_precise($name, $bytes, $token, $deadline) {
    $ext = tc_mineru_ext($name);
    $headers = array(
        'Content-Type' => 'application/json',
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $token,
    );
    $model = ($ext === 'html' || $ext === 'htm') ? 'MinerU-HTML' : 'vlm';
    $signed = tc_mineru_json(TC_MINERU_PRECISE . '/file-urls/batch', 'POST', $headers, tc_json_encode(array(
        'files' => array(array('name' => $name, 'data_id' => 'f1')),
        'model_version' => $model,
        'language' => 'ch',
        'enable_table' => true,
        'enable_formula' => true,
        'is_ocr' => false,
    )), 20000);
    if (empty($signed['ok'])) return $signed;
    $data = $signed['data'];
    $batchId = isset($data['batch_id']) ? (string) $data['batch_id'] : '';
    $fileUrl = (isset($data['file_urls']) && is_array($data['file_urls']) && isset($data['file_urls'][0])) ? (string) $data['file_urls'][0] : '';
    if ($batchId === '' || $fileUrl === '') return array('ok' => false, 'error' => '精准解析没有返回上传地址，请检查 Token', 'code' => 502);
    $put = tc_mineru_put_file($fileUrl, $bytes, 60000);
    if (empty($put['ok'])) return $put;
    $polled = tc_mineru_poll(TC_MINERU_PRECISE . '/extract-results/batch/' . rawurlencode($batchId), array(
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $token,
    ), $deadline, true);
    if (empty($polled['ok'])) return $polled;
    $text = tc_mineru_fetch_text($polled['url']);
    if (empty($text['ok'])) return $text;
    return array('ok' => true, 'markdown' => tc_mineru_clip($text['markdown']), 'mode' => 'precise', 'name' => $name);
}

function tc_mineru_parse($name, $bytes, $token, $budgetSec) {
    $name = tc_mineru_safe_name($name);
    if (!tc_mineru_parseable($name)) return array('ok' => false, 'error' => 'MinerU 不支持这个格式', 'code' => 400);
    $size = strlen($bytes);
    if ($size <= 0) return array('ok' => false, 'error' => '文件是空的', 'code' => 400);
    $precise = trim((string) $token) !== '';
    $limit = $precise ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
    if ($size > $limit) {
        return array('ok' => false, 'error' => '文件超过 ' . ($precise ? '200MB' : '10MB') . '，' . ($precise ? '请拆分后再试' : '轻量解析上限 10MB、20 页'), 'code' => 400);
    }
    $deadline = time() + max(20, (int) $budgetSec);
    if ($precise) return tc_mineru_parse_precise($name, $bytes, trim((string) $token), $deadline);
    return tc_mineru_parse_lite($name, $bytes, $deadline);
}

// ---- 文档解析通道:按文件类别(PDF/图片/Office)路由到 MinerU / PaddleOCR / Mistral OCR ----
// 类别归属:pdf=pdf;image=png/jpg/jpeg/jp2/webp/gif/bmp;office=doc/docx/ppt/pptx/xls/xlsx;html 归 mineru。
function tc_parse_category($name) {
    $ext = tc_mineru_ext($name);
    if ($ext === 'pdf') return 'pdf';
    if (in_array($ext, array('png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp'), true)) return 'image';
    if (in_array($ext, array('doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'), true)) return 'office';
    return 'html';
}

// PaddleOCR 是纯 OCR 引擎:只吃 PDF 与图片,Office 文档不支持
function tc_paddle_parseable($name) {
    $cat = tc_parse_category($name);
    return $cat === 'pdf' || $cat === 'image';
}

// Mistral OCR:PDF/图片/DOCX/PPTX;不支持旧版 .doc/.ppt/.xls 与 HTML
function tc_mistral_parseable($name) {
    $ext = tc_mineru_ext($name);
    return in_array($ext, array('pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'docx', 'pptx'), true);
}

// PaddleOCR:POST 文件(base64)到自建 PaddleX serving /ocr 或 AI Studio 托管 API,可选 token 鉴权
function tc_paddle_parse($url, $key, $name, $bytes) {
    $url = trim((string) $url);
    if ($url === '' || !preg_match('#^https?://#i', $url)) return array('ok' => false, 'error' => 'PaddleOCR 服务地址无效', 'code' => 400);
    // 只填了根地址(无路径)时自动补 /ocr(PaddleX serving 默认端点);带路径的按原样使用
    $path = (string) parse_url($url, PHP_URL_PATH);
    if ($path === '' || $path === '/') $url = rtrim($url, '/') . '/ocr';
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if (trim((string) $key) !== '') $headers['Authorization'] = 'token ' . trim((string) $key);
    $payload = tc_json_encode(array(
        'file' => base64_encode($bytes),
        'fileType' => tc_parse_category($name) === 'pdf' ? 0 : 1,
    ));
    $res = tc_http_request($url, 'POST', $headers, $payload, 100000, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'PaddleOCR 解析失败', 'code' => isset($res['status']) && $res['status'] >= 400 ? (int) $res['status'] : 502);
    }
    $j = json_decode($res['body'], true);
    if (!is_array($j)) return array('ok' => false, 'error' => 'PaddleOCR 返回了无法解析的内容', 'code' => 502);
    $errMsg = isset($j['errorMsg']) ? trim((string) $j['errorMsg']) : '';
    if ($errMsg !== '') return array('ok' => false, 'error' => 'PaddleOCR: ' . $errMsg, 'code' => 502);
    $result = (isset($j['result']) && is_array($j['result'])) ? $j['result'] : $j;
    // 两种服务形态都要兼容:
    //   纯 OCR 管线(PaddleX ocr / AI Studio PP-OCRv5) -> ocrResults[].prunedResult.rec_texts
    //   文档解析管线(PP-StructureV3) -> layoutParsingResults[].markdown.text
    $pages = array();
    if (isset($result['ocrResults']) && is_array($result['ocrResults'])) $pages = $result['ocrResults'];
    elseif (isset($result['layoutParsingResults']) && is_array($result['layoutParsingResults'])) $pages = $result['layoutParsingResults'];
    $texts = array();
    foreach ($pages as $p) {
        if (!is_array($p)) continue;
        $pr = isset($p['prunedResult']) && is_array($p['prunedResult']) ? $p['prunedResult'] : array();
        if (!empty($pr['rec_texts']) && is_array($pr['rec_texts'])) {
            $lines = array();
            foreach ($pr['rec_texts'] as $t) if (trim((string) $t) !== '') $lines[] = trim((string) $t);
            if ($lines) { $texts[] = implode("\n", $lines); continue; }
        }
        if (!empty($p['markdown']['text'])) $texts[] = (string) $p['markdown']['text'];
        elseif (!empty($p['markdown']) && is_string($p['markdown'])) $texts[] = $p['markdown'];
    }
    if (!$texts) return array('ok' => false, 'error' => 'PaddleOCR 没有识别到文字（若你的服务返回结构调整过，请把响应示例发给开发者适配）', 'code' => 502);
    return array('ok' => true, 'markdown' => tc_mineru_clip(implode("\n\n", $texts)), 'mode' => 'paddle', 'name' => $name);
}

// Mistral OCR:cloud API /v1/ocr,文件以 data-URI 内联,返回分页 markdown
function tc_mistral_parse($name, $bytes, $key) {
    $key = trim((string) $key);
    if ($key === '') return array('ok' => false, 'error' => '请先在后台填写 Mistral OCR API Key', 'code' => 400);
    if (!tc_mistral_parseable($name)) {
        return array('ok' => false, 'error' => 'Mistral OCR 不支持这个格式（仅 PDF/图片/DOCX/PPTX），这类文件请改用 MinerU 通道', 'code' => 400);
    }
    $ext = tc_mineru_ext($name);
    $mimes = array(
        'pdf' => 'application/pdf',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp',
        'gif' => 'image/gif', 'bmp' => 'image/bmp',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    $mime = isset($mimes[$ext]) ? $mimes[$ext] : 'application/octet-stream';
    if (strlen($bytes) > 50 * 1024 * 1024) {
        return array('ok' => false, 'error' => 'Mistral OCR 单文件不超过 50MB', 'code' => 400);
    }
    // 官方 schema:document 是判别联合,必须带 type(document_url / image_url) 与对应字段
    $isImage = tc_parse_category($name) === 'image';
    $docType = $isImage ? 'image_url' : 'document_url';
    $body = tc_json_encode(array(
        'model' => 'mistral-ocr-latest',
        'document' => array(
            'type' => $docType,
            $docType => 'data:' . $mime . ';base64,' . base64_encode($bytes),
        ),
    ));
    $base = rtrim((string) (getenv('TC_MISTRAL_OCR_BASE') ?: 'https://api.mistral.ai'), '/');
    $res = tc_http_request($base . '/v1/ocr', 'POST', array(
        'Content-Type' => 'application/json',
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $key,
    ), $body, 120000, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'Mistral OCR 解析失败', 'code' => isset($res['status']) && $res['status'] >= 400 ? (int) $res['status'] : 502);
    }
    $j = json_decode($res['body'], true);
    $pages = (is_array($j) && isset($j['pages']) && is_array($j['pages'])) ? $j['pages'] : array();
    $texts = array();
    foreach ($pages as $p) {
        if (is_array($p) && isset($p['markdown']) && trim((string) $p['markdown']) !== '') $texts[] = (string) $p['markdown'];
    }
    if (!$texts) return array('ok' => false, 'error' => 'Mistral OCR 没有识别到内容', 'code' => 502);
    return array('ok' => true, 'markdown' => tc_mineru_clip(implode("\n\n", $texts)), 'mode' => 'mistral', 'name' => $name);
}

// 把消息 content(字符串,或 [{type,text}] 部件数组)拍平成纯文本。
// 只用于 responses 格式下把 system 消息搬进 instructions —— 那里只能放文本,图片部件丢弃。
function tc_content_text($content) {
    if (is_string($content)) return $content;
    if (!is_array($content)) return '';
    $parts = array();
    foreach ($content as $p) {
        if (is_string($p)) $parts[] = $p;
        elseif (is_array($p) && isset($p['text'])) $parts[] = (string) $p['text'];
    }
    return implode("\n", $parts);
}

function tc_prepare_upstream_body($b, $provider, $format) {
    $out = array();
    foreach ($b as $k => $v) {
        if ($k === 'providerId' || $k === 'anthropicVersion' || $k === 'webSearch' || strncmp((string) $k, '_', 1) === 0) continue;
        $out[$k] = $v;
    }
    // responses 格式的入参形状和对话格式不同:历史走 input(不是 messages)、系统提示走
    // instructions、输出上限叫 max_output_tokens。站内几个辅助调用(工具判定/自动标题、
    // 跟进建议、AI 笔记整理)只按对话格式拼 body,而 endpoint 是跟着供应商格式走的,
    // 原样转发会被上游当成「不支持的参数」拒掉 —— 而且这类网关往往只回一句笼统的
    // invalid or unsupported parameter,连字段名都不给,极难排查。这里统一归一化一次,
    // 调用点就不必各自记着两种形状。
    if ($format === 'responses' && !isset($out['input']) && isset($out['messages']) && is_array($out['messages'])) {
        $input = array();
        $system = array();
        foreach ($out['messages'] as $m) {
            if (!is_array($m)) continue;
            $role = isset($m['role']) ? (string) $m['role'] : 'user';
            $content = isset($m['content']) ? $m['content'] : '';
            if ($role === 'system' || $role === 'developer') {
                $text = trim(tc_content_text($content));
                if ($text !== '') $system[] = $text;
                continue;
            }
            $input[] = array('role' => $role === 'assistant' ? 'assistant' : 'user', 'content' => $content);
        }
        unset($out['messages'], $out['max_tokens']);
        $out['input'] = $input;
        if ($system) {
            $cur = isset($out['instructions']) && is_string($out['instructions']) ? $out['instructions'] : '';
            $joined = implode("\n\n", $system);
            $out['instructions'] = $cur === '' ? $joined : ($cur . "\n\n" . $joined);
        }
        // Responses 里没有 max_tokens;对话格式调用点带过来的值改挂到 max_output_tokens
        if (!isset($out['max_output_tokens']) && isset($b['max_tokens'])) {
            $out['max_output_tokens'] = $b['max_tokens'];
        }
    }
    $model = isset($out['model']) ? $out['model'] : (isset($provider['models'][0]['id']) ? $provider['models'][0]['id'] : null);
    if ($model) $out['model'] = $model;
    // Anthropic 的 max_tokens 必填,缺省值留到钳制阶段按模型上限补(此处不定死小值)
    return $out;
}

function tc_unsupported_param_names($raw) {
    $text = strtolower((string) $raw);
    if ($text === '') return array();
    $known = array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'temperature');
    $found = array();
    if (preg_match_all('/[`\'"]([a-z0-9_.]+)[`\'"]/i', (string) $raw, $m)) {
        foreach ($m[1] as $name) {
            $name = strtolower($name);
            if (in_array($name, $known, true) && !in_array($name, $found, true)) $found[] = $name;
        }
    }
    // 上游对"不支持某参数"的表述五花八门(如 Kimi:"Unsupported Kimi K3 thinking_effort=...; supported values are ..."),
    // 只要错误文本表达了"不支持"且点名了已知参数,就纳入去参重试的范围
    if (strpos($text, 'unsupported') !== false || strpos($text, 'not supported') !== false || strpos($text, 'supported values') !== false) {
        if (preg_match_all('/\b(enable_thinking|reasoning_effort|thinking_effort|thinking|reasoning|temperature)\b/', $text, $m2)) {
            foreach ($m2[0] as $name) if (!in_array($name, $found, true)) $found[] = $name;
        }
    }
    if (!$found && strpos($text, 'unsupported parameter') !== false) {
        foreach ($known as $name) {
            if (strpos($text, $name) !== false) $found[] = $name;
        }
    }
    return $found;
}

// 从上游报错里解析"该模型支持的 effort 档位",把当前请求的档位就近改写后重试,
// 比直接删参数更好——保留推理强度控制。支持 thinking_effort / reasoning_effort / reasoning.effort 三种载体。
function tc_effort_remap_from_error(&$body, $raw, &$levelsOut = null) {
    $text = strtolower((string) $raw);
    if ($text === '' || strpos($text, 'unsupported') === false && strpos($text, 'not supported') === false && strpos($text, 'supported values') === false) return false;
    $param = '';
    foreach (array('thinking_effort', 'reasoning_effort') as $p) {
        if (strpos($text, $p) !== false) { $param = $p; break; }
    }
    // 有的上游把字段名写成空格形式("reasoning effort is not supported")
    if ($param === '' && strpos($text, 'reasoning effort') !== false) $param = 'reasoning_effort';
    if ($param === '') return false;
    $values = array();
    // 只截取到句末,避免贪婪回溯吃掉整个列表只剩最后一个词
    if (preg_match('/supported values?\s*(?:are|:|is)?\s*([^.;\n]+)/i', (string) $raw, $m) || preg_match('/must be (?:one of|between)[^.\n:;]*[:\s]+([^.;\n]+)/i', (string) $raw, $m)) {
        if (preg_match_all('/\b(minimal|none|low|medium|high|max)\b/i', $m[1], $vm)) {
            foreach ($vm[1] as $v) { $v = strtolower($v); if (!in_array($v, $values, true)) $values[] = $v; }
        }
    }
    if (!$values) return false;
    $order = array('minimal', 'none', 'low', 'medium', 'high', 'max');
    $cur = null; $slot = '';
    if ($param === 'thinking_effort') {
        if (array_key_exists('thinking_effort', $body)) { $cur = $body['thinking_effort']; $slot = 'thinking_effort'; }
    } else {
        if (array_key_exists('reasoning_effort', $body)) { $cur = $body['reasoning_effort']; $slot = 'reasoning_effort'; }
        elseif (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning'])) { $cur = $body['reasoning']['effort']; $slot = 'reasoning.effort'; }
    }
    if ($cur === null || $slot === '') return false;
    if (in_array(strtolower((string) $cur), $values, true)) return false;
    $target = tc_nearest_effort($cur, $values);
    if ($slot === 'reasoning.effort') $body['reasoning']['effort'] = $target;
    else $body[$slot] = $target;
    if (func_num_args() >= 3) $levelsOut = $values;
    return true;
}

// 自动学习:上游报错暴露了某模型可用的 effort 档位(或明确不收推理参数)时,
// 把结论沉淀为自动规则,后续请求在发出前就完成适配,不再依赖报错往返。
function tc_thinking_learn($model, $levels, $disable) {
    $model = strtolower(trim((string) $model));
    if ($model === '') return;
    try {
        tc_with_db(true, function (&$db) use ($model, $levels, $disable) {
            $cfg = tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null);
            if (empty($cfg['autoLearn'])) return;
            // 手动规则已覆盖该模型时,尊重管理员意图,不学习
            foreach ($cfg['rules'] as $r) {
                if (!empty($r['enabled']) && ($r['source'] ?? '') === 'manual' && strpos($model, strtolower((string) $r['match'])) !== false) return;
            }
            $match = substr($model, 0, 80);
            $mode = $disable ? 'off' : 'map';
            $levels = is_array($levels) ? array_values(array_filter(array_map('strtolower', $levels))) : array();
            if ($mode === 'map' && !$levels) return;
            $updatedAt = tc_now();
            $found = false;
            foreach ($cfg['rules'] as $i => $r) {
                if (($r['source'] ?? '') !== 'auto' || strtolower((string) $r['match']) !== $match) continue;
                $found = true;
                if (($r['mode'] ?? '') === $mode) {
                    if ($mode === 'map') {
                        $merged = array_values(array_unique(array_merge((array) ($r['levels'] ?? array()), $levels)));
                        sort($merged);
                        $cfg['rules'][$i]['levels'] = $merged;
                    }
                    $cfg['rules'][$i]['updatedAt'] = $updatedAt;
                } else {
                    // 同一模型报错性质变了(从可映射变为完全不支持,或反之):替换为最新结论
                    $cfg['rules'][$i] = array('id' => $r['id'], 'match' => $match, 'mode' => $mode, 'levels' => $levels, 'forceEffort' => '', 'enabled' => true, 'source' => 'auto', 'updatedAt' => $updatedAt);
                }
                break;
            }
            if (!$found) {
                // 规则数量上限:超出时淘汰最旧的自动规则
                $auto = array_values(array_filter($cfg['rules'], function ($r) { return ($r['source'] ?? '') === 'auto'; }));
                if (count($auto) >= 60) {
                    usort($auto, function ($a, $b) { return ($a['updatedAt'] ?? 0) - ($b['updatedAt'] ?? 0); });
                    $drop = $auto[0]['id'] ?? '';
                    $cfg['rules'] = array_values(array_filter($cfg['rules'], function ($r) use ($drop) { return ($r['id'] ?? '') !== $drop; }));
                }
                $cfg['rules'][] = array('id' => tc_uid(8), 'match' => $match, 'mode' => $mode, 'levels' => $levels, 'forceEffort' => '', 'enabled' => true, 'source' => 'auto', 'updatedAt' => $updatedAt);
            }
            $db['settings']['thinking'] = $cfg;
        });
    } catch (Throwable $e) { /* 学习失败不影响主流程 */ }
}

function tc_strip_reasoning_params(&$body, $names) {
    $changed = false;
    foreach ($names as $name) {
        if ($name === 'enable_thinking' && array_key_exists('enable_thinking', $body)) {
            unset($body['enable_thinking']);
            $changed = true;
        } elseif ($name === 'temperature' && array_key_exists('temperature', $body)) {
            unset($body['temperature']);
            $changed = true;
        } elseif ($name === 'reasoning_effort' && array_key_exists('reasoning_effort', $body)) {
            unset($body['reasoning_effort']);
            $changed = true;
        } elseif ($name === 'thinking_effort' && array_key_exists('thinking_effort', $body)) {
            unset($body['thinking_effort']);
            $changed = true;
        } elseif ($name === 'thinking' && array_key_exists('thinking', $body)) {
            unset($body['thinking']);
            $changed = true;
        } elseif ($name === 'reasoning' && array_key_exists('reasoning', $body)) {
            unset($body['reasoning']);
            $changed = true;
        }
    }
    return $changed;
}

// $force=true 时无条件写入(硬覆盖),否则只在缺失或超上限时压回
function tc_clamp_output_tokens(&$body, $format, $cap, $force = false) {
    $cap = (int) $cap;
    if ($cap < 256) return;
    if ($format === 'anthropic') {
        // max_tokens 是 Anthropic 的必填项。客户端没给就补成上限——补一个偏小的定值
        // (旧实现补 8192)会把「未指定」误当成「只要这么多」，模型上限再大也用不上。
        $want = isset($body['max_tokens']) ? (int) $body['max_tokens'] : 0;
        $body['max_tokens'] = $force ? $cap : ($want > 0 ? min($cap, max(256, $want)) : $cap);
        return;
    }
    if ($format === 'responses') {
        $current = isset($body['max_output_tokens']) ? (int) $body['max_output_tokens'] : 0;
        if ($force || $current <= 0 || $current > $cap) $body['max_output_tokens'] = $cap;
        return;
    }
    if ($format === 'chat' || $format === 'completions') {
        $current = isset($body['max_tokens']) ? (int) $body['max_tokens'] : 0;
        if ($force || $current <= 0 || $current > $cap) $body['max_tokens'] = $cap;
    }
}

// 开启思考时,保证输出额度里给正文留出 $reserve:显式带了 thinking.budget_tokens 的
// (Anthropic 及部分网关)直接压缩思维预算;只有 effort 档位的网关由上游自行分配额度,
// 服务端不干预。思维链吃光额度会导致正文为空(实测 finish_reason=length、content 长度 0),
// 所以这里宁可压缩思考也不让正文没有位置。$cap 为该模型的输出上限。
function tc_fit_thinking_budget(&$body, $cap, $reserve = 2048) {
    $cap = (int) $cap;
    if ($cap < 256) return;
    if (empty($body['thinking']) || !is_array($body['thinking'])) return;
    if (isset($body['thinking']['type']) && $body['thinking']['type'] === 'disabled') return;
    if (empty($body['thinking']['budget_tokens'])) return;
    $budget = (int) $body['thinking']['budget_tokens'];
    if ($budget <= 0) return;
    // 实际生效的输出额度:Anthropic 的 max_tokens 优先,其余格式用上限
    $limit = isset($body['max_tokens']) && (int) $body['max_tokens'] > 0 ? (int) $body['max_tokens'] : $cap;
    $room = $limit - (int) $reserve;
    if ($room < 1024) $room = 1024;          // 预算再小思考也没有意义
    if ($room > $limit - 1) $room = $limit - 1; // Anthropic 要求 budget < max_tokens
    if ($room < 1) $room = 1;
    if ($budget > $room) $body['thinking']['budget_tokens'] = $room;
}

// 全局温度:管理员未设置(null)时不发送,避免影响不接受该参数的推理型模型
function tc_apply_temperature(&$body, $format, $temperature) {
    if ($temperature === null || $temperature === '') return;
    $t = (float) $temperature;
    if ($t < 0) $t = 0;
    // Anthropic 的温度取值范围是 0-1
    if ($format === 'anthropic') $t = min(1, $t);
    $body['temperature'] = $t;
}

// 粗略 token 估算:中日韩字符按 1 token/字,其余按 4 字符/token(宁可略高估,保证输出预算留足)
function tc_estimate_text_tokens($s) {
    if ($s === '' || !is_string($s)) return 0;
    $len = tc_mb_len($s);
    if ($len === 0) return 0;
    $cjk = @preg_match_all('/[\x{3000}-\x{30ff}\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{ac00}-\x{d7a3}\x{f900}-\x{faf6}\x{ff00}-\x{ffef}]/u', $s);
    $cjk = $cjk === false ? 0 : (int) $cjk;
    return (int) round($cjk + ($len - $cjk) / 4);
}

// 递归估算请求体 token:图片/文件等多模态部分按固定 1024 计,base64 数据不计(避免把图片体积当文本)
function tc_estimate_body_tokens($v) {
    if (is_string($v)) {
        $v = preg_replace('#data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+#', '', (string) $v);
        $v = preg_replace('#\b[A-Za-z0-9+/=]{512,}\b#', '', (string) $v);
        return tc_estimate_text_tokens($v);
    }
    if (is_array($v)) {
        $type = isset($v['type']) && is_string($v['type']) ? $v['type'] : '';
        if (in_array($type, array('image_url', 'input_image', 'image', 'file', 'input_file', 'document'), true)) return 1024;
        $sum = 0;
        foreach ($v as $val) $sum += tc_estimate_body_tokens($val);
        return $sum;
    }
    return 0;
}

function tc_disable_buffers() {
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) @ob_end_flush();
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    header('X-Accel-Buffering: no');
}

// 把 curl 失败翻译成带诊断信息的结果:区分「连不上」与「响应慢」,便于用户定位
function tc_curl_failure($ch, $errno, $err, $status, $url, $connectSec, $timeoutSec) {
    $connectTime = (float) curl_getinfo($ch, CURLINFO_CONNECT_TIME);
    $totalTime = (float) curl_getinfo($ch, CURLINFO_TOTAL_TIME);
    $host = parse_url((string) $url, PHP_URL_HOST);
    $port = parse_url((string) $url, PHP_URL_PORT);
    $hostLabel = $host ? ($host . ($port ? ':' . $port : '')) : (string) $url;
    // curl 常量在不同 PHP/curl 构建里未必齐全,统一用 defined() 兜底成标准数值
    $c = function ($name, $fallback) { return defined($name) ? constant($name) : $fallback; };
    $errResolveHost = $c('CURLE_COULDNT_RESOLVE_HOST', 6);
    $errResolveProxy = $c('CURLE_COULDNT_RESOLVE_PROXY', 5);
    $errConnect = $c('CURLE_COULDNT_CONNECT', 7);
    $errTimeout = $c('CURLE_OPERATION_TIMEDOUT', 28);
    $tlsErrs = array(
        $c('CURLE_SSL_CONNECT_ERROR', 35),
        $c('CURLE_SSL_CERTPROBLEM', 58),
        $c('CURLE_SSL_CIPHER', 59),
        $c('CURLE_PEER_FAILED_VERIFICATION', 60),
        $c('CURLE_SSL_CACERT', 60),
        $c('CURLE_SSL_CACERT_BADFILE', 77),
    );
    $kind = 'other';
    $code = 502;
    if ($errno === $errResolveHost || $errno === $errResolveProxy) {
        $kind = 'dns';
    } elseif ($errno === $errConnect) {
        $kind = 'connect';
    } elseif (in_array($errno, $tlsErrs, true)) {
        $kind = 'tls';
    } elseif ($errno === $errTimeout) {
        // 连接从未建立(connectTime 为 0)= 连不上/DNS 卡住;已建立则是在等响应
        $kind = $connectTime <= 0 ? 'connect_timeout' : 'read_timeout';
        $code = 504;
    }
    return array(
        'ok' => false,
        'error' => $err ?: '无法连接上游 API',
        'code' => $code,
        'status' => (int) $status,
        'kind' => $kind,
        'host' => $hostLabel,
        'connect_timeout' => $connectSec,
        'timeout' => $timeoutSec,
        'connect_time' => round($connectTime, 2),
        'elapsed' => round($totalTime, 2),
    );
}

// 把上游连接失败结果翻译成可操作的中文提示(带主机名与秒数,指明该查什么)
function tc_upstream_fail_message($res, $providerName = '') {
    $label = ($providerName !== '' ? '「' . $providerName . '」' : '');
    $host = (isset($res['host']) && $res['host'] !== '') ? $res['host'] : '上游地址';
    $kind = isset($res['kind']) ? $res['kind'] : 'other';
    $ct = isset($res['connect_timeout']) ? (int) $res['connect_timeout'] : 0;
    $tt = isset($res['timeout']) ? (int) $res['timeout'] : 0;
    $detail = isset($res['error']) ? (string) $res['error'] : '';
    switch ($kind) {
        case 'connect_timeout':
            return $label . '连接上游超时：' . $ct . ' 秒内无法与 ' . $host . ' 建立连接。请确认该地址与端口正确、服务已启动，且服务器能访问外网（境外平台常被防火墙/网络出口拦截）。';
        case 'read_timeout':
            return $label . '上游响应超时：已连接 ' . $host . '，但超过 ' . $tt . ' 秒未返回内容。可在「对话设置 → 请求超时」调大该值，或改用响应更快的模型。';
        case 'dns':
            return $label . '无法解析上游域名 ' . $host . '。请检查 Base URL 拼写与服务器 DNS。';
        case 'connect':
            return $label . '无法连接上游 ' . $host . '（' . $detail . '）。请确认服务已启动、端口开放且地址可访问。';
        case 'tls':
            return $label . '与上游建立 HTTPS 连接失败：' . $detail . '。请检查证书链是否完整，或改用 http。';
        default:
            return $label . '无法连接上游 API（' . $host . '）：' . ($detail !== '' ? $detail : '未知错误');
    }
}

function tc_http_request($url, $method, $headers, $body, $timeoutMs, $stream = false, $onChunk = null, $sendExpect = true, $connectTimeoutMs = null) {
    if (!function_exists('curl_init')) {
        return array('ok' => false, 'error' => '服务器未启用 curl 扩展，无法请求上游 API', 'code' => 0);
    }
    // PHP 默认 max_execution_time 为 30 秒,而生图/长文等上游调用常需 30~90 秒。
    // 不抬高这个上限,请求会被 PHP 半路掐断并返回空响应(前端表现为「点了没反应」)。
    // 这里按本次 curl 预算给足 PHP 执行时间,每次调用都重置计时器。
    $curlSec = $stream ? 600 : max(5, (int) ceil($timeoutMs / 1000));
    $connSec = $connectTimeoutMs === null ? 20 : max(3, (int) ceil($connectTimeoutMs / 1000));
    @set_time_limit(min(1200, $curlSec + $connSec + 20));
    $ch = curl_init($url);
    $hdrs = array();
    foreach ($headers as $k => $v) $hdrs[] = $k . ': ' . $v;
    $opts = array(
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $hdrs,
        CURLOPT_RETURNTRANSFER => !$stream,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => $connSec,
        CURLOPT_TIMEOUT => $stream ? 0 : $curlSec,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADER => false,
    );
    $ca = tc_cacert_path();
    if ($ca) $opts[CURLOPT_CAINFO] = $ca;
    // 出站代理:管理员在「对话设置」配置后,所有出站请求(含拉取模型价格表)统一走它。
    // 直连 raw.githubusercontent.com 在国内网络常下到一半卡死,代理能稳定完成。
    $proxy = tc_outbound_proxy();
    if ($proxy !== '') {
        $opts[CURLOPT_PROXY] = $proxy;
        // socks5h 表示由代理解析域名,避免本地 DNS 污染
        if (stripos($proxy, 'socks5') === 0) $opts[CURLOPT_PROXYTYPE] = CURLPROXY_SOCKS5_HOSTNAME;
    }
    curl_setopt_array($ch, $opts);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    if (!$sendExpect) curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge($hdrs, array('Expect:', 'Content-Type:')));
    $status = 0;
    $raw = '';
    if ($stream && is_callable($onChunk)) {
        $errBody = '';
        $lastOut = microtime(true);
        // 空闲超时:流式不设总时长上限,但上游连续 N 秒没有任何字节即视为卡死并中止
        // (原先 TIMEOUT=0,上游挂起会一直占住 PHP worker 直到执行时限)
        $idleSec = defined('TC_STREAM_IDLE_SEC') ? (int) TC_STREAM_IDLE_SEC : 300;
        if ($idleSec > 0) {
            curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 1);
            curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, $idleSec);
        }
        // 进度回调(约每秒触发一次,空闲时也有):空闲时向客户端发 SSE 注释帧(: ping)
        // 保活,并感知客户端断开 —— 返回非 0 中止 curl,不再为已离开的读者消耗上游。
        // 心跳仅在 SSE 响应头已发出后进行,避免抢在首字节前输出污染响应头
        $heartbeat = function () use (&$lastOut) {
            if (microtime(true) - $lastOut < 15 || headers_sent() === false) return;
            $lastOut = microtime(true);
            echo ": ping\n\n";
            if (function_exists('ob_flush')) @ob_flush();
            flush();
        };
        $progress = function () use ($heartbeat) {
            $heartbeat();
            return connection_aborted() ? 1 : 0;
        };
        curl_setopt($ch, CURLOPT_NOPROGRESS, false);
        if (defined('CURLOPT_XFERINFOFUNCTION')) curl_setopt($ch, CURLOPT_XFERINFOFUNCTION, $progress);
        elseif (defined('CURLOPT_PROGRESSFUNCTION')) curl_setopt($ch, CURLOPT_PROGRESSFUNCTION, $progress);
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use ($onChunk, &$status, &$errBody, &$lastOut) {
            if (!$status) $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($status >= 400) {
                $errBody .= $data;
                return strlen($data);
            }
            $ret = $onChunk($data);
            $lastOut = microtime(true);
            // onChunk 返回 false 或 -1 都表示客户端已断开,中止上游传输
            if ($ret === false || $ret === -1) return -1;
            return strlen($data);
        });
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        $errno = curl_errno($ch);
        $fail = $ok === false ? tc_curl_failure($ch, $errno, $err, $status, $url, $connSec, 0) : null;
        curl_close($ch);
        if ($fail !== null) return $fail;
        return array('ok' => true, 'status' => $status, 'body' => $errBody, 'ctype' => '');
    }
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $err = curl_error($ch);
    $errno = curl_errno($ch);
    $fail = $raw === false ? tc_curl_failure($ch, $errno, $err, $status, $url, $connSec, $curlSec) : null;
    curl_close($ch);
    if ($fail !== null) return $fail;
    return array('ok' => true, 'status' => $status, 'body' => $raw, 'ctype' => $ctype);
}

function tc_upstream_error_message($raw, $status) {
    $msg = '上游 API 错误 (HTTP ' . $status . ')';
    $j = json_decode($raw, true);
    if (is_array($j)) {
        if (isset($j['error']['message'])) return (string) $j['error']['message'];
        if (isset($j['error']['code'])) return (string) $j['error']['code'];
        if (isset($j['message'])) return (string) $j['message'];
    }
    return $msg;
}

// 本次上游结果是否属于「该换下一把 Key 重试」的失败:
// 连接失败、认证/权限类状态码(401/402/403),或响应体明确指向密钥/鉴权问题。
// 非流式时 body 可用;流式时 >=400 的响应体也会被收集到 body。
function tc_key_failure_retryable($res) {
    if (empty($res['ok'])) return true;                 // 连接失败
    $status = (int) (isset($res['status']) ? $res['status'] : 0);
    // 认证/权限/配额类:401 未授权、402 余额、403 禁止、429 限流(多为按 Key 计,换一把可绕过)
    if (in_array($status, array(401, 402, 403, 429), true)) return true;
    $body = isset($res['body']) ? (string) $res['body'] : '';
    if ($body === '') return false;
    if ($status >= 400 && $status < 500) {
        // 400/422 等:仅当错误信息指向密钥/鉴权/权限时才换 Key,避免把普通参数错误当成密钥问题
        if (preg_match('/(api[\s_-]?key|apikey|invalid[\s_-]?key|unauthor|forbidden|authentication|鉴权|密钥|无权|未授权|权限)/iu', $body)) return true;
    }
    return false;
}

// 本次上游结果是否属于「该换下一个渠道重试」的失败(汇总组的故障自动转移)。
// 比「换 Key」更宽:连接失败、限流、网关/服务端 5xx(整条渠道不可用),以及认证/权限类错误
// (该渠道的 Key 全部无效,再换 Key 也没用,只能换渠道)。
// 参数类 4xx(400/404/422 且与鉴权无关)不换渠道 —— 换一个渠道多半同样被拒,白花一次上游调用。
function tc_candidate_failure_retryable($res) {
    if (empty($res['ok'])) return true;                 // 连接失败
    $status = (int) (isset($res['status']) ? $res['status'] : 0);
    if (in_array($status, array(500, 502, 503, 504, 520, 521, 522, 523, 524), true)) return true;
    // 认证/权限/配额类与「响应体指向鉴权问题」的 4xx:交给换 Key 的同一套判定,
    // 该渠道整体不可用时(Key 全部无效)才会走到换渠道
    return tc_key_failure_retryable($res);
}

// 切换到汇总组的第 $idx 个候选渠道,返回重建后的请求要素。
// 候选可能属于不同供应商、且上游模型名不同,因此 URL、密钥链、请求体都要重算。
// 只在「尚未向客户端发出任何字节」时调用(与换 Key 同一条纪律:发出去了就不能再换)。
function tc_candidate_switch($candidates, $idx, $format, $body) {
    $c = $candidates[$idx];
    $provider = $c['provider'];
    $body['model'] = $c['model'];
    $url = tc_upstream_path(rtrim((string) $provider['baseUrl'], '/'), $format);
    $chain = tc_provider_key_chain($provider, (string) $c['model']);
    if (!$chain) $chain = array('');
    return array(
        'provider' => $provider,
        'body' => $body,
        'url' => $url,
        'keyChain' => $chain,
        'headers' => tc_upstream_auth_headers($format, $chain[0], true),
        'payload' => tc_json_encode($body),
    );
}

function tc_plain_text($s, $limit = 360) {
    $s = html_entity_decode(strip_tags((string) $s), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = preg_replace('/\s+/u', ' ', $s);
    $s = trim((string) $s);
    if ($limit > 0 && function_exists('mb_substr')) return mb_substr($s, 0, $limit, 'UTF-8');
    if ($limit > 0) return substr($s, 0, $limit);
    return $s;
}

function tc_web_search_query_from_body($body, $format) {
    $text = '';
    if ($format === 'responses' && isset($body['input'])) {
        if (is_string($body['input'])) $text = $body['input'];
        elseif (is_array($body['input'])) {
            for ($i = count($body['input']) - 1; $i >= 0; $i--) {
                $m = $body['input'][$i];
                if (!is_array($m)) continue;
                $role = isset($m['role']) ? $m['role'] : '';
                if ($role && $role !== 'user') continue;
                $c = isset($m['content']) ? $m['content'] : '';
                if (is_string($c)) { $text = $c; break; }
                if (is_array($c)) {
                    $parts = array();
                    foreach ($c as $p) {
                        if (is_string($p)) $parts[] = $p;
                        elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                    }
                    $text = implode("\n", $parts);
                    if (trim($text) !== '') break;
                }
            }
        }
    } elseif ($format === 'completions' && isset($body['prompt'])) {
        $text = (string) $body['prompt'];
    } elseif (isset($body['messages']) && is_array($body['messages'])) {
        for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
            $m = $body['messages'][$i];
            if (!is_array($m) || (isset($m['role']) && $m['role'] !== 'user')) continue;
            $c = isset($m['content']) ? $m['content'] : '';
            if (is_string($c)) { $text = $c; break; }
            if (is_array($c)) {
                $parts = array();
                foreach ($c as $p) {
                    if (is_string($p)) $parts[] = $p;
                    elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                }
                $text = implode("\n", $parts);
                if (trim($text) !== '') break;
            }
        }
    }
    $text = tc_plain_text($text, 240);
    if ($text === '') return '';
    if (function_exists('mb_strlen') && mb_strlen($text, 'UTF-8') < 2) return '';
    if (strlen($text) < 2) return '';
    return $text;
}

// 提取最后一条用户消息的纯文本(用于内容审核,不做截断压缩)
function tc_last_user_text($body, $format) {
    $text = '';
    if ($format === 'responses' && isset($body['input'])) {
        if (is_string($body['input'])) $text = $body['input'];
        elseif (is_array($body['input'])) {
            for ($i = count($body['input']) - 1; $i >= 0; $i--) {
                $m = $body['input'][$i];
                if (!is_array($m)) continue;
                $role = isset($m['role']) ? $m['role'] : '';
                if ($role && $role !== 'user') continue;
                $c = isset($m['content']) ? $m['content'] : '';
                if (is_string($c)) { $text = $c; break; }
                if (is_array($c)) {
                    $parts = array();
                    foreach ($c as $p) {
                        if (is_string($p)) $parts[] = $p;
                        elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                    }
                    $text = implode("\n", $parts);
                    if (trim($text) !== '') break;
                }
            }
        }
    } elseif ($format === 'completions' && isset($body['prompt'])) {
        $text = (string) $body['prompt'];
    } elseif (isset($body['messages']) && is_array($body['messages'])) {
        for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
            $m = $body['messages'][$i];
            if (!is_array($m) || (isset($m['role']) && $m['role'] !== 'user')) continue;
            $c = isset($m['content']) ? $m['content'] : '';
            if (is_string($c)) { $text = $c; break; }
            if (is_array($c)) {
                $parts = array();
                foreach ($c as $p) {
                    if (is_string($p)) $parts[] = $p;
                    elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                }
                $text = implode("\n", $parts);
                if (trim($text) !== '') break;
            }
        }
    }
    return tc_plain_text($text, 20000);
}

function tc_normalize_search_hits($rows, $max) {
    $out = array();
    $seen = array();
    foreach ($rows as $r) {
        if (!is_array($r)) continue;
        $url = trim((string) (isset($r['url']) ? $r['url'] : (isset($r['href']) ? $r['href'] : (isset($r['link']) ? $r['link'] : ''))));
        if ($url === '' || !preg_match('#^https?://#i', $url)) continue;
        $key = strtolower($url);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $title = tc_plain_text(isset($r['title']) ? $r['title'] : $url, 120);
        $snippet = tc_plain_text(isset($r['content']) ? $r['content'] : (isset($r['snippet']) ? $r['snippet'] : (isset($r['description']) ? $r['description'] : '')), 360);
        $out[] = array(
            'id' => (string) (count($out) + 1),
            'title' => $title !== '' ? $title : $url,
            'url' => $url,
            'snippet' => $snippet,
        );
        if (count($out) >= $max) break;
    }
    return $out;
}

function tc_search_tavily($key, $query, $max, $timeoutMs = 18000) {
    $payload = tc_json_encode(array(
        'api_key' => $key,
        'query' => $query,
        'search_depth' => 'basic',
        'max_results' => $max,
        'include_answer' => false,
    ));
    $res = tc_http_request('https://api.tavily.com/search', 'POST', array(
        'Content-Type' => 'application/json',
        'Accept' => 'application/json',
    ), $payload, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'Tavily 搜索失败');
    }
    $j = json_decode($res['body'], true);
    $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
    return array('ok' => true, 'hits' => tc_normalize_search_hits($rows, $max));
}

function tc_search_searxng($base, $query, $max, $timeoutMs = 18000) {
    $base = rtrim((string) $base, '/');
    if ($base === '' || !preg_match('#^https?://#i', $base)) {
        return array('ok' => false, 'error' => 'SearXNG 地址无效');
    }
    $url = $base . '/search?' . http_build_query(array(
        'q' => $query,
        'format' => 'json',
        'language' => 'zh-CN',
        'safesearch' => 0,
    ));
    // SearXNG 地址可由用户在「工具设置」里自填(后台开启 webSearchAllowUser 后),
    // 服务端会带着自己的网络身份去请求它,因此同样必须过 SSRF 闸门。
    if (!tc_upstream_url_is_safe($url)) {
        return array('ok' => false, 'error' => 'SearXNG 地址不可用：不允许请求内网或保留地址');
    }
    $res = tc_http_request($url, 'GET', array(
        'Accept' => 'application/json',
        'User-Agent' => 'TinyChat/1.0 (SearXNG JSON)',
    ), null, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'SearXNG 搜索失败');
    }
    $j = json_decode($res['body'], true);
    $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
    return array('ok' => true, 'hits' => tc_normalize_search_hits($rows, $max));
}

function tc_search_searxng_failover($raw, $query, $max, $timeoutMs = 12000) {
    $urls = tc_searx_url_list($raw);
    if (!$urls) return array('ok' => false, 'error' => '请先填写 SearXNG 地址');
    $errors = array();
    foreach ($urls as $i => $url) {
        $found = tc_search_searxng($url, $query, $max, $timeoutMs);
        $hits = (!empty($found['ok']) && isset($found['hits']) && is_array($found['hits'])) ? $found['hits'] : array();
        if (!empty($found['ok']) && $hits) {
            return array('ok' => true, 'hits' => $hits, 'url' => $url);
        }
        $msg = !empty($found['ok']) ? '没有返回可用结果' : (isset($found['error']) ? (string) $found['error'] : 'SearXNG 搜索失败');
        $errors[] = $url . '：' . $msg;
        if ($i >= 5) break;
    }
    return array('ok' => false, 'error' => implode('；', array_slice($errors, 0, 3)));
}

// Brave Search:独立索引,中文尚可;免费档 2000 次/月,Key 在 brave.com/search/api 申请。
// 基址可用环境变量 TC_BRAVE_SEARCH_BASE 覆盖(测试/代理用)。
function tc_search_brave($key, $query, $max, $timeoutMs = 18000) {
    $key = trim((string) $key);
    if ($key === '') return array('ok' => false, 'error' => '请先填写 Brave Search API Key');
    $base = rtrim((string) (getenv('TC_BRAVE_SEARCH_BASE') ?: 'https://api.search.brave.com'), '/');
    $url = $base . '/res/v1/web/search?' . http_build_query(array(
        'q' => $query,
        'count' => min(20, max(1, (int) $max)),
    ));
    $res = tc_http_request($url, 'GET', array(
        'Accept' => 'application/json',
        'X-Subscription-Token' => $key,
    ), null, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'Brave 搜索失败');
    }
    $j = json_decode($res['body'], true);
    $rows = (is_array($j) && isset($j['web']['results']) && is_array($j['web']['results'])) ? $j['web']['results'] : array();
    return array('ok' => true, 'hits' => tc_normalize_search_hits($rows, $max));
}

// DuckDuckGo HTML 端点:免 Key,抓结果页解析;有速率限制,被弹验证码时会把错误透传给前端。
// 基址可用环境变量 TC_DDG_HTML_BASE 覆盖(测试/代理用)。
function tc_search_ddg($query, $max, $timeoutMs = 18000) {
    $base = rtrim((string) (getenv('TC_DDG_HTML_BASE') ?: 'https://html.duckduckgo.com'), '/');
    $url = $base . '/html/?' . http_build_query(array('q' => $query));
    $res = tc_http_request($url, 'GET', array(
        'Accept' => 'text/html,application/xhtml+xml',
        'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ), null, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'DuckDuckGo 搜索失败');
    }
    $hits = tc_parse_ddg_html((string) $res['body'], $max);
    if (!$hits) {
        return array('ok' => false, 'error' => 'DuckDuckGo 没有返回结果（可能被限流或触发验证码，稍后重试或改用其他检索源）');
    }
    return array('ok' => true, 'hits' => $hits);
}

// 解析 DuckDuckGo HTML 结果页。标题锚点带跳转包装(/l/?uddg=<urlencoded>),需解包;
// 广告结果(y.js / ad_provider)直接跳过。结果片段锚点与标题按出现顺序对齐。
function tc_parse_ddg_html($html, $max) {
    $rows = array();
    if (!preg_match_all('#<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)</a>#is', (string) $html, $ms, PREG_SET_ORDER)) {
        return array();
    }
    preg_match_all('#<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>#is', (string) $html, $sm);
    $snips = isset($sm[1]) ? $sm[1] : array();
    foreach ($ms as $i => $m) {
        $href = html_entity_decode((string) $m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        if (strpos($href, 'duckduckgo.com/y.js') !== false || strpos($href, 'ad_provider=') !== false) continue;
        $url = $href;
        if (preg_match('#[?&]uddg=([^&]+)#i', $href, $um)) {
            $url = rawurldecode($um[1]);
        } elseif (strpos($url, '//') === 0) {
            $url = 'https:' . $url;
        }
        if (!preg_match('#^https?://#i', $url)) continue;
        $title = tc_plain_text(strip_tags((string) $m[2]), 200);
        if ($title === '') continue;
        $snippet = isset($snips[$i]) ? tc_plain_text(strip_tags((string) $snips[$i]), 400) : '';
        $rows[] = array('url' => $url, 'title' => $title, 'snippet' => $snippet);
        if (count($rows) >= $max) break;
    }
    return tc_normalize_search_hits($rows, $max);
}

// Jina AI 搜索(s.jina.ai):返回 LLM 友好的结构化结果;无 Key 可用但有速率限制,填 Key 提升配额。
// X-Respond-With: no-content 只要检索摘要、不读整页,保证速度。基址可用 TC_JINA_SEARCH_BASE 覆盖。
function tc_search_jina($key, $query, $max, $timeoutMs = 25000) {
    $base = rtrim((string) (getenv('TC_JINA_SEARCH_BASE') ?: 'https://s.jina.ai'), '/');
    $url = $base . '/' . rawurlencode(trim((string) $query));
    $headers = array(
        'Accept' => 'application/json',
        'X-Respond-With' => 'no-content',
    );
    if (trim((string) $key) !== '') $headers['Authorization'] = 'Bearer ' . trim((string) $key);
    $res = tc_http_request($url, 'GET', $headers, null, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'Jina 搜索失败');
    }
    $rows = tc_parse_jina_rows((string) $res['body']);
    $hits = tc_normalize_search_hits($rows, $max);
    if (!$hits) {
        return array('ok' => false, 'error' => 'Jina 没有返回结果（免 Key 额度可能已用尽，填入自己的 Key 可提升配额）');
    }
    return array('ok' => true, 'hits' => $hits);
}

// 兼容三种返回:JSON({data:[{title,url,description}]})、JSON({data:{单个对象}}),以及 markdown([标题](链接) 列表)兜底。
function tc_parse_jina_rows($body) {
    $j = json_decode((string) $body, true);
    if (is_array($j)) {
        $data = (isset($j['data']) && is_array($j['data'])) ? $j['data'] : ((isset($j[0]) && is_array($j[0])) ? $j : array());
        // data 也可能是单个对象(assoc 带 url/title),统一成列表
        if ($data && !isset($data[0]) && (isset($data['url']) || isset($data['title']))) $data = array($data);
        $rows = array();
        foreach ($data as $r) {
            if (!is_array($r)) continue;
            $url = trim((string) (isset($r['url']) ? $r['url'] : ''));
            if ($url === '') continue;
            $rows[] = array(
                'url' => $url,
                'title' => (string) (isset($r['title']) ? $r['title'] : $url),
                'snippet' => (string) (isset($r['description']) ? $r['description'] : (isset($r['content']) ? $r['content'] : '')),
            );
        }
        if ($rows) return $rows;
    }
    // markdown 兜底:抓 [标题](链接),其后最近一段非空文本当摘要
    $rows = array();
    $lines = preg_split('/\r?\n/', (string) $body);
    $n = is_array($lines) ? count($lines) : 0;
    for ($i = 0; $i < $n; $i++) {
        if (!preg_match('#\[([^\]]+)\]\((https?://[^)\s]+)\)#', (string) $lines[$i], $m)) continue;
        $snippet = '';
        for ($k = $i + 1; $k < min($n, $i + 4); $k++) {
            $line = trim(strip_tags((string) $lines[$k]));
            if ($line !== '' && strpos($line, '](') === false) { $snippet = $line; break; }
        }
        $rows[] = array('url' => $m[2], 'title' => $m[1], 'snippet' => $snippet);
    }
    return $rows;
}

function tc_search_local_verdict($query) {
    $q = trim((string) $query);
    if ($q === '') return false;
    $fresh = '/(天气|气温|新闻|头条|股价|汇率|金价|油价|比分|赛程|赛果|最新消息|最新新闻|最新版本|最近发生|今天|今日|昨天|刚才|现在几点|当前版本|实时|官网|网页|版本号|更新了什么|发生了什么|多少钱|报价)/u';
    if (preg_match($fresh, $q)) return true;
    if (preg_match('/https?:\/\/|www\./i', $q)) return true;
    $stable = '/(翻译成|润色|改写一下|续写|扩写|缩写|总结一下|概括一下|写一首|写一篇|写一段|写一份|写一封|写一个|写个|写作文|写诗|写代码|代码|函数|脚本|报错|调试|解释一下|什么是|是什么意思|怎么理解|举个例子|帮我算|计算|证明|闲聊|你好|谢谢)/u';
    if (preg_match($stable, $q)) return false;
    return null;
}

function tc_search_needs_web($query, $provider, $format, $model) {
    $q = trim((string) $query);
    if ($q === '') return false;
    $local = tc_search_local_verdict($q);
    if ($local !== null) return $local;
    $len = function_exists('mb_strlen') ? mb_strlen($q, 'UTF-8') : strlen($q);
    if ($len > 240) $q = function_exists('mb_substr') ? mb_substr($q, 0, 240, 'UTF-8') : substr($q, 0, 240);
    $prompt = "你是检索闸门。只有当这句话离开互联网上的最新事实就答不好时才回答 YES。YES 仅限：新闻、天气、股价、汇率、比分、今天或最近发生的事、最新版本、具体网页、人物或机构的近况。写作、润色、翻译、改写、闲聊、代码、数学、解释概念、基于用户已给出材料的任务，一律回答 NO。拿不准时回答 NO。只输出 YES 或 NO。\n\n" . $q;
    $model = trim((string) $model);
    if ($model === '' && isset($provider['models'][0]['id'])) $model = $provider['models'][0]['id'];
    if ($model === '') return false;
    $fmt = ($format === 'anthropic' || $format === 'responses' || $format === 'completions') ? 'chat' : $format;
    $url = tc_upstream_path(rtrim((string) $provider['baseUrl'], '/'), $fmt);
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    $testKey = tc_provider_key_for_model($provider, $model);
    if ($fmt === 'anthropic') {
        $headers['x-api-key'] = $testKey;
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $testKey;
    }
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode(array(
        'model' => $model,
        'stream' => false,
        'max_tokens' => 4,
        'temperature' => 0,
        'messages' => array(array('role' => 'user', 'content' => $prompt)),
    )), 8000, false);
    if (empty($res['ok']) || (isset($res['status']) && (int) $res['status'] >= 400)) return false;
    $j = json_decode(isset($res['body']) ? $res['body'] : '', true);
    $text = '';
    if (is_array($j) && isset($j['choices'][0]['message']['content'])) $text = trim((string) $j['choices'][0]['message']['content']);
    if ($text === '') return false;
    if (preg_match('/^\s*NO\b/i', $text)) return false;
    return (bool) preg_match('/^\s*YES\b/i', $text);
}

// 「智能联网」的后端回退判定:仅用本地规则,不调用模型(省一次 token)。
// 明确带时效性/实时性关键词或较长问句含最新事实诉求时才联网;拿不准则不联网。
function tc_search_should_auto($query) {
    $q = trim((string) $query);
    if ($q === '') return false;
    $local = tc_search_local_verdict($q);
    if ($local !== null) return $local;
    $re = '/(今天|今日|现在|目前|最新|实时|刚刚|最近|近期|本周|上周|本月|今年|截至|新闻|头条|天气|气温|空气质量|'
        . '股价|股市|汇率|油价|金价|比分|赛程|赛果|彩票|中奖|发布会|上市|涨价|降息|加息|政策|法规|新规|版本更新|发布了|'
        . 'when (is|did|does)|latest|current|today|now|news|weather|price|stock|score)\b/iu';
    if (preg_match($re, $q)) return true;
    $len = function_exists('mb_strlen') ? mb_strlen($q, 'UTF-8') : strlen($q);
    if ($len >= 60 && preg_match('/(是否|有没有|哪些|哪个|谁|多少钱|怎么样|如何)/u', $q)) return true;
    return false;
}

function tc_run_web_search($settings, $query) {
    $query = trim((string) $query);
    if ($query === '') return array('ok' => false, 'error' => '没有可检索的问题');
    if (!tc_web_search_ready($settings)) return array('ok' => false, 'error' => '管理员尚未配置联网搜索');
    $max = isset($settings['webSearchMaxResults']) ? (int) $settings['webSearchMaxResults'] : 5;
    $prov = isset($settings['webSearchProvider']) ? (string) $settings['webSearchProvider'] : 'tavily';
    if ($prov === 'searxng') {
        return tc_search_searxng_failover($settings['webSearchSearxUrl'], $query, $max);
    }
    if ($prov === 'brave') {
        return tc_search_brave(isset($settings['webSearchBraveKey']) ? $settings['webSearchBraveKey'] : '', $query, $max);
    }
    if ($prov === 'ddg') {
        return tc_search_ddg($query, $max);
    }
    if ($prov === 'jina') {
        return tc_search_jina(isset($settings['webSearchJinaKey']) ? $settings['webSearchJinaKey'] : '', $query, $max);
    }
    return tc_search_tavily($settings['webSearchTavilyKey'], $query, $max);
}

function tc_search_today() {
    try {
        $dt = new DateTime('now', new DateTimeZone('Asia/Shanghai'));
    } catch (Exception $e) {
        $dt = new DateTime('now');
    }
    $week = array('日', '一', '二', '三', '四', '五', '六');
    return $dt->format('Y年n月j日') . ' 星期' . $week[(int) $dt->format('w')];
}

function tc_html_to_text($html) {
    $html = (string) $html;
    $html = preg_replace('#<(script|style|noscript|svg|iframe|template)\b[^>]*>.*?</\1>#is', ' ', $html);
    // 注释不是正文:strip_tags 会把 <!-- ... --> 原样当文本留下来,既占额度又干扰模型
    $html = preg_replace('#<!--.*?-->#s', ' ', $html);
    $scoped = false;
    if (preg_match('#<article\b[^>]*>(.*?)</article>#is', $html, $m)) { $html = $m[1]; $scoped = true; }
    elseif (preg_match('#<main\b[^>]*>(.*?)</main>#is', $html, $m)) { $html = $m[1]; $scoped = true; }
    // 页头/页脚/侧栏/导航里几乎不会是答案,去掉后正文能更靠前,
    // 不至于被导航链接占满截断额度(很多站点正文在 1000 字之后)
    $html = preg_replace('#<(nav|header|footer|aside)\b[^>]*>.*?</\1>#is', ' ', $html);
    // 整页抓取时另删「锚文本极短」的链接:这类几乎都是菜单/面包屑,却常占掉上千字额度。
    // 已被 article/main 圈定的正文不做这一步,避免误删正文里的短链接文本。
    if (!$scoped) {
        $html = preg_replace_callback('#<a\b[^>]*>(.*?)</a>#is', function ($mm) {
            $txt = trim(html_entity_decode(strip_tags($mm[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            $len = function_exists('mb_strlen') ? mb_strlen($txt, 'UTF-8') : strlen($txt);
            return $len <= 12 ? ' ' : $mm[0];
        }, $html);
    }
    // 先转义「不构成合法标签」的 <(如正文里的「<3级」「2<3」)。
    // strip_tags 遇到裸 < 会当作标签起点一直吞到下一个 >,把正文整段吃掉
    // (实测天气页因「<3级」丢失全部预报数据),所以必须先转义再剥标签。
    // 判据:只有「<」后面能在不含 <> 的范围内闭合出「>」才算真标签,否则是正文里的比较符。
    $html = preg_replace('/<(?![a-zA-Z\/!?][^<>]*>)/', '&lt;', $html);
    $html = preg_replace('#</?(br|p|div|li|h[1-6]|tr|section|article|header|footer)\b[^>]*>#i', "\n", $html);
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace("/[ \t\x{00A0}]+/u", ' ', (string) $text);
    $text = preg_replace("/\n[ \t]+/u", "\n", (string) $text);
    $text = preg_replace("/\n{3,}/u", "\n\n", (string) $text);
    return trim((string) $text);
}

// 从 SSE 流里切出完整的 data: 行。SSE 事件按行分隔,但 curl 回调收到的 chunk 边界
// 是 TCP 层的,与事件边界无关:一条 data: {...} 完全可能被拆到两次回调里。
// 直接对单个 chunk 做 explode 会漏掉这些事件(用量统计与落库文本会静默变少),
// 所以未收尾的半行要留在 $carry 里等下一个 chunk 拼齐。
function tc_sse_take_lines(&$carry, $chunk) {
    $carry .= $chunk;
    $nl = strrpos($carry, "\n");
    if ($nl === false) return array();   // 还没有一行是完整的
    $head = substr($carry, 0, $nl);
    $carry = substr($carry, $nl + 1);
    return explode("\n", $head);
}

// 流结束时把 carry 里剩下的一段(上游最后一条事件不带换行时留下的)补一个换行交给解析器。
// 只有确实像 SSE 数据行时才解析,避免把普通响应体尾部误当事件。
function tc_sse_flush_tail(&$carry, $fn, &$target, $format) {
    if ($carry === '') return;
    $tail = $carry;
    $carry = '';
    if (strpos($tail, 'data:') !== 0 && strpos($tail, "\ndata:") === false) return;
    $fn($target, $tail . "\n", $format, $carry);
}

// 服务端从 SSE 流里解析 token 用量(镜像前端 captureStreamUsage 的逻辑)
// 兼容 OpenAI(prompt_tokens/completion_tokens)与 Anthropic(input_tokens/output_tokens)两种字段
function tc_capture_stream_usage(&$target, $chunk, $format, &$carry = null) {
    if ($carry === null) {
        if ($chunk === '' || strpos($chunk, '_tokens') === false) return;
        $lines = explode("\n", $chunk);
    } else {
        if ($chunk === '' && $carry === '') return;
        $lines = tc_sse_take_lines($carry, $chunk);   // 先累积再过滤,否则半条事件会被丢掉
        if (!$lines) return;
    }
    foreach ($lines as $line) {
        $line = trim($line);
        if (strpos($line, 'data:') !== 0) continue;
        $payload = trim(substr($line, 5));
        if ($payload === '' || $payload === '[DONE]') continue;
        $j = json_decode($payload, true);
        if (!is_array($j)) continue;
        $cands = array();
        if (isset($j['usage']) && is_array($j['usage'])) $cands[] = $j['usage'];
        if (isset($j['message']) && is_array($j['message']) && isset($j['message']['usage']) && is_array($j['message']['usage'])) $cands[] = $j['message']['usage'];
        if (isset($j['response']) && is_array($j['response']) && isset($j['response']['usage']) && is_array($j['response']['usage'])) $cands[] = $j['response']['usage'];
        foreach ($cands as $u) {
            $prompt = (int) (isset($u['prompt_tokens']) ? $u['prompt_tokens'] : (isset($u['input_tokens']) ? $u['input_tokens'] : 0));
            $completion = (int) (isset($u['completion_tokens']) ? $u['completion_tokens'] : (isset($u['output_tokens']) ? $u['output_tokens'] : 0));
            // message_delta 里的 output_tokens 是累计值,取较大者即为最终用量
            if ($prompt > (isset($target['prompt']) ? $target['prompt'] : 0)) $target['prompt'] = $prompt;
            if ($completion > (isset($target['completion']) ? $target['completion'] : 0)) $target['completion'] = $completion;
        }
    }
}

// 从请求体提取完整的 user/assistant 消息序列(供 API 对话落库)。
// 必须取全量历史而非最后一条:落库要按「首条用户消息」判断这是不是同一段上下文。
function tc_api_history_messages($body, $format) {
    $out = array();
    $push = function ($role, $content) use (&$out) {
        $c = '';
        if (is_string($content)) $c = $content;
        elseif (is_array($content)) {
            $parts = array();
            foreach ($content as $p) {
                if (is_string($p)) $parts[] = $p;
                elseif (is_array($p) && isset($p['text'])) $parts[] = (string) $p['text'];
            }
            $c = implode("
", $parts);
        }
        $c = trim($c);
        if ($c === '') return;
        $orig = isset($out[0]) ? null : null; unset($orig);
        $out[] = array('role' => $role, 'content' => substr($c, 0, 200000));
    };
    if ($format === 'responses') {
        if (isset($body['instructions']) && is_string($body['instructions'])) { /* system, 不落库 */ }
        $input = isset($body['input']) ? $body['input'] : null;
        if (is_string($input)) $push('user', $input);
        elseif (is_array($input)) {
            foreach ($input as $m) {
                if (!is_array($m)) continue;
                $role = isset($m['role']) ? $m['role'] : 'user';
                if ($role !== 'user' && $role !== 'assistant') continue;
                $push($role, isset($m['content']) ? $m['content'] : '');
            }
        }
    } elseif ($format === 'completions') {
        if (isset($body['prompt']) && is_string($body['prompt'])) $push('user', $body['prompt']);
    } elseif (isset($body['messages']) && is_array($body['messages'])) {
        foreach ($body['messages'] as $m) {
            if (!is_array($m)) continue;
            $role = isset($m['role']) ? $m['role'] : '';
            if ($role !== 'user' && $role !== 'assistant') continue;   // 跳过 system
            $push($role, isset($m['content']) ? $m['content'] : '');
        }
    }
    return $out;
}

// 流式增量文本采集:从 SSE chunk 里累加助手输出,供 API 对话落库使用
// 组装上游请求头(含鉴权)。密钥回退时用它按新密钥重建。
function tc_upstream_auth_headers($format, $apiKey, $acceptStream = false) {
    $h = array(
        'Content-Type' => 'application/json',
        'Accept' => $acceptStream ? 'text/event-stream, application/json' : 'application/json',
    );
    if ($format === 'anthropic') {
        $h['x-api-key'] = (string) $apiKey;
        $h['anthropic-version'] = '2023-06-01';
    } else {
        $h['Authorization'] = 'Bearer ' . (string) $apiKey;
    }
    return $h;
}

function tc_capture_stream_text(&$target, $chunk, $format, &$carry = null) {
    if ($carry === null) {
        if ($chunk === '' || strpos($chunk, 'data:') === false) return;
        $lines = explode("\n", $chunk);
    } else {
        if ($chunk === '' && $carry === '') return;
        // 先累积再过滤:半条事件在 carry 里,直接 return 会把整条丢掉
        $lines = tc_sse_take_lines($carry, $chunk);
        if (!$lines) return;
    }
    foreach ($lines as $line) {
        $line = trim($line);
        if (strpos($line, 'data:') !== 0) continue;
        $payload = trim(substr($line, 5));
        if ($payload === '' || $payload === '[DONE]') continue;
        $j = json_decode($payload, true);
        if (!is_array($j)) continue;
        $piece = '';
        if ($format === 'anthropic') {
            if (isset($j['delta']['text'])) $piece = (string) $j['delta']['text'];
        } elseif ($format === 'responses') {
            if (isset($j['delta']) && is_string($j['delta'])) $piece = $j['delta'];
            elseif (isset($j['output_text'])) $piece = (string) $j['output_text'];
        } elseif ($format === 'completions') {
            if (isset($j['choices'][0]['text'])) $piece = (string) $j['choices'][0]['text'];
        } else {
            if (isset($j['choices'][0]['delta']['content'])) $piece = (string) $j['choices'][0]['delta']['content'];
        }
        if ($piece !== '') $target .= $piece;
    }
}

// 进程内(单请求内)DNS 解析缓存。一次页面加载会抓几十上百个子资源,而 SSRF 闸门每个
// 资源都要解析一次主机名 —— 不缓存就是上百次 gethostbynamel,每次几十毫秒的解析延迟
// 叠加起来正是「加载网页慢」的主因之一。PHP-FPM 下静态变量只在当前请求内有效,
// 不会跨请求拿到过期结果,所以不需要 TTL。$force=false 时命中即返回。
function tc_dns_a($host, $force = false) {
    static $cache = array();
    $host = strtolower((string) $host);
    if ($host === '') return array();
    if (!$force && array_key_exists($host, $cache)) return $cache[$host];
    $ips = array();
    foreach ((array) @gethostbynamel($host) as $ip) {
        if (!in_array($ip, $ips, true)) $ips[] = $ip;
    }
    return $cache[$host] = $ips;
}

function tc_dns_aaaa($host, $force = false) {
    static $cache = array();
    $host = strtolower((string) $host);
    if ($host === '') return array();
    if (!$force && array_key_exists($host, $cache)) return $cache[$host];
    $ips = array();
    if (function_exists('dns_get_record')) {
        foreach ((array) @dns_get_record($host, DNS_AAAA) as $rec) {
            $v6 = isset($rec['ipv6']) ? $rec['ipv6'] : '';
            if ($v6 !== '' && !in_array($v6, $ips, true)) $ips[] = $v6;
        }
    }
    return $cache[$host] = $ips;
}

// SSRF 防护:校验 URL 指向公网地址 —— 拒绝内网/保留 IP(含 127.0.0.1、云元数据 169.254.169.254)、
// localhost 类主机名、非常规端口;域名会做真实 DNS 解析,返回选定 IP 供请求固定解析结果。
// ips 保留全部解析结果,供「按归属地筛选目标站」这类判定使用(只能看到一个 IP 会漏判)。
function tc_url_public_host($url) {
    $p = @parse_url((string) $url);
    if (!$p || empty($p['host'])) return false;
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if (!in_array($scheme, array('http', 'https'), true)) return false;
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
    if (!in_array($port, array(80, 443, 8080, 8443), true)) return false;
    $host = strtolower((string) $p['host']);
    $host = trim($host, '[]');
    if ($host === '' || $host === 'localhost' || preg_match('/\.(local|internal|intranet|lan|home\.arpa|arpa)$/i', $host)) return false;
    $ipOk = function ($ip) {
        return is_string($ip) && $ip !== '' && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    };
    $ips = array();
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        if ($ipOk($host)) $ips[] = $host;
    } else {
        foreach (tc_dns_a($host) as $ip) if ($ipOk($ip) && !in_array($ip, $ips, true)) $ips[] = $ip;
        if (!$ips) {
            foreach (tc_dns_aaaa($host) as $v6) if ($ipOk($v6) && !in_array($v6, $ips, true)) $ips[] = $v6;
        }
    }
    return $ips ? array('ip' => $ips[0], 'ips' => $ips, 'port' => $port, 'host' => $host) : false;
}

function tc_fetch_pages_parallel($urls, $timeoutMs = 8000, $maxChars = 1800) {
    $out = array();
    $entries = array();
    // 测试钩子:把已通过 SSRF 校验的公网地址重定向到本地 mock(与 TC_BRAVE_SEARCH_BASE 等一致的约定)。
    // 只在设置环境变量时生效,且校验发生在改写之前 —— 被拦截的地址照样进不来。
    $testBase = rtrim((string) (getenv('TC_PAGE_FETCH_BASE') ?: ''), '/');
    foreach ((array) $urls as $u) {
        $out[$u] = '';
        $guard = tc_url_public_host($u);
        if (!$guard) continue; // 内网/保留地址/非法端口:静默跳过
        if ($testBase !== '') {
            // 原始地址仍要先过 SSRF 校验(恶意搜索结果照样进不来),通过后才改写到
            // 运营方/CI 显式配置的测试基址 —— 该基址由环境变量给定,不来自页面内容。
            $p = @parse_url($u);
            $target = $testBase . '/page' . (isset($p['path']) ? $p['path'] : '/')
                . (isset($p['query']) ? '?' . $p['query'] : '');
            $tGuard = tc_url_public_host($target);
            $entries[] = array(
                'url' => $target,
                'resolve' => $tGuard ? ($tGuard['host'] . ':' . $tGuard['port'] . ':' . $tGuard['ip']) : null,
                'orig' => $u,
                'test' => true,
            );
            continue;
        }
        $entries[] = array('url' => $u, 'resolve' => $guard['host'] . ':' . $guard['port'] . ':' . $guard['ip'], 'orig' => $u);
    }
    if (!$entries) return $out;
    if (!function_exists('curl_multi_init')) {
        foreach ($entries as $e) {
            $res = tc_http_request($e['url'], 'GET', array(
                'Accept' => 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8',
                'User-Agent' => 'Mozilla/5.0 (compatible; TinyChat/1.0)',
            ), null, $timeoutMs, false);
            if (empty($res['ok']) || $res['status'] >= 400) continue;
            $out[$e['orig']] = tc_html_to_text(isset($res['body']) ? $res['body'] : '');
        }
        return $out;
    }
    $mh = curl_multi_init();
    $handles = array();
    $ca = tc_cacert_path();
    foreach ($entries as $e) {
        $ch = curl_init($e['url']);
        $opts = array(
            CURLOPT_HTTPHEADER => array(
                'Accept: text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8',
                'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
            ),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => max(4, (int) ceil($timeoutMs / 1000)),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // 固定已校验的解析结果,防 DNS 重绑定;限制协议;限制下载体积
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_MAXFILESIZE => 4194304,
        );
        // 测试基址可能是本机地址(拿不到「公网解析」结果),此时不加 RESOLVE,交给系统解析
        if (!empty($e['resolve'])) $opts[CURLOPT_RESOLVE] = array($e['resolve']);
        if ($ca) $opts[CURLOPT_CAINFO] = $ca;
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($mh, $ch);
        $handles[] = $ch;
    }
    $running = null;
    do {
        $status = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running && $status === CURLM_OK);
    foreach ($handles as $i => $ch) {
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $ctype = strtolower((string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
        $raw = curl_multi_getcontent($ch);
        // 重定向后可能落到内网:对最终生效地址再做一次校验,不通过则丢弃内容。
        // 测试基址是本机 mock,本身就不是公网地址,这一步对它跳过(该基址由环境变量显式指定)。
        $eff = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        if (empty($entries[$i]['test']) && $eff !== '' && !tc_url_public_host($eff)) { curl_multi_remove_handle($mh, $ch); curl_close($ch); continue; }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
        if ($code < 200 || $code >= 400 || !is_string($raw) || $raw === '') continue;
        if ($ctype !== '' && strpos($ctype, 'html') === false && strpos($ctype, 'text/plain') === false && strpos($ctype, 'xml') === false) continue;
        if (strlen($raw) > 800000) $raw = substr($raw, 0, 800000);
        $text = (strpos($ctype, 'text/plain') !== false) ? trim($raw) : tc_html_to_text($raw);
        $text = trim((string) preg_replace('/[ \t]+/u', ' ', $text));
        $len = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
        if ($len < 80) continue;
        $out[$entries[$i]['orig']] = function_exists('mb_substr') ? mb_substr($text, 0, $maxChars, 'UTF-8') : substr($text, 0, $maxChars);
    }
    curl_multi_close($mh);
    return $out;
}

function tc_enrich_search_pages(&$hits) {
    // 候选最多看 5 条(与搜索结果条数上限一致),但只有「确实抓到正文」的才占名额:
    // 纯前端渲染页/抓取失败很常见,若按前 3 条硬取,一条空白就会让后面对的内容轮不到。
    $want = array();
    foreach ($hits as $i => $h) {
        if (count($want) >= 5) break;
        $url = isset($h['url']) ? (string) $h['url'] : '';
        if ($url === '' || preg_match('/\.(pdf|zip|png|jpe?g|gif|webp|mp4|mp3)(\?|$)/i', $url)) continue;
        $want[$i] = $url;
    }
    if (!$want) return;
    $pages = tc_fetch_pages_parallel(array_values($want), 8000);
    $kept = 0;
    foreach ($want as $i => $url) {
        if ($kept >= 3) break;
        $text = isset($pages[$url]) ? trim((string) $pages[$url]) : '';
        if ($text === '') continue;
        $hits[$i]['page'] = $text;
        $kept++;
    }
}

function tc_format_search_context($hits) {
    $lines = array(
        '今天是 ' . tc_search_today() . '（北京时间）。用户已打开联网搜索。',
        '下列材料包含检索摘要，以及已经打开的网页正文摘录。回答事实、日期和数字时只依据这些材料；材料里没有的就说明没查到，不要改用你的训练截止日期，也不要说自己无法浏览网页。',
        '在正文用 [1]、[2] 标注对应条目，不要编造未列出的网址。',
    );
    foreach ($hits as $i => $h) {
        $n = $i + 1;
        $block = '[' . $n . '] ' . $h['title'] . "\nURL: " . $h['url'];
        if (!empty($h['snippet'])) $block .= "\n摘要: " . $h['snippet'];
        if (!empty($h['page'])) $block .= "\n正文摘录: " . $h['page'];
        $lines[] = $block;
    }
    return implode("\n\n", $lines);
}

// ============ 链接读取:用户消息里带网址时,自动打开并提取正文作为回答材料 ============
function tc_urls_from_last_user_message($body, $format) {
    $text = tc_web_search_query_from_body($body, $format);
    if ($text === '' || stripos($text, 'http://') === false && stripos($text, 'https://') === false) return array();
    // 只匹配 URL 合法字符:遇到中文等自然语言字符即视为链接结束
    if (!preg_match_all('~https?://[A-Za-z0-9\-._%!$&\'()*+,;=:@/?#\[\]\~]+~u', $text, $m)) return array();
    $urls = array();
    foreach ($m[0] as $u) {
        $u = rtrim($u, '.,;:!?\'"');
        // 括号失衡时去掉尾部括号(维基百科类成对括号路径保留)
        while ($u !== '' && substr_count($u, '(') !== substr_count($u, ')') && substr($u, -1) === ')') $u = substr($u, 0, -1);
        while ($u !== '' && substr_count($u, '[') !== substr_count($u, ']') && substr($u, -1) === ']') $u = substr($u, 0, -1);
        if ($u === '' || !preg_match('#^https?://[^\s]+\.[^\s]+$#i', $u)) continue;
        if (!in_array($u, $urls, true)) $urls[] = $u;
    }
    return $urls;
}

function tc_read_urls_to_citations($urls, $settings) {
    $max = max(1, min(5, (int) (isset($settings['urlReadMax']) ? $settings['urlReadMax'] : 3) ?: 3));
    $urls = array_slice($urls, 0, $max);
    if (!$urls) return array();
    $pages = tc_fetch_pages_parallel($urls, 9000);
    $out = array();
    foreach ($urls as $u) {
        $text = trim((string) (isset($pages[$u]) ? $pages[$u] : ''));
        if ($text === '') continue;
        $host = (string) parse_url($u, PHP_URL_HOST);
        $out[] = array('url' => $u, 'title' => $host !== '' ? $host : $u, 'snippet' => '', 'page' => tc_mb_cut($text, 8000));
    }
    return $out;
}

function tc_format_url_read_context($hits, $start) {
    $lines = array(
        '用户消息中包含以下链接，已打开并提取正文。回答这些链接相关的问题时以正文为准；正文里没有的信息就说明没抓到，不要编造。',
        '在正文用 [' . ($start + 1) . ']、[' . ($start + 2) . '] 标注对应条目。',
    );
    foreach ($hits as $i => $h) {
        $n = $start + $i + 1;
        $block = '[' . $n . '] ' . $h['title'] . "\nURL: " . $h['url'];
        if (!empty($h['page'])) $block .= "\n正文摘录: " . $h['page'];
        $lines[] = $block;
    }
    return implode("\n\n", $lines);
}

function tc_append_system_text(&$body, $format, $extra) {
    $extra = trim((string) $extra);
    if ($extra === '') return;
    if ($format === 'anthropic') {
        $cur = isset($body['system']) ? (string) $body['system'] : '';
        $body['system'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    if ($format === 'responses') {
        $cur = isset($body['instructions']) ? (string) $body['instructions'] : '';
        $body['instructions'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    if ($format === 'completions') {
        $cur = isset($body['prompt']) ? (string) $body['prompt'] : '';
        $body['prompt'] = $extra . "\n\n" . $cur;
        return;
    }
    if (!isset($body['messages']) || !is_array($body['messages'])) $body['messages'] = array();
    if (isset($body['messages'][0]) && is_array($body['messages'][0]) && isset($body['messages'][0]['role']) && $body['messages'][0]['role'] === 'system') {
        $cur = isset($body['messages'][0]['content']) ? (string) $body['messages'][0]['content'] : '';
        $body['messages'][0]['content'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    array_unshift($body['messages'], array('role' => 'system', 'content' => $extra));
}

function tc_public_searx_fallback() {
    return array(
        'https://baresearch.org',
        'https://etsi.me',
        'https://opnxng.com',
        'https://paulgo.io',
        'https://priv.au',
        'https://search.inetol.net',
        'https://search.mdosch.de',
        'https://searx.tiekoetter.com',
        'https://searx.namejeff.xyz',
        'https://searxng.site',
        'https://searxng.website',
        'https://sx.catgirl.cloud',
    );
}

function tc_public_searx_instances() {
    $file = tc_data_dir() . '/searx-instances.json';
    $fresh = is_file($file) && (time() - (int) @filemtime($file)) < 6 * 3600;
    $text = $fresh ? (string) @file_get_contents($file) : '';
    if ($text === '') {
        $sources = array(
            'https://cdn.jsdelivr.net/gh/searxng/searx-instances@master/searxinstances/instances.yml',
            'https://fastly.jsdelivr.net/gh/searxng/searx-instances@master/searxinstances/instances.yml',
        );
        foreach ($sources as $src) {
            $res = tc_http_request($src, 'GET', array('Accept' => 'text/yaml, text/plain, */*'), null, 8000, false);
            if (!empty($res['ok']) && $res['status'] < 400 && !empty($res['body']) && strpos($res['body'], 'https://') !== false) {
                $text = $res['body'];
                break;
            }
        }
    }
    $urls = array();
    if ($text !== '' && $text[0] === '[') {
        $cached = json_decode($text, true);
        if (is_array($cached)) $urls = $cached;
    } elseif ($text !== '') {
        if (preg_match_all('/^(https:\/\/[^\s:#]+)\s*:/m', $text, $m)) $urls = $m[1];
    }
    $out = array();
    $seen = array();
    foreach ($urls as $u) {
        $u = rtrim(trim((string) $u), '/');
        if (!preg_match('#^https://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $u;
    }
    if (!$out) $out = tc_public_searx_fallback();
    if (!$fresh && $out && $text !== '') {
        @file_put_contents($file, tc_json_encode($out), LOCK_EX);
    }
    return $out;
}

function tc_probe_searx_many($urls, $query, $max, $timeoutMs = 6000) {
    if (!function_exists('curl_multi_init') || !$urls) {
        $out = array();
        foreach ($urls as $u) $out[] = tc_probe_search_endpoint('searxng', $query, '', $u, $max, $timeoutMs);
        return $out;
    }
    $mh = curl_multi_init();
    $handles = array();
    $started = tc_now();
    foreach ($urls as $i => $base) {
        $base = rtrim((string) $base, '/');
        $url = $base . '/search?' . http_build_query(array(
            'q' => $query,
            'format' => 'json',
            'language' => 'zh-CN',
            'safesearch' => 0,
        ));
        $ch = curl_init($url);
        $opts = array(
            CURLOPT_HTTPHEADER => array('Accept: application/json', 'User-Agent: TinyChat/1.0 (SearXNG JSON)'),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 2,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => max(2, (int) ceil($timeoutMs / 1000)),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADER => false,
        );
        $ca = tc_cacert_path();
        if ($ca) $opts[CURLOPT_CAINFO] = $ca;
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($mh, $ch);
        $handles[$i] = array('ch' => $ch, 'base' => $base);
    }
    $running = null;
    do {
        $stat = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 0.4);
    } while ($running && $stat === CURLM_OK);
    $ms = tc_now() - $started;
    $out = array();
    foreach ($handles as $h) {
        $ch = $h['ch'];
        $raw = curl_multi_getcontent($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
        $hits = array();
        $error = '';
        if ($raw === false || $raw === null || $err || $status === 0) {
            $error = $err ?: '连接失败或超时';
        } elseif ($status >= 400) {
            $error = tc_upstream_error_message((string) $raw, $status);
        } else {
            $j = json_decode($raw, true);
            $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
            $hits = tc_normalize_search_hits($rows, $max);
            if (!$hits) $error = '没有返回可用结果';
        }
        $sample = array();
        foreach (array_slice($hits, 0, 2) as $hit) $sample[] = array('title' => $hit['title'], 'url' => $hit['url']);
        $out[] = array(
            'ok' => count($hits) > 0,
            'provider' => 'searxng',
            'url' => $h['base'],
            'ms' => $ms,
            'count' => count($hits),
            'error' => $error,
            'sample' => $sample,
        );
    }
    curl_multi_close($mh);
    usort($out, function ($a, $b) {
        if ($a['ok'] === $b['ok']) return $a['ms'] - $b['ms'];
        return $a['ok'] ? -1 : 1;
    });
    return $out;
}

function tc_probe_search_endpoint($provider, $query, $key, $url, $max, $timeoutMs = 8000) {
    $started = tc_now();
    if ($provider === 'searxng') {
        $found = tc_search_searxng($url, $query, $max, $timeoutMs);
    } elseif ($provider === 'brave') {
        $found = tc_search_brave($key, $query, $max, $timeoutMs);
    } elseif ($provider === 'ddg') {
        $found = tc_search_ddg($query, $max, $timeoutMs);
    } elseif ($provider === 'jina') {
        $found = tc_search_jina($key, $query, $max, $timeoutMs);
    } else {
        $found = tc_search_tavily($key, $query, $max, $timeoutMs);
    }
    $ms = tc_now() - $started;
    $hits = (!empty($found['ok']) && isset($found['hits']) && is_array($found['hits'])) ? $found['hits'] : array();
    $sample = array();
    foreach (array_slice($hits, 0, 3) as $h) {
        $sample[] = array('title' => $h['title'], 'url' => $h['url']);
    }
    $provUrl = array(
        'tavily' => 'https://api.tavily.com',
        'brave' => rtrim((string) (getenv('TC_BRAVE_SEARCH_BASE') ?: 'https://api.search.brave.com'), '/'),
        'ddg' => rtrim((string) (getenv('TC_DDG_HTML_BASE') ?: 'https://html.duckduckgo.com'), '/'),
        'jina' => rtrim((string) (getenv('TC_JINA_SEARCH_BASE') ?: 'https://s.jina.ai'), '/'),
    );
    return array(
        'ok' => !empty($found['ok']) && count($hits) > 0,
        'provider' => $provider,
        'url' => $provider === 'searxng' ? rtrim((string) $url, '/') : (isset($provUrl[$provider]) ? $provUrl[$provider] : $provUrl['tavily']),
        'ms' => $ms,
        'count' => count($hits),
        'error' => !empty($found['ok']) ? (count($hits) ? '' : '没有返回可用结果') : (isset($found['error']) ? (string) $found['error'] : '搜索失败'),
        'sample' => $sample,
    );
}

function tc_api_admin_test_search() {
    $ctx = tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $provider = strtolower(trim((string) (isset($b['provider']) ? $b['provider'] : 'tavily')));
        if (!in_array($provider, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true)) $provider = 'tavily';
        $query = tc_plain_text(isset($b['query']) ? $b['query'] : 'openai', 120);
        if ($query === '') $query = 'openai';
        $max = isset($b['max']) ? (int) $b['max'] : 3;
        $max = min(5, max(1, $max ?: 3));
        $scan = !empty($b['scan']);
        $key = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        // 掩码 Key(回显的 •••)或未填时回退到已保存的对应源 Key;ddg 不需要 Key
        if ($key === '' || strpos($key, '••') !== false) {
            $keyMap = array(
                'tavily' => 'webSearchTavilyKey',
                'brave' => 'webSearchBraveKey',
                'jina' => 'webSearchJinaKey',
            );
            $key = '';
            if (isset($keyMap[$provider])) {
                $key = isset($db['settings'][$keyMap[$provider]]) ? (string) $db['settings'][$keyMap[$provider]] : '';
            }
        }
        $url = trim((string) (isset($b['url']) ? $b['url'] : ''));
        if ($url === '') $url = isset($db['settings']['webSearchSearxUrl']) ? (string) $db['settings']['webSearchSearxUrl'] : '';
        $url = tc_searx_urls_text($url);
        return array(
            'provider' => $provider,
            'query' => $query,
            'max' => $max,
            'scan' => $scan,
            'key' => $key,
            'url' => $url,
        );
    });
    if ($ctx['provider'] === 'tavily') {
        if ($ctx['key'] === '') tc_fail(400, '请先填写 Tavily API Key');
        tc_json(200, array('result' => tc_probe_search_endpoint('tavily', $ctx['query'], $ctx['key'], '', $ctx['max'])));
    }
    if ($ctx['provider'] === 'brave') {
        if ($ctx['key'] === '') tc_fail(400, '请先填写 Brave Search API Key');
        tc_json(200, array('result' => tc_probe_search_endpoint('brave', $ctx['query'], $ctx['key'], '', $ctx['max'])));
    }
    if ($ctx['provider'] === 'ddg') {
        tc_json(200, array('result' => tc_probe_search_endpoint('ddg', $ctx['query'], '', '', $ctx['max'])));
    }
    if ($ctx['provider'] === 'jina') {
        tc_json(200, array('result' => tc_probe_search_endpoint('jina', $ctx['query'], $ctx['key'], '', $ctx['max'])));
    }
    if (!$ctx['scan']) {
        $mine = tc_searx_url_list($ctx['url']);
        if (!$mine) tc_fail(400, '请先填写 SearXNG 地址');
        $results = array();
        foreach ($mine as $u) $results[] = tc_probe_search_endpoint('searxng', $ctx['query'], '', $u, $ctx['max']);
        tc_json(200, array('query' => $ctx['query'], 'results' => $results));
    }
    $urls = array();
    $seen = array();
    $candidates = array_merge(tc_searx_url_list($ctx['url']), tc_public_searx_instances());
    foreach ($candidates as $u) {
        $u = rtrim(trim((string) $u), '/');
        if ($u === '' || !preg_match('#^https://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $urls[] = $u;
    }
    @set_time_limit(40);
    $results = array();
    foreach (array_chunk($urls, 24) as $chunk) {
        foreach (tc_probe_searx_many($chunk, $ctx['query'], $ctx['max'], 5000) as $row) $results[] = $row;
    }
    usort($results, function ($a, $b) {
        if ($a['ok'] === $b['ok']) return $a['ms'] - $b['ms'];
        return $a['ok'] ? -1 : 1;
    });
    tc_json(200, array(
        'query' => $ctx['query'],
        'total' => count($urls),
        'results' => $results,
    ));
}

function tc_model_reply_text($data, $format) {
    if (!is_array($data)) return '';
    if ($format === 'anthropic') {
        $parts = array();
        if (isset($data['content']) && is_array($data['content'])) {
            foreach ($data['content'] as $p) {
                if (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
            }
        }
        return tc_plain_text(implode("\n", $parts), 240);
    }
    if ($format === 'responses') {
        if (isset($data['output_text'])) return tc_plain_text($data['output_text'], 240);
        $parts = array();
        if (isset($data['output']) && is_array($data['output'])) {
            foreach ($data['output'] as $o) {
                if (!is_array($o) || !isset($o['content']) || !is_array($o['content'])) continue;
                foreach ($o['content'] as $c) {
                    if (is_array($c) && isset($c['text'])) $parts[] = $c['text'];
                }
            }
        }
        return tc_plain_text(implode("\n", $parts), 240);
    }
    if ($format === 'completions') {
        return tc_plain_text(isset($data['choices'][0]['text']) ? $data['choices'][0]['text'] : '', 240);
    }
    $choice = isset($data['choices'][0]) ? $data['choices'][0] : array();
    $msg = isset($choice['message']) ? $choice['message'] : array();
    $content = isset($msg['content']) ? $msg['content'] : (isset($choice['text']) ? $choice['text'] : '');
    if (is_array($content)) {
        $parts = array();
        foreach ($content as $p) {
            if (is_string($p)) $parts[] = $p;
            elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
        }
        $content = implode("\n", $parts);
    }
    return tc_plain_text($content, 240);
}

// 日志用:取模型回复的完整文本(不做摘要截断,由调用方按日志上限裁剪)
function tc_model_reply_full($data, $format) {
    if (!is_array($data)) return is_string($data) ? $data : '';
    if ($format === 'anthropic') {
        $parts = array();
        if (isset($data['content']) && is_array($data['content'])) {
            foreach ($data['content'] as $p) {
                if (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
            }
        }
        return implode("\n", $parts);
    }
    if ($format === 'responses') {
        if (isset($data['output_text']) && is_string($data['output_text'])) return $data['output_text'];
        $parts = array();
        if (isset($data['output']) && is_array($data['output'])) {
            foreach ($data['output'] as $o) {
                if (!is_array($o) || !isset($o['content']) || !is_array($o['content'])) continue;
                foreach ($o['content'] as $c) {
                    if (is_array($c) && isset($c['text'])) $parts[] = $c['text'];
                }
            }
        }
        return implode("\n", $parts);
    }
    if ($format === 'completions') {
        return isset($data['choices'][0]['text']) ? (string) $data['choices'][0]['text'] : '';
    }
    $choice = isset($data['choices'][0]) ? $data['choices'][0] : array();
    $msg = isset($choice['message']) ? $choice['message'] : array();
    $content = isset($msg['content']) ? $msg['content'] : (isset($choice['text']) ? $choice['text'] : '');
    if (is_array($content)) {
        $parts = array();
        foreach ($content as $p) {
            if (is_string($p)) $parts[] = $p;
            elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
        }
        $content = implode("\n", $parts);
    }
    return is_string($content) ? $content : '';
}

// 视频模型连通性测试(管理员/个人共用):只建任务判定连通,不等待出片。
// 成功后直接输出响应并退出。
function tc_video_test_and_reply($baseUrl, $model, $prompt, $apiKey, $providerName, $userName, $userId, $providerId) {
    $baseUrl = rtrim(trim((string) $baseUrl), '/');
    if (!preg_match('/^https?:\/\//i', $baseUrl)) tc_fail(400, '供应商 Base URL 无效');
    $vurl = tc_api_url($baseUrl, '/videos');
    // 视频连通性测试同样带服务端身份出站(调用方的 format=video 分支会走到这里,
    // 绕开调用方的检查),在这里单独把关。
    tc_upstream_guard($vurl);
    $vbody = array('model' => $model, 'prompt' => $prompt, 'mode' => 'text', 'seconds' => '4', 'size' => '720P', 'aspect_ratio' => '16:9', 'n' => 1);
    $started = tc_now();
    $vres = tc_http_request($vurl, 'POST', array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . $apiKey), tc_json_encode($vbody), 30000, false, null, true, 20000);
    $ms = tc_now() - $started;
    if (empty($vres['ok'])) tc_fail($vres['code'] === 504 ? 504 : 502, tc_model_test_safe_error(tc_upstream_fail_message($vres, $providerName), $apiKey));
    if ((int) $vres['status'] >= 400) tc_fail((int) $vres['status'] >= 500 ? 502 : 400, tc_model_test_safe_error(tc_upstream_error_message($vres['body'], $vres['status']), $apiKey));
    $vj = json_decode((string) $vres['body'], true);
    $vid = '';
    if (is_array($vj)) {
        foreach (array('video_id', 'id', 'task_id') as $k) { if (!empty($vj[$k]) && is_string($vj[$k])) { $vid = $vj[$k]; break; } }
    }
    $reply = $vid !== '' ? ('已提交视频任务（ID：' . $vid . '）') : '上游已响应（未返回任务 ID）';
    tc_push_log(array('kind' => 'model-test', 'userName' => $userName, 'userId' => $userId, 'provider' => $providerName, 'providerId' => $providerId, 'model' => $model, 'format' => 'video', 'status' => 200, 'ms' => $ms, 'cost' => 0, 'ok' => true));
    tc_json(200, array('result' => array('ok' => true, 'model' => $model, 'ms' => $ms, 'reply' => $reply, 'error' => '')));
}

function tc_api_admin_test_model() {
    $ctx = tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $baseUrl = rtrim(trim((string) (isset($b['baseUrl']) ? $b['baseUrl'] : '')), '/');
        $format = (isset($b['apiFormat']) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic', 'video'), true))
            ? $b['apiFormat'] : 'chat';
        $model = trim((string) (isset($b['model']) ? $b['model'] : ''));
        $prompt = tc_plain_text(isset($b['prompt']) ? $b['prompt'] : '回复一个字：好', 400);
        if ($prompt === '') $prompt = '回复一个字：好';
        if ($baseUrl === '') tc_fail(400, '请先填写 Base URL');
        if ($model === '') tc_fail(400, '请选择要测试的模型');
        if (!preg_match('/^https?:\/\//i', $baseUrl)) tc_fail(400, 'Base URL 需以 http:// 或 https:// 开头');
        $apiKey = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        if (($apiKey === '' || strpos($apiKey, '••') !== false) && !empty($b['providerId'])) {
            foreach ($db['providers'] as $p) {
                if ($p['id'] === (string) $b['providerId']) {
                    $apiKey = tc_provider_key($p);
                    break;
                }
            }
        }
        if ($apiKey === '') tc_fail(400, '请先填写 API Key');
        // 单次测试的超时(秒)。模型可能因上游慢/模型不存在而长时间不响应,
        // 允许管理员按需调小,便于批量测试时快速跳过不可用的模型。
        // 未传时用 25 秒;传了(含 0/负数)一律夹紧到 3~120,不再回退默认值 ——
        // 否则传 0 会被当成「没填」而变回 25 秒,与预期不符。
        $timeoutSec = array_key_exists('timeoutSec', $b) ? (int) $b['timeoutSec'] : 25;
        $timeoutSec = min(120, max(3, $timeoutSec));
        return array(
            'baseUrl' => $baseUrl,
            'format' => $format,
            'model' => substr($model, 0, 120),
            'prompt' => $prompt,
            'apiKey' => $apiKey,
            'timeoutMs' => $timeoutSec * 1000,
        );
    });
    // 视频模型:建任务即可判定连通(不等待出片),返回任务 ID / 状态
    if ($ctx['format'] === 'video') {
        tc_video_test_and_reply($ctx['baseUrl'], $ctx['model'], $ctx['prompt'], $ctx['apiKey'], '', '', '', '');
    }
    $body = array('model' => $ctx['model'], 'stream' => false);
    if ($ctx['format'] === 'anthropic') {
        $body['max_tokens'] = 64;
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
    } elseif ($ctx['format'] === 'responses') {
        $body['input'] = $ctx['prompt'];
        $body['max_output_tokens'] = 64;
    } elseif ($ctx['format'] === 'completions') {
        $body['prompt'] = $ctx['prompt'];
        $body['max_tokens'] = 64;
    } else {
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
        $body['max_tokens'] = 64;
    }
    $url = tc_upstream_path($ctx['baseUrl'], $ctx['format']);
    // 连通性测试同样会带服务端身份出站,内网目标一律拒绝。
    if (!tc_upstream_url_is_safe($url)) tc_fail(400, '不允许请求内网或保留地址');
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($ctx['format'] === 'anthropic') {
        $headers['x-api-key'] = $ctx['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $ctx['apiKey'];
    }
    $started = tc_now();
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), (int) $ctx['timeoutMs'], false);
    $ms = tc_now() - $started;
    if (!$res['ok']) {
        $failMsg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
        // 超时要单独说清楚:这是「等太久主动放弃」,不是模型一定不可用,
        // 批量测试时据此自动跳到下一个模型,避免整批卡在同一个慢模型上。
        $isTimeout = ($ms >= (int) $ctx['timeoutMs'] - 500)
            || preg_match('/timed?\s*out|timeout|超时/i', (string) (isset($res['error']) ? $res['error'] : ''));
        tc_json(200, array('result' => array(
            'ok' => false,
            'model' => $ctx['model'],
            'ms' => $ms,
            'timeout' => (bool) $isTimeout,
            'error' => $isTimeout
                ? ('请求超过 ' . round((int) $ctx['timeoutMs'] / 1000) . ' 秒仍未响应，已判定为超时（可在上方调小超时时间，或在后台加大上限后重试）')
                : $failMsg,
        )));
    }
    if ($res['status'] >= 400) {
        tc_json(200, array('result' => array(
            'ok' => false,
            'model' => $ctx['model'],
            'ms' => $ms,
            'status' => $res['status'],
            'error' => tc_upstream_error_message($res['body'], $res['status']),
        )));
    }
    $j = json_decode($res['body'], true);
    $reply = tc_model_reply_text($j, $ctx['format']);
    tc_json(200, array('result' => array(
        'ok' => $reply !== '',
        'model' => $ctx['model'],
        'ms' => $ms,
        'reply' => $reply,
        'error' => $reply === '' ? '上游已响应，但没有读到文本回复' : '',
    )));
}

function tc_model_test_safe_error($message, $apiKey) {
    $message = (string) $message;
    $apiKey = (string) $apiKey;
    if ($apiKey !== '') $message = str_replace($apiKey, '[已隐藏]', $message);
    return substr($message, 0, 200);
}

function tc_api_user_test_model() {
    $ctx = tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body(65536);
        $providerId = trim((string) (isset($b['providerId']) ? $b['providerId'] : ''));
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 120);
        $prompt = tc_plain_text(isset($b['prompt']) ? $b['prompt'] : '回复一个字：好', 400);
        if ($providerId === '') tc_fail(400, '请选择要测试的个人供应商');
        if ($model === '') tc_fail(400, '请选择要测试的模型');
        if ($prompt === '') $prompt = '回复一个字：好';

        $provider = null;
        foreach ($db['providers'] as $p) {
            if ($p['id'] === $providerId && isset($p['ownerId']) && $p['ownerId'] === $user['id'] && (!isset($p['scope']) || $p['scope'] === 'user')) {
                $provider = $p;
                break;
            }
        }
        if (!$provider) tc_fail(403, '只能测试自己添加的供应商');
        $found = false;
        foreach ((isset($provider['models']) ? $provider['models'] : array()) as $m) {
            if (is_array($m) && isset($m['id']) && $m['id'] === $model) { $found = true; break; }
        }
        if (!$found) tc_fail(403, '该模型不在供应商的已保存模型列表中');
        $apiKey = trim((string) tc_provider_key($provider));
        if ($apiKey === '') tc_fail(400, '该供应商没有可用的 API Key');
        return array(
            'user' => $user,
            'provider' => $provider,
            'format' => (isset($provider['apiFormat']) && in_array($provider['apiFormat'], array('chat', 'responses', 'completions', 'anthropic', 'video'), true)) ? $provider['apiFormat'] : 'chat',
            'model' => $model,
            'prompt' => $prompt,
            'apiKey' => $apiKey,
        );
    });

    $format = $ctx['format'];
    $provider = $ctx['provider'];
    // 视频模型:建任务即可判定连通(不等待出片),返回任务 ID / 状态
    if ($format === 'video') {
        tc_video_test_and_reply(
            isset($provider['baseUrl']) ? $provider['baseUrl'] : '',
            $ctx['model'], $ctx['prompt'], $ctx['apiKey'],
            isset($provider['name']) ? $provider['name'] : '',
            isset($ctx['user']['name']) ? $ctx['user']['name'] : '',
            isset($ctx['user']['id']) ? $ctx['user']['id'] : '',
            isset($provider['id']) ? $provider['id'] : ''
        );
    }
    $body = array('model' => $ctx['model'], 'stream' => false);
    if ($format === 'anthropic') {
        $body['max_tokens'] = 64;
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
    } elseif ($format === 'responses') {
        $body['input'] = $ctx['prompt'];
        $body['max_output_tokens'] = 64;
    } elseif ($format === 'completions') {
        $body['prompt'] = $ctx['prompt'];
        $body['max_tokens'] = 64;
    } else {
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
        $body['max_tokens'] = 64;
    }

    $baseUrl = rtrim(trim((string) (isset($ctx['provider']['baseUrl']) ? $ctx['provider']['baseUrl'] : '')), '/');
    if (!preg_match('/^https?:\/\//i', $baseUrl)) tc_fail(400, '供应商 Base URL 无效');
    $url = tc_upstream_path($baseUrl, $format);
    // 该接口允许直接传 baseUrl 试探连通性,同样不能成为探内网的跳板。
    if (!tc_upstream_url_is_safe($url)) tc_fail(400, '不允许请求内网或保留地址');
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($format === 'anthropic') {
        $headers['x-api-key'] = $ctx['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $ctx['apiKey'];
    }

    $started = tc_now();
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), 25000, false);
    $ms = tc_now() - $started;
    $provider = $ctx['provider'];
    $baseLog = array(
        'kind' => 'model-test',
        'userName' => isset($ctx['user']['name']) ? $ctx['user']['name'] : '',
        'userId' => isset($ctx['user']['id']) ? $ctx['user']['id'] : '',
        'provider' => isset($provider['name']) ? $provider['name'] : '',
        'providerId' => isset($provider['id']) ? $provider['id'] : '',
        'model' => $ctx['model'],
        'format' => $format,
        'ms' => $ms,
        'cost' => 0,
    );
    if (!$res['ok']) {
        $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
        $safeMsg = tc_model_test_safe_error($msg, $ctx['apiKey']);
        $baseLog['status'] = 0;
        $baseLog['ok'] = false;
        $baseLog['error'] = $safeMsg;
        tc_push_log($baseLog);
        tc_fail($res['code'] === 504 ? 504 : 502, $safeMsg);
    }
    if ($res['status'] >= 400) {
        $msg = tc_upstream_error_message($res['body'], $res['status']);
        $safeMsg = tc_model_test_safe_error($msg, $ctx['apiKey']);
        $baseLog['status'] = $res['status'];
        $baseLog['ok'] = false;
        $baseLog['error'] = $safeMsg;
        tc_push_log($baseLog);
        tc_fail($res['status'] >= 500 ? 502 : 400, $safeMsg);
    }

    $j = json_decode($res['body'], true);
    $reply = tc_model_reply_text($j, $format);
    $ok = $reply !== '';
    $baseLog['status'] = $res['status'] ?: 200;
    $baseLog['ok'] = $ok;
    if (!$ok) $baseLog['error'] = '上游已响应，但没有读到文本回复';
    tc_push_log($baseLog);
    tc_json(200, array('result' => array(
        'ok' => $ok,
        'model' => $ctx['model'],
        'ms' => $ms,
        'reply' => $reply,
        'error' => $ok ? '' : '上游已响应，但没有读到文本回复',
    )));
}

function tc_api_fetch_models() {
    $started = tc_now();
    $ctx = tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $baseUrl = rtrim(trim((string) (isset($b['baseUrl']) ? $b['baseUrl'] : '')), '/');
        $format = (isset($b['apiFormat']) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic', 'video'), true))
            ? $b['apiFormat'] : 'chat';
        if ($baseUrl === '') tc_fail(400, '请先填写 Base URL');
        if ($format === 'anthropic') tc_fail(400, 'Anthropic 不支持自动获取模型，请手动填写模型列表');
        $apiKey = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        $wantKeyId = isset($b['keyId']) ? trim((string) $b['keyId']) : '';
        if (($apiKey === '' || strpos($apiKey, '••') !== false) && !empty($b['providerId'])) {
            foreach ($db['providers'] as $p) {
                if ($p['id'] === (string) $b['providerId'] && ((isset($p['ownerId']) && $p['ownerId'] === $user['id']) || !empty($user['admin']))) {
                    // 指定了 keyId 就用那把 Key,否则用默认钥匙
                    $apiKey = $wantKeyId !== '' ? tc_provider_key_by_id($p, $wantKeyId) : tc_provider_key($p);
                    break;
                }
            }
        }
        if ($apiKey === '') tc_fail(400, '请先填写 API Key');
        // 掩码占位符不是真实密钥:带着它请求上游只会得到误导性的 401。
        // 常见于「编辑供应商 + 留空 Key」但 providerId 不匹配(非本人/已删除)的场景,本地直接给出可行动的提示。
        if (strpos($apiKey, '••') !== false) tc_fail(400, '请先填写 API Key（编辑已有供应商时留空即沿用已保存的密钥）');
        $url = tc_api_url($baseUrl, '/models');
        // 这里带着服务端身份出站,且 baseUrl 直接来自请求体:必须过 SSRF 闸门。
        tc_upstream_guard($url);
        return array('url' => $url, 'apiKey' => $apiKey);
    });
    $res = tc_http_request($ctx['url'], 'GET', array(
        'Authorization' => 'Bearer ' . $ctx['apiKey'],
        'Accept' => 'application/json',
    ), null, 20000, false);
    if (!$res['ok']) {
        tc_fail($res['code'] === 504 ? 504 : 502, tc_upstream_fail_message($res));
    }
    if ($res['status'] >= 400) tc_fail(400, tc_upstream_error_message($res['body'], $res['status']));
    $j = json_decode($res['body'], true);
    if (!is_array($j)) tc_fail(400, '无法解析模型列表响应');
    $arr = array();
    if (isset($j['data']) && is_array($j['data'])) $arr = $j['data'];
    elseif (isset($j['models']) && is_array($j['models'])) $arr = $j['models'];
    $mapped = array();
    foreach ($arr as $m) {
        if (!is_array($m)) continue;
        $mapped[] = array('id' => isset($m['id']) ? $m['id'] : (isset($m['name']) ? $m['name'] : ''), 'name' => isset($m['name']) ? $m['name'] : (isset($m['id']) ? $m['id'] : ''));
    }
    unset($started);
    tc_json(200, array('models' => tc_normalize_models($mapped)));
}

// 计费结算:billingMode=call 按次;=token 按 (prompt+completion)/1000 × pricePer1k。
// 按 token 时若上游未返回用量(如部分流式),回退按次计费,避免漏计
// $free 为真表示本次「明确免费」(用户自备 Key / 站内 judge 预检):按 token 计费时
// 不能再用算出来的金额覆盖它,否则「不向用户计费」的承诺失效 —— 自备 Key 反而会
// 倒扣站点额度,judge 这类用户看不见的内部步骤也会被计费。
function tc_final_cost($provider, $baseCost, $usage, $free = false) {
    if ($free) return 0;
    $mode = isset($provider['billingMode']) ? $provider['billingMode'] : 'call';
    if ($mode !== 'token') return $baseCost;
    $price = isset($provider['pricePer1k']) ? (float) $provider['pricePer1k'] : 0;
    if ($price <= 0) return 0;
    $prompt = isset($usage['prompt']) ? (int) $usage['prompt'] : 0;
    $completion = isset($usage['completion']) ? (int) $usage['completion'] : 0;
    if ($prompt <= 0 && $completion <= 0) return $baseCost;
    return round(($prompt + $completion) / 1000 * $price, 4);
}

// 流式按 token 计费结算:首字节时刻用量未知,已按次预扣;流结束按实际用量多退少补。
// 返回最终扣费额(供台账);无限额度与按次模式是 no-op(delta=0)。
function tc_settle_stream_charge(&$db, $userId, $provider, $baseCost, $charged, $usage, $free = false) {
    $trueCost = tc_final_cost($provider, $baseCost, $usage, $free);
    $delta = round($trueCost - (float) $charged, 4);
    if (abs($delta) < 0.0001) return $trueCost;
    $fresh = null;
    foreach ($db['users'] as &$u) {
        if (isset($u['id']) && (string) $u['id'] === (string) $userId) { $fresh = &$u; break; }
    }
    unset($u);
    if (!$fresh) return $charged;
    if (tc_is_unlimited_quota($fresh)) return 0;
    if ($delta > 0) {
        $fresh['quota'] = max(0, round((float) $fresh['quota'] - $delta, 4));
    } else {
        // 预扣高于实际用量:返还差额(只动余额,不动发放统计)
        $fresh['quota'] = round((float) $fresh['quota'] + (-$delta), 4);
    }
    $GLOBALS['_tc_quota_after'] = $fresh['quota'];
    return $trueCost;
}

// ---- 流式转发的公共扣费/发头/结算块(原先 4 处近乎重复的实现收敛于此) ----

// 扣费:取最新用户记录按实际用量计费,回写余量到 $GLOBALS['_tc_quota_after']
// 额度已在请求前原子预扣(见 tc_quota_reserve),这里只按实际用量结算:
// 原来在这里再调 tc_charge_user 会二次扣费,也会把并发窗口重新打开。
function tc_stream_charge(&$db, $userId, $provider, $body, $cost, $streamUsage, $purpose, &$charged, $free = false) {
    $fresh = null;
    foreach ($db['users'] as $u) if ((string) $u['id'] === (string) $userId) { $fresh = $u; break; }
    if (!$fresh) return;
    $actual = tc_final_cost($provider, $cost, $streamUsage, $free);
    $charged = tc_quota_settle($db, $userId, $actual, isset($body['model']) ? (string) $body['model'] : '', $purpose);
    tc_quota_clear_pending();
    foreach ($db['users'] as $u) if ((string) $u['id'] === (string) $userId) { $fresh = $u; break; }
    tc_charge_user_stats($db, $fresh, isset($body['model']) ? $body['model'] : '', $purpose);
    tc_touch_user($db, $userId);
    $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
}

// X-Oc-* 元信息响应头($withTask=false 用于空流收尾,任务头此前已发过)
function tc_stream_headers($charged, $citations, $ms, $withTask, $taskId, $format) {
    header('X-Oc-Cost: ' . $charged);
    header('X-Oc-Quota: ' . (isset($GLOBALS['_tc_quota_after']) ? $GLOBALS['_tc_quota_after'] : 0));
    header('X-Oc-Elapsed: ' . $ms);
    if ($withTask) {
        header('X-Oc-Task-Id: ' . $taskId);
        header('X-Oc-Task-Format: ' . $format);
    }
    if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
}

// 首字节:扣费 + 落一条日志(收尾回填) + 记模型健康 + 发送 SSE 响应头。返回日志 id
function tc_stream_begin($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $format, $isStream, $citations, $taskId, &$charged) {
    $ms = tc_now() - $started;
    $charged = 0;
    $free = !empty($ctx['free']);
    tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage, $ctx, $free) {
        tc_stream_charge($db, $user['id'], $provider, $body, $cost, $streamUsage, isset($ctx['purpose']) ? (string) $ctx['purpose'] : '', $charged, $free);
    });
    // 扣费落库后立即提交并释放写锁:流式响应要持续几十秒到几分钟,
    // 若把事务留到请求结束才提交,一个长回复会让全站所有写操作排队
    // (实测 6 秒流式会让另一名管理员的保存操作阻塞 4 秒以上,长流式直接吃满 busy_timeout)。
    // 收尾结算(tc_stream_settle)本就在独立事务里,提前提交不影响多退少补。
    tc_db_commit();
    $logId = tc_push_log(array_merge(array(
        'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
        'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
        'format' => $format, 'status' => 200, 'ms' => $ms, 'cost' => $charged, 'stream' => $isStream,
    ), tc_log_chat_meta($body, $format)));
    tc_note_model_health($provider, $body, true);
    tc_disable_buffers();
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('Connection: keep-alive');
    tc_stream_headers($charged, $citations, $ms, true, $taskId, $format);
    return $logId;
}

// 空流收尾(上游 200 但一个分片都没发):一次扣费 + 记台账 + 输出 [DONE]
function tc_stream_charge_done($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $citations, &$charged) {
    $ms = tc_now() - $started;
    $charged = 0;
    $free = !empty($ctx['free']);
    tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage, $ctx, $free) {
        tc_stream_charge($db, $user['id'], $provider, $body, $cost, $streamUsage, isset($ctx['purpose']) ? (string) $ctx['purpose'] : '', $charged, $free);
        tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $charged, $streamUsage['prompt'], $streamUsage['completion']);
    });
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    tc_stream_headers($charged, $citations, $ms, false, '', '');
    echo "data: [DONE]\n\n";
}

// 流结束结算:按实际用量多退少补、写台账、按需把对话落库、回填日志
function tc_stream_settle($user, $provider, $body, $cost, &$charged, $streamUsage, $streamText, $ctx, $format, $modelStr, $streamLogId) {
    $saveApiChat = !empty($ctx['saveApiChat']);
    $free = !empty($ctx['free']);
    tc_with_db(true, function (&$db) use ($user, $provider, $cost, &$charged, $streamUsage, $streamText, $body, $saveApiChat, $format, $modelStr, $free) {
        $final = tc_settle_stream_charge($db, $user['id'], $provider, $cost, $charged, $streamUsage, $free);
        tc_record_usage_entry($db, $user['id'], $modelStr, $final, $streamUsage['prompt'], $streamUsage['completion']);
        if ($saveApiChat) {
            // 传全量历史:落库按「首条用户消息」判断是否同一段上下文,并自动去重
            $msgs = tc_api_history_messages($body, $format);
            if ($streamText !== '') $msgs[] = array('role' => 'assistant', 'content' => $streamText);
            tc_api_append_chat($db, $user['id'], $msgs, array('model' => $modelStr, 'usage' => $streamUsage));
        }
    });
    if ($streamLogId) tc_update_log($streamLogId, array(
        'reply' => tc_log_clip($streamText, TC_LOG_TEXT_LIMIT),
        'usage' => array('prompt' => (int) $streamUsage['prompt'], 'completion' => (int) $streamUsage['completion']),
        'cost' => $charged,
    ));
}

function tc_api_proxy($format, $apiKeyOwner = null) {
    $started = tc_now();
    $ctx = tc_with_db(false, function ($db) use ($format, $apiKeyOwner) {
        if ($apiKeyOwner !== null) {
            // OpenAI 兼容出口:密钥已在外层验证,取最新用户记录
            $user = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === (string) $apiKeyOwner['userId']) { $user = $u; break; }
            }
            if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        } else {
            $user = tc_require_auth($db);
        }
        // 开放接口已在 tc_v1_authenticate 记过用户级窗口;这里再记会把同一次请求算成两次,
        // 自动分流到生图/生视频时还会再记第三次。网页端没有外层计数,仍在这里记。
        if ($apiKeyOwner === null) {
            $rateLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
            if (!tc_rate_limit_check('u:' . $user['id'], $rateLimit)) {
                tc_fail(429, '请求太频繁了，请稍后再试（当前上限 ' . $rateLimit . ' 次/分钟）');
            }
        }
        $b = tc_read_json_body(20 * 1024 * 1024);
        $resolved = tc_resolve_provider($db, $user, $b);
        if (!empty($resolved['error'])) tc_fail(400, $resolved['error']);
        $provider = $resolved['provider'];
        // 模型汇总:resolve 命中汇总组时带回候选渠道列表,首个候选即本次首选(轮询已定序)。
        // 这里把 body 里的 model 改写成「命中成员的真实模型名」,后续的元数据取数、思考规则、
        // 日志、可用性统计、生图/生视频自动分流因此都落在真实模型上,各处置无需再适配汇总 ID。
        $group = isset($resolved['group']) ? $resolved['group'] : null;
        $candidates = isset($resolved['candidates']) && is_array($resolved['candidates']) ? $resolved['candidates'] : array();
        $reqModelRaw = isset($b['model']) ? (string) $b['model'] : '';
        if ($candidates) {
            $provider = $candidates[0]['provider'];
            $b['model'] = $candidates[0]['model'];
        }
        // 开放接口的对外模型白名单:仅对 API 密钥调用生效,网页端不受影响
        if ($apiKeyOwner !== null) {
            if ($group !== null) {
                // 汇总 ID:自身被开放,或组内任一成员被开放,都算放行(存量白名单不必重配)
                if (!tc_api_group_exposed($db['settings'], $db, $group)) {
                    tc_fail(403, '模型 ' . $reqModelRaw . ' 未对开放接口开放，请联系管理员');
                }
            } else {
                $reqModel = isset($b['model']) ? (string) $b['model'] : '';
                if (!tc_api_model_exposed($db['settings'], isset($provider['id']) ? $provider['id'] : '', $reqModel)) {
                    tc_fail(403, '模型 ' . $reqModel . ' 未对开放接口开放，请联系管理员');
                }
            }
        }
        // 熔断:该模型近期持续全失败时快速失败,给出清晰提示(管理员豁免,便于现场排查)
        if (empty($user['admin'])) {
            if ($candidates) {
                // 汇总:逐个候选检查,把已熔断的渠道剔出候选 —— 这正是汇总最实用的地方:
                // 某个渠道整体挂掉时,请求自动落到还活着的渠道上,而不是一起 503。
                $alive = array();
                foreach ($candidates as $c) {
                    if (tc_model_circuit_message($db, $c['providerId'], $c['model']) === '') $alive[] = $c;
                }
                if (!$alive) tc_fail(503, '模型 ' . $reqModelRaw . ' 的渠道当前都不可用（近 4 小时连续失败），请稍后再试');
                if (count($alive) !== count($candidates)) {
                    $candidates = array_values($alive);
                    $provider = $candidates[0]['provider'];
                    $b['model'] = $candidates[0]['model'];
                }
            } else {
                $circuitModel = isset($b['model']) ? (string) $b['model'] : (isset($provider['models'][0]['id']) ? (string) $provider['models'][0]['id'] : '');
                $circuitMsg = tc_model_circuit_message($db, isset($provider['id']) ? $provider['id'] : '', $circuitModel);
                if ($circuitMsg !== '') tc_fail(503, $circuitMsg);
            }
        }
        // 单价:模型级 cost 优先,未设置时回退供应商的 costPerCall
        $costModel = isset($b['model']) ? (string) $b['model'] : '';
        if ($costModel === '' && !empty($provider['models'][0]['id'])) $costModel = (string) $provider['models'][0]['id'];
        $cost = tc_model_cost($provider, $costModel);
        $free = false;
        // 汇总组的预扣与上限:候选之间可能单价/窗口差很多,取「最保守」的那一侧。
        //   预扣取各候选的最大单次费用 —— 故障转移可能落到更贵的成员上,按最小值预扣会少扣;
        //   结算时仍按实际命中的成员多退少补(见下方 tc_final_cost 用的是获胜渠道)。
        //   窗口/输出上限取各候选的最小值,保证同一个请求对任何一个候选都塞得下。
        $caps = null;
        if ($candidates) {
            $gcost = 0;
            $allFree = true;
            $minOut = null;
            $minCtx = null;
            foreach ($candidates as $c) {
                $cc = tc_model_cost($c['provider'], $c['model']);
                if ($cc > $gcost) $gcost = $cc;
                if (!isset($c['provider']['ownerId']) || (string) $c['provider']['ownerId'] !== (string) $user['id']) $allFree = false;
                list($co, $ccx) = tc_model_meta_caps(tc_model_meta_get($db, $c['model']));
                $minOut = $minOut === null ? $co : min($minOut, $co);
                $minCtx = $minCtx === null ? $ccx : min($minCtx, $ccx);
            }
            // 组上配了单次扣费就按它(管理员显式定价优先),否则用候选最大值
            if ($group !== null && $group['cost'] !== null) $gcost = (float) $group['cost'];
            $cost = $gcost;
            $free = $allFree;
            $caps = array($minOut, $minCtx);
        }
        // 内容审核:开启敏感词过滤时,先检查最后一条用户消息
        $modHit = tc_moderation_hit(isset($db['settings']['moderation']) && is_array($db['settings']['moderation']) ? $db['settings']['moderation'] : array(), tc_last_user_text($b, $format));
        if ($modHit !== '') tc_fail(400, '消息包含被禁止的内容，请修改后重试');
        // 用户自备供应商(自己的 Key):不扣站点次数,也不设额度门槛。
        // 汇总组不适用这一条 —— 它的候选里只要有站点的渠道,就不能整体免单($free 已按「全部自备」算过)。
        if (!$candidates && isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id']) { $cost = 0; $free = true; }
        // 内部「AI 工具判定」(生图/联网/标题的调度预检)不向用户计费:它是用户看不见的
        // 基础步骤,对用户而言一条消息就是一次对话;上游成本由站点承担。
        // 仅限网页端内部调用 —— 开放 API 的外部请求不能靠自带 _purpose=judge 绕过计费。
        $reqPurpose = isset($b['_purpose']) ? (string) $b['_purpose'] : '';
        if ($reqPurpose === 'judge' && $apiKeyOwner === null) { $cost = 0; $free = true; }
        // 额度预扣:检查与扣减放在同一个写事务里完成,避免并发请求都读到同一笔余额后全部放行。
        // 实际费用要等上游返回才知道(按 token 计费),所以先按预估费用扣,结算时再多退少补。
        $reserveOk = false;
        $quotaNow = -1;
        tc_with_db(true, function (&$db) use ($user, $cost, &$reserveOk, &$quotaNow) {
            $reserveOk = tc_quota_reserve($db, $user['id'], $cost);
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === (string) $user['id']) { $quotaNow = tc_is_unlimited_quota($u) ? -1 : tc_quota_effective($u); break; }
            }
        });
        if (!$reserveOk) {
            $msg = $cost > 1
                ? '剩余次数不足（本次需要 ' . $cost . ' 次，当前 ' . max(0, (int) $quotaNow) . ' 次），请联系管理员充值'
                : '剩余次数不足（当前 ' . max(0, (int) $quotaNow) . ' 次），请联系管理员充值';
            tc_json(402, array(
                'error' => array('message' => $msg),
                'quota' => max(0, (int) $quotaNow),
                'need' => $cost,
            ));
        }
        // 预扣已落库:记下待结算,之后任何 tc_fail 退出都会自动退回(见 tc_quota_refund_pending)
        tc_quota_mark_pending($user['id'], $cost);
        // 生图模型自动路由:调用对话接口但命中的是生图模型时,改走 images/generations。
        // 上游对这种请求会直接报错(如 "xxx is an image model. Use /v1/images/generations"),
        // 这里在发起对话请求前就分流,用户/客户端无需自己判断模型类型。
        $isImageModel = false;
        $isVideoModel = false;
        if (in_array($format, array('chat', 'completions', 'responses'), true)) {
            $reqModel = isset($b['model']) ? (string) $b['model'] : '';
            if ($reqModel === '' && !empty($provider['models'][0]['id'])) $reqModel = (string) $provider['models'][0]['id'];
            $isImageModel = tc_model_is_image($provider, $reqModel);
            // 视频模型命中对话接口时同样自动分流(按名称启发式或视频标记),避免上游报「不支持此模型」
            if (!$isImageModel) $isVideoModel = tc_model_is_video($provider, $reqModel);
        }
        return array(
            'user' => $user,
            'provider' => $provider,
            'body' => tc_prepare_upstream_body($b, $provider, $format),
            // 用途标记(标题/跟进建议/判定等):仅存在于原始请求体,用于余量明细
            'purpose' => isset($b['_purpose']) ? (string) $b['_purpose'] : '',
            'cost' => $cost,
            'free' => $free,
            'timeout' => $db['settings']['proxyTimeoutMs'],
            'wantSearch' => (!empty($b['webSearch']) && $b['webSearch'] !== 'off' && $b['webSearch'] !== false) ? (string) $b['webSearch'] : '',
            'settings' => tc_user_search_settings($user, $db['settings']),
            // 模型元数据(输出上限/上下文窗口)在这里取出:tc_with_db 结束后 $db 即释放,
            // 而钳制逻辑在事务之外执行,拿不到库,只能提前带出来。
            // 取数用 $costModel:请求没带 model 时它是供应商首个模型,与服务端补默认模型的
            // 逻辑一致,否则「省略 model」的请求会取不到元数据、静默落到兜底值。
            'modelMeta' => tc_model_meta_get($db, $costModel),
            // 汇总组的候选渠道(首个即本次首选)与组 ID。候选之间单价/窗口可能不同,
            // 上限按候选最小值算好带出来(见上方 $caps),模板之外的请求无需再查库。
            'candidates' => $candidates,
            'aggId' => $group !== null ? (string) $group['id'] : '',
            'caps' => $caps,
            'temperature' => isset($db['settings']['temperature']) ? $db['settings']['temperature'] : null,
            'thinking' => tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null),
            'imageGen' => $isImageModel,
            'videoGen' => $isVideoModel,
            // 开放 API 密钥调用且站点允许时,把本次对话记入该用户的对话列表
            'saveApiChat' => ($apiKeyOwner !== null)
                && !empty($db['settings']['apiSaveChats'])
                && !empty($db['settings']['persistChats']),
        );
    });

    // 生图/生视频的自动路由:对话接口收到生图/生视频模型时改走对应接口。
    // 这两个接口各自会做完整的鉴权/限流/审核与「原子预扣 + 结算」,因此这里必须先把
    // 对话路径已做的预扣原样退回,否则同一次请求会被扣两次:内层结算只释放内层那笔,
    // 外层预扣永远留在账上(成功时用户付双份;内层失败时外层也不退,用户为失败买单)。
    // 用 refund_pending 而不是自己写余额:它同时清掉待结算标记,避免后续 tc_fail 重复退款。
    if (!empty($ctx['videoGen']) || !empty($ctx['imageGen'])) {
        tc_quota_refund_pending();
    }

    // 视频模型自动改走视频接口(异步任务;tc_generate_video 自带鉴权/限流/额度/审核与计费)
    if (!empty($ctx['videoGen'])) {
        if ($apiKeyOwner !== null) {
            $out = tc_generate_video($apiKeyOwner);
            $data = array();
            foreach ((isset($out['videos']) ? $out['videos'] : array()) as $v) {
                $data[] = array('url' => isset($v['url']) ? $v['url'] : '', 'model' => isset($out['model']) ? $out['model'] : '');
            }
            tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
        }
        tc_json(200, tc_generate_video(null));
    }

    // 生图模型自动改走生图接口(tc_generate_images 自带鉴权/限流/额度/审核与计费)
    if (!empty($ctx['imageGen'])) {
        if ($apiKeyOwner !== null) {
            $out = tc_generate_images($apiKeyOwner);
            $data = array();
            foreach ((isset($out['images']) ? $out['images'] : array()) as $im) {
                $row = array();
                if (!empty($im['url'])) $row['url'] = $im['url'];
                elseif (!empty($im['b64_json'])) $row['b64_json'] = $im['b64_json'];
                if (isset($im['revised_prompt'])) $row['revised_prompt'] = $im['revised_prompt'];
                if ($row) $data[] = $row;
            }
            tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
        }
        tc_json(200, tc_generate_images(null));
    }

    $provider = $ctx['provider'];
    $user = $ctx['user'];
    $body = $ctx['body'];
    $cost = $ctx['cost'];
    $citations = array();
    $searchMode = isset($ctx['wantSearch']) ? (string) $ctx['wantSearch'] : '';
    if ($searchMode === '1' || $searchMode === 'true') $searchMode = 'on';
    if ($searchMode === 'on' || $searchMode === 'auto') {
        $query = tc_web_search_query_from_body($body, $format);
        if ($searchMode === 'auto') {
            // 智能模式的「是否联网」判定已由前端统一完成(前端会用用户的判定模型给出 on/off)。
            // 走到这里的 auto 是未判定或判定失败的回退:用保守的本地启发式,不再调用主模型,
            // 从而避免额外消耗一次 token。
            $query = tc_search_should_auto($query) ? $query : '';
        }
        $found = $query === '' ? array('ok' => true, 'hits' => array()) : tc_run_web_search($ctx['settings'], $query);
        if (empty($found['ok'])) {
            if ($searchMode !== 'auto') {
                $err = isset($found['error']) ? $found['error'] : '联网搜索失败';
                tc_fail(502, '联网搜索失败: ' . $err);
            }
            $found = array('ok' => true, 'hits' => array());
        }
        $citations = isset($found['hits']) ? $found['hits'] : array();
        if ($citations) {
            @set_time_limit(90);
            tc_enrich_search_pages($citations);
            tc_append_system_text($body, $format, tc_format_search_context($citations));
            foreach ($citations as &$hit) unset($hit['page']);
            unset($hit);
        }
    }
    // 链接读取:用户消息里带网址时自动抓取正文作为回答材料(独立于联网搜索开关)
    if (empty($ctx['settings']['urlReadEnabled']) === false) {
        $readUrls = tc_urls_from_last_user_message($body, $format);
        if ($readUrls && $citations) {
            // 搜索管线已打开过的链接不重复读取
            $seenUrls = array();
            foreach ($citations as $h) if (!empty($h['url'])) $seenUrls[strtolower((string) $h['url'])] = true;
            $readUrls = array_values(array_filter($readUrls, function ($u) use ($seenUrls) { return !isset($seenUrls[strtolower($u)]); }));
        }
        if ($readUrls) {
            @set_time_limit(90);
            $readHits = tc_read_urls_to_citations($readUrls, $ctx['settings']);
            if ($readHits) {
                tc_append_system_text($body, $format, tc_format_url_read_context($readHits, count($citations)));
                foreach ($readHits as $hit) { unset($hit['page']); $citations[] = $hit; }
            }
        }
    }
    // 输出上限与上下文窗口的唯一来源:「模型元数据」表(后台按模型名维护,全站渠道共用)。
    // 供应商模型项不再单独配置这两项;表里没有该模型时用兜底常量补齐,
    // 因此这里始终能拿到确定值,不存在「无上限」的请求。
    // 汇总组例外:上限取候选中的最小值(在事务里算好带出来),保证请求对每个候选都塞得下。
    $meta = isset($ctx['modelMeta']) ? $ctx['modelMeta'] : null;
    if (!empty($ctx['caps'])) list($outCap, $ctxWindow) = $ctx['caps'];
    else list($outCap, $ctxWindow) = tc_model_meta_caps($meta);
    // 上下文窗:输入与输出共用一个总窗口,先粗估输入 token,把输出压进「窗口 − 预估输入」内
    $promptEst = tc_estimate_body_tokens($body);
    $outCap = min($outCap, max(256, $ctxWindow - $promptEst));
    // 元数据值只做「补齐 + 压回上限」:请求没带 max_tokens 时补上,超了压回,更小则尊重用户意图
    tc_clamp_output_tokens($body, $format, $outCap, false);
    // 推理模型:开启思考时,思维链与正文共用输出额度。预算放不下时压缩思维链
    // (而不是抬高输出上限——元数据里的值是该模型的能力天花板)。
    // 顺序不能颠倒:必须等 max_tokens 被压回上限后再比对,否则读到的是用户原样传来的
    // 大数(如 999999),预算看着「放得下」而实际生效额度只有 4096,思维链会把正文挤空。
    tc_fit_thinking_budget($body, $outCap, 2048);
    tc_apply_temperature($body, $format, isset($ctx['temperature']) ? $ctx['temperature'] : null);
    tc_apply_thinking_rules($body, isset($ctx['thinking']) ? $ctx['thinking'] : null);
    $url = tc_upstream_path(rtrim((string) $provider['baseUrl'], '/'), $format);
    // 出站前的最后一道 SSRF 检查:写入时校验过的地址也要在这里再确认一次,
    // 免得历史数据(或管理员导入的配置)带着内网目标发出去。
    if (!tc_upstream_url_is_safe($url)) tc_fail(400, '供应商地址不可用:不允许请求内网或保留地址');
    $isStream = !empty($body['stream']);
    // 多 Key:按模型绑定的优先级取出一串密钥,失败时依次回退(见下方 keyFallback)
    $keyChain = tc_provider_key_chain($provider, isset($body['model']) ? (string) $body['model'] : '');
    if (!$keyChain) $keyChain = array('');
    $keyIdx = 0;
    $headers = tc_upstream_auth_headers($format, $keyChain[0], true);
    $payload = tc_json_encode($body);
    $reasoningRetried = false;
    // 汇总组的候选渠道:首个已由 resolve 选好,其余留作「换渠道重试」的备选。
    // 换渠道只在「尚未向客户端发出任何字节」时进行(与换 Key 同一条纪律),因此不会重复计费。
    // 候选是在上面的 tc_with_db 闭包里算出来的,只经 $ctx 带出来;事务闭包的局部变量在这里
    // 并不存在,漏掉这一行会让候选相关的分支都读到一个未定义变量(汇总请求直接 500)。
    $candidates = isset($ctx['candidates']) && is_array($ctx['candidates']) ? $ctx['candidates'] : array();
    $candIdx = 0;
    $ends = tc_endpoints();
    $ep = isset($ends[$format]) ? $ends[$format] : $format;
    // 尝试切到下一个候选渠道;成功返回 true。地址不安全(内网/保留地址)的候选直接跳过。
    // 由引用改写:让两个重试循环共用同一段切换逻辑。
    $nextCandidate = function () use (&$candIdx, &$provider, &$body, &$url, &$keyChain, &$keyIdx, &$headers, &$payload, $candidates, $format) {
        while ($candIdx + 1 < count($candidates)) {
            $candIdx++;
            $sw = tc_candidate_switch($candidates, $candIdx, $format, $body);
            if (!tc_upstream_url_is_safe($sw['url'])) continue;
            $provider = $sw['provider'];
            $body = $sw['body'];
            $url = $sw['url'];
            $keyChain = $sw['keyChain'];
            $keyIdx = 0;
            $headers = $sw['headers'];
            $payload = $sw['payload'];
            return true;
        }
        return false;
    };

    if ($isStream) {
        @ignore_user_abort(true);
        @set_time_limit(0);
        $taskId = tc_uid(12);
        tc_task_create($taskId, $user['id'], array('provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '', 'format' => $format));
        header('X-Oc-Task-Id: ' . $taskId);
        header('X-Oc-Task-Format: ' . $format);
        @ini_set('default_socket_timeout', '600');
        $errorBuf = '';
        $headersSent = false;
        $charged = 0;
        $streamUsage = array('prompt' => 0, 'completion' => 0);
        $streamText = '';
        $usageCarry = '';
        $textCarry = '';
        $streamLogId = 0;   // 首字节时先落一条日志,收尾再回填完整回复/用量
        // 429/5xx 一次自动重试:错误响应不会进入 onChunk(未计费未发送),重试安全
        $attempt = 0;
        do {
            $attempt++;
            $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], true, function ($chunk) use (&$headersSent, &$charged, $user, $provider, $body, $cost, $started, $format, $isStream, $citations, $taskId, &$streamUsage, &$streamText, &$streamLogId, &$usageCarry, &$textCarry, $ctx) {
            tc_capture_stream_usage($streamUsage, $chunk, $format, $usageCarry);
            tc_capture_stream_text($streamText, $chunk, $format, $textCarry);
            if (!$headersSent) {
                // First successful bytes: charge then start SSE.
                $streamLogId = tc_stream_begin($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $format, $isStream, $citations, $taskId, $charged);
                $headersSent = true;
            }
            tc_task_append($taskId, $chunk);
            echo $chunk;
            if (function_exists('ob_flush')) @ob_flush();
            flush();
            // 客户端已断开:返回非分片长度让 curl 中止上游,避免继续空烧配额
            if (connection_aborted()) return -1;
        });
            // 密钥回退:认证失败 / 连接失败,且还未向客户端发出任何字节时,换下一把密钥重试
            if ($keyIdx + 1 < count($keyChain) && !$headersSent && tc_key_failure_retryable($res)) {
                $keyIdx++;
                $headers = tc_upstream_auth_headers($format, $keyChain[$keyIdx], true);
                continue;
            }
            if (!( !empty($res['ok']) && !empty($res['status']) && in_array((int) $res['status'], array(429, 500, 502, 503, 504), true) && $attempt < 2 )) {
                // 汇总:本渠道的密钥链已走完且属于渠道级失败时,换下一个候选渠道再试。
                // 只有 !$headersSent(尚未发出任何字节)才安全:此时回调从未执行,没计费也没写客户端。
                if (!$headersSent && $candIdx + 1 < count($candidates) && tc_candidate_failure_retryable($res)) {
                    if ($nextCandidate()) {
                        // 任务条目上的渠道/模型跟着换,免得前端进度条写着已被换掉的渠道
                        tc_task_finish($taskId, 'failed', 'failover');
                        $taskId = tc_uid(12);
                        tc_task_create($taskId, $user['id'], array('provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '', 'format' => $format));
                        header('X-Oc-Task-Id: ' . $taskId);
                        $errorBuf = '';
                        $attempt = 0;
                        continue;
                    }
                }
                break;
            }
            sleep(1);
        } while (true);

    // 上游最后一条事件可能不带换行,此时它还在 carry 里没被解析;结算前补上,
    // 否则用量/文本会少最后一段(流式生成时最常见的就是最后那条 usage 事件)
    tc_sse_flush_tail($usageCarry, 'tc_capture_stream_usage', $streamUsage, $format);
    tc_sse_flush_tail($textCarry, 'tc_capture_stream_text', $streamText, $format);

    // 流结束:按实际用量与首字节预扣额多退少补,并把最终费用写入台账
    if ($headersSent && connection_aborted()) {
        // 客户端已断开(用户取消生成/关闭页面):上游已随写回调中止,
        // 结算已产生的用量后按取消收尾;上游本身没有错,不记模型失败
        tc_stream_settle($user, $provider, $body, $cost, $charged, $streamUsage, $streamText, $ctx, $format, isset($body['model']) ? $body['model'] : '', $streamLogId);
        tc_task_finish($taskId, 'cancelled', '客户端断开');
        exit;
    }
    if ($headersSent) {
        tc_stream_settle($user, $provider, $body, $cost, $charged, $streamUsage, $streamText, $ctx, $format, isset($body['model']) ? $body['model'] : '', $streamLogId);
    }

        if (!$res['ok']) {
            tc_task_finish($taskId, 'failed', $res['error'] ?? 'upstream_error');
            $ms = tc_now() - $started;
            $code = $res['code'] ?: 502;
            $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
            tc_push_log(array_merge(array(
                'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                'format' => $format, 'status' => 0, 'ms' => $ms, 'cost' => 0, 'stream' => $isStream, 'error' => $msg,
            ), tc_log_chat_meta($body, $format)));
            tc_note_model_health($provider, $body, false);
            if (!$headersSent) tc_fail($code, $msg);
            exit;
        }
        if (!empty($res['status']) && $res['status'] >= 400) {
            $errBody = isset($res['body']) ? $res['body'] : '';
            tc_context_learn($provider, $body, $errBody);
            $unsupported = tc_unsupported_param_names($errBody);
            $learnLevels = null;
            $effortRemapped = false;
            $reasoningStripped = false;
            if (!$reasoningRetried) {
                $effortRemapped = tc_effort_remap_from_error($body, $errBody, $learnLevels);
                if (!$effortRemapped && $unsupported) $reasoningStripped = tc_strip_reasoning_params($body, $unsupported);
                if ($effortRemapped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', $learnLevels, false);
                elseif ($reasoningStripped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', array(), true);
            }
            if (!$reasoningRetried && ($effortRemapped || $reasoningStripped)) {
                $reasoningRetried = true;
                tc_task_finish($taskId, 'failed', 'retry_without_reasoning');
                $payload = tc_json_encode($body);
                $taskId = tc_uid(12);
                tc_task_create($taskId, $user['id'], array('provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '', 'format' => $format));
                header('X-Oc-Task-Id: ' . $taskId);
                $errorBuf = '';
                $headersSent = false;
                $charged = 0;
                $streamUsage = array('prompt' => 0, 'completion' => 0);
                $streamText = '';
                $usageCarry = '';
                $textCarry = '';
                $streamLogId = 0;
                $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], true, function ($chunk) use (&$headersSent, &$charged, $user, $provider, $body, $cost, $started, $format, $isStream, $citations, $taskId, &$streamUsage, &$streamText, &$streamLogId, &$usageCarry, &$textCarry, $ctx) {
                    tc_capture_stream_usage($streamUsage, $chunk, $format, $usageCarry);
                    tc_capture_stream_text($streamText, $chunk, $format, $textCarry);
                    if (!$headersSent) {
                        $streamLogId = tc_stream_begin($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $format, $isStream, $citations, $taskId, $charged);
                        $headersSent = true;
                    }
                    tc_task_append($taskId, $chunk);
                    echo $chunk;
                    if (function_exists('ob_flush')) @ob_flush();
                    flush();
                    if (connection_aborted()) return -1;
                });
                if (!empty($res['ok']) && (empty($res['status']) || $res['status'] < 400)) {
                    if (!$headersSent) {
                        tc_task_finish($taskId, 'completed');
                        tc_stream_charge_done($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $citations, $charged);
                        exit;
                    }
                    tc_stream_settle($user, $provider, $body, $cost, $charged, $streamUsage, $streamText, $ctx, $format, isset($body['model']) ? $body['model'] : '', $streamLogId);
                    tc_task_finish($taskId, 'completed');
                    exit;
                }
                // 重试流途中客户端断开:按取消结算,不误记模型失败
                if ($headersSent && connection_aborted()) {
                    tc_stream_settle($user, $provider, $body, $cost, $charged, $streamUsage, $streamText, $ctx, $format, isset($body['model']) ? $body['model'] : '', $streamLogId);
                    tc_task_finish($taskId, 'cancelled', '客户端断开');
                    exit;
                }
            }
            tc_task_finish($taskId, 'failed', 'upstream_http_' . $res['status']);
            $ms = tc_now() - $started;
            $msg = (isset($provider['name']) && $provider['name'] !== '' ? '「' . $provider['name'] . '」' : '') . tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', $res['status']);
            tc_push_log(array_merge(array(
                'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => 0, 'stream' => $isStream,
                'error' => substr($msg, 0, 200),
            ), tc_log_chat_meta($body, $format)));
            tc_note_model_health($provider, $body, false);
            if (!$headersSent) tc_fail($res['status'], $msg);
            exit;
        }
        if (!$headersSent) {
            tc_task_finish($taskId, 'completed');
            tc_stream_charge_done($user, $provider, $body, $cost, $streamUsage, $ctx, $started, $citations, $charged);
        }
        if ($headersSent) tc_task_finish($taskId, 'completed');
        exit;
    }

    // 429/5xx 一次自动重试(非流式):响应未返回给客户端前,重试安全
    $attempt = 0;
    do {
        $attempt++;
        $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], false);
        // 密钥回退:认证失败 / 连接失败时换下一把密钥重试(非流式未向客户端发送任何内容,安全)
        if ($keyIdx + 1 < count($keyChain) && tc_key_failure_retryable($res)) {
            $keyIdx++;
            $headers = tc_upstream_auth_headers($format, $keyChain[$keyIdx], false);
            continue;
        }
        if (!( !empty($res['ok']) && !empty($res['status']) && in_array((int) $res['status'], array(429, 500, 502, 503, 504), true) && $attempt < 2 )) {
            // 汇总:本渠道的密钥链已走完且属于渠道级失败时,换下一个候选渠道再试一次。
            // 非流式尚未向客户端返回任何内容,切换安全(与换 Key 同一条纪律)。
            if ($candIdx + 1 < count($candidates) && tc_candidate_failure_retryable($res)) {
                if ($nextCandidate()) { $attempt = 0; continue; }
            }
            break;
        }
        sleep(1);
    } while (true);
    if (!empty($res['ok']) && !empty($res['status']) && $res['status'] >= 400) {
        $errBody = isset($res['body']) ? $res['body'] : '';
        tc_context_learn($provider, $body, $errBody);
        $unsupported = tc_unsupported_param_names($errBody);
        $learnLevels = null;
        $effortRemapped = tc_effort_remap_from_error($body, $errBody, $learnLevels);
        $reasoningStripped = false;
        if (!$effortRemapped && $unsupported) $reasoningStripped = tc_strip_reasoning_params($body, $unsupported);
        if ($effortRemapped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', $learnLevels, false);
        elseif ($reasoningStripped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', array(), true);
        if ($effortRemapped || $reasoningStripped) {
            $payload = tc_json_encode($body);
            $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], false);
        }
    }
    $ms = tc_now() - $started;
    if (!$res['ok']) {
        $code = $res['code'] ?: 502;
        $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
        tc_push_log(array_merge(array(
            'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
            'format' => $format, 'status' => 0, 'ms' => $ms, 'cost' => 0, 'stream' => false, 'error' => $msg,
        ), tc_log_chat_meta($body, $format)));
        tc_note_model_health($provider, $body, false);
        tc_fail($code, $msg);
    }
    if ($res['status'] >= 400) {
        $msg = (isset($provider['name']) && $provider['name'] !== '' ? '「' . $provider['name'] . '」' : '') . tc_upstream_error_message($res['body'], $res['status']);
        tc_push_log(array_merge(array(
            'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
            'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => 0, 'stream' => false,
            'error' => substr($msg, 0, 200),
        ), tc_log_chat_meta($body, $format)));
        tc_note_model_health($provider, $body, false);
        tc_fail($res['status'], $msg);
    }

    $charged = 0;
    $quota = 0;
    $bodyUsage = array('prompt' => 0, 'completion' => 0);
    $jBody = json_decode(isset($res['body']) ? $res['body'] : '', true);
    if (is_array($jBody) && isset($jBody['usage']) && is_array($jBody['usage'])) {
        $u = $jBody['usage'];
        $bodyUsage['prompt'] = (int) (isset($u['prompt_tokens']) ? $u['prompt_tokens'] : (isset($u['input_tokens']) ? $u['input_tokens'] : 0));
        $bodyUsage['completion'] = (int) (isset($u['completion_tokens']) ? $u['completion_tokens'] : (isset($u['output_tokens']) ? $u['output_tokens'] : 0));
    }
    tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, &$quota, $bodyUsage, $provider, $ctx, $format, $jBody) {
        $fresh = null;
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        if (!$fresh) return;
        // 额度已在请求前预扣:这里只做结算(按实际 token 费用多退少补),不再二次扣减。
        $actual = tc_final_cost($provider, $cost, $bodyUsage, !empty($ctx['free']));
        $charged = tc_quota_settle($db, $user['id'], $actual, isset($body['model']) ? (string) $body['model'] : '', isset($ctx['purpose']) ? (string) $ctx['purpose'] : '');
        tc_quota_clear_pending();
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        tc_charge_user_stats($db, $fresh, isset($body['model']) ? $body['model'] : '', isset($ctx['purpose']) ? (string) $ctx['purpose'] : '');
        tc_touch_user($db, $user['id']);
        $quota = isset($fresh['quota']) ? $fresh['quota'] : 0;
        tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $charged, $bodyUsage['prompt'], $bodyUsage['completion']);
        // 开放 API 调用落库到该用户的对话列表(与流式路径共用同一归并规则)
        if (!empty($ctx['saveApiChat'])) {
            $msgs = tc_api_history_messages($body, $format);
            $reply = tc_model_reply_text($jBody, $format);
            if ($reply !== '') $msgs[] = array('role' => 'assistant', 'content' => $reply);
            tc_api_append_chat($db, $user['id'], $msgs, array('model' => isset($body['model']) ? $body['model'] : '', 'usage' => $bodyUsage));
        }
    });
    tc_push_log(array_merge(array(
        'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
        'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
        'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => $charged, 'stream' => false,
        'reply' => tc_log_clip(is_array($jBody) ? tc_model_reply_full($jBody, $format) : (string) $res['body'], TC_LOG_TEXT_LIMIT),
        'usage' => array('prompt' => (int) $bodyUsage['prompt'], 'completion' => (int) $bodyUsage['completion']),
    ), tc_log_chat_meta($body, $format)));
    tc_note_model_health($provider, $body, true);
    $ctype = $res['ctype'];
    if (strpos($ctype, 'application/json') !== false) $ct = 'application/json; charset=utf-8';
    elseif ($ctype) $ct = $ctype;
    else $ct = 'application/json';
    http_response_code($res['status'] ?: 200);
    header('Content-Type: ' . $ct);
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('X-Oc-Cost: ' . $charged);
    header('X-Oc-Quota: ' . $quota);
    header('X-Oc-Elapsed: ' . $ms);
    if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
    echo $res['body'];
    exit;
}

function tc_note_model_health($provider, $body, $ok) {
    $pid = isset($provider['id']) ? $provider['id'] : '';
    $model = isset($body['model']) ? $body['model'] : '';
    if ($pid === '' || $model === '') return;
    try {
        tc_with_db(true, function (&$db) use ($pid, $model, $ok) {
            tc_record_model_health($db, $pid, $model, $ok);
        });
    } catch (Throwable $e) {
    }
}

// 熔断判定:近 4 小时内该模型调用 ≥5 次且全部失败 → 视为持续不可用。
// 熔断期间快速失败,不再打上游,因此不会再产生失败事件,事件随 4 小时窗口老化后自动恢复
function tc_model_circuit_message($db, $providerId, $model) {
    if ($providerId === '' || $model === '') return '';
    $summary = tc_model_health_summary($db, $providerId);
    $row = isset($summary[$model]) ? $summary[$model] : null;
    if (!$row || (int) $row['calls'] < 5 || (int) $row['ok'] > 0) return '';
    return '模型 ' . $model . ' 当前持续不可用（近 4 小时连续 ' . $row['calls'] . ' 次调用全部失败），请换一个模型或稍后再试';
}

// 从上游报错中提取模型上下文窗口上限
function tc_context_limit_from_error($raw) {
    $text = (string) $raw;
    if ($text === '') return 0;
    $candidates = array();
    // OpenAI: "This model's maximum context length is 8192 tokens"
    if (preg_match('/maximum context length is (\d+)/i', $text, $m)) $candidates[] = (int) $m[1];
    // Anthropic: "... 205063 tokens > 200000 maximum"
    if (preg_match('/(\d{3,})\s*tokens?\s*>\s*(\d{3,})\s*maximum/i', $text, $m)) $candidates[] = (int) $m[2];
    // 通用: context length/window/size 后跟数字(≥4 位,降低误报)
    if (preg_match('/(?:context[_ ](?:length|window|size)|max(?:imum)?[_ ](?:context|tokens?))[^\d]{0,40}(\d{4,})/i', $text, $m)) $candidates[] = (int) $m[1];
    if (!$candidates) return 0;
    $limit = max($candidates);
    if ($limit < 256) return 0;
    return min(2000000, $limit);
}

// 自动学习上下文窗口:仅当管理员开启且该模型尚未配置 maxContext 时回填,不覆盖手动设置
function tc_context_learn($provider, $body, $errBody) {
    $model = isset($body['model']) ? (string) $body['model'] : '';
    $pid = isset($provider['id']) ? $provider['id'] : '';
    if ($model === '' || $pid === '' || (string) $errBody === '') return;
    $limit = tc_context_limit_from_error($errBody);
    if ($limit <= 0) return;
    try {
        tc_with_db(true, function (&$db) use ($pid, $model, $limit) {
            if (empty($db['settings']['contextAutoLearn'])) return;
            // 上限统一记在「模型元数据」表(全站渠道共用);供应商模型项已不再保存窗口
            // 渠道给模型加前缀/后缀时(XXX/deepseek-flash)复用包含匹配到的原条目,不另建一条
            $key = tc_model_meta_key($model);
            if ($key === '' || strlen($key) > 200) return;
            if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) $db['modelMeta'] = array();
            $matched = tc_model_meta_resolve($db, $model);
            if ($matched !== null) $key = $matched;
            $cur = isset($db['modelMeta'][$key]) && is_array($db['modelMeta'][$key]) ? $db['modelMeta'][$key] : array();
            // 上游亲口报出的窗口比表里的值可信:覆盖之。但手工/内置条目是显式声明,
            // 不覆盖显式设置这一条依然成立——这两类条目仅在数值缺失时才补。
            $src = isset($cur['source']) ? (string) $cur['source'] : '';
            $isPinned = ($src === 'manual' || $src === 'builtin');
            $hasCtx = !empty($cur['maxInputTokens']);
            if ($isPinned && $hasCtx) return;
            if ($hasCtx && (int) $cur['maxInputTokens'] === $limit) return;
            $cur['maxInputTokens'] = $limit;
            $cur['updatedAt'] = tc_now();
            if (!isset($cur['source'])) $cur['source'] = 'auto';
            // 学到真实窗口后仍需管理员核对:自动兜底值一律带待复核标记
            if ($cur['source'] === 'auto') $cur['needsReview'] = true;
            if (empty($cur['maxOutputTokens'])) $cur['maxOutputTokens'] = TC_MODEL_META_AUTO_OUTPUT;
            $db['modelMeta'][$key] = $cur;
        });
    } catch (Throwable $e) {
    }
}

// ---- OpenAI 兼容出口:Bearer sk-tc- 密钥鉴权,计费/限流/熔断与网页端完全一致 ----
function tc_v1_authenticate() {
    $auth = tc_with_db(true, function (&$db) {
        if (empty($db['settings']['apiKeysEnabled'])) tc_fail(403, '管理员已关闭 API 密钥功能');
        $token = tc_bearer();
        $owner = tc_find_api_key_owner($db, $token);
        if (!$owner) tc_fail(401, '无效的 API 密钥');
        // 开放接口限流:按"密钥"独立计数(与网页端按用户计数互不影响),
        // 使后台设置的频率限制对每个 API 密钥各自生效
        $keyLimit = isset($db['settings']['apiKeyRateLimitPerMin']) ? (int) $db['settings']['apiKeyRateLimitPerMin'] : 60;
        if ($keyLimit > 0) {
            $keyTag = substr(hash('sha256', $token), 0, 24);
            if (!tc_rate_limit_check('k:' . $keyTag, $keyLimit)) {
                tc_fail(429, '请求太频繁了，请稍后再试（当前密钥上限 ' . $keyLimit . ' 次/分钟）');
            }
        }
        // 用户级限流同样生效,防止用多把密钥绕过站点总量限制
        $userLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
        if ($userLimit > 0 && !tc_rate_limit_check('u:' . $owner['userId'], $userLimit)) {
            tc_fail(429, '请求太频繁了，请稍后再试（当前账号上限 ' . $userLimit . ' 次/分钟）');
        }
        // lastUsed 分钟级节流:避免每次 API 调用都全量重写数据库
        $changed = false;
        foreach ($db['users'] as &$u) {
            if (!isset($u['id']) || (string) $u['id'] !== (string) $owner['userId']) continue;
            $k = &$u['apiKeys'][$owner['keyIndex']];
            if (isset($k) && is_array($k) && (int) (isset($k['lastUsed']) ? $k['lastUsed'] : 0) < tc_now() - 60000) {
                $k['lastUsed'] = tc_now();
                $changed = true;
            }
            unset($k);
            break;
        }
        unset($u);
        if (!$changed) tc_db_skip_write();
        return array('userId' => (string) $owner['userId']);
    });
    return $auth;
}

// 开放接口是否对外暴露某个 provider/model:白名单为空表示不限制
function tc_api_model_exposed($settings, $providerId, $modelId) {
    $list = isset($settings['apiExposedModels']) && is_array($settings['apiExposedModels']) ? $settings['apiExposedModels'] : array();
    if (!$list) return true;
    return in_array($providerId . '|' . $modelId, $list, true);
}

// 汇总组是否对开放接口暴露。白名单为空表示不限制;否则「agg|<组ID>」命中,
// 或该组的任一成员模型被单独开放,都算暴露 —— 启用汇总前配好的白名单不必重配。
function tc_api_group_exposed($settings, $db, $group) {
    $list = isset($settings['apiExposedModels']) && is_array($settings['apiExposedModels']) ? $settings['apiExposedModels'] : array();
    if (!$list) return true;
    if (in_array('agg|' . (string) $group['id'], $list, true)) return true;
    if (!empty($group['auto'])) {
        $match = (string) (isset($group['matchId']) && $group['matchId'] !== '' ? $group['matchId'] : $group['id']);
        foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
            if (!is_array($p)) continue;
            foreach ((isset($p['models']) ? $p['models'] : array()) as $m) {
                if (!is_array($m) || !isset($m['id']) || (string) $m['id'] !== $match) continue;
                if (in_array((string) $p['id'] . '|' . $match, $list, true)) return true;
            }
        }
        return false;
    }
    foreach ((isset($group['members']) && is_array($group['members']) ? $group['members'] : array()) as $m) {
        $key = (string) (isset($m['providerId']) ? $m['providerId'] : '') . '|' . (string) (isset($m['model']) ? $m['model'] : '');
        if (in_array($key, $list, true)) return true;
    }
    return false;
}

// ---- 图像生成代理:POST {baseUrl}/images/generations(OpenAI 兼容),按次计费 ----
// 说明:图像模型不进对话模型清单,因此不做模型成员校验;鉴权/限流/额度/审核与对话一致。
// $apiKeyOwner 非 null 时走开放接口(密钥)路径,并额外校验对外模型白名单。
function tc_generate_images($apiKeyOwner = null) {
    $started = tc_now();
    $authUserId = $apiKeyOwner !== null ? (string) $apiKeyOwner['userId'] : '';
    $ctx = tc_with_db(false, function ($db) use ($apiKeyOwner, $authUserId) {
        if ($apiKeyOwner !== null) {
            $user = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === $authUserId) { $user = $u; break; }
            }
            if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        } else {
            $user = tc_require_auth($db);
        }
        // 密钥路径的用户级窗口已由 tc_v1_authenticate 记过,这里只给网页端计数
        if ($apiKeyOwner === null) {
            $rateLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
            if (!tc_rate_limit_check('u:' . $user['id'], $rateLimit)) {
                tc_fail(429, '请求太频繁了，请稍后再试（当前上限 ' . $rateLimit . ' 次/分钟）');
            }
        }
        // 图生图/改图需要携带参考图(data URL),给足请求体上限(约 4 张 8MB 图)
        $b = tc_read_json_body(48 * 1024 * 1024);
        // 支持两种入参:原生 {prompt} 与 OpenAI 对话格式 {messages/input}(生图模型自动路由时会用到)
        $promptText = isset($b['prompt']) ? (string) $b['prompt'] : '';
        if (trim($promptText) === '' && (isset($b['messages']) || isset($b['input']))) {
            $promptText = tc_last_user_text($b, isset($b['messages']) ? 'chat' : 'responses');
        }
        $modHit = tc_moderation_hit(isset($db['settings']['moderation']) && is_array($db['settings']['moderation']) ? $db['settings']['moderation'] : array(), $promptText);
        if ($modHit !== '') tc_fail(400, '提示词包含被禁止的内容，请修改后重试');
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 120);
        // 解析供应商:显式指定 providerId 优先;开放接口/未指定时按模型归属查找
        $resolved = tc_resolve_provider($db, $user, array(
            'providerId' => isset($b['providerId']) ? $b['providerId'] : null,
            'model' => $model,
        ));
        if (!empty($resolved['error'])) tc_fail(400, $resolved['error']);
        $provider = $resolved['provider'];
        if ((isset($provider['apiFormat']) ? $provider['apiFormat'] : 'chat') === 'anthropic') {
            tc_fail(400, '该供应商为 Anthropic 格式，暂不支持图像生成');
        }
        if ($apiKeyOwner !== null && !tc_api_model_exposed($db['settings'], isset($provider['id']) ? $provider['id'] : '', $model)) {
            tc_fail(403, '模型 ' . $model . ' 未对开放接口开放，请联系管理员');
        }
        $cost = tc_model_cost($provider, $model);
        if (isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id']) $cost = 0;
        // 原子预扣:与对话路径同一套(见 tc_quota_reserve),避免并发出图把额度刷穿
        $reserveOk = false; $quotaNow = -1;
        tc_with_db(true, function (&$db) use ($user, $cost, &$reserveOk, &$quotaNow) {
            $reserveOk = tc_quota_reserve($db, $user['id'], $cost);
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === (string) $user['id']) { $quotaNow = tc_is_unlimited_quota($u) ? -1 : tc_quota_effective($u); break; }
            }
        });
        if (!$reserveOk) tc_fail(402, '剩余次数不足，请联系管理员充值');
        tc_quota_mark_pending($user['id'], $cost);
        // 透传常见可选参数(仅白名单键,避免污染上游请求)
        $extra = array();
        foreach (array('quality', 'style', 'response_format', 'background') as $k) {
            if (isset($b[$k]) && is_string($b[$k]) && $b[$k] !== '') $extra[$k] = substr($b[$k], 0, 40);
        }
        // 尺寸:接受「1024x1024」这类精确值,也接受「1K/2K/3K/4K」这类档位(部分平台推荐用档位)
        $size = '1024x1024';
        $sizeExplicit = false;
        if (isset($b['size']) && is_string($b['size'])) {
            $s = trim($b['size']);
            if (preg_match('/^\d{3,4}x\d{3,4}$/i', $s) || preg_match('/^[1-4]K$/i', $s)) { $size = $s; $sizeExplicit = true; }
        }
        // 宽高比(部分平台如 Agnes 用 ratio 而非 size 表达构图)
        $ratio = '';
        if (isset($b['ratio']) && is_string($b['ratio']) && preg_match('#^\d{1,2}:\d{1,2}$#', trim($b['ratio']))) $ratio = trim($b['ratio']);
        // 用户只给了宽高比、没给尺寸时,首轮只发 ratio(两者同发部分平台会冲突);
        // 降级阶梯里仍会用默认尺寸兜底,兼容只认 size 的平台。
        if ($ratio !== '' && !$sizeExplicit) $size = '';
        // 图生图/修改图:允许用户上传 1~4 张待修改图片(data URL 或公网 URL)
        $editImages = tc_edit_image_refs(isset($b['images']) ? $b['images'] : null);
        return array(
            'user' => $user,
            'provider' => $provider,
            'cost' => $cost,
            'model' => $model,
            'prompt' => substr(trim($promptText), 0, 4000),
            'size' => $size,
            'ratio' => $ratio,
            'n' => min(4, max(1, (int) (isset($b['n']) ? $b['n'] : 1) ?: 1)),
            'extra' => $extra,
            'images' => $editImages,
            'timeout' => $db['settings']['proxyTimeoutMs'],
            'imageArchive' => !array_key_exists('imageArchiveEnabled', $db['settings']) || !empty($db['settings']['imageArchiveEnabled']),
            'imageArchiveQuotaMb' => isset($db['settings']['imageArchiveQuotaMb']) ? (int) $db['settings']['imageArchiveQuotaMb'] : 500,
        );
    });
    $provider = $ctx['provider'];
    $user = $ctx['user'];
    if ($ctx['model'] === '' || $ctx['prompt'] === '') tc_fail(400, '请填写模型和提示词');
    // 关键:生图也必须补齐 /v1(用户常按平台文档只填 https://host,不写 /v1)
    $url = tc_api_url($provider['baseUrl'], '/images/generations');
    // 生图是「带服务端身份 + 多部分表单」的出站请求,方向与对话接口相反,风险更高。
    // 供应商地址写入时已校验过一次,这里在真正发请求前再确认,挡住历史数据与导入配置。
    tc_upstream_guard($url);
    // 多密钥:按优先级链依次尝试,前一把认证/连接失败时自动换下一把
    $imgKeyChain = tc_provider_key_chain($provider, $ctx['model']);
    if (!$imgKeyChain) $imgKeyChain = array('');
    $imgKeyIdx = 0;
    $headers = array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . $imgKeyChain[0]);
    $body = array(
        'model' => $ctx['model'],
        'prompt' => $ctx['prompt'],
        'n' => $ctx['n'],
    );
    if ($ctx['size'] !== '') $body['size'] = $ctx['size'];
    if (!empty($ctx['ratio'])) $body['ratio'] = $ctx['ratio'];
    // 图生图/修改图:部分平台(如 Agnes)用 image 数组接收待修改图片
    if (!empty($ctx['images'])) $body['image'] = array_values($ctx['images']);
    // 透传常见可选参数(如 quality / style / response_format);仅收录白名单键,避免污染上游请求
    foreach (array('quality', 'style', 'response_format', 'background') as $k) {
        if (isset($ctx['extra'][$k])) $body[$k] = $ctx['extra'][$k];
    }
    // 不同平台对可选参数的容忍度差异很大(有的拒绝 response_format,有的拒绝 size/style;
    // 还有的(如 Agnes)要求把 response_format 放进 extra_body 而不是顶层)。
    // 先按完整参数请求,若被上游以 4xx 拒绝,则逐级降级/换形态重试。
    // 降级顺序刻意「先丢冷门可选参数、最后才丢 size」——因为 size 是很多平台的必填项。
    // 允许「网络类连接错误」重试一次(提高网络抖动/冷启动的成功率),但参数类错误不重试。
    $attempts = array();
    $attempts[] = $body;                                                    // 0. 完整参数
    if (isset($body['response_format'])) {                                  // 1. response_format 挪进 extra_body
        $alt = $body;
        unset($alt['response_format']);
        $alt['extra_body'] = array('response_format' => $body['response_format']);
        $attempts[] = $alt;
    }
    $strip = function ($src, $keys) {                                        // 去掉指定键,保留其余
        $out = $src;
        foreach ($keys as $k) unset($out[$k]);
        return $out;
    };
    // 只给宽高比、没给尺寸时:补一个「只认 size 的平台」能接受的默认尺寸版本,
    // 避免降级到去掉 ratio 后既没有 ratio 也没有 size。
    if (empty($body['size']) && !empty($body['ratio'])) {
        $withSize = $body;
        $withSize['size'] = '1024x1024';
        $attempts[] = $withSize;
    }
    $optional = array('quality', 'style', 'background', 'response_format', 'extra_body', 'ratio');
    $attempts[] = $strip($body, $optional);                                  // 2. 去可选参数,保留 size/n
    $attempts[] = $strip($body, array_merge($optional, array('n')));         // 3. 再去 n,保留 size
    $attempts[] = array('model' => $ctx['model'], 'prompt' => $ctx['prompt']); // 4. 最后只剩必填(极端平台)
    $seen = array();
    $res = null;
    $status = 0;
    $lastMsg = '';
    $imgKeyAttempt = 0;
    while (true) {
        $imgKeyAttempt++;
        foreach ($attempts as $idx => $b) {
            $sig = tc_json_encode($b);
            if (isset($seen[$sig])) continue;
            $seen[$sig] = true;
            $res = tc_http_request($url, 'POST', $headers, $sig, $ctx['timeout'], false, null, true, 30000);
            if (empty($res['ok'])) {
                // 连接层失败:网络类(超时/连接)重试一次,其余交给下面的换 Key 逻辑判断
                $retryable = in_array(isset($res['kind']) ? $res['kind'] : '', array('connect_timeout', 'read_timeout', 'connect'), true);
                if ($retryable && $idx < 2) { sleep(1); continue; }
                break;
            }
            $status = (int) (isset($res['status']) ? $res['status'] : 0);
            if ($status < 400) break;
            $lastMsg = tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', $status);
            // 认证 / 限流 / 余额类错误:先尝试换下一把 Key;没有更多 Key 时才返回错误
            if (in_array($status, array(401, 402, 403, 429), true)) break;
            // 「该模型不支持此路径」的提示可能伴随各种状态码(实测 400 / 503 都出现过)。
            // 命中这类语义时不必再降级参数(参数再少也不行),直接跳出走对话接口兜底。
            if (tc_error_means_path_unsupported($lastMsg, $status)) break;
            // 参数类错误(400/422):继续用下一组更精简的参数重试
            if (!in_array($status, array(400, 422), true)) break; // 其它状态:路径/服务不可用,改走对话兜底
        }
        // 换 Key:第一把认证/连接失败,而还有下一把时,用下一把重跑整条参数降级链
        if ($imgKeyIdx + 1 < count($imgKeyChain) && tc_key_failure_retryable($res)) {
            $imgKeyIdx++;
            $headers['Authorization'] = 'Bearer ' . $imgKeyChain[$imgKeyIdx];
            $seen = array(); $lastMsg = ''; $status = 0;
            if ($imgKeyAttempt < 8) continue;
        }
        break;
    }
    if (empty($res['ok'])) {
        tc_fail(isset($res['code']) && $res['code'] ? $res['code'] : 502, tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : ''));
    }
    if ((int) (isset($res['status']) ? $res['status'] : 0) >= 400 && in_array((int) $res['status'], array(401, 402, 403, 429), true)) {
        // 所有 Key 都失败:返回最后一次的原样错误
        tc_fail((int) $res['status'], $lastMsg !== '' ? $lastMsg : tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', (int) $res['status']));
    }
    // ---- 兜底:改走 chat/completions ----
    // 不少平台(如 api.apilio.ai 的 gemini / gpt-4o-image / nano-banana 等)根本没有
    // images/generations 路径,而是用对话接口出图、把图片放进 message.content。
    // 因此当该路径不可用或响应里取不到图片时,自动改用对话接口重试一次。
    $items = array();
    $usedChat = false;
    if ($status < 400) {
        $j = json_decode((string) (isset($res['body']) ? $res['body'] : ''), true);
        $chatText = '';
        $items = tc_image_results_from_payload($j, $ctx['n']);
        // 响应体里可能直接是对话结构(Markdown 图片),一并尝试抽取
        if (!$items) {
            $fromChat = tc_images_from_chat_response($j, $ctx['n'], $chatText);
            if ($fromChat) { $items = $fromChat; $usedChat = true; }
        }
    }
    if (!$items) {
        // 无论前一步是路径不可用还是响应里没找到图,都尝试对话接口。
        // 对话式出图没有 size/ratio 参数,把规格拼进提示词,让模型按构图要求出图。
        $chatPrompt = $ctx['prompt'];
        if (!empty($ctx['ratio'])) $chatPrompt .= '（图片宽高比 ' . $ctx['ratio'] . '）';
        elseif (!empty($ctx['size'])) $chatPrompt .= '（图片尺寸 ' . $ctx['size'] . '）';
        $chatBody = array(
            'model' => $ctx['model'],
            'stream' => false,
            'messages' => array(array('role' => 'user', 'content' => tc_image_edit_message_content($chatPrompt, $ctx['images']))),
        );
        $chatRes = tc_http_request(tc_api_url($provider['baseUrl'], '/chat/completions'), 'POST', $headers, tc_json_encode($chatBody), $ctx['timeout'], false, null, true, 30000);
        if (!empty($chatRes['ok']) && (int) $chatRes['status'] < 400) {
            $cj = json_decode((string) (isset($chatRes['body']) ? $chatRes['body'] : ''), true);
            $ctext = '';
            $chatItems = tc_images_from_chat_response($cj, $ctx['n'], $ctext);
            if ($chatItems) {
                $items = $chatItems;
                $res = $chatRes;
                $status = (int) $chatRes['status'];
                $usedChat = true;
            } elseif ($ctext !== '') {
                // 对话接口回复了文字但没出图:多为上游拒绝或需要更明确的指令,回传原文便于定位
                tc_fail(502, '该模型未返回图片，上游回复：' . substr($ctext, 0, 200));
            }
        }
    }
    if (!$items && $status >= 400) {
        // 两条路径都没成功,返回上游原始错误
        tc_fail($status, $lastMsg !== '' ? $lastMsg : ('上游 API 错误 (HTTP ' . $status . ')'));
    }
    // 为每个 URL 结果补一个同源代理地址:多数平台的图片在第三方对象存储域,
    // 部分网络下浏览器直连加载不到(后端却已成功出图),经本站转发即可稳定显示。
    // 若开启「生图结果本地留存」(默认开启),则即时把图片下载到本站,
    // 并把地址换成长期可用的本地留存地址,避免上游图床链接过期后历史图打不开。
    $archiveEnabled = !isset($ctx['imageArchive']) || !empty($ctx['imageArchive']);
    $archiveQuota = isset($ctx['imageArchiveQuotaMb']) ? (int) $ctx['imageArchiveQuotaMb'] : 500;
    foreach ($items as &$it) {
        if (!empty($it['url'])) {
            $storeId = '';
            if ($archiveEnabled) {
                try { $storeId = tc_img_store_save($it['url']); } catch (Throwable $e) { $storeId = ''; }
            }
            if ($storeId !== '') {
                $it['store'] = $storeId;
                $it['display'] = tc_img_store_path($storeId);
            } else {
                $it['display'] = tc_img_proxy_path($it['url']);
            }
        } elseif (!empty($it['b64_json'])) {
            // 上游直接吐 base64(常见于 gpt-image / gemini 系):messages 里的 content 会把
            // data URL 整段内联,而单张图编码后轻易超过云同步 200000 字符的 content 上限,
            // 截断后换设备就只剩半截乱码。这里同样落盘取一个短地址,content 随之变小。
            $storeId = '';
            if ($archiveEnabled) {
                try { $storeId = tc_img_store_save_b64($it['b64_json']); } catch (Throwable $e) { $storeId = ''; }
            }
            if ($storeId !== '') {
                $it['store'] = $storeId;
                $it['display'] = tc_img_store_path($storeId);
            }
        }
    }
    unset($it);
    if ($archiveEnabled && $archiveQuota > 0) {
        try { tc_img_store_gc(max(50, $archiveQuota) * 1048576); } catch (Throwable $e) { /* 忽略 */ }
    }
    if (!$items) {
        tc_fail(502, '该模型未返回图片。若这是对话式生图模型，请确认 Base URL 与模型名正确；也可尝试在「设置 → 供应商」中把该模型标记为生图。');
    }
    $usage = array('prompt' => 0, 'completion' => 0);
    tc_with_db(true, function (&$db) use ($user, $provider, $ctx, $usage, $started, $items) {
        $fresh = null;
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        if (!$fresh) return;
        $charged = tc_quota_settle($db, $user['id'], tc_final_cost($provider, $ctx['cost'], $usage), $ctx['model'] . ' (图像)', 'image');
        tc_quota_clear_pending();
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        tc_charge_user_stats($db, $fresh, $ctx['model'] . ' (图像)', 'image');
        tc_touch_user($db, $user['id']);
        $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
        tc_record_usage_entry($db, $user['id'], $ctx['model'] . ' (图像)', $charged, 0, 0);
        tc_push_log(array('kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'], 'provider' => $provider['name'], 'model' => $ctx['model'] . ' (图像)', 'format' => 'images', 'status' => 200, 'ms' => tc_now() - $started, 'cost' => $charged, 'stream' => false,
            'prompt' => tc_log_clip(isset($ctx['prompt']) ? $ctx['prompt'] : '', 4000),
            'reply' => tc_log_clip(count($items) . ' 张图片：' . implode("\n", array_map(function ($im) { return isset($im['url']) ? $im['url'] : (isset($im['display']) ? $im['display'] : ($im['b64_json'] ?? '' ? '[b64 图片]' : '')); }, $items)), 4000),
            'ip' => tc_client_ip()));
    });
    return array('ok' => true, 'model' => $ctx['model'], 'images' => $items);
}

// ---- 生图结果图片代理 ----
// 多数生图平台把图片放在第三方对象存储(如 Google Cloud Storage 域),在部分网络下
// 浏览器加载不到,表现为「后端出图了但页面上看不到图」。这里把图片经由本站转发,
// 让 <img> 始终从同源加载。
//
// 鉴权方式:签名而非 Bearer——<img> 请求不会带 Authorization 头。服务器生成带 HMAC
// 的地址,因此代理不会被当成任意 URL 的开放转发。
function tc_img_proxy_token($url) {
    return substr(hash_hmac('sha256', (string) $url, tc_secret()), 0, 24);
}
function tc_img_proxy_path($url) {
    $u = (string) $url;
    if (!preg_match('#^https?://#i', $u)) return $u; // data: 等无需代理
    return '/api/proxy/image?u=' . rawurlencode($u) . '&s=' . tc_img_proxy_token($u);
}

// SSRF 防护:只允许指向公网地址的 http(s) URL。
// 端口与 tc_url_public_host 对齐,避免签名过的图片/视频地址把本机非常规端口也卷进来。
function tc_url_is_public_http($url) {
    $p = parse_url((string) $url);
    if (!is_array($p) || empty($p['host'])) return false;
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if ($scheme !== 'http' && $scheme !== 'https') return false;
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
    if (!in_array($port, array(80, 443, 8080, 8443), true)) return false;
    $host = $p['host'];
    $ips = array();
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        $recs = @dns_get_record($host, DNS_A | DNS_AAAA);
        if (is_array($recs)) {
            foreach ($recs as $r) {
                if (!empty($r['ip'])) $ips[] = $r['ip'];
                elseif (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
            }
        }
        if (!$ips) {
            $one = @gethostbyname($host);
            if ($one && $one !== $host) $ips[] = $one;
        }
    }
    if (!$ips) return false;
    foreach ($ips as $ip) {
        // 拒绝私有/保留网段(含回环、链路本地 169.254、内网等)
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return false;
    }
    return true;
}

// 跟随跳转之后,curl 实际落到的地址必须再过一遍公网校验。
// 起始地址合法不能代表 30x 的目标也合法。
function tc_http_landed_public($ch) {
    $eff = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    if ($eff === '') return false;
    return tc_url_is_public_http($eff);
}

function tc_img_cache_dir() {
    $dir = tc_data_dir() . '/imgcache';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// 缓存落盘(按 URL 哈希),并做总量清理;返回缓存文件路径或 ''
function tc_img_cache_lookup($url) {
    $file = tc_img_cache_dir() . '/' . hash('sha256', (string) $url) . '.bin';
    if (!is_file($file)) return '';
    if (filesize($file) < 8) { @unlink($file); return ''; }
    return $file;
}
function tc_img_cache_store($url, $bytes, $ctype) {
    $dir = tc_img_cache_dir();
    if (!is_dir($dir) || !is_writable($dir)) return;
    // 头部 1 字节长度 + 内容类型,再存图片字节
    $ct = substr((string) $ctype, 0, 120);
    $head = chr(strlen($ct)) . $ct;
    @file_put_contents($dir . '/' . hash('sha256', (string) $url) . '.bin', $head . $bytes, LOCK_EX);
    tc_img_cache_gc($dir);
}
// 缓存总量上限 300MB,超出按修改时间从旧到新删除
function tc_img_cache_gc($dir, $limitBytes = 314572800) {
    $files = @glob($dir . '/*.bin');
    if (!is_array($files) || count($files) < 2) return;
    $total = 0; $rows = array();
    foreach ($files as $f) {
        $sz = @filesize($f); if ($sz === false) continue;
        $total += $sz;
        $rows[] = array('f' => $f, 't' => (int) @filemtime($f), 's' => $sz);
    }
    if ($total <= $limitBytes) return;
    usort($rows, function ($a, $b) { return $a['t'] - $b['t']; });
    foreach ($rows as $r) {
        if ($total <= $limitBytes) break;
        if (@unlink($r['f'])) $total -= $r['s'];
    }
}

// ---- 代理媒体的统一输出策略 ----
// 生图/生视频代理会把「上游返回的任意字节」以本站同源地址再次输出。若原样透传上游的
// Content-Type,一个 image/svg+xml(或视频路径上的 text/html)就能在本站源内内联渲染并
// 执行脚本、读走 localStorage 里的令牌 —— 等于把存储型 XSS 的入口交给上游配置。
// 与笔记/IM 附件的输出策略(lib/api.php / lib/im.php)同一口径:类型收紧到本族、
// SVG 用 CSP sandbox 断脚本、统一加 nosniff。
function tc_proxy_media_ctype($ctype, $families, $fallback) {
    $ctype = strtolower(trim(explode(';', (string) $ctype)[0]));
    // 只认「type/subtype」这一种形状。上游若回 'image/svg+xml, text/html' 这类拼接串,
    // 前缀判断会放它过关,而 tc_proxy_media_headers 里按等值加的 SVG sandbox 又落不到,
    // 等于给 SVG 留了个免检口子;带换行的值还能顺手做响应头注入。
    if (!preg_match('#\A[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*\z#', $ctype)) return $fallback;
    foreach ((array) $families as $f) {
        if (strpos($ctype, $f . '/') === 0) return $ctype;
    }
    return $fallback;
}
function tc_proxy_media_headers($ctype, $cache) {
    header('Content-Type: ' . $ctype);
    header('X-Content-Type-Options: nosniff');
    if ($ctype === 'image/svg+xml') {
        header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    }
    header('Cache-Control: ' . $cache);
}

// 输出缓存文件(带长缓存头)
function tc_img_serve_cached($file) {
    $raw = @file_get_contents($file);
    if ($raw === false || strlen($raw) < 2) return false;
    $len = ord($raw[0]);
    $ctype = substr($raw, 1, $len);
    $body = substr($raw, 1 + $len);
    // 缓存文件里的类型是历史写入的,同样要过一遍收紧(且必须是规范形状),
    // 否则老缓存里一条畸形类型就能绕过上面那套判等加 CSP 的逻辑。
    $ctype = tc_proxy_media_ctype($ctype, array('image'), 'image/png');
    tc_proxy_media_headers($ctype, 'public, max-age=86400');
    header('Content-Length: ' . strlen($body));
    echo $body;
    return true;
}

// ---- 生图结果本地留存 ----
// 上游图床(第三方对象存储)的链接常有时效,过期后历史图打不开。出图后即时把图片
// 下载到本站 data/imgstore/,并把结果里的地址换成本地留存地址,从而长期可用。
// 与 imgcache(按需代理缓存)不同:这是出图当下主动落盘、不受上游链接时效影响。
function tc_img_store_dir() {
    $dir = tc_data_dir() . '/imgstore';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}
function tc_img_store_file($id) {
    $id = preg_replace('/[^a-f0-9]/', '', (string) $id);
    return $id === '' ? '' : tc_img_store_dir() . '/' . $id . '.bin';
}
// 读取本地留存图片的二进制(id 为 sha1),返回 raw 或 false
function tc_img_store_read($id) {
    $f = tc_img_store_file($id);
    if ($f === '' || !is_file($f)) return false;
    $raw = @file_get_contents($f);
    return ($raw === false || strlen($raw) < 2) ? false : $raw;
}
function tc_img_store_serve($id) {
    $raw = tc_img_store_read($id);
    if ($raw === false) return false;
    $len = ord($raw[0]);
    $ctype = substr($raw, 1, $len);
    $body = substr($raw, 1 + $len);
    $ctype = tc_proxy_media_ctype($ctype, array('image'), 'image/png');
    tc_proxy_media_headers($ctype, 'public, max-age=31536000, immutable');
    header('Content-Length: ' . strlen($body));
    echo $body;
    return true;
}
// 反 DNS rebinding:校验时解析出的 IP 必须与实际连接用的 IP 一致。
// 只做「先校验后连接」的话,攻击者可以让域名第一次解析到公网、第二次解析到 127.0.0.1,
// 校验通过但真正的请求打到了内网。这里把解析结果固定进 curl,消除这个时间窗。
// 返回 array(host, port, ip) 或 null(校验不通过)。
function tc_public_resolve_pin($url) {
    $p = @parse_url((string) $url);
    if (!is_array($p) || empty($p['host'])) return null;
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if ($scheme !== 'http' && $scheme !== 'https') return null;
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
    if (!in_array($port, array(80, 443, 8080, 8443), true)) return null;
    $host = trim(strtolower((string) $p['host']), '[]');
    if ($host === '' || $host === 'localhost') return null;
    if (preg_match('/\.(local|internal|intranet|lan|home\.arpa|arpa)$/i', $host)) return null;
    $ipOk = function ($ip) {
        return is_string($ip) && $ip !== ''
            && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    };
    $picked = '';
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        if (!$ipOk($host)) return null;
        $picked = $host;
    } else {
        foreach ((array) @gethostbynamel($host) as $ip) {
            if ($ipOk($ip)) { $picked = $ip; break; }
        }
        if ($picked === '' && function_exists('dns_get_record')) {
            foreach ((array) @dns_get_record($host, DNS_AAAA) as $rec) {
                if (!empty($rec['ipv6']) && $ipOk($rec['ipv6'])) { $picked = $rec['ipv6']; break; }
            }
        }
    }
    if ($picked === '') return null;
    return array('host' => $host, 'port' => $port, 'ip' => $picked);
}

// 下载一张图片并落盘;成功返回 id(24位),失败返回 ''
function tc_img_store_save($url, $maxBytes = 30 * 1024 * 1024) {
    $url = (string) $url;
    if (!preg_match('#^https?://#i', $url)) return '';
    $pin = tc_public_resolve_pin($url);
    if (!$pin) return '';
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 90,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT => 'TinyChat-ImageStore/1.0',
        // 固定到校验过的那个 IP,堵住解析二次变化(DNS rebinding)
        CURLOPT_RESOLVE => array($pin['host'] . ':' . $pin['port'] . ':' . $pin['ip']),
    ));
    $ca = tc_cacert_path();
    if ($ca) curl_setopt($ch, CURLOPT_CAINFO, $ca);
    $buf = ''; $tooBig = false; $ctype = '';
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$ctype) {
        if (stripos($line, 'content-type:') === 0) $ctype = trim(substr($line, 13));
        return strlen($line);
    });
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$buf, &$tooBig, $maxBytes) {
        if (strlen($buf) + strlen($data) > $maxBytes) { $tooBig = true; return 0; }
        $buf .= $data;
        return strlen($data);
    });
    @curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $landed = tc_http_landed_public($ch);
    curl_close($ch);
    if ($tooBig || !$landed || $status < 200 || $status >= 300 || $buf === '') return '';
    $ctype = strtolower(trim(explode(';', $ctype)[0]));
    if (strpos($ctype, 'image/') !== 0) $ctype = 'image/png';
    $id = substr(sha1($url . '|' . tc_secret()), 0, 24);
    $dir = tc_img_store_dir();
    if (!is_dir($dir) || !is_writable($dir)) return '';
    $ct = substr($ctype, 0, 120);
    $head = chr(strlen($ct)) . $ct;
    if (@file_put_contents($dir . '/' . $id . '.bin', $head . $buf, LOCK_EX) === false) return '';
    return $id;
}
// 把一张 base64 图片写入本地留存(与 URL 下载同一目录/格式),返回 id 或 ''
function tc_img_store_save_b64($b64, $mime = 'image/png') {
    $b64 = (string) $b64;
    if ($b64 === '') return '';
    $bin = base64_decode(str_replace(array("\r", "\n", ' '), '', $b64), true);
    if ($bin === false || $bin === '') return '';
    $mime = strtolower(trim((string) $mime));
    if (strpos($mime, 'image/') !== 0) $mime = 'image/png';
    $id = substr(sha1($bin . '|' . tc_secret()), 0, 24);
    $dir = tc_img_store_dir();
    if (!is_dir($dir) || !is_writable($dir)) return '';
    $ct = substr($mime, 0, 120);
    $head = chr(strlen($ct)) . $ct;
    if (@file_put_contents($dir . '/' . $id . '.bin', $head . $bin, LOCK_EX) === false) return '';
    return $id;
}
// 本地留存地址(带签名,供 <img> 同源加载)
function tc_img_store_path($id) {
    return '/api/proxy/image?id=' . rawurlencode($id) . '&s=' . tc_img_store_token($id);
}
function tc_img_store_token($id) {
    return substr(hash_hmac('sha256', 'store:' . (string) $id, tc_secret()), 0, 24);
}
// 总量清理:按最旧优先删除,超出上限为止
function tc_img_store_gc($limitBytes) {
    $dir = tc_img_store_dir();
    $files = @glob($dir . '/*.bin');
    if (!is_array($files) || !$files) return;
    $total = 0; $rows = array();
    foreach ($files as $f) {
        $sz = @filesize($f); if ($sz === false) continue;
        $total += $sz;
        $rows[] = array('f' => $f, 't' => (int) @filemtime($f), 's' => $sz);
    }
    if ($total <= $limitBytes) return;
    usort($rows, function ($a, $b) { return $a['t'] - $b['t']; });
    foreach ($rows as $r) {
        if ($total <= $limitBytes) break;
        if (@unlink($r['f'])) $total -= $r['s'];
    }
}

// GET /api/proxy/image?u=<原始图片地址>&s=<签名>
function tc_api_image_proxy() {
    $q = tc_query();
    // 本地留存图片:?id=<sha1>&s=<签名> 直接读本地文件,不受上游链接时效影响
    $storeId = isset($q['id']) ? (string) $q['id'] : '';
    if ($storeId !== '') {
        $ssig = isset($q['s']) ? (string) $q['s'] : '';
        if ($ssig === '' || !hash_equals(tc_img_store_token($storeId), $ssig)) {
            http_response_code(403);
            header('Content-Type: text/plain; charset=utf-8');
            echo '签名无效';
            exit;
        }
        if (tc_img_store_serve($storeId)) exit;
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '图片已过期';
        exit;
    }
    $url = isset($q['u']) ? (string) $q['u'] : '';
    $sig = isset($q['s']) ? (string) $q['s'] : '';
    if ($url === '' || $sig === '' || !hash_equals(tc_img_proxy_token($url), $sig)) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo '签名无效';
        exit;
    }
    // 每 IP 限流,避免被当作图片转发器刷带宽
    if (!tc_rate_limit_check('imgpx:' . tc_client_ip(), 300)) {
        http_response_code(429);
        header('Content-Type: text/plain; charset=utf-8');
        echo '请求过于频繁';
        exit;
    }
    // 命中缓存直接返回
    $cached = tc_img_cache_lookup($url);
    if ($cached !== '' && tc_img_serve_cached($cached)) exit;
    // 安全校验:必须是公网 http(s)
    if (!tc_url_is_public_http($url)) {
        http_response_code(400);
        header('Content-Type: text/plain; charset=utf-8');
        echo '图片地址不被允许';
        exit;
    }
    // 拉取图片,限制体积(25MB)与超时;跟随少量重定向
    $max = 25 * 1024 * 1024;
    $ch = curl_init($url);
    // DNS rebinding:上面校验时解析过一次 DNS,curl 真正连接时会再解析一次。
    // 攻击者让域名两次解析结果不同(公网→内网)就能穿过校验。这里把第一次的解析结果
    // pin 进 CURLOPT_RESOLVE,与 tc_img_store_save / 网页代理同一套防重绑定口径。
    $pin = tc_public_resolve_pin($url);
    if ($pin) curl_setopt($ch, CURLOPT_RESOLVE, array($pin['host'] . ':' . $pin['port'] . ':' . $pin['ip']));
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 2,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT => 'TinyChat-ImageProxy/1.0',
    ));
    $ca = tc_cacert_path();
    if ($ca) curl_setopt($ch, CURLOPT_CAINFO, $ca);
    $buf = '';
    $tooBig = false;
    $ctype = '';
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$ctype) {
        if (stripos($line, 'content-type:') === 0) $ctype = trim(substr($line, 13));
        return strlen($line);
    });
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$buf, &$tooBig, $max) {
        if (strlen($buf) + strlen($data) > $max) { $tooBig = true; return 0; }
        $buf .= $data;
        return strlen($data);
    });
    @curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $landed = tc_http_landed_public($ch);
    curl_close($ch);
    if ($tooBig || !$landed || $status < 200 || $status >= 300 || $buf === '') {
        // 代理失败时回退:302 到原始地址(用户浏览器直连,或许能打开)。
        // 跳转落到了不允许的地址时不回退,避免把那个地址交给浏览器。
        if (!$landed) {
            http_response_code(400);
            header('Content-Type: text/plain; charset=utf-8');
            echo '图片地址不被允许';
            exit;
        }
        header('Location: ' . $url, true, 302);
        exit;
    }
    // 首次拉取与命中缓存必须走同一套输出策略:上游给 image/svg+xml 时首次响应也要套
    // CSP sandbox,只把 tc_img_serve_cached 改安全的话,第一次那份仍是可执行的。
    $ctype = tc_proxy_media_ctype($ctype, array('image'), 'image/png');
    tc_img_cache_store($url, $buf, $ctype);
    tc_proxy_media_headers($ctype, 'public, max-age=86400');
    header('Content-Length: ' . strlen($buf));
    echo $buf;
    exit;
}

// 从对话式图像响应里提取图片:不少平台(如 api.apilio.ai 的 gemini / gpt-4o-image /
// nano-banana)把出图放在 chat/completions 的 message.content 里,形如
//   "Here you go: ![image](https://.../x.png)"
// 或 content 为多模态数组 [{type:'image_url', image_url:{url}}, ...]。
// $textOut 回填纯文本部分(用于判断上游是「拒绝/反问」还是真的出了图)。
function tc_images_from_chat_response($j, $limit = 1, &$textOut = '') {
    $items = array();
    $textOut = '';
    if (!is_array($j)) return $items;
    $limit = max(1, (int) $limit);
    $content = null;
    if (isset($j['choices'][0]['message']['content'])) $content = $j['choices'][0]['message']['content'];
    elseif (isset($j['choices'][0]['text'])) $content = $j['choices'][0]['text'];
    elseif (isset($j['output_text'])) $content = $j['output_text'];
    if ($content === null) return $items;
    $nodes = is_array($content) ? $content : array(array('type' => 'text', 'text' => (string) $content));
    $pushUrl = function ($u) use (&$items, $limit) {
        if (count($items) >= $limit) return;
        $u = trim((string) $u);
        if ($u === '') return;
        if (strpos($u, 'data:image/') === 0) {
            $pos = strpos($u, 'base64,');
            if ($pos !== false) $items[] = array('b64_json' => substr($u, $pos + 7));
            return;
        }
        if (preg_match('#^https?://#i', $u)) $items[] = array('url' => $u);
    };
    foreach ($nodes as $part) {
        if (is_string($part)) { $textOut .= $part . "\n"; $part = array('type' => 'text', 'text' => $part); }
        if (!is_array($part)) continue;
        $type = isset($part['type']) ? (string) $part['type'] : '';
        // 结构化图片分片
        if ($type === 'image_url' || $type === 'output_image' || $type === 'image') {
            $u = '';
            if (isset($part['image_url']['url'])) $u = $part['image_url']['url'];
            elseif (isset($part['image_url']) && is_string($part['image_url'])) $u = $part['image_url'];
            elseif (isset($part['url'])) $u = $part['url'];
            elseif (isset($part['image']) && is_string($part['image'])) $u = $part['image'];
            elseif (isset($part['source']['data'])) $u = 'data:image/png;base64,' . $part['source']['data'];
            if ($u !== '') { $pushUrl($u); continue; }
        }
        if (isset($part['url']) && is_string($part['url'])) { $pushUrl($part['url']); continue; }
        // 文本里内嵌的 Markdown 图片 ![](url)、HTML <img src>、裸 data URL
        $t = isset($part['text']) ? (string) $part['text'] : '';
        if ($t !== '') $textOut .= $t . "\n";
    }
    if (count($items) < $limit) {
        // 从整段文本里兜底抽取图片地址
        $allText = $textOut;
        if (preg_match_all('#!\[[^\]]*\]\(\s*([^)\s]+)\s*\)#i', $allText, $m)) {
            foreach ($m[1] as $u) $pushUrl($u);
        }
        if (count($items) < $limit && preg_match_all('#<img[^>]+src=["\']([^"\']+)["\']#i', $allText, $m2)) {
            foreach ($m2[1] as $u) $pushUrl($u);
        }
        if (count($items) < $limit && preg_match_all('#(data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)#i', $allText, $m3)) {
            foreach ($m3[1] as $u) $pushUrl($u);
        }
    }
    $textOut = trim($textOut);
    return $items;
}

// 判断上游错误是否表示「这个模型/接口路径不支持」——这类错误应改走对话接口兜底,
// 而不是当成参数问题反复降级或直接失败。
function tc_error_means_path_unsupported($msg, $status = 0) {
    $s = strtolower((string) $msg);
    if ($status === 404 || $status === 405 || $status === 415) return true;
    foreach (array('不支持此 api 路径', '不支持该', '更换请求路径', 'not support', 'unsupported', 'does not support',
                   'no such', 'not found', 'invalid url', 'unknown endpoint', 'no route') as $kw) {
        if (strpos($s, $kw) !== false) return true;
    }
    return false;
}

// 轻量公网判断:用于「只是转交给上游、由上游去拉取」的地址(如改图参考图)。
// 不要求本地能解析该域名(那样会误杀临时不可解析但合法的公网地址),只拦截
// 明确的内网目标:字面量私有/保留 IP、localhost 与常见内网后缀。
function tc_url_looks_public($url) {
    $p = parse_url((string) $url);
    if (!is_array($p) || empty($p['host'])) return false;
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if ($scheme !== 'http' && $scheme !== 'https') return false;
    $host = strtolower($p['host']);
    if ($host === 'localhost' || substr($host, -6) === '.local' || substr($host, -9) === '.internal') return false;
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        return (bool) filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    }
    return true; // 域名交给上游解析
}

// 组装对话式生图/改图的消息内容:有参考图时用多模态数组(text + image_url),
// 无参考图时用纯文本字符串(兼容性最好)。
function tc_image_edit_message_content($prompt, $images) {
    $prompt = (string) $prompt;
    if (!is_array($images) || !$images) return $prompt;
    $content = array(array('type' => 'text', 'text' => $prompt));
    foreach ($images as $u) {
        $content[] = array('type' => 'image_url', 'image_url' => array('url' => $u));
    }
    return $content;
}

// 把输入的图片整理成对话编辑请求可用的 image_url 列表(默认最多 4 张)
function tc_edit_image_refs($images, $max = 4) {
    $refs = array();
    if (!is_array($images)) return $refs;
    foreach ($images as $im) {
        $v = '';
        if (is_string($im)) $v = trim($im);
        elseif (is_array($im)) {
            if (isset($im['dataUrl']) && is_string($im['dataUrl'])) $v = trim($im['dataUrl']);
            elseif (isset($im['data']) && is_string($im['data'])) $v = trim($im['data']);
            elseif (isset($im['url']) && is_string($im['url'])) $v = trim($im['url']);
        }
        if ($v === '') continue;
        // data:image/... 直接用;远程 URL 只做轻量公网校验,避免把内网地址转发给上游
        if (strpos($v, 'data:image/') === 0) $refs[] = $v;
        elseif (preg_match('#^https?://#i', $v) && tc_url_looks_public($v)) $refs[] = $v;
        if (count($refs) >= max(1, (int) $max)) break;
    }
    return $refs;
}

function tc_image_results_from_payload($j, $limit = 1) {
    $items = array();
    $limit = max(1, (int) $limit);
    $push = function ($node) use (&$items, $limit) {
        if (count($items) >= $limit) return;
        if (is_string($node)) {
            $s = trim($node);
            if ($s === '') return;
            if (strpos($s, 'data:image/') === 0) {
                $pos = strpos($s, 'base64,');
                if ($pos !== false) { $items[] = array('b64_json' => substr($s, $pos + 7)); return; }
            }
            if (preg_match('#^https?://#i', $s)) { $items[] = array('url' => $s); return; }
            return;
        }
        if (!is_array($node)) return;
        $item = array();
        if (!empty($node['url']) && is_string($node['url'])) $item['url'] = $node['url'];
        elseif (!empty($node['b64_json'])) $item['b64_json'] = (string) $node['b64_json'];
        elseif (!empty($node['image_url']) && is_string($node['image_url'])) $item['url'] = $node['image_url'];
        elseif (!empty($node['image']) && is_string($node['image'])) {
            // image 字段可能是裸 base64 或 data URL
            $v = $node['image'];
            if (strpos($v, 'data:image/') === 0) {
                $pos = strpos($v, 'base64,');
                if ($pos !== false) $item['b64_json'] = substr($v, $pos + 7);
            } elseif (preg_match('#^https?://#i', $v)) {
                $item['url'] = $v;
            } else {
                $item['b64_json'] = $v;
            }
        }
        if (isset($node['revised_prompt']) && is_string($node['revised_prompt'])) $item['revised_prompt'] = $node['revised_prompt'];
        if ($item) $items[] = $item;
    };
    if (!is_array($j)) return $items;
    foreach (array('data', 'images', 'output', 'artifacts', 'results', 'image') as $key) {
        if (!array_key_exists($key, $j)) continue;
        $v = $j[$key];
        if (is_array($v)) {
            // 关联数组且自身带 url/b64_json,视为单个对象
            if (isset($v['url']) || isset($v['b64_json']) || isset($v['image']) || isset($v['image_url'])) $push($v);
            else foreach ($v as $one) $push($one);
        } else {
            $push($v);
        }
        if (count($items) >= $limit) break;
    }
    // 顶层直接是单张图片
    if (!$items && (isset($j['url']) || isset($j['b64_json']) || isset($j['image']))) $push($j);
    return $items;
}

// 网页端入口:返回 {ok, model, images:[{url|b64_json}]}
function tc_api_proxy_images() {
    tc_json(200, tc_generate_images(null));
}

// 开放接口入口:POST /v1/images/generations,返回 OpenAI 规范形状
function tc_api_v1_images_generations() {
    $auth = tc_v1_authenticate();
    $out = tc_generate_images($auth);
    $data = array();
    foreach ((isset($out['images']) ? $out['images'] : array()) as $im) {
        $row = array();
        if (!empty($im['url'])) $row['url'] = $im['url'];
        elseif (!empty($im['b64_json'])) $row['b64_json'] = $im['b64_json'];
        if (isset($im['revised_prompt'])) $row['revised_prompt'] = $im['revised_prompt'];
        if ($row) $data[] = $row;
    }
    tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
}

// ============ 视频生成(异步任务:建任务 + 轮询) ============
// 视频模型名启发式(供前后台默认判断;仍以后台显式 video 标记 / apiFormat=video 为准)
function tc_video_model_name_hint($id) {
    $s = strtolower(trim((string) $id));
    if ($s === '') return false;
    if (strpos($s, 'agnes-video') !== false) return true;
    return (bool) preg_match('/(^|[^a-z0-9])(videos?|text-to-video|image-to-video|t2v|i2v|kling|sora|veo|runway|pika|seedance|hailuo|vidu|wan-?video)([^a-z0-9]|$)/', $s);
}
// 模型是否视频模型:供应商 apiFormat=video 或模型 video 标记优先,否则按名称启发式
function tc_model_is_video($provider, $modelId) {
    $id = trim((string) $modelId);
    if ($id === '') return false;
    $fmt = isset($provider['apiFormat']) ? (string) $provider['apiFormat'] : 'chat';
    if ($fmt === 'video') return true;
    foreach ((isset($provider['models']) && is_array($provider['models'])) ? $provider['models'] : array() as $m) {
        if (!is_array($m)) continue;
        if ((string) (isset($m['id']) ? $m['id'] : '') !== $id) continue;
        if (array_key_exists('video', $m)) return !empty($m['video']);
        break;
    }
    return tc_video_model_name_hint($id);
}
// 任务查询地址:Agnes 的查询端点在站点根(/agnesapi),不在 /v1 下;从 Base URL 去掉版本段再拼
function tc_video_poll_url($baseUrl) {
    $base = rtrim(trim((string) $baseUrl), '/');
    return preg_replace('#/v\d+[a-z]*$#i', '', $base) . '/agnesapi';
}

function tc_generate_video($apiKeyOwner = null) {
    $started = tc_now();
    $authUserId = $apiKeyOwner !== null ? (string) $apiKeyOwner['userId'] : '';
    $ctx = tc_with_db(false, function ($db) use ($apiKeyOwner, $authUserId) {
        if ($apiKeyOwner !== null) {
            $user = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === $authUserId) { $user = $u; break; }
            }
            if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        } else {
            $user = tc_require_auth($db);
        }
        // 密钥路径的用户级窗口已由 tc_v1_authenticate 记过,这里只给网页端计数
        if ($apiKeyOwner === null) {
            $rateLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
            if (!tc_rate_limit_check('u:' . $user['id'], $rateLimit)) {
                tc_fail(429, '请求太频繁了，请稍后再试（当前上限 ' . $rateLimit . ' 次/分钟）');
            }
        }
        // 参考图 / 首尾帧都可能是 data URL,给足请求体上限
        $b = tc_read_json_body(48 * 1024 * 1024);
        $promptText = isset($b['prompt']) ? (string) $b['prompt'] : '';
        if (trim($promptText) === '' && (isset($b['messages']) || isset($b['input']))) {
            $promptText = tc_last_user_text($b, isset($b['messages']) ? 'chat' : 'responses');
        }
        $modHit = tc_moderation_hit(isset($db['settings']['moderation']) && is_array($db['settings']['moderation']) ? $db['settings']['moderation'] : array(), $promptText);
        if ($modHit !== '') tc_fail(400, '提示词包含被禁止的内容，请修改后重试');
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 120);
        $resolved = tc_resolve_provider($db, $user, array(
            'providerId' => isset($b['providerId']) ? $b['providerId'] : null,
            'model' => $model,
        ));
        if (!empty($resolved['error'])) tc_fail(400, $resolved['error']);
        $provider = $resolved['provider'];
        $fmt = isset($provider['apiFormat']) ? (string) $provider['apiFormat'] : 'chat';
        if ($fmt === 'anthropic') tc_fail(400, '该供应商为 Anthropic 格式，暂不支持视频生成');
        if ($apiKeyOwner !== null && !tc_api_model_exposed($db['settings'], isset($provider['id']) ? $provider['id'] : '', $model)) {
            tc_fail(403, '模型 ' . $model . ' 未对开放接口开放，请联系管理员');
        }
        $cost = tc_model_cost($provider, $model);
        if (isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id']) $cost = 0;
        // 原子预扣:与对话路径同一套(见 tc_quota_reserve),避免并发生视频把额度刷穿
        $reserveOk = false; $quotaNow = -1;
        tc_with_db(true, function (&$db) use ($user, $cost, &$reserveOk, &$quotaNow) {
            $reserveOk = tc_quota_reserve($db, $user['id'], $cost);
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === (string) $user['id']) { $quotaNow = tc_is_unlimited_quota($u) ? -1 : tc_quota_effective($u); break; }
            }
        });
        if (!$reserveOk) tc_fail(402, '剩余次数不足，请联系管理员充值');
        tc_quota_mark_pending($user['id'], $cost);
        // 模式:文字生成 / 首尾帧 / 参考图
        $mode = isset($b['mode']) && in_array($b['mode'], array('text', 'keyframe', 'reference'), true) ? $b['mode'] : 'text';
        // 时长:4~12 秒(字符串)
        $seconds = '5';
        if (isset($b['seconds'])) {
            $sec = is_numeric($b['seconds']) ? (int) $b['seconds'] : 0;
            if ($sec >= 4 && $sec <= 12) $seconds = (string) $sec;
        }
        // 画面比例
        $ratio = '16:9';
        $allowedRatios = array('21:9', '16:9', '4:3', '1:1', '3:4', '9:16');
        if (isset($b['aspect_ratio']) && is_string($b['aspect_ratio']) && in_array(trim($b['aspect_ratio']), $allowedRatios, true)) {
            $ratio = trim($b['aspect_ratio']);
        }
        $seed = null;
        if (isset($b['seed']) && is_numeric($b['seed'])) { $s = (int) $b['seed']; if ($s >= 0) $seed = $s; }
        // 参考图(最多 5)/ 音频(最多 3)/ 首尾帧
        $images = $mode === 'reference' ? tc_edit_image_refs(isset($b['images']) ? $b['images'] : null, 5) : array();
        $audios = $mode === 'reference' ? tc_edit_image_refs(isset($b['audios']) ? $b['audios'] : null, 3) : array();
        $firstFrame = '';
        $lastFrame = '';
        if ($mode === 'keyframe') {
            $f = tc_edit_image_refs(isset($b['first_frame']) ? array($b['first_frame']) : null, 1);
            $l = tc_edit_image_refs(isset($b['last_frame']) ? array($b['last_frame']) : null, 1);
            $firstFrame = $f ? $f[0] : '';
            $lastFrame = $l ? $l[0] : '';
            if ($firstFrame === '' && $lastFrame === '') tc_fail(400, '首尾帧模式至少需要上传首帧或尾帧');
        }
        return array(
            'user' => $user,
            'provider' => $provider,
            'cost' => $cost,
            'model' => $model,
            'prompt' => substr(trim($promptText), 0, 4000),
            'mode' => $mode,
            'seconds' => $seconds,
            'ratio' => $ratio,
            'seed' => $seed,
            'images' => $images,
            'audios' => $audios,
            'first_frame' => $firstFrame,
            'last_frame' => $lastFrame,
        );
    });
    $provider = $ctx['provider'];
    $user = $ctx['user'];
    if ($ctx['model'] === '' || $ctx['prompt'] === '') tc_fail(400, '请填写模型和提示词');
    $url = tc_api_url($provider['baseUrl'], '/videos');
    // 生视频同样是带服务端身份的出站请求,发请求前确认目标不是内网/保留地址。
    tc_upstream_guard($url);
    // 多密钥:按优先级链依次尝试,前一把认证/连接失败时自动换下一把
    $videoKeyChain = tc_provider_key_chain($provider, $ctx['model']);
    if (!$videoKeyChain) $videoKeyChain = array('');
    $videoKeyIdx = 0;
    $videoKey = $videoKeyChain[0];
    $headers = array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . $videoKey);
    $body = array(
        'model' => $ctx['model'],
        'prompt' => $ctx['prompt'],
        'mode' => $ctx['mode'],
        'seconds' => $ctx['seconds'],
        'size' => '720P',
        'aspect_ratio' => $ctx['ratio'],
        'n' => 1,
    );
    if ($ctx['seed'] !== null) $body['seed'] = $ctx['seed'];
    if (!empty($ctx['images'])) $body['images'] = array_values($ctx['images']);
    if (!empty($ctx['audios'])) $body['audios'] = array_values($ctx['audios']);
    if ($ctx['first_frame'] !== '') $body['first_frame'] = $ctx['first_frame'];
    if ($ctx['last_frame'] !== '') $body['last_frame'] = $ctx['last_frame'];
    $res = null;
    for ($videoTry = 0; $videoTry < 8; $videoTry++) {
        $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), 60000, false, null, true, 30000);
        if ($videoKeyIdx + 1 < count($videoKeyChain) && tc_key_failure_retryable($res)) {
            $videoKeyIdx++;
            $videoKey = $videoKeyChain[$videoKeyIdx];
            $headers['Authorization'] = 'Bearer ' . $videoKey;
            continue;
        }
        break;
    }
    if (empty($res['ok'])) {
        tc_fail(isset($res['code']) && $res['code'] ? $res['code'] : 502, tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : ''));
    }
    $status = (int) (isset($res['status']) ? $res['status'] : 0);
    if ($status >= 400) {
        tc_fail($status, tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', $status));
    }
    $j = json_decode((string) (isset($res['body']) ? $res['body'] : ''), true);
    if (!is_array($j)) $j = array();
    $videoUrl = '';
    if (!empty($j['url']) && is_string($j['url'])) $videoUrl = $j['url'];
    $videoId = '';
    foreach (array('video_id', 'id', 'task_id') as $k) {
        if (!empty($j[$k]) && is_string($j[$k])) { $videoId = $j[$k]; break; }
    }
    // 部分平台同步返回视频地址;否则轮询任务直到完成(failed/timeout 报错)。
    if ($videoUrl === '') {
        if ($videoId === '') tc_fail(502, '上游未返回视频地址或任务 ID');
        @set_time_limit(0);
        $pollUrl = tc_video_poll_url($provider['baseUrl']);
        $deadline = time() + 300;
        $lastProgress = -1;
        while (time() < $deadline) {
            usleep(1500000);
            $q = $pollUrl . '?video_id=' . rawurlencode($videoId) . '&model_name=' . rawurlencode($ctx['model']);
            $pr = tc_http_request($q, 'GET', array('Authorization' => 'Bearer ' . $videoKey, 'Accept' => 'application/json'), null, 20000, false);
            if (empty($pr['ok']) || (int) $pr['status'] >= 400) continue; // 短暂失败不致命,继续轮询
            $pj = json_decode((string) $pr['body'], true);
            if (!is_array($pj)) continue;
            $pstatus = strtolower(trim((string) (isset($pj['status']) ? $pj['status'] : '')));
            if (isset($pj['progress']) && is_numeric($pj['progress'])) $lastProgress = (int) $pj['progress'];
            if (!empty($pj['url']) && is_string($pj['url'])) { $videoUrl = $pj['url']; break; }
            if (in_array($pstatus, array('failed', 'error', 'canceled', 'cancelled'), true)) {
                $err = '';
                if (isset($pj['error']) && is_string($pj['error'])) $err = $pj['error'];
                elseif (isset($pj['error']['message'])) $err = (string) $pj['error']['message'];
                elseif (isset($pj['message']) && is_string($pj['message'])) $err = $pj['message'];
                tc_fail(502, '视频生成失败' . ($err !== '' ? '：' . substr($err, 0, 200) : ''));
            }
            if (in_array($pstatus, array('completed', 'success', 'succeeded', 'finished'), true) && $videoUrl === '') {
                // 已完成但没给 url:再取一次原始响应里的常见字段
                foreach (array('video_url', 'output', 'result') as $k) {
                    if (!empty($pj[$k]) && is_string($pj[$k])) { $videoUrl = $pj[$k]; break; }
                }
                if ($videoUrl !== '') break;
            }
        }
        if ($videoUrl === '') tc_fail(504, '视频生成超时，请稍后重试（任务 ID：' . $videoId . '）');
    }
    $video = array(
        'url' => $videoUrl,
        'display' => tc_video_proxy_path($videoUrl),
        'seconds' => $ctx['seconds'],
        'size' => '720P',
        'aspect_ratio' => $ctx['ratio'],
        'mode' => $ctx['mode'],
    );
    $usage = array('prompt' => 0, 'completion' => 0);
    tc_with_db(true, function (&$db) use ($user, $provider, $ctx, $usage, $started, $video) {
        $fresh = null;
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        if (!$fresh) return;
        $charged = tc_quota_settle($db, $user['id'], tc_final_cost($provider, $ctx['cost'], $usage), $ctx['model'] . ' (视频)', 'video');
        tc_quota_clear_pending();
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        tc_charge_user_stats($db, $fresh, $ctx['model'] . ' (视频)', 'video');
        tc_touch_user($db, $user['id']);
        $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
        tc_record_usage_entry($db, $user['id'], $ctx['model'] . ' (视频)', $charged, 0, 0);
        tc_push_log(array('kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'], 'provider' => $provider['name'], 'model' => $ctx['model'] . ' (视频)', 'format' => 'videos', 'status' => 200, 'ms' => tc_now() - $started, 'cost' => $charged, 'stream' => false,
            'prompt' => tc_log_clip(isset($ctx['prompt']) ? $ctx['prompt'] : '', 4000),
            'reply' => tc_log_clip('视频：' . (isset($video['url']) ? $video['url'] : (isset($video['display']) ? $video['display'] : '')), 4000),
            'ip' => tc_client_ip()));
    });
    return array('ok' => true, 'model' => $ctx['model'], 'videos' => array($video));
}

// ---- 视频结果代理 ----
// 视频托管在第三方域时浏览器可能加载不到;同时 <video> 需要 Range 才能拖动进度,
// 因此视频代理转发浏览器的 Range 头并原样流式回传(不缓存整文件)。
function tc_video_proxy_token($url) {
    return substr(hash_hmac('sha256', 'video:' . (string) $url, tc_secret()), 0, 24);
}
function tc_video_proxy_path($url) {
    $u = (string) $url;
    if (!preg_match('#^https?://#i', $u)) return $u;
    return '/api/proxy/video?u=' . rawurlencode($u) . '&s=' . tc_video_proxy_token($u);
}
function tc_api_video_proxy() {
    $q = tc_query();
    $url = isset($q['u']) ? (string) $q['u'] : '';
    $sig = isset($q['s']) ? (string) $q['s'] : '';
    if ($url === '' || $sig === '' || !hash_equals(tc_video_proxy_token($url), $sig)) {
        http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); echo '签名无效'; exit;
    }
    if (!tc_rate_limit_check('vidpx:' . tc_client_ip(), 240)) {
        http_response_code(429); header('Content-Type: text/plain; charset=utf-8'); echo '请求过于频繁'; exit;
    }
    if (!tc_url_is_public_http($url)) {
        http_response_code(400); header('Content-Type: text/plain; charset=utf-8'); echo '视频地址不被允许'; exit;
    }
    while (ob_get_level()) { @ob_end_clean(); }
    @ini_set('zlib.output_compression', '0');
    @set_time_limit(0);
    $range = isset($_SERVER['HTTP_RANGE']) ? trim((string) $_SERVER['HTTP_RANGE']) : '';
    $hdrs = array('User-Agent: TinyChat-VideoProxy/1.0');
    if ($range !== '') $hdrs[] = 'Range: ' . $range;
    $ch = curl_init($url);
    // 与图片代理同一套防 DNS rebinding 口径:校验时的解析结果 pin 进 CURLOPT_RESOLVE
    $pin = tc_public_resolve_pin($url);
    if ($pin) curl_setopt($ch, CURLOPT_RESOLVE, array($pin['host'] . ':' . $pin['port'] . ':' . $pin['ip']));
    curl_setopt_array($ch, array(
        CURLOPT_HTTPHEADER => $hdrs,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 2,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ));
    $ca = tc_cacert_path();
    if ($ca) curl_setopt($ch, CURLOPT_CAINFO, $ca);
    $up = array();
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$up) {
        $t = trim($line);
        $pos = strpos($t, ':');
        if ($pos !== false) $up[strtolower(substr($t, 0, $pos))] = trim(substr($t, $pos + 1));
        return strlen($line);
    });
    $sent = false;
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$sent, &$up) {
        if (!$sent) {
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if (!tc_http_landed_public($ch)) {
                http_response_code(400);
                header('Content-Type: text/plain; charset=utf-8');
                echo '视频地址不被允许';
                $sent = true;
                return 0;
            }
            if ($code >= 400) { http_response_code($code); $sent = true; return strlen($data); }
            http_response_code($code === 206 ? 206 : 200);
            // 上游的 Content-Type 原样透传的话,text/html 会被本站同源内联渲染。
            // 收紧到视频/音频两族,其余一律按 video/mp4 输出(浏览器解析不了,只会显示破图)。
            tc_proxy_media_headers(tc_proxy_media_ctype(
                isset($up['content-type']) ? $up['content-type'] : 'video/mp4',
                array('video', 'audio'), 'video/mp4'), 'public, max-age=3600');
            header('Accept-Ranges: bytes');
            if (isset($up['content-length'])) header('Content-Length: ' . $up['content-length']);
            if (isset($up['content-range'])) header('Content-Range: ' . $up['content-range']);
            $sent = true;
        }
        echo $data;
        return strlen($data);
    });
    @curl_exec($ch);
    curl_close($ch);
    exit;
}

// 网页端入口:返回 {ok, model, videos:[{url, display, seconds, size, aspect_ratio}]}
function tc_api_proxy_videos() {
    tc_json(200, tc_generate_video(null));
}
// 开放接口入口:POST /v1/videos(同步返回最终结果;内部完成轮询)
function tc_api_v1_videos() {
    $auth = tc_v1_authenticate();
    $out = tc_generate_video($auth);
    $data = array();
    foreach ((isset($out['videos']) ? $out['videos'] : array()) as $v) {
        $row = array('url' => isset($v['url']) ? $v['url'] : '', 'model' => isset($out['model']) ? $out['model'] : '');
        if (isset($v['seconds'])) $row['seconds'] = $v['seconds'];
        if (isset($v['size'])) $row['size'] = $v['size'];
        if (isset($v['aspect_ratio'])) $row['aspect_ratio'] = $v['aspect_ratio'];
        $data[] = $row;
    }
    tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
}

function tc_api_v1_chat_completions() {
    $auth = tc_v1_authenticate();
    tc_api_proxy('chat', $auth);
}

function tc_api_v1_models() {
    $auth = tc_v1_authenticate();
    tc_with_db(false, function ($db) use ($auth) {
        $user = null;
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === $auth['userId']) { $user = $u; break; }
        }
        if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        $allowed = tc_user_access($db, $user);
        $data = array();
        // 模型汇总:被汇总组收纳的原始模型不再单独列出,改由汇总 ID 代表 ——
        // 开放接口因此拿到的是「一个 ID 背后多条渠道」,客户端代码无需改动即获得故障转移。
        $aggOn = tc_model_groups_on($db);
        $memberKeys = $aggOn ? tc_model_group_member_keys($db, $user) : array();
        $seen = array();
        foreach (tc_visible_providers_of($db, $user) as $p) {
            $vis = tc_visible_provider($user, $p, $allowed);
            if (!$vis) continue;
            $ownerName = (isset($p['name']) && $p['name'] !== '' ? $p['name'] : 'tinychat');
            foreach ((isset($vis['models']) ? $vis['models'] : array()) as $m) {
                if (!is_array($m) || !isset($m['id']) || $m['id'] === '') continue;
                $mid = (string) $m['id'];
                if (isset($memberKeys[(string) $p['id'] . '|' . $mid])) continue;
                // 对外模型白名单:未开放的模型不出现在 /v1/models 里
                if (!tc_api_model_exposed($db['settings'], isset($p['id']) ? $p['id'] : '', $mid)) continue;
                if (isset($seen[$mid])) continue;   // 同名模型跨渠道只列一次,避免列表里重复
                $seen[$mid] = true;
                $data[] = array('id' => $mid, 'object' => 'model', 'created' => 0, 'owned_by' => $ownerName);
            }
        }
        if ($aggOn) {
            foreach (tc_model_groups_ordered($db) as $g) {
                list($candidates, $err) = tc_model_group_candidates($db, $user, $g);
                if ($err !== '' || !$candidates) continue;
                if (!tc_api_group_exposed($db['settings'], $db, $g)) continue;
                $gid = (string) $g['id'];
                if (isset($seen[$gid])) continue;
                $seen[$gid] = true;
                $data[] = array(
                    'id' => $gid,
                    'object' => 'model',
                    'created' => 0,
                    'owned_by' => isset($g['label']) && $g['label'] !== '' ? $g['label'] : $gid,
                );
            }
        }
        tc_json(200, array('object' => 'list', 'data' => $data));
    });
}

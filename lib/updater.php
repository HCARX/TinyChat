<?php
/**
 * TinyChat 在线更新：检查 GitHub Releases 并一键升级。
 *
 * 流程：检查(结果缓存 30 分钟) → 下载对应 tag 的源码包 → 解压校验 →
 *       备份当前程序到 data/update/backup → 覆盖站点文件。
 * 覆盖时固定跳过 data/ 与 config.php，用户数据和本地配置不受影响。
 *
 * config.php / 环境变量可选配置：
 *   github_repo      仓库(owner/name)，默认 TinyNano/TinyChat
 *   github_token     访问令牌：私有仓库必填，公开仓库可留空(可提升 API 限流)
 *   github_api_base  API 根地址，默认 https://api.github.com，可换镜像
 *   github_base      发布包下载根地址，默认 https://github.com，可填 ghproxy 类加速前缀
 */
define('TC_UPDATE_CACHE_MIN', 30);

function tc_update_cfg($key, $default) {
    $v = tc_cfg($key);
    return ($v === null || $v === '') ? $default : $v;
}

function tc_update_repo() {
    $repo = trim((string) tc_update_cfg('github_repo', 'TinyNano/TinyChat'));
    if (!preg_match('#^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$#', $repo)) {
        throw new RuntimeException('github_repo 配置无效，应为 owner/repo 形式');
    }
    return $repo;
}

function tc_update_work_dir() {
    $dir = tc_data_dir() . '/update';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    if (!is_dir($dir)) throw new RuntimeException('无法创建更新工作目录: ' . $dir);
    return $dir;
}

function tc_update_normalize_tag($tag) {
    return ltrim(trim((string) $tag), 'vV');
}

function tc_update_http($url, $headers = array()) {
    if (!function_exists('curl_init')) throw new RuntimeException('主机未启用 curl 扩展');
    $ch = curl_init($url);
    $opts = array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 12,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => $headers,
    );
    $ca = tc_cacert_path();
    if ($ca) $opts[CURLOPT_CAINFO] = $ca;
    // 出站代理同样覆盖更新检查:国内主机直连 GitHub 常卡死,走代理才稳定。
    tc_curl_apply_proxy($opts);
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $effective = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);
    if ($body === false) throw new RuntimeException($err !== '' ? $err : '网络请求失败');
    return array('code' => $code, 'body' => (string) $body, 'url' => $effective);
}

// 下载到文件:流式写入,超过 256MB 视为异常中止;返回前校验 HTTP 状态与体积
function tc_update_download($url, $toFile, $headers = array()) {
    $ch = curl_init($url);
    $fp = @fopen($toFile, 'wb');
    if (!$fp) { curl_close($ch); throw new RuntimeException('无法写入下载文件: ' . $toFile); }
    $size = 0;
    $max = 268435456;
    $opts = array(
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 600,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_WRITEFUNCTION => function ($ch, $data) use ($fp, &$size, $max) {
            $size += strlen($data);
            if ($size > $max) return -1;
            return fwrite($fp, $data);
        },
    );
    $ca = tc_cacert_path();
    if ($ca) $opts[CURLOPT_CAINFO] = $ca;
    // 出站代理同样覆盖更新包下载(见 tc_update_http 的说明)。
    tc_curl_apply_proxy($opts);
    curl_setopt_array($ch, $opts);
    $ok = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    fclose($fp);
    if ($size > $max) { @unlink($toFile); throw new RuntimeException('更新包超过 256MB 上限，已中止'); }
    if (!$ok || $code !== 200) {
        @unlink($toFile);
        throw new RuntimeException('下载更新包失败(HTTP ' . $code . ')' . ($err !== '' ? ': ' . $err : ''));
    }
    if ($size <= 0) { @unlink($toFile); throw new RuntimeException('下载的更新包为空'); }
}

function tc_update_extract($pkgPath, $destDir) {
    if (substr($pkgPath, -4) === '.zip') {
        if (!class_exists('ZipArchive')) throw new RuntimeException('主机 PHP 缺少 zip 扩展，无法解压');
        $zip = new ZipArchive();
        $res = $zip->open($pkgPath);
        if ($res !== true) throw new RuntimeException('更新包无法打开(ZipArchive #' . $res . ')');
        if (!$zip->extractTo($destDir)) { $zip->close(); throw new RuntimeException('解压失败，请检查磁盘空间与目录权限'); }
        $zip->close();
        return;
    }
    if (!class_exists('PharData')) throw new RuntimeException('主机 PHP 缺少 phar/zlib 扩展，无法解压');
    try {
        $phar = new PharData($pkgPath);
        $phar->extractTo($destDir, null, true);
    } catch (Exception $e) {
        throw new RuntimeException('更新包解压失败: ' . $e->getMessage());
    }
}

// GitHub 源码包外层套一层目录(如 TinyChat-1.2.3/),定位真正的程序根
function tc_update_locate_root($exDir) {
    if (is_file($exDir . '/index.php')) return $exDir;
    $dirs = array();
    foreach ((@scandir($exDir) ?: array()) as $name) {
        if ($name === '.' || $name === '..') continue;
        if (is_dir($exDir . '/' . $name)) $dirs[] = $name;
    }
    if (count($dirs) === 1 && is_file($exDir . '/' . $dirs[0] . '/index.php')) return $exDir . '/' . $dirs[0];
    throw new RuntimeException('更新包结构不符合预期（未找到 index.php）');
}

// 递归复制;$skipTop 只匹配 $src 顶层条目名;返回复制失败的相对路径列表
function tc_update_copy_tree($src, $dst, $skipTop = array()) {
    $failed = array();
    tc_update_copy_walk($src, $src, $dst, $skipTop, $failed);
    return $failed;
}

function tc_update_copy_walk($root, $dir, $dst, $skipTop, &$failed) {
    $items = @scandir($dir);
    if (!is_array($items)) { $failed[] = ltrim(substr($dir, strlen($root)), '/\\'); return; }
    foreach ($items as $name) {
        if ($name === '.' || $name === '..') continue;
        if ($dir === $root && in_array($name, $skipTop, true)) continue;
        $path = $dir . '/' . $name;
        $rel = str_replace('\\', '/', ltrim(substr($path, strlen($root)), '/\\'));
        $target = rtrim($dst, '/\\') . '/' . $rel;
        if (is_dir($path)) {
            if (!is_dir($target) && !@mkdir($target, 0755, true)) { $failed[] = $rel; continue; }
            tc_update_copy_walk($root, $path, $dst, $skipTop, $failed);
        } else {
            $targetDir = dirname($target);
            if (!is_dir($targetDir)) @mkdir($targetDir, 0755, true);
            if (!@copy($path, $target)) $failed[] = $rel;
        }
    }
}

// 只允许删除 data/update/ 内部的内容,防止误删站点目录
function tc_update_rrmdir($dir) {
    $work = realpath(tc_update_work_dir());
    $real = realpath($dir);
    if ($real === false || $work === false || $real === $work || strpos($real, $work . DIRECTORY_SEPARATOR) !== 0) return;
    foreach ((@scandir($real) ?: array()) as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $real . DIRECTORY_SEPARATOR . $name;
        if (is_dir($path)) tc_update_rrmdir_inner($path);
        else @unlink($path);
    }
    @rmdir($real);
}

function tc_update_rrmdir_inner($dir) {
    foreach ((@scandir($dir) ?: array()) as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $dir . DIRECTORY_SEPARATOR . $name;
        if (is_dir($path)) tc_update_rrmdir_inner($path);
        else @unlink($path);
    }
    @rmdir($dir);
}

// 找可用的 PHP CLI 解释器。PHP_BINARY 在 FPM/CGI 下是 php-fpm 本身:
// 它不是 CLI SAPI,不认 -l,拿它 lint 会把「新版本文件存在语法错误」误报出来,
// 于是宝塔/Nginx 站点上「在线更新」永远失败。这里改为逐个候选探测 -l 能力。
function tc_update_php_cli() {
    static $cached = false;
    if ($cached !== false) return $cached;
    $cached = '';
    if (!function_exists('exec')) return $cached;

    $devnull = DIRECTORY_SEPARATOR === '\\' ? ' 2>NUL' : ' 2>/dev/null';
    $probe = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'tc-lint-probe-' . bin2hex(random_bytes(4)) . '.php';
    if (@file_put_contents($probe, "<?php echo 1;\n") === false) return $cached;

    $candidates = array();
    if (PHP_SAPI === 'cli' || PHP_SAPI === 'cli-server' || PHP_SAPI === 'phpdbg') {
        $candidates[] = (string) PHP_BINARY;
    }
    if (defined('PHP_BINDIR') && PHP_BINDIR) {
        $candidates[] = rtrim((string) PHP_BINDIR, '/\\') . DIRECTORY_SEPARATOR . 'php';
    }
    foreach (array('php', 'php-cli') as $name) $candidates[] = $name;
    // 宝塔/常见面板的多版本目录:www/server/php/<版本>/bin/php
    foreach (glob('/www/server/php/*/bin/php') ?: array() as $p) $candidates[] = $p;
    $candidates = array_merge($candidates, array('/usr/bin/php', '/usr/local/bin/php', '/opt/homebrew/bin/php'));

    foreach (array_unique($candidates) as $bin) {
        if ($bin === '') continue;
        @exec(escapeshellarg($bin) . ' -l ' . escapeshellarg($probe) . $devnull, $o, $c);
        if ($c === 0) { $cached = $bin; break; }
    }
    @unlink($probe);
    return $cached;
}

// 有 PHP CLI 可用时对新包逐个 .php 做语法检查;失败即中止,避免半新半旧
function tc_update_lint($srcRoot) {
    $phpBin = tc_update_php_cli();
    if ($phpBin === '') return; // 没有可用的 PHP CLI(如 FPM 且 PATH 里也没有 php),跳过语法检查
    $php = escapeshellarg($phpBin);
    $devnull = DIRECTORY_SEPARATOR === '\\' ? ' 2>NUL' : ' 2>/dev/null';
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($srcRoot, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (substr($f->getFilename(), -4) !== '.php') continue;
        @exec($php . ' -l ' . escapeshellarg($f->getPathname()) . $devnull, $o, $c);
        if ($c !== 0) throw new RuntimeException('新版本文件存在语法错误: ' . $f->getBasename() . '，已中止更新');
    }
}

function tc_update_last_update() {
    $file = tc_update_work_dir() . '/last-update.json';
    if (!is_file($file)) return null;
    $j = json_decode((string) @file_get_contents($file), true);
    return is_array($j) ? $j : null;
}

// 检查更新:优先 GitHub API(带 token 可用),失败时走 releases/latest 的 302 跳转解析 tag(免限流)
function tc_update_check($force = false) {
    $workDir = tc_update_work_dir();
    $cacheFile = $workDir . '/update-check.json';
    if (!$force && is_file($cacheFile)) {
        $j = json_decode((string) @file_get_contents($cacheFile), true);
        if (is_array($j) && !empty($j['checkedAt']) && !empty($j['result'])
            && tc_now() - (int) $j['checkedAt'] < TC_UPDATE_CACHE_MIN * 60 * 1000) {
            $result = $j['result'];
            $result['cached'] = true;
            return $result;
        }
    }

    $repo = tc_update_repo();
    $token = trim((string) tc_cfg('github_token'));
    $latest = null;
    $saw404 = false;
    $warns = array();

    $headers = array('User-Agent: TinyChat-Updater', 'Accept: application/vnd.github+json');
    if ($token !== '') $headers[] = 'Authorization: token ' . $token;
    try {
        $apiBase = rtrim((string) tc_update_cfg('github_api_base', 'https://api.github.com'), '/');
        $r = tc_update_http($apiBase . '/repos/' . $repo . '/releases/latest', $headers);
        if ($r['code'] === 200) {
            $j = json_decode($r['body'], true);
            if (is_array($j) && !empty($j['tag_name'])) {
                $latest = array(
                    'version' => tc_update_normalize_tag($j['tag_name']),
                    'tagName' => (string) $j['tag_name'],
                    'name' => (string) (isset($j['name']) ? $j['name'] : ''),
                    'notes' => (string) (isset($j['body']) ? $j['body'] : ''),
                    'url' => (string) (isset($j['html_url']) ? $j['html_url'] : ''),
                    'publishedAt' => (string) (isset($j['published_at']) ? $j['published_at'] : ''),
                );
            }
        } elseif ($r['code'] === 404) {
            $saw404 = true;
        } else {
            $warns[] = 'API HTTP ' . $r['code'];
        }
    } catch (Exception $e) {
        $warns[] = $e->getMessage();
    }

    if (!$latest && !$saw404) {
        try {
            $base = rtrim((string) tc_update_cfg('github_base', 'https://github.com'), '/');
            $r = tc_update_http($base . '/' . $repo . '/releases/latest');
            if ($r['code'] === 200 && preg_match('#/releases/tag/([^/?#]+)$#', $r['url'], $m)) {
                $tag = rawurldecode($m[1]);
                $latest = array(
                    'version' => tc_update_normalize_tag($tag),
                    'tagName' => $tag,
                    'name' => '',
                    'notes' => '',
                    'url' => $r['url'],
                    'publishedAt' => '',
                );
            }
        } catch (Exception $e) {
            $warns[] = $e->getMessage();
        }
    }

    if (!$latest) {
        if ($saw404) throw new RuntimeException('仓库 ' . $repo . ' 没有已发布的版本（或仓库不可访问）');
        throw new RuntimeException('无法连接更新源' . ($warns ? '：' . implode('；', array_slice($warns, 0, 2)) : ''));
    }

    $result = array(
        'current' => TC_VERSION,
        'repo' => $repo,
        'hasUpdate' => $latest['version'] !== '' && version_compare($latest['version'], TC_VERSION, '>'),
        'latest' => $latest,
        'checkedAt' => tc_now(),
        'lastUpdate' => tc_update_last_update(),
        'cached' => false,
    );
    @file_put_contents($cacheFile, tc_json_encode(array('checkedAt' => $result['checkedAt'], 'result' => $result)), LOCK_EX);
    return $result;
}

// 执行更新;成功/失败都以 tc_json/tc_fail 结束响应
function tc_update_perform() {
    try {
        $result = tc_update_do();
    } catch (Exception $e) {
        tc_fail(500, '更新失败：' . $e->getMessage());
    }
    tc_json(200, $result);
}

// 校验更新包完整性:发布包自带 checksums.txt(相对路径 + sha256),解压后逐文件比对。
// 能拦住下载损坏、CDN/加速前缀被篡改、半新半旧包等;注意它防不了能同时重算
// checksums.txt 的攻击者(那需要代码签名,纯 PHP 虚拟主机无法验签)。
// checksums.txt 由 tools/make-checksums.php 生成并随仓库发布。
function tc_update_verify_checksums($srcRoot) {
    $file = $srcRoot . '/checksums.txt';
    if (!is_file($file)) return; // 旧版发布包没有清单,跳过(保持向后兼容)
    $listed = 0;
    $failed = array();
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: array();
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (!preg_match('/^([a-f0-9]{64})\s+\*?(.+)$/i', $line, $m)) continue;
        $rel = str_replace('\\', '/', $m[2]);
        if (strpos($rel, '..') !== false) continue; // 清单异常路径直接忽略
        $target = $srcRoot . '/' . $rel;
        if (!is_file($target)) { $failed[] = $rel . '（缺失）'; continue; }
        $actual = hash_file('sha256', $target);
        if ($actual !== strtolower($m[1])) { $failed[] = $rel; continue; }
        $listed++;
    }
    // 清单里一条都没校验成功视为清单无效,不据此中止(避免误杀合法包);
    // 只要清单有效,任何 listed 文件不匹配都中止覆盖
    if ($listed === 0) return;
    if ($failed) {
        throw new RuntimeException('更新包完整性校验未通过：' . implode(', ', array_slice($failed, 0, 5))
            . '，已中止覆盖。可重新下载或手动安装。');
    }
}

function tc_update_do() {
    @set_time_limit(0);
    ignore_user_abort(true);
    $workDir = tc_update_work_dir();

    $lockFp = @fopen($workDir . '/update.lock', 'c');
    if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
        if ($lockFp) fclose($lockFp);
        throw new RuntimeException('已有更新任务在进行中，请稍后再试');
    }
    try {
        // 1) 重新检查,确认目标版本
        $info = tc_update_check(true);
        if (empty($info['hasUpdate'])) {
            throw new RuntimeException('当前已是最新版本 v' . TC_VERSION . '，无需更新');
        }
        $tag = $info['latest']['tagName'];
        $repo = $info['repo'];

        // 2) 环境与权限检查(失败要在动文件之前)
        $useZip = class_exists('ZipArchive');
        $useTar = !$useZip && class_exists('PharData');
        if (!$useZip && !$useTar) throw new RuntimeException('主机 PHP 缺少 zip/phar 扩展，无法解压更新包；请在 php.ini 启用 zip 后重试');
        foreach (array(TC_ROOT, TC_ROOT . '/lib', TC_ROOT . '/static') as $dir) {
            if (!is_writable($dir)) throw new RuntimeException('站点目录不可写（' . $dir . '），无法在线更新；请检查目录权限或到 GitHub 手动下载新版覆盖');
        }

        // 3) 下载(有 token 走 API zipball,否则走 archive 源码包)
        $token = trim((string) tc_cfg('github_token'));
        $apiBase = rtrim((string) tc_update_cfg('github_api_base', 'https://api.github.com'), '/');
        $base = rtrim((string) tc_update_cfg('github_base', 'https://github.com'), '/');
        $ext = ($useZip && $token !== '') ? '.zip' : ($useTar ? '.tar.gz' : '.zip');
        if ($ext === '.zip' && $token !== '') {
            $url = $apiBase . '/repos/' . $repo . '/zipball/' . rawurlencode($tag);
        } else {
            $url = $base . '/' . $repo . '/archive/refs/tags/' . rawurlencode($tag) . $ext;
        }
        $headers = array('User-Agent: TinyChat-Updater');
        if ($token !== '') $headers[] = 'Authorization: token ' . $token;
        $pkgPath = $workDir . '/pkg-' . $tag . $ext;
        tc_update_download($url, $pkgPath, $headers);

        // 4) 解压 + 定位程序根
        $exDir = $workDir . '/extract';
        tc_update_rrmdir($exDir);
        if (!is_dir($exDir)) @mkdir($exDir, 0755, true);
        tc_update_extract($pkgPath, $exDir);
        $srcRoot = tc_update_locate_root($exDir);
        // 4.5) 包完整性校验(解压后、覆盖前)
        tc_update_verify_checksums($srcRoot);

        // 5) 校验核心文件与版本号,可行时做语法检查
        if (!is_file($srcRoot . '/index.php') || !is_file($srcRoot . '/lib/core.php')) {
            throw new RuntimeException('更新包缺少核心文件（index.php / lib/core.php），已中止');
        }
        $newVer = '';
        $coreSrc = (string) @file_get_contents($srcRoot . '/lib/core.php');
        if (preg_match("/define\\('TC_VERSION',\\s*'([^']+)'/", $coreSrc, $m)) $newVer = $m[1];
        tc_update_lint($srcRoot);

        // 6) 备份当前程序(仅保留最新一份,data/ 与 config.php 不需要备份——它们不会被覆盖)
        $backupDir = $workDir . '/backup';
        tc_update_rrmdir($backupDir);
        $backupFailed = tc_update_copy_tree(TC_ROOT, $backupDir, array('data', '.tmp', 'config.php'));
        if ($backupFailed) throw new RuntimeException('备份当前程序失败：' . implode(', ', array_slice($backupFailed, 0, 5)));

        // 7) 覆盖站点文件(跳过 data 与 config.php)
        $failed = tc_update_copy_tree($srcRoot, TC_ROOT, array('data', 'config.php', '.git'));
        if ($failed) {
            throw new RuntimeException('部分文件覆盖失败：' . implode(', ', array_slice($failed, 0, 5)) . (count($failed) > 5 ? ' 等' : '')
                . '；更新前程序备份在 data/update/backup/，可手动恢复');
        }

        // 8) 记录、清理缓存与临时文件
        $to = $newVer !== '' ? $newVer : $info['latest']['version'];
        $last = array('from' => TC_VERSION, 'to' => $to, 'tag' => $tag, 'at' => tc_now());
        @file_put_contents($workDir . '/last-update.json', tc_json_encode($last), LOCK_EX);
        @unlink($workDir . '/update-check.json');
        @unlink($pkgPath);
        tc_update_rrmdir($exDir);
        tc_push_log(array('kind' => 'admin', 'userName' => 'system', 'action' => '在线更新：v' . $last['from'] . ' → v' . $last['to']));
        return array('ok' => true, 'from' => $last['from'], 'to' => $to, 'tag' => $tag, 'backup' => 'data/update/backup/');
    } finally {
        flock($lockFp, LOCK_UN);
        fclose($lockFp);
    }
}

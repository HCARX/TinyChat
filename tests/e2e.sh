#!/usr/bin/env bash
# TinyChat E2E 冒烟测试:起真实 PHP 服务 + mock 上游,跑完整业务流断言。
# 覆盖:登录/设置、备份(含越权与穿越防护)、邀请码注册、按次与按 token 计费、
#       敏感词审核、接口限流、API 密钥与 /v1 出口、图像生成、协议页、安全响应头。
# 用法:bash tests/e2e.sh   (需要 php、curl;端口可用 E2E_PORT / E2E_MOCK_PORT 覆盖)
set -u
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8099}"
MOCK_PORT="${E2E_MOCK_PORT:-8100}"
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); say "  ✗ $1"; }
assert_contains() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing: $3 | got: $(printf '%s' "$2" | head -c 180))"; fi
}
# 固定字符串包含断言:断言里含 [ ] 等正则元字符时用它,避免被 grep 当字符组解析
assert_has() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (missing literal: $3 | got: $(printf '%s' "$2" | head -c 180))"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3] got [$2])"; fi
}
jget() { # 从 stdin JSON 提取 "key":"value" 或 "key":value 的值
  sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" | head -1
}

# Windows(Git Bash)下 bash 的 kill 杀不死原生 php.exe,残留的监听进程会让
# 下一次 e2e 连上「数据目录已被删」的僵尸服务器,出现成片的 401/空响应假失败。
# 因此 kill 之后再按 WINPID 用 taskkill 按进程树补刀(Linux 下无 taskkill 自动跳过)。
kill_tree() {
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null
  if command -v taskkill > /dev/null 2>&1 && command -v ps > /dev/null 2>&1; then
    wpid=$(ps -W 2>/dev/null | awk -v p="$1" '$1==p && $4+0>0 {print $4; exit}')
    [ -n "$wpid" ] && taskkill //F //T //PID "$wpid" > /dev/null 2>&1
  fi
}

cleanup() {
  kill_tree "$APP_PID"
  kill_tree "$MOCK_PID"
  kill_tree "$OAUTH_PID"
  kill_tree "$SMTP_PID"
  kill_tree "$SMTP_GBK_PID"
  kill_tree "$SMTP_REQ_PID"
  kill_tree "$SMTP_GMAIL_PID"
  # Windows 上被占用的文件删不掉:先补刀再清目录,仍删不掉(极端情况)只提示不报错
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

say "== 启动服务 (app :$PORT / mock :$MOCK_PORT) =="
SMTP_PORT="${E2E_SMTP_PORT:-8105}"
SMTP_GBK_PORT="${E2E_SMTP_GBK_PORT:-8106}"
php tests/mock-smtp.php "$SMTP_PORT" ok >"$TMP/smtp.log" 2>&1 &
SMTP_PID=$!
php tests/mock-smtp.php "$SMTP_GBK_PORT" gbk >"$TMP/smtp-gbk.log" 2>&1 &
SMTP_GBK_PID=$!
SMTP_REQ_PORT="${E2E_SMTP_REQ_PORT:-8107}"
SMTP_GMAIL_PORT="${E2E_SMTP_GMAIL_PORT:-8108}"
php tests/mock-smtp.php "$SMTP_REQ_PORT" requirepass >"$TMP/smtp-req.log" 2>&1 &
SMTP_REQ_PID=$!
php tests/mock-smtp.php "$SMTP_GMAIL_PORT" gmail535 >"$TMP/smtp-gmail.log" 2>&1 &
SMTP_GMAIL_PID=$!
OAUTH_PORT="${E2E_OAUTH_PORT:-8104}"
DATA_DIR="$TMP/data" ADMIN_NAME=admin ADMIN_PASSWORD=e2e-pass \
  TC_BRAVE_SEARCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_DDG_HTML_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_JINA_SEARCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_MISTRAL_OCR_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_PAGE_FETCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_WEB_FETCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_WECHAT_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" TC_WECHAT_API_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_QQ_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_LINUXDO_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_NODELOC_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_ALLOW_PRIVATE_UPSTREAM=1 \
  TC_WEB_CN_ONLY=0 \
  php -S "127.0.0.1:$PORT" router.php >"$TMP/app.log" 2>&1 &
APP_PID=$!
TC_MOCK_ECHO_FILE="$TMP/pf_echo_out.txt" php -S "127.0.0.1:$MOCK_PORT" tests/mock-upstream.php >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!
OAUTH_PORT="${E2E_OAUTH_PORT:-8104}"
php -S "127.0.0.1:$OAUTH_PORT" tests/mock-oauth.php >"$TMP/mock-oauth.log" 2>&1 &
OAUTH_PID=$!

wait_for() {
  local i code
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)
    if [ "$code" != "000" ] && [ -n "$code" ]; then return 0; fi
    sleep 0.2
  done
  return 1
}
wait_for "$BASE/api/config" || { say "app 服务未启动"; exit 1; }

# ---------- 基础页面与安全头 ----------
say "== 基础 =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
assert_eq "首页 200" "$code" "200"
cfg=$(curl -s "$BASE/api/config")
assert_contains "config 返回版本" "$cfg" '"version":"2.'
ecode=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/env-check")
assert_eq "已安装时环境自检接口关闭(403)" "$ecode" "403"
assert_contains "config 返回公告字段" "$cfg" '"announcement"'
hdr=$(curl -s -D - -o /dev/null "$BASE/api/config")
assert_contains "CSP 头" "$hdr" "Content-Security-Policy:"
assert_contains "X-Frame-Options DENY" "$hdr" "X-Frame-Options: DENY"

# ---------- 登录与设置 ----------
say "== 登录与设置 =="
login_json=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"admin","password":"e2e-pass"}')
assert_contains "管理员登录返回合法 JSON" "$login_json" '"token":"'
TOKEN=$(printf '%s' "$login_json" | jget token)
[ -n "$TOKEN" ] && ok "管理员登录" || bad "管理员登录"
AUTH="Authorization: Bearer $TOKEN"
cat > "$TMP/settings1.json" <<'EOF'
{"temperature":0.7,"rateLimitPerMin":50,"backupKeep":3,"agreementEnabled":true,"agreementHtml":"<p>测试协议</p>","registerInviteRequired":true,"registerLimitPerHour":100,"announcement":{"enabled":true,"text":"E2E announcement"}}
EOF
res=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/settings1.json")
assert_contains "设置: temperature 保存" "$res" '"temperature":0.7'
assert_contains "设置: 限流保存" "$res" '"rateLimitPerMin":50'
assert_contains "设置: 协议启用" "$res" '"agreementEnabled":true'
assert_contains "设置: 公告保存" "$res" '"text":"E2E announcement"'
assert_contains "config 回读公告" "$(curl -s "$BASE/api/config")" '"text":"E2E announcement"'
# 模型可用性阈值:可保存,颠倒输入自动纠正,并下发到前端
assert_contains "可用性阈值可保存" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":90,"healthWarnMin":60}')" '"healthOkMin":90'
swapped=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":30,"healthWarnMin":80}')
assert_contains "阈值颠倒自动纠正(ok)" "$swapped" '"healthOkMin":30'
assert_contains "阈值颠倒自动纠正(warn)" "$swapped" '"healthWarnMin":29'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":75,"healthWarnMin":40}' > /dev/null
empty_ann=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"announcement":{"enabled":true,"text":""}}')
assert_contains "空公告启用被拒" "$empty_ann" '启用公告时请填写公告内容'
# 协议页(启用后)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/agreement")
assert_eq "协议页 200" "$code" "200"
page=$(curl -s "$BASE/agreement")
assert_contains "协议页渲染正文" "$page" "测试协议"

# ---------- 备份 ----------
say "== 数据备份 =="
bn=$(curl -s -X POST "$BASE/api/admin/backup" -H "$AUTH" | jget created)
[ -n "$bn" ] && ok "创建备份 ($bn)" || bad "创建备份"
assert_contains "备份列表" "$(curl -s "$BASE/api/admin/backup" -H "$AUTH")" 'db-'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/backup/download?id=$bn" -H "$AUTH")
assert_eq "备份下载 200" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/backup/download?id=$bn")
assert_eq "未登录下载 401" "$code" "401"
assert_contains "路径穿越被拦截" "$(curl -s "$BASE/api/admin/backup/download?id=..%2F..%2Fdb.json" -H "$AUTH")" '备份不存在'
assert_contains "恢复成功" "$(curl -s -X POST "$BASE/api/admin/backup/restore" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$bn\"}")" '"ok":true'

# ---------- 邀请码与注册 ----------
say "== 邀请码与注册 =="
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":2}' > /dev/null
codes=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | grep -o '"code":"[A-F0-9]*"' | cut -d'"' -f4)
INV1=$(printf '%s' "$codes" | sed -n 1p)
INV2=$(printf '%s' "$codes" | sed -n 2p)
[ -n "$INV1" ] && [ -n "$INV2" ] && ok "生成邀请码 ($INV1 / $INV2)" || bad "生成邀请码"
assert_contains "无邀请码注册被拒" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"name":"tester1","password":"pass1234","agreementAccepted":true}')" '邀请码'
cat > "$TMP/reg1.json" <<EOF
{"name":"tester1","password":"pass1234","invite":"$INV1","agreementAccepted":true}
EOF
UTOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg1.json" | jget token)
[ -n "$UTOKEN" ] && ok "邀请码注册成功" || bad "邀请码注册成功"
UAUTH="Authorization: Bearer $UTOKEN"
cat > "$TMP/reg2.json" <<EOF
{"name":"tester2","password":"pass1234","invite":"$INV1","agreementAccepted":true}
EOF
assert_contains "邀请码复用被拒" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg2.json")" '无效或已被使用'
# 多次有效邀请码:一张码可用 2 次,第 3 次拒绝
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":1,"maxUses":2,"prefix":"MULTI"}' > /dev/null
MCODE=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | grep -o '"code":"MULTI-[A-F0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$MCODE" ] && ok "生成多次邀请码 ($MCODE)" || bad "生成多次邀请码"
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi1\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}" > /dev/null
m2=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi2\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}")
assert_contains "多次邀请码第 2 次可用" "$m2" '"token"'
assert_contains "多次邀请码用尽后拒绝" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi3\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}")" '无效或已被使用'
assert_contains "邀请码使用次数记录" "$(curl -s "$BASE/api/admin/invites" -H "$AUTH")" '"usedCount":2'

# ---------- 供应商与按次计费 ----------
say "== 供应商与计费 =="
cat > "$TMP/prov.json" <<'EOF'
{"name":"Mock","baseUrl":"http://127.0.0.1:MOCKPORT/v1","apiKey":"sk-mock","apiFormat":"chat","models":[{"id":"mock-model","name":"Mock"},{"id":"mock-image","name":"Mock Image","image":true},{"id":"mock-chat-image","name":"Chat Image","image":true}],"costPerCall":1,"scope":"global"}
EOF
sed -i "s/MOCKPORT/$MOCK_PORT/" "$TMP/prov.json"
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov.json" > /dev/null
PROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"Mock"' | cut -d'"' -f4)
[ -n "$PROV" ] && ok "创建全局供应商" || bad "创建全局供应商"
# 用户组 ID 必须跨请求稳定(否则授权规则会全部失效)
GID1=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
GID2=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
assert_eq "用户组 ID 跨请求稳定" "$GID1" "$GID2"
# 用户组必须下发 role(前端据此判断「管理员组」;缺失会导致改成演示管理员时误报「用户组更新失败」)
assert_has "用户组下发 admin role" "$(curl -s "$BASE/api/admin/groups" -H "$AUTH")" '"role":"admin"'
assert_has "用户组下发 user role" "$(curl -s "$BASE/api/admin/groups" -H "$AUTH")" '"role":"user"'
ADMINGID=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([g['id'] for g in d['groups'] if g.get('role')=='admin'][0])")
# 普通用户设为演示管理员:后端应自动归入管理员组(前端因此无需再多调一次组接口)
DEMOU=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"todemo","password":"pass1234"}')
TU=$(printf '%s' "$DEMOU" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])")
convert=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$TU"'","name":"todemo","admin":true,"demo":true,"demoMinutes":10}')
assert_contains "普通用户转演示管理员成功" "$convert" '"demo":true'
assert_has "转演示后自动归入管理员组" "$convert" "\"groupId\":\"$ADMINGID\""
# 新建全局供应商应默认授权给各用户组(规则里出现该供应商且为通配)
assert_has "新供应商默认对所有分组开放" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]"
# 收窄授权后再次读取必须仍然生效
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
assert_has "模型授权保存后可回读" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]"
# 部分模型授权:先给全部,再收窄为单个模型,验证该组用户只能看到被授权的模型
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}" > /dev/null
full=$(curl -s "$BASE/api/providers" -H "$UAUTH")
assert_contains "全部授权时可见所有模型" "$full" 'mock-image'
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
partial=$(curl -s "$BASE/api/providers" -H "$UAUTH")
assert_contains "部分授权后仍可见被授权模型" "$partial" 'mock-model'
if printf '%s' "$partial" | grep -q 'mock-image'; then bad "部分授权后不应可见未授权模型 mock-image"; else ok "部分授权后不可见未授权模型"; fi
# 恢复为全部模型授权,后续计费/图像等用例需要访问 mock-image
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}" > /dev/null
cat > "$TMP/chat1.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":false,"messages":[{"role":"user","content":"hello"}]}
EOF
cost=$(curl -s -D - -o /dev/null -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json" | grep -i '^X-Oc-Cost' | tr -d '\r' | awk '{print $2}')
assert_eq "按次计费 X-Oc-Cost=1" "$cost" "1"
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "额度扣减 100->99" "$quota" "99"
# 按 token 计费:2000 tokens × 0.002/1K = 0.004
curl -s -X POST "$BASE/api/admin/providers/$PROV" -H "$AUTH" -H "Content-Type: application/json" -d '{"billingMode":"token","pricePer1k":0.002}' > /dev/null
cost=$(curl -s -D - -o /dev/null -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json" | grep -i '^X-Oc-Cost' | tr -d '\r' | awk '{print $2}')
assert_eq "按 token 计费 0.004" "$cost" "0.004"
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "额度扣减 99->98.996" "$quota" "98.996"

# 流式 + token 计费:首字节用量未知按次预扣 1,流结束按 2000 token 结算 0.004 并退差价 → 净扣 0.004,额度 98.996-0.004=98.992
cat > "$TMP/chat-stream.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":true,"messages":[{"role":"user","content":"hello"}]}
EOF
body=$(curl -s -N -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat-stream.json")
assert_contains "流式输出内容" "$body" 'MOCK-REPLY'
assert_contains "流式正常收尾" "$body" '\[DONE\]'
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "流式按 token 结算(净扣 0.004) 98.992" "$quota" "98.992"

# ---------- 敏感词审核 ----------
say "== 内容审核 =="
cat > "$TMP/mod.json" <<'EOF'
{"moderation":{"enabled":true,"words":"坏词"}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mod.json" > /dev/null
cat > "$TMP/chat2.json" <<'EOF'
{"model":"mock-model","messages":[{"role":"user","content":"这句话包含坏词测试"}]}
EOF
assert_contains "敏感词命中被拒" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat2.json")" '被禁止的内容'

# ---------- API 密钥与 /v1 出口 ----------
say "== API 密钥与 /v1 出口 =="
KEY=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"e2e"}' | jget secret)
[ -n "$KEY" ] && ok "生成 API 密钥" || bad "生成 API 密钥"
assert_contains "/v1/models 列表" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY")" 'mock-model'
assert_contains "/v1/chat/completions 正常应答" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" 'MOCK-REPLY'
assert_contains "无效密钥 401" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer sk-tc-deadbeefdeadbeefdeadbeefdeadbeef" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" '无效的 API 密钥'

# ---------- 图像生成 ----------
say "== 图像生成 =="
cat > "$TMP/img.json" <<EOF
{"providerId":"$PROV","model":"mock-image","prompt":"a corgi surfing","size":"1024x1024","n":1}
EOF
imgresp=$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/img.json")
assert_contains "图像生成返回 URL" "$imgresp" 'example.com/mock.png'
# 结果附带同源代理显示地址(供 <img> 稳定加载,规避第三方存储域不可达)
assert_contains "图像结果附带同源代理地址" "$imgresp" '/api/proxy/image?u='
# b64_json 返回形态(按 response_format 透传)
cat > "$TMP/img-b64.json" <<EOF
{"providerId":"$PROV","model":"mock-image","prompt":"x","n":1,"response_format":"b64_json"}
EOF
assert_contains "图像生成支持 b64_json" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/img-b64.json")" 'b64_json'
# 自定义图片规格:宽高比(只给 ratio、不给 size)、档位(4K)、竖版精确像素都要能出图
assert_contains "图片规格:只给宽高比可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","ratio":"16:9"}')" 'example.com/mock.png'
assert_contains "图片规格:4K 档位可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","size":"4K"}')" 'example.com/mock.png'
assert_contains "图片规格:竖版精确像素可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","size":"1024x1792"}')" 'example.com/mock.png'
# 生图模型标记持久化(供应商保存 image:true 后能读回)
assert_has "供应商模型生图标记可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"id":"mock-image","name":"Mock Image","image":true'
# 生图多密钥回退:第一把坏 Key(401)→ 应自动换第二把好 Key 出图成功
cat > "$TMP/imgkey.json" <<EOF
{"name":"ImgKeyProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏","apiKey":"sk-fail"},{"id":"k2","name":"好","apiKey":"sk-good"}],
 "models":[{"id":"mock-image","name":"Img","image":true,"keyIds":["k1"]}]}
EOF
imgkey=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/imgkey.json")
IMGKEYPROV=$(printf '%s' "$imgkey" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
assert_contains "生图多密钥: 第一把失败自动回退第二把" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$IMGKEYPROV"'","model":"mock-image","prompt":"x"}')" 'example.com/mock.png'
# 模型级单价:保存后能读回,并在 /api/proxy/models 的 costs 映射中体现
cat > "$TMP/prov-cost.json" <<EOF
{"name":"CostProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-cost","apiFormat":"chat","models":[{"id":"mock-model","name":"Mock","cost":3},{"id":"mock-cheap","name":"Cheap"}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-cost.json" > /dev/null
COSTPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"CostProv"' | cut -d'"' -f4)
assert_has "模型级单价可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"id":"mock-model","name":"Mock","cost":3'
assert_contains "模型单价下发到前端" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"mock-model":3'
assert_contains "未设单价的模型回退供应商价" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"mock-cheap":1'
assert_contains "可用性阈值下发前端" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"healthOkMin"'
# 开放接口 /v1/images/generations
IMGKEY=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"img"}' | jget secret)
assert_contains "/v1/images/generations 返回图片" "$(curl -s -X POST "$BASE/v1/images/generations" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-image","prompt":"a corgi","size":"1024x1024","n":1}')" 'example.com/mock.png'

# ---------- 生图模型自动路由 ----------
say "== 生图模型自动路由 =="
# 用生图模型调对话接口:应自动改走 images/generations 并返回图片(而不是上游的 "is an image model" 报错)
assert_contains "对话接口自动改走生图" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","messages":[{"role":"user","content":"draw a corgi"}]}')" 'example.com/mock.png'
assert_contains "开放接口自动改走生图" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-image","messages":[{"role":"user","content":"draw"}]}')" 'example.com/mock.png'
# 对话式出图模型:生图路径不支持时自动回退到 chat/completions 并从回复里提取图片
assert_contains "对话式生图自动回退" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-chat-image","prompt":"draw a cat"}')" 'example.com/mock-chat.png'
# 开放接口同样受益于兜底
assert_contains "开放接口对话式生图兜底" "$(curl -s -X POST "$BASE/v1/images/generations" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-chat-image","prompt":"draw a cat"}')" 'example.com/mock-chat.png'

# 图生图/改图:带 image 数组时应返回改后的图
assert_contains "图生图(带参考图)返回结果" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"make it red","images":["https://example.com/ref.png"]}')" 'example.com/mock-edited.png'

# 普通文本模型仍走对话,不受影响
assert_contains "文本模型仍走对话" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-model","messages":[{"role":"user","content":"hi"}]}')" 'MOCK-REPLY'
# Base URL 不带 /v1(平台文档常见写法,如 Agnes):生图应自动补 /v1,不能拼成 /images/generations(会 404)
cat > "$TMP/prov-nov1.json" <<EOF
{"name":"NoV1","baseUrl":"http://127.0.0.1:$MOCK_PORT","apiKey":"sk-nov1","apiFormat":"chat","models":[{"id":"mock-image","name":"Mock Image","image":true}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-nov1.json" > /dev/null
NOV1=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"NoV1"' | cut -d'"' -f4)
[ -n "$NOV1" ] && ok "创建无 /v1 供应商" || bad "创建无 /v1 供应商"
assert_contains "Base URL 不带 /v1 也能生图" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d "{\"providerId\":\"$NOV1\",\"model\":\"mock-image\",\"prompt\":\"x\",\"size\":\"2K\",\"ratio\":\"16:9\"}")" 'example.com/mock.png'

# ---------- 视频生成 ----------
say "== 视频生成 =="
cat > "$TMP/prov-video.json" <<EOF
{"name":"MockVideo","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-vid","apiFormat":"video","models":[{"id":"mock-video","name":"Mock Video"}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-video.json" > /dev/null
VIDPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"MockVideo"' | cut -d'"' -f4)
[ -n "$VIDPROV" ] && ok "创建视频供应商" || bad "创建视频供应商"
# 供应商接口格式 video 应能保存并读回
assert_has "视频供应商接口格式可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"apiFormat":"video"'
# 文字生成视频:应返回视频地址 + 同源代理地址
vidresp=$(curl -s -X POST "$BASE/api/proxy/videos" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$VIDPROV"'","model":"mock-video","prompt":"a rainy city street","mode":"text","seconds":5,"aspect_ratio":"16:9"}')
assert_contains "视频生成返回 URL" "$vidresp" 'example.com/generated/mock-video.mp4'
assert_contains "视频结果附同源代理地址" "$vidresp" '/api/proxy/video?u='
# 视频代理:签名校验(错误签名 403)
assert_contains "视频代理拒绝无效签名" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/proxy/video?u=https%3A%2F%2Fexample.com%2Fx.mp4&s=bad")" '403'
# 对话接口自动改走视频(视频模型按名命中时)
assert_contains "对话接口自动改走生视频" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$VIDPROV"'","model":"mock-video","messages":[{"role":"user","content":"draw"}]}')" 'example.com/generated/mock-video.mp4'

# ---------- 获取模型列表 ----------
say "== 多密钥供应商 =="
cat > "$TMP/mk.json" <<EOF
{"name":"MultiKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-legacy","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"ka","name":"主号","apiKey":"sk-key-a"},{"id":"kb","name":"副号","apiKey":"sk-key-b"}],
 "models":[{"id":"mock-model","name":"Mock","keyId":"ka"},{"id":"mock-image","name":"Mock Image","keyId":"kb","image":true}]}
EOF
mk=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mk.json")
assert_contains "创建多密钥供应商" "$mk" '"name":"主号"'
assert_contains "密钥二存在" "$mk" '"name":"副号"'
assert_contains "模型绑定密钥" "$mk" '"keyId":"ka"'
MKPROV=$(printf '%s' "$mk" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
# 密钥重名应被拒
cat > "$TMP/mkdup.json" <<EOF
{"name":"DupKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"k1","name":"同名","apiKey":"sk-1"},{"id":"k2","name":"同名","apiKey":"sk-2"}],
 "models":[{"id":"mock-model","name":"M"}]}
EOF
assert_contains "密钥重名被拒" "$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkdup.json")" 'Key 名称不能重复'
# 多密钥未命名应被拒
cat > "$TMP/mknn.json" <<EOF
{"name":"NoName","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"k1","name":"","apiKey":"sk-1"},{"id":"k2","name":"B","apiKey":"sk-2"}],
 "models":[{"id":"mock-model","name":"M"}]}
EOF
assert_contains "多密钥未命名被拒" "$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mknn.json")" '每个 Key 都需要填写名称'
# 模拟「编辑时不动密钥、直接保存」:keys 里 apiKey 为空,应沿用原密文
cat > "$TMP/mkupd.json" <<EOF
{"name":"MultiKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,"keyRevealable":true,"keys":[{"id":"ka","name":"主号改名","apiKey":""},{"id":"kb","name":"副号","apiKey":""}],"models":[{"id":"mock-model","name":"Mock","keyId":"ka"}]}
EOF
curl -s -X POST "$BASE/api/admin/providers/$MKPROV" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkupd.json" > /dev/null
assert_contains "未改动密钥保存后仍在" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"name":"主号改名"'
# 按 keyId 取回明文(勾选了「保存后保持显示」)
assert_contains "按 keyId 取回第一把" "$(curl -s -X POST "$BASE/api/providers/$MKPROV/key?keyId=ka" -H "$AUTH")" 'sk-key-a'
assert_contains "按 keyId 取回第二把" "$(curl -s -X POST "$BASE/api/providers/$MKPROV/key?keyId=kb" -H "$AUTH")" 'sk-key-b'
# 模型绑定的 keyId 必须存在:传一个不存在的 keyId 应被清掉(不报错)
cat > "$TMP/mkbadkey.json" <<EOF
{"name":"BadKeyRef","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"ka","name":"A","apiKey":"sk-a"}],
 "models":[{"id":"mock-model","name":"M","keyId":"nope"}]}
EOF
bk=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkbadkey.json")
if printf '%s' "$bk" | grep -q '"keyId"'; then bad "无效 keyId 应被清除"; else ok "无效 keyId 被清除"; fi

# 同一模型绑定多把密钥(优先级链):keyIds 应原样保存,keyId 取第一把
cat > "$TMP/mkchain.json" <<EOF
{"name":"ChainProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"Chained","keyIds":["k1","k2"]}]}
EOF
chain=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkchain.json")
assert_has "模型密钥链保存" "$chain" '"keyIds":["k1","k2"]'
assert_contains "模型密钥链首把 keyId" "$chain" '"keyId":"k1"'
CHAINPROV=$(printf '%s' "$chain" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
# 上游对第一把返回 401:应自动回退到第二把,请求仍然成功
cat > "$TMP/chain-chat.json" <<EOF
{"model":"mock-model","providerId":"$CHAINPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "密钥链认证失败自动回退下一把" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chain-chat.json")" 'MOCK-REPLY'

# 关键场景:供应商配了两把 Key,但模型只绑了第一把(坏号)→ 也应自动回退到供应商的另一把好号
cat > "$TMP/mkone.json" <<EOF
{"name":"OneBindProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"OneBound","keyIds":["k1"]}]}
EOF
onebind=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkone.json")
ONEBINDPROV=$(printf '%s' "$onebind" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
cat > "$TMP/onebind-chat.json" <<EOF
{"model":"mock-model","providerId":"$ONEBINDPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "模型只绑一把时也回退到供应商其余 Key" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/onebind-chat.json")" 'MOCK-REPLY'
# 模型完全未绑定 Key(仅有供应商多把)时,同样应有回退保障
cat > "$TMP/mknone.json" <<EOF
{"name":"NoBindProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"NoBound"}]}
EOF
nobind=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mknone.json")
NOBINDPROV=$(printf '%s' "$nobind" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
cat > "$TMP/nobind-chat.json" <<EOF
{"model":"mock-model","providerId":"$NOBINDPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "模型未绑定时也回退到供应商其余 Key" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/nobind-chat.json")" 'MOCK-REPLY'

# ---------- 供应商排序 ----------
say "== 供应商排序 =="
# 建两个供应商,把后建的排到前面,验证列表顺序随 order 变化
for nm in OrderA OrderB; do
  cat > "$TMP/ord-$nm.json" <<EOF
{"name":"$nm","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-ord","apiFormat":"chat","scope":"global","models":[{"id":"mock-model","name":"M"}],"costPerCall":1}
EOF
  curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/ord-$nm.json" > /dev/null
done
OA=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([p['id'] for p in d['providers'] if p['name']=='OrderA'][0])")
OB=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([p['id'] for p in d['providers'] if p['name']=='OrderB'][0])")
# 把 OrderB 排到 OrderA 前面
curl -s -X POST "$BASE/api/admin/providers/$OB" -H "$AUTH" -H "Content-Type: application/json" -d '{"action":"reorder","order":["'"$OB"'","'"$OA"'"]}' > /dev/null
ord=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);ids=[p['id'] for p in d['providers']];print(ids.index('$OB')<ids.index('$OA'))")
assert_eq "供应商排序: OrderB 排在 OrderA 之前" "$ord" "True"
assert_contains "供应商列表下发 order 字段" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"order"'

# ---------- 运行日志:提示词/回复/用量 ----------
say "== 运行日志细节 =="
cat > "$TMP/log-chat.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":false,"messages":[{"role":"user","content":"记录一下我的日志提示词"}]}
EOF
curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/log-chat.json" > /dev/null
logs=$(curl -s "$BASE/api/admin/logs?limit=20" -H "$AUTH")
assert_contains "日志记录提示词" "$logs" '记录一下我的日志提示词'
assert_contains "日志记录模型回复" "$logs" 'MOCK-REPLY'
assert_contains "日志记录 token 用量" "$logs" '"usage"'
assert_contains "日志记录来源 IP" "$logs" '"ip"'

# ---------- 后台查看对话:完整不截断 ----------
say "== 后台查看对话完整显示 =="
# 正文超过旧上限(2000 字),末尾埋一个标记:只有不截断才能读到
LONGTXT=$(python -c "print('填充正文' * 700 + 'TAILMARKER-完整尾部')")
CHATUID=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([u['id'] for u in d['users'] if u['name']=='tester1'][0])")
cat > "$TMP/long-chat.json" <<EOF
{"chats":[{"id":"longchat1","title":"长文本对话","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"$LONGTXT","reasoning":"先想一下再回答"}]}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/long-chat.json" > /dev/null
chatsresp=$(curl -s "$BASE/api/admin/users/chats?userId=$CHATUID" -H "$AUTH")
assert_contains "后台对话: 长正文未被截断(读到尾部标记)" "$chatsresp" 'TAILMARKER-完整尾部'
assert_contains "后台对话: 带出思维链" "$chatsresp" '先想一下再回答'

# ---------- 云同步软删除: A 删 B 也删, 云端留档, 管理员可查可清 ----------
say "== 云同步软删除与留档 =="
cat > "$TMP/sd1.json" <<EOF
{"chats":[{"id":"sd-keep","title":"保留的对话","messages":[{"role":"user","content":"保留"}],"updatedAt":1791000000000},{"id":"sd-gone","title":"待删的对话","messages":[{"role":"user","content":"删除标记"}],"updatedAt":1791000000001}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/sd1.json" > /dev/null
assert_contains "软删除前两段对话都在" "$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")" '"sd-gone"'
# 设备 A 删除 sd-gone:带 deletedIds + 副本(deletedChats)
cat > "$TMP/sd2.json" <<EOF
{"chats":[{"id":"sd-keep","title":"保留的对话","messages":[{"role":"user","content":"保留"}],"updatedAt":1791000000000}],"deletedIds":["sd-gone"],"deletedChats":[{"id":"sd-gone","title":"待删的对话","messages":[{"role":"user","content":"删除标记"}],"updatedAt":1791000000002}]}
EOF
SDRESP=$(curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/sd2.json")
assert_contains "删除推送返回墓碑集合" "$SDRESP" '"deletedIds"'
# 精确检查活跃列表(整段 grep 会把 deletedIds 里的墓碑键也匹配上)
check_live() { # $1=响应 $2=id $3=want(present/absent)
  printf '%s' "$1" | python -c "
import sys,json
d=json.load(sys.stdin)
ids=[c.get('id') for c in d.get('chats',[])]
want=sys.argv[1]=='present'
got=('$2' in ids)
print('OK' if got==want else ('FAIL ids=%s' % ids))
" "$3"
}
GETA=$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")
assert_eq "删除后云端列表不再下发 sd-gone" "$(check_live "$GETA" sd-gone absent)" "OK"
assert_eq "删除后 sd-keep 仍在活跃列表" "$(check_live "$GETA" sd-keep present)" "OK"
assert_contains "删除后云端下发墓碑(A 删 B 也删)" "$GETA" '"sd-gone"'
# 设备 B 拿着旧列表回推(deletedIds 没带):墓碑必须挡住复活,内容进留档
cat > "$TMP/sd3.json" <<EOF
{"chats":[{"id":"sd-keep","title":"保留的对话","messages":[{"role":"user","content":"保留"}],"updatedAt":1791000000000},{"id":"sd-gone","title":"待删的对话","messages":[{"role":"user","content":"旧设备回推"}],"updatedAt":1791000000009}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/sd3.json" > /dev/null
GETB=$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")
assert_eq "墓碑挡住旧设备回推,不复活" "$(check_live "$GETB" sd-gone absent)" "OK"
DELRESP=$(curl -s "$BASE/api/admin/chats/deleted" -H "$AUTH")
assert_contains "后台留档列表含已删对话" "$DELRESP" '待删的对话'
assert_contains "后台留档带删除时间" "$DELRESP" '"deletedAt"'
assert_contains "存续管理汇总含留档统计" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" '"deleted"'
VIEWRESP=$(curl -s "$BASE/api/admin/chats/deleted/view?userId=$CHATUID&chatId=sd-gone" -H "$AUTH")
assert_contains "后台可查看留档全文" "$VIEWRESP" '旧设备回推'
# 批量清理留档(保留墓碑):内容删除,删除依然对所有设备生效
assert_contains "批量清理留档成功" "$(curl -s -X POST "$BASE/api/admin/chats/deleted/purge" -H "$AUTH" -H "Content-Type: application/json" -d '{"items":[{"userId":"'"$CHATUID"'","chatId":"sd-gone"}]}')" '"removed":1'
check_archived() { # $1=响应 $2=id $3=want(present/absent)
  printf '%s' "$1" | python -c "
import sys,json
d=json.load(sys.stdin)
ids=[x.get('chatId') for x in d.get('items',[])]
want=sys.argv[1]=='present'
got=('$2' in ids)
print('OK' if got==want else ('FAIL ids=%s' % ids))
" "$3"
}
assert_eq "清理后留档列表不再含 sd-gone" "$(check_archived "$(curl -s "$BASE/api/admin/chats/deleted?userId=$CHATUID" -H "$AUTH")" sd-gone absent)" "OK"
assert_eq "清理留档不影响删除(墓碑仍在,不复活)" "$(check_live "$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")" sd-gone absent)" "OK"
# 清空全部留档(带墓碑):彻底清除
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/sd1.json" > /dev/null
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" -d '{"chats":[],"deletedIds":["sd-keep","sd-gone"]}' > /dev/null
assert_contains "清空全部留档(带墓碑)成功" "$(curl -s -X POST "$BASE/api/admin/chats/deleted/purge" -H "$AUTH" -H "Content-Type: application/json" -d '{"all":true,"withTombstones":true}')" '"ok":true'
GETC=$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")
assert_eq "清空留档带墓碑后活跃列表无 sd-keep" "$(check_live "$GETC" sd-keep absent)" "OK"
assert_eq "清空留档带墓碑后墓碑也清空" "$(printf '%s' "$GETC" | python -c "import sys,json;print(len(json.load(sys.stdin).get('deletedIds',{})))")" "0"

say "== 获取模型列表 ==" 
# Git Bash 的 curl 会搅乱 UTF-8 字面量,掩码占位符用字节转义构造,确保后端收到真实的 ••••
MASKEDKEY=$'sk-\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2'
assert_contains "获取模型: 标准 Base URL" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
assert_contains "获取模型: 不带 /v1 自动补全" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
assert_contains "获取模型: 粘贴完整 /v1/models 不重复拼接" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1/models","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
# 真实场景是「管理员编辑全局供应商」:掩码 Key + 属主/管理员身份才回退存储密钥;
# 普通用户传全局 providerId 不会回退(否则可借用站点密钥拉取上游模型),由下一条用例保证。
printf '{"baseUrl":"http://127.0.0.1:%s/v1","apiKey":"%s","providerId":"%s","apiFormat":"chat"}' "$MOCK_PORT" "$MASKEDKEY" "$PROV" > "$TMP/masked.json"
assert_contains "获取模型: 掩码 Key 回退存储密钥(管理员)" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/masked.json")" 'mock-model'
assert_contains "获取模型: Anthropic 明确提示手填" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"https://api.anthropic.com","apiKey":"x","apiFormat":"anthropic"}')" '手动填写'
assert_contains "获取模型: 缺 Key 且无 providerId 拒绝" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1","apiKey":"","apiFormat":"chat"}')" '请先填写 API Key'
printf '{"baseUrl":"http://127.0.0.1:%s/v1","apiKey":"%s","providerId":"not-exist","apiFormat":"chat"}' "$MOCK_PORT" "$MASKEDKEY" > "$TMP/masked2.json"
assert_contains "获取模型: 掩码 Key 无匹配 providerId 快速失败" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/masked2.json")" '沿用已保存的密钥'
assert_contains "获取模型: 不可达主机可定位" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:9/nope/v1","apiKey":"x","apiFormat":"chat"}')" '无法连接上游'

# ---------- 接口限流(tester2 全新窗口:3 次/分钟) ----------
say "== 接口限流 =="
cat > "$TMP/reg3.json" <<EOF
{"name":"tester2","password":"pass1234","invite":"$INV2","agreementAccepted":true}
EOF
T2TOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg3.json" | jget token)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"rateLimitPerMin":3}' > /dev/null
c1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c4=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
assert_eq "限流: 前 3 次放行" "$c1/$c2/$c3" "200/200/200"
assert_eq "限流: 第 4 次 429" "$c4" "429"

# ---------- 开放 API:每密钥限流与对外模型白名单 ----------
say "== 开放 API 限制 =="
assert_contains "密钥接口返回限制信息" "$(curl -s "$BASE/api/me/apikeys" -H "$UAUTH")" '"keyRateLimitPerMin"'
# 先把账号级限流放宽,避免上一节残留的 3 次/分钟窗口干扰"每密钥限流"断言
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiKeyRateLimitPerMin":2,"rateLimitPerMin":600,"apiExposedModels":[]}' > /dev/null
KEY2=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"rl"}' | jget secret)
k1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
k2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
k3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
assert_eq "每密钥限流: 前 2 次放行" "$k1/$k2" "200/200"
assert_eq "每密钥限流: 第 3 次 429" "$k3" "429"
# 白名单只开放 mock-model,则 /v1/models 只出现它
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"apiExposedModels\":[\"$PROV|mock-model\"],\"apiKeyRateLimitPerMin\":0}" > /dev/null
assert_contains "白名单内模型可见" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" 'mock-model'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"apiExposedModels\":[\"$PROV|not-exist\"]}" > /dev/null
assert_has "白名单外模型不可见" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" '"data":[]'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":[]}' > /dev/null
# 白名单归一化:裸模型 id 唯一命中时自动转成「供应商ID|模型ID」;
# 同名歧义或不存在的模型必须明确报 400,不能静默丢弃(否则白名单悄悄失效)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["mock-cheap"]}' > /dev/null
assert_has "裸模型 id 自动解析为供应商规则" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" "\"$COSTPROV|mock-cheap\""
assert_contains "解析后的白名单对 /v1 生效" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" 'mock-cheap'
assert_contains "同名模型裸 id 明确报错" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["mock-model"]}')" '无法唯一匹配'
assert_contains "不存在的模型也明确报错" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["no-such-model"]}')" '无法唯一匹配'
# 报错时原白名单不被破坏
assert_has "报错后白名单保持原值" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" "\"$COSTPROV|mock-cheap\""
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":[]}' > /dev/null

# ---------- 演示管理员 ----------
say "== 演示管理员 =="
dm=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoadmin","password":"demo1234","demo":true}')
assert_contains "创建演示管理员" "$dm" '"demo":true'
DTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"demoadmin","password":"demo1234"}' | jget token)
DAUTH="Authorization: Bearer $DTOKEN"
assert_contains "演示管理员可保存设置" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"siteName":"DemoSite"}')" '"siteName":"DemoSite"'
assert_contains "演示管理员不可改密码" "$(curl -s -X POST "$BASE/api/auth/password" -H "$DAUTH" -H "Content-Type: application/json" -d '{"oldPassword":"demo1234","newPassword":"other1234"}')" '演示账号不允许修改密码'
assert_contains "演示管理员不可强制下线" "$(curl -s -X POST "$BASE/api/admin/session/invalidate" -H "$DAUTH")" '演示账号不能强制全站下线'
assert_contains "演示管理员不可删用户" "$(curl -s -X DELETE "$BASE/api/admin/users/$GID1" -H "$DAUTH")" '演示账号不能删除用户'
assert_contains "演示管理员不可改公告" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"announcement":{"enabled":true,"text":"x"}}')" '演示管理员不能修改公告'
assert_contains "演示管理员不可改协议" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"agreementHtml":"<script>alert(1)</script>"}')" '演示管理员不能修改用户协议'
assert_contains "演示管理员不可查看用户对话" "$(curl -s "$BASE/api/admin/users/chats" -H "$DAUTH")" '演示管理员不能查看用户对话'
assert_contains "演示管理员不可创建用户" "$(curl -s -X POST "$BASE/api/admin/users" -H "$DAUTH" -H "Content-Type: application/json" -d '{"name":"zzz","password":"pass1234"}')" '演示管理员不能管理用户账号'
# 新增的「在线聊天 / AI 笔记」管理端同样属于用户私人内容,演示管理员一律拒绝。
# 尤其留档清理(imDeleted)不在演示快照范围内,一旦放行就无法随演示到期还原。
assert_contains "演示管理员不可查看聊天会话列表" "$(curl -s "$BASE/api/admin/im/threads" -H "$DAUTH")" '演示管理员不可查看用户聊天'
assert_contains "演示管理员不可查看聊天原文" "$(curl -s "$BASE/api/admin/im/view?thread=x" -H "$DAUTH")" '演示管理员不可查看用户聊天'
assert_contains "演示管理员不可清理聊天留档" "$(curl -s -X POST "$BASE/api/admin/im/purge" -H "$DAUTH" -H "Content-Type: application/json" -d '{"threadIds":["x"]}')" '演示管理员不能清理用户聊天留档'
assert_contains "演示管理员不可查看用户笔记" "$(curl -s "$BASE/api/admin/notes" -H "$DAUTH")" '演示管理员不可查看用户笔记'
# 真实管理员不受影响(否则就是拦过头了)
assert_has "真实管理员可列出聊天会话" "$(curl -s "$BASE/api/admin/im/threads" -H "$AUTH")" '"threads":'
assert_has "真实管理员可列出笔记用户" "$(curl -s "$BASE/api/admin/notes" -H "$AUTH")" '"users":'
# 真实管理员的改动成为演示的还原基准(不会被演示到期还原冲掉)
snap_site() { # 读 demoSnapshot 里的基准 siteName
  php -r '$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
    $v = $pdo->query("SELECT v FROM store WHERE k = \"demoSnapshot\"")->fetchColumn();
    $j = json_decode($v, true);
    echo isset($j["settings"]["siteName"]) ? $j["settings"]["siteName"] : "";' "$1"
}
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"siteName":"REALBASE"}' > /dev/null
assert_eq "真实管理员改动写入演示基准" "$(snap_site "$TMP/data")" "REALBASE"
# 演示管理员改动不写入基准
curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"siteName":"DEMOTMP"}' > /dev/null
assert_eq "演示管理员改动不污染基准" "$(snap_site "$TMP/data")" "REALBASE"
assert_contains "config 暴露 demoMode" "$(curl -s "$BASE/api/config")" '"demoMode":true'
# 演示管理员的隐私边界:登录 IP / 邮箱 / 密钥 / 备份 / 日志内容 / 第三方绑定 一律不可见
DEMOUSERS=$(curl -s "$BASE/api/admin/users" -H "$DAUTH")
assert_contains "演示管理员看不到用户登录 IP" "$DEMOUSERS" '"lastIp":""'
assert_contains "演示管理员看不到用户邮箱" "$DEMOUSERS" '"email":""'
# 真实管理员仍应看到 IP(否则这次修复就过头了)
assert_contains "真实管理员仍可见用户 IP" "$(curl -s "$BASE/api/admin/users" -H "$AUTH")" '"lastIp":"127.0.0.1"'
# 供应商密钥:演示管理员连掩码都不下发
DEMOPROV=$(curl -s "$BASE/api/providers" -H "$DAUTH")
assert_contains "演示管理员看不到供应商密钥掩码" "$DEMOPROV" '"apiKey":""'
assert_has "演示管理员看不到多密钥列表" "$DEMOPROV" '"keys":[]'
assert_contains "演示管理员不可查看明文密钥" "$(curl -s -X POST "$BASE/api/providers/$PROV/key" -H "$DAUTH")" '演示管理员不可查看供应商密钥'
assert_contains "演示管理员不可删除供应商" "$(curl -s -X DELETE "$BASE/api/admin/providers/$PROV" -H "$DAUTH")" '演示管理员不能删除供应商'
# SMTP 凭据:演示管理员整段不可见(SMTP 密码可用于冒用站点域名发信),也不可写入或取回明文
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"smtpKeyRevealable":true,"smtp":{"host":"smtp.e2e.local","port":465,"username":"ops@e2e.local","password":"E2eSmtpSecret","encryption":"ssl","fromEmail":"ops@e2e.local"}}' > /dev/null
DEMOSET=$(curl -s "$BASE/api/admin/settings" -H "$DAUTH")
assert_has "演示管理员看不到 SMTP 主机" "$DEMOSET" '"host":""'
assert_has "演示管理员看不到 SMTP 密码" "$DEMOSET" '"password":""'
assert_has "演示管理员看不到 SMTP 用户名" "$DEMOSET" '"username":""'
assert_has "演示管理员收到 SMTP 受限标记" "$DEMOSET" '"smtpRestricted":true'
assert_contains "演示管理员不可写入 SMTP 配置" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"smtp":{"host":"evil.local","port":25,"username":"x","password":"pwn","encryption":"none","fromEmail":"x@evil.local"}}')" '演示管理员不能修改邮件(SMTP)配置'
assert_contains "演示管理员不可取回 SMTP 明文密码" "$(curl -s -X POST "$BASE/api/admin/settings/smtp-reveal" -H "$DAUTH")" '演示管理员不可查看邮件(SMTP)密码'
# 真实管理员:勾选「保持显示」后自己可读可复制,取消勾选则只给掩码且拒绝取回
assert_has "勾选保持显示后下发 SMTP 明文" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"password":"E2eSmtpSecret"'
assert_has "真实管理员可取回 SMTP 明文" "$(curl -s -X POST "$BASE/api/admin/settings/smtp-reveal" -H "$AUTH")" '"password":"E2eSmtpSecret"'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"smtpKeyRevealable":false,"smtp":{"host":"smtp.e2e.local","port":465,"username":"ops@e2e.local","encryption":"ssl","fromEmail":"ops@e2e.local"}}' > /dev/null
# 掩码含多字节字符(••),用「含掩码且不含明文」判定,避开 grep 的 locale 差异
MASKED=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
if printf '%s' "$MASKED" | grep -qF '"password":"E2eS' && ! printf '%s' "$MASKED" | grep -qF 'E2eSmtpSecret'; then ok "未勾选时仅下发掩码(不含明文)"; else bad "未勾选时仍可能下发明文: $(printf '%s' "$MASKED" | head -c 120)"; fi
assert_contains "未勾选时拒绝取回明文" "$(curl -s -X POST "$BASE/api/admin/settings/smtp-reveal" -H "$AUTH")" '保存时未勾选'
# 管理员账号不可走邮箱自助改密(邮箱被接管等于交出后台)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"passwordResetEnabled":true}' > /dev/null
php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("users")); $us=json_decode($q->fetchColumn(),true); foreach($us as &$u) if(($u["name"]??"")==="admin") $u["email"]="admin@e2e.local"; unset($u); $up=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $up->execute(array(json_encode($us),"users"));' "$TMP/data"
assert_contains "管理员账号拒绝邮箱重置" "$(curl -s -X POST "$BASE/api/auth/forgot-password" -H "Content-Type: application/json" -d '{"email":"admin@e2e.local"}')" '管理员账号不支持通过邮箱重置密码'
# 普通用户仍可走该流程(否则就是拦过头了)
php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("users")); $us=json_decode($q->fetchColumn(),true); $first=""; foreach($us as &$u) if(empty($u["admin"]) && empty($u["guest"]) && ($u["email"]??"")===""){ $u["email"]="member@e2e.local"; $first=$u["name"]; break; } unset($u); $up=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $up->execute(array(json_encode($us),"users")); echo $first;' "$TMP/data" > /dev/null
if printf '%s' "$(curl -s -X POST "$BASE/api/auth/forgot-password" -H "Content-Type: application/json" -d '{"email":"member@e2e.local"}')" | grep -q '管理员账号'; then bad "普通用户被误判为管理员"; else ok "普通用户仍可走邮箱重置"; fi
# 备份是整库快照(含密码哈希/对话/密钥),演示管理员完全不可接触
assert_contains "演示管理员不可列出备份" "$(curl -s "$BASE/api/admin/backup" -H "$DAUTH")" '演示管理员不可下载或管理数据备份'
assert_contains "演示管理员不可下载备份" "$(curl -s "$BASE/api/admin/backup/download?id=x" -H "$DAUTH")" '演示管理员不可下载或管理数据备份'
assert_contains "演示管理员不可恢复备份" "$(curl -s -X POST "$BASE/api/admin/backup/restore" -H "$DAUTH" -H "Content-Type: application/json" -d '{"id":"x"}')" '演示管理员不可下载或管理数据备份'
# 日志:IP/用户名/对话正文都要剔除(日志里能读到提示词=绕过「不可查看用户对话」)
DEMOLOG=$(curl -s "$BASE/api/admin/logs?limit=20" -H "$DAUTH")
if printf '%s' "$DEMOLOG" | grep -qF '"ip"'; then bad "演示管理员日志里仍有 IP"; else ok "演示管理员日志不含 IP"; fi
if printf '%s' "$DEMOLOG" | grep -qF '"prompt":"'; then bad "演示管理员日志里仍有对话正文"; else ok "演示管理员日志不含对话正文"; fi
if printf '%s' "$DEMOLOG" | grep -qF '"reply":"'; then bad "演示管理员日志里仍有模型回复"; else ok "演示管理员日志不含模型回复"; fi
if printf '%s' "$DEMOLOG" | grep -qF '"userName"'; then bad "演示管理员日志里仍有用户名"; else ok "演示管理员日志不含用户名"; fi
assert_contains "真实管理员日志仍含 IP" "$(curl -s "$BASE/api/admin/logs?limit=1" -H "$AUTH")" '"ip":'

# ---------- 邮件发送:失败原因必须可读且响应体合法 ----------
say "== 邮件发送报错 =="
# 正常投递(经 mock SMTP)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"smtp\":{\"host\":\"127.0.0.1\",\"port\":$SMTP_PORT,\"username\":\"ops@e2e.local\",\"password\":\"pw\",\"encryption\":\"none\",\"fromEmail\":\"ops@e2e.local\"}}" > /dev/null
assert_contains "测试邮件发送成功" "$(curl -s -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')" '"ok":true'
# 端口不通:状态码必须是网关不会替换的 4xx,且带上目标地址与排查方向
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"smtp":{"host":"127.0.0.1","port":2599,"username":"ops@e2e.local","password":"pw","encryption":"none","fromEmail":"ops@e2e.local"}}' > /dev/null
CONN_CODE=$(curl -s -o "$TMP/mail1.json" -w '%{http_code}' -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')
assert_eq "连接失败返回 4xx(网关不劫持)" "$CONN_CODE" "400"
assert_has "连接失败给出目标地址与端口建议" "$(cat "$TMP/mail1.json")" 'SSL→465'
# 关键回归:中文服务商用 GBK 回错误文本时,响应体仍必须是合法 JSON(此前会变成空体 → 前端只看到 502)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"smtp\":{\"host\":\"127.0.0.1\",\"port\":$SMTP_GBK_PORT,\"username\":\"ops@e2e.local\",\"password\":\"pw\",\"encryption\":\"none\",\"fromEmail\":\"ops@e2e.local\"}}" > /dev/null
GBK_CODE=$(curl -s -o "$TMP/mail2.json" -w '%{http_code}' -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')
assert_eq "GBK 错误文本仍返回 4xx" "$GBK_CODE" "400"
# 端口被防火墙/主机商静默丢包(TEST-NET 地址不会回应):必须明确指向「出站被屏蔽」并给建议,
# 这是虚拟主机上最常见的一类失败,不能只丢一句「连接失败」
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"smtp":{"host":"192.0.2.1","port":587,"username":"ops@e2e.local","password":"pw","encryption":"tls","fromEmail":"ops@e2e.local"}}' > /dev/null
BLOCKED_CODE=$(curl -s -o "$TMP/mail3.json" -w '%{http_code}' -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')
assert_eq "端口无响应返回 4xx" "$BLOCKED_CODE" "400"
assert_has "端口无响应识别为出站被屏蔽" "$(cat "$TMP/mail3.json")" '主机商屏蔽了出站 SMTP'
assert_has "端口无响应给出换端口建议" "$(cat "$TMP/mail3.json")" '换端口'
# Google 应用专用密码在页面上是「abcd efgh ijkl mnop」带空格的形式:
# 用户整段复制时,密码必须被自动去掉空格后才能通过认证
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"smtpKeyRevealable\":true,\"smtp\":{\"host\":\"127.0.0.1\",\"port\":$SMTP_REQ_PORT,\"username\":\"ops@gmail.com\",\"password\":\"abcd efgh ijkl mnop\",\"encryption\":\"none\",\"fromEmail\":\"ops@gmail.com\"}}" > /dev/null
assert_has "带空格的应用专用密码被归一化为 16 位" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"password":"abcdefghijklmnop"'
assert_contains "带空格的应用专用密码可正常发信" "$(curl -s -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')" '"ok":true'
# 认证被拒时给出服务商专属排查清单(含「多账号 / u/2」这类真实陷阱)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"smtp\":{\"host\":\"127.0.0.1\",\"port\":$SMTP_GMAIL_PORT,\"username\":\"ops@gmail.com\",\"password\":\"WrongPassword123\",\"encryption\":\"none\",\"fromEmail\":\"ops@gmail.com\"}}" > /dev/null
GMAIL_MSG=$(curl -s -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')
assert_has "Gmail 认证失败给出专属核对清单" "$GMAIL_MSG" '应用专用密码'
assert_has "Gmail 提示包含多账号陷阱" "$GMAIL_MSG" 'u/2'
assert_has "认证失败回显本次登录账号" "$GMAIL_MSG" '本次用于登录的账号'
# 有用户名但无密码:提前给可读原因,而不是让服务端回英文 535。
# 注意:保存时空密码会被「保留原值」保护,所以这里直接清库里的密码来构造该场景。
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"smtp":{"host":"127.0.0.1","port":8105,"username":"ops@e2e.local","encryption":"none","fromEmail":"ops@e2e.local"}}' > /dev/null
php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("settings")); $s=json_decode($q->fetchColumn(),true); $s["smtp"]["password"]=""; $up=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $up->execute(array(json_encode($s),"settings"));' "$TMP/data"
assert_has "用户名有值但密码为空给出明确提示" "$(curl -s -X POST "$BASE/api/admin/settings/test-email" -H "$AUTH" -H "Content-Type: application/json" -d '{"to":"t@e2e.local"}')" '密码为空'  
GBK_JSON=$(cat "$TMP/mail2.json")
assert_has "GBK 错误文本响应体仍是合法 JSON" "$GBK_JSON" '"error"'
assert_has "GBK 原文被转成可读中文" "$GBK_JSON" '用户名或密码不正确'
assert_has "认证失败附带处理建议" "$GBK_JSON" '授权码' ;
# 用户第三方绑定属账号隐私
assert_contains "演示管理员不可查看用户第三方绑定" "$(curl -s "$BASE/api/admin/users/oauth?userId=$GID1" -H "$DAUTH")" '演示管理员不可查看用户的第三方绑定'
# 用量导出与用户维度排行
assert_contains "演示管理员不可导出用户用量" "$(curl -s "$BASE/api/admin/usage/export" -H "$DAUTH")" '演示管理员不可导出用户用量明细'
assert_has "演示管理员看到的额度排行已匿名" "$(curl -s "$BASE/api/admin/stats" -H "$DAUTH")" '"name":"用户 '
# 演示管理员保存供应商时必须保留既有密钥(接口不下发密钥,提交里 keys 为空也不能清空)
curl -s -X POST "$BASE/api/admin/providers/$PROV" -H "$DAUTH" -H "Content-Type: application/json" -d '{"name":"Demo Renamed","apiKey":"","keys":[]}' > /dev/null
assert_contains "演示改供应商后密钥仍在" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"hasKey":true'
curl -s -X POST "$BASE/api/admin/providers/$PROV" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"MockAI"}' > /dev/null

# 已有用户可随时转为/取消演示管理员(不限于创建时)
plain=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"plainadmin","password":"pass1234","admin":true}')
PLAINID=$(printf '%s' "$plain" | jget id)
assert_contains "普通管理员创建时非演示" "$plain" '"demo":false'
upd=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","demo":true,"demoMinutes":7}')
assert_contains "可把已有用户转为演示管理员" "$upd" '"demo":true'
assert_contains "转为演示后成为管理员" "$upd" '"admin":true'
assert_contains "转演示可设复原时长" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":7'
# 取消演示身份:快照与 demoMode 一并清零
undemo=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","demo":false}')
assert_contains "可取消演示身份" "$undemo" '"demo":false'
# 不允许把唯一的非演示管理员变为演示(会失去账号管理能力):
# 先把 plainadmin 降为普通成员,使 admin 成为唯一非演示管理员,再尝试转换。
curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","admin":false}' > /dev/null
ADMINID=$(python -c "
import json,urllib.request
req=urllib.request.Request('$BASE/api/admin/users', headers={'Authorization':'Bearer $TOKEN'})
d=json.load(urllib.request.urlopen(req))
print([u['id'] for u in d['users'] if u['name']=='admin'][0])
")
selfdemo=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$ADMINID"'","demo":true}')
assert_contains "不能把唯一普通管理员变为演示" "$selfdemo" '至少要保留一个非演示的管理员'
# 确认 admin 未被改动为演示
assert_contains "唯一管理员未被改坏" "$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"name":"admin"[^}]*')" '"demo":false'
# 演示管理员额度必须尊重填入值(此前会被强制写成 1e15)
dq=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoq","password":"demo1234","demo":true,"quota":9999,"demoMinutes":5}' | jget quota)
assert_eq "演示管理员额度按填入值" "$dq" "9999"
assert_contains "演示管理员可配复原时长" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":5'
# 演示管理员改动设置后应处于 demo 模式,且快照记录了改动前的 siteName
DEMOQTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"demoq","password":"demo1234"}' | jget token)
DQAUTH="Authorization: Bearer $DEMOQTOKEN"
curl -s -X POST "$BASE/api/admin/settings" -H "$DQAUTH" -H "Content-Type: application/json" -d '{"siteName":"DemoRenamed"}' > /dev/null
assert_contains "演示管理员改动后进入 demo 模式" "$(curl -s "$BASE/api/config")" '"demoMode":true'
# 还原逻辑的完整往返(拍摄/到期/反复还原)由 tests/demo-revert.php 覆盖,此处只做冒烟
assert_contains "演示模式提示时长可读" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":'

# ---------- 游客模式 ----------
say "== 游客模式 =="
assert_contains "游客默认关闭被拒" "$(curl -s -X POST "$BASE/api/auth/guest")" '游客体验已关闭'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"guestEnabled":true,"guestRounds":4}' > /dev/null
assert_contains "config 暴露游客开关" "$(curl -s "$BASE/api/config")" '"guestEnabled":true'
glog=$(curl -s -X POST "$BASE/api/auth/guest")
assert_contains "游客自动登录" "$glog" '"guest":true'
GTOKEN=$(printf '%s' "$glog" | jget token)
[ -n "$GTOKEN" ] && ok "游客获取令牌" || bad "游客获取令牌"
assert_contains "游客命名带前缀" "$glog" '"name":"游客'
assert_contains "游客按轮数发放额度" "$glog" '"quota":4'
GAUTH="Authorization: Bearer $GTOKEN"
# 游客可看到全局供应商,说明游客组默认授权生效
assert_contains "游客组可见全局模型" "$(curl -s "$BASE/api/providers" -H "$GAUTH")" 'Mock'
# 后台用户列表展示游客标记与 IP
assert_contains "用户列表含 IP 字段" "$(curl -s "$BASE/api/admin/users" -H "$AUTH")" '"lastIp":'
# 游客不能领取套餐额度 / 兑换码(否则可绕过体验轮数)
cat > "$TMP/pkg-free.json" <<'EOF'
{"name":"FreeTrial","quota":500,"price":0,"enabled":true,"limitPerUser":1}
EOF
FREEPKG=$(curl -s -X POST "$BASE/api/admin/packages" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/pkg-free.json" | jget id)
[ -n "$FREEPKG" ] && ok "创建 0 元套餐" || bad "创建 0 元套餐"
assert_contains "游客不能领取免费套餐" "$(curl -s -X POST "$BASE/api/packages/claim" -H "$GAUTH" -H "Content-Type: application/json" -d '{"packageId":"'"$FREEPKG"'"}')" '游客不能领取套餐'
assert_contains "游客不能兑换额度" "$(curl -s -X POST "$BASE/api/packages/redeem" -H "$GAUTH" -H "Content-Type: application/json" -d '{"code":"ANYCODE"}')" '游客不能兑换额度'
assert_contains "游客额度未被套餐改动" "$(curl -s "$BASE/api/auth/me" -H "$GAUTH")" '"quota":4'
# 一键清除游客:普通成员保留,游客及其对话一并删除
curl -s -X POST "$BASE/api/auth/guest" > /dev/null
GUESTCNT=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"guest":true' | wc -l | tr -d ' ')
[ "$GUESTCNT" -ge 1 ] && ok "存在游客账号($GUESTCNT)" || bad "应存在游客账号"
purge=$(curl -s -X POST "$BASE/api/admin/users/purge-guests" -H "$AUTH")
assert_contains "一键清除游客" "$purge" '"ok":true'
assert_contains "清除后有移除计数" "$purge" '"removed":'
LEFT=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"guest":true' | wc -l | tr -d ' ')
assert_eq "清除后无游客" "$LEFT" "0"

# ---------- 性能优化开关 ----------
say "== 性能优化开关 =="
# 默认全关
perfcfg=$(curl -s "$BASE/api/config")
assert_contains "config 下发 perf 开关" "$perfcfg" '"perf"'
assert_contains "性能开关默认不加载字体为 false" "$perfcfg" '"noWebfonts":false'
# 开启「内置字体默认不加载」后,前台配置应据此把默认字体切到系统字体(用户仍可自选)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":true}' > /dev/null
assert_contains "内置字体默认不加载可开启" "$(curl -s "$BASE/api/config")" '"noWebfonts":true'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":false}' > /dev/null
# 打开若干开关后应下发 true,并能读回
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":true,"perfNoKatex":true,"perfNoHighlight":true,"perfNoMermaid":true}' > /dev/null
perfcfg2=$(curl -s "$BASE/api/config")
assert_contains "不加载字体生效" "$perfcfg2" '"noWebfonts":true'
assert_contains "不加载 KaTeX 生效" "$perfcfg2" '"noKatex":true'
assert_contains "不加载高亮生效" "$perfcfg2" '"noHighlight":true'
assert_contains "不加载 Mermaid 生效" "$perfcfg2" '"noMermaid":true'
assert_contains "后台设置可读回 perf" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"perfNoKatex":true'
# 关回去(不影响后续用例)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":false,"perfNoKatex":false,"perfNoHighlight":false,"perfNoMermaid":false}' > /dev/null
assert_contains "性能开关可关闭" "$(curl -s "$BASE/api/config")" '"noKatex":false'

# ---------- 生图结果本地留存 ----------
say "== 生图本地留存 =="
# 默认开启
assert_contains "生图本地留存默认开启" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveEnabled":true'
assert_contains "留存配额默认 500MB" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":500'
# 可关闭并读回
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveEnabled":false,"imageArchiveQuotaMb":800}' > /dev/null
assert_contains "留存可关闭" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveEnabled":false'
assert_contains "留存配额可改" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":800'
# 配额越界被夹紧
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveQuotaMb":1}' > /dev/null
assert_contains "留存配额下界夹紧到 50" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":50'
# 关回去(默认开启;网络不可达时自动回退为按需代理,不影响出图)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveEnabled":true,"imageArchiveQuotaMb":500}' > /dev/null

# ---------- 开放 API 对话落库 ----------
say "== 开放 API 对话落库 =="
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":true,"persistChats":true}' > /dev/null
# 第一次:全新上下文
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic one"}]}' > /dev/null
# 第二次:同一上下文(客户端带上历史) → 应追加到同一对话,不重复历史
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic one"},{"role":"assistant","content":"MOCK-REPLY"},{"role":"user","content":"and more"}]}' > /dev/null
# 第三次:不同上下文 → 新建对话
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic two"}]}' > /dev/null
CHATS=$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")
assert_contains "API 对话已落库" "$CHATS" 'cellar topic one'
assert_contains "新上下文另建对话" "$CHATS" 'cellar topic two'
MSGCNT=$(printf '%s' "$CHATS" | grep -o '"content":"cellar topic one"' | wc -l | tr -d ' ')
assert_eq "同上下文历史未重复" "$MSGCNT" "1"
# 关闭开关后不再落库
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":false}' > /dev/null
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic three"}]}' > /dev/null
assert_contains "关闭后不再落库" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"apiSaveChats":false'
if curl -s "$BASE/api/sync/chats" -H "$UAUTH" | grep -q 'cellar topic three'; then bad "关闭 apiSaveChats 后仍落库"; else ok "关闭 apiSaveChats 后不落库"; fi
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":true}' > /dev/null

# ---------- 无限额度(-1) ----------
say "== 无限额度 =="
# 管理员创建 quota=-1 的固定兑换码,用户兑换后应变为无限额度
curl -s -X POST "$BASE/api/admin/codes/fixed" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"code":"UNLIMITED2026","quota":-1,"maxRedemptions":1,"perUserLimit":true}' > /dev/null
redeem=$(curl -s -X POST "$BASE/api/packages/redeem" -H "$UAUTH" -H "Content-Type: application/json" -d '{"code":"UNLIMITED2026"}')
assert_contains "固定兑换码可发放无限额度" "$redeem" '"quota":-1'
# 无限额度用户不受额度拦截,可继续调用
assert_contains "无限额度用户可继续对话" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" 'MOCK-REPLY'
assert_contains "无限额度在 me 中保持 -1" "$(curl -s "$BASE/api/auth/me" -H "$UAUTH")" '"quota":-1'

# ---------- 上游连接失败提示 ----------
say "== 上游连接失败提示 =="
# 指向无法解析的域名:应返回可定位的中文提示,而不是笼统的 504
cat > "$TMP/badprov.json" <<'EOF'
{"name":"BadHost","baseUrl":"http://no-such-host-xyz123.invalid/v1","apiKey":"sk-bad-123456","apiFormat":"chat","scope":"global","models":[{"id":"bad-model"}]}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/badprov.json" > /dev/null
BADPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"BadHost"' | cut -d'"' -f4)
[ -n "$BADPROV" ] && ok "创建不可达供应商" || bad "创建不可达供应商"
badmsg=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d "{\"providerId\":\"$BADPROV\",\"model\":\"bad-model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_contains "连接失败给出可定位提示" "$badmsg" '无法解析上游域名'

# ---------- 授权规则 API 语义:单组更新 vs 全量替换 ----------
say "== 授权规则语义 =="
# 基准快照。注意:内置管理员组会在每次写库时自动补齐全部供应商授权(管理员永远全量可用),
# 因此断言只针对「非管理员组」的规则增删,不能假设全量替换后总条数为 1。
baseline=$(curl -s "$BASE/api/admin/access" -H "$AUTH")
basecount=$(printf '%s' "$baseline" | grep -o '"groupId"' | wc -l | tr -d ' ')
NG=$(curl -s -X POST "$BASE/api/admin/groups" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"access-sem-group"}' | jget id)
[ -n "$NG" ] && ok "创建语义测试组" || bad "创建语义测试组"
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
assert_has "单组更新写入新规则" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]"
newcount=$(curl -s "$BASE/api/admin/access" -H "$AUTH" | grep -o '"groupId"' | wc -l | tr -d ' ')
assert_eq "单组更新不影响其他组(规则数+1)" "$newcount" "$((basecount + 1))"
# rules 数组 = 全量替换:替换后只剩 NG 一条 + 管理员组自愈规则;其他组(如默认组)的规则必须消失
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"rules\":[{\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}]}" > /dev/null
acc_after=$(curl -s "$BASE/api/admin/access" -H "$AUTH")
assert_has "替换后 NG 规则可回读" "$acc_after" "\"groupId\":\"$NG\""
if printf '%s' "$acc_after" | grep -q "\"groupId\":\"$GID1\""; then bad "全量替换应移除未包含组(默认组)的规则"; else ok "全量替换移除了未包含组的规则"; fi
# 用基准快照整体回滚,验证全量替换可用于安全的批量导入
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"rules\":$(printf '%s' "$baseline" | sed 's/^{"rules"://; s/}$//')}" > /dev/null
assert_eq "基准快照可整体回滚" "$(curl -s "$BASE/api/admin/access" -H "$AUTH" | grep -o '"groupId"' | wc -l | tr -d ' ')" "$basecount"

# ---------- 多源联网搜索(brave / ddg / jina,走 mock) ----------
say "== 多源联网搜索 =="
# 注意:请求体含中文,一律走文件(--data-binary),避免 Windows 终端把内联中文转成错误编码
cat > "$TMP/ws_q.json" <<'EOF'
{"query":"上海天气","max":3}
EOF
cat > "$TMP/ws_chat.json" <<EOF
{"providerId":"$PROV","model":"mock-model","webSearch":"1","messages":[{"role":"user","content":"上海天气"}]}
EOF
# brave:key 保存后掩码回显,config 暴露 provider,测试端点命中 mock
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":true,"webSearchProvider":"brave","webSearchBraveKey":"BSA-e2e-key-12345","webSearchMaxResults":3}' > /dev/null
assert_contains "brave 供应商可保存" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"webSearchProvider":"brave"'
assert_has "brave key 掩码回显" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"webSearchBraveKey":"BSA'
assert_contains "config 暴露 brave" "$(curl -s "$BASE/api/config")" '"provider":"brave"'
cat > "$TMP/ws_brave.json" <<'EOF'
{"provider":"brave","query":"上海天气","max":3}
EOF
BRAVE=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_brave.json")
assert_contains "brave 测试命中 mock" "$BRAVE" '"ok":true'
assert_contains "brave 结果带查询词" "$BRAVE" 'Brave:上海天气'
# ddg:免 key;广告被过滤、uddg 跳转解包
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"ddg"}' > /dev/null
cat > "$TMP/ws_ddg.json" <<'EOF'
{"provider":"ddg","query":"上海天气","max":3}
EOF
DDG=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_ddg.json")
assert_contains "ddg 测试命中 mock" "$DDG" '"ok":true'
assert_contains "ddg 广告被过滤(只剩 2 条)" "$DDG" '"count":2'
assert_contains "ddg uddg 解包" "$DDG" 'example.com/ddg1'
# jina:免 key 也可测,JSON 解析
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"jina","webSearchJinaKey":""}' > /dev/null
cat > "$TMP/ws_jina.json" <<'EOF'
{"provider":"jina","query":"上海天气","max":3}
EOF
JINA=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_jina.json")
assert_contains "jina 免 key 可用" "$JINA" '"ok":true'
assert_contains "jina JSON 解析" "$JINA" 'Jina:上海天气'
# 对话链路:brave 无 key → ready=false,搜索请求 502 且可定位;ddg → 搜索走通,回复正常
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"brave","webSearchBraveKey":""}' > /dev/null
CHATNS=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_chat.json")
assert_contains "brave 无 key 时搜索失败可定位" "$CHATNS" '联网搜索失败'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"ddg"}' > /dev/null
CHATDS=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_chat.json")
assert_contains "ddg 搜索走通对话正常" "$CHATDS" 'MOCK-REPLY'
# 用户自备源:ddg 免 key 即 ready
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchAllowUser":true}' > /dev/null
TOOLS=$(curl -s -X POST "$BASE/api/me/tools" -H "$UAUTH" -H "Content-Type: application/json" -d '{"webSearchSource":"own","webSearchProvider":"ddg"}')
assert_contains "用户自备 ddg 即 ready" "$TOOLS" '"ownReady":true'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchAllowUser":false}' > /dev/null

# ---------- 文档解析通道(PaddleOCR / Mistral OCR,按类别路由,走 mock) ----------
say "== 联网搜索默认值 =="
# 新站点默认:联网开启 + 默认用免 Key 的 DuckDuckGo(开箱即可用)
SETTINGS_WS=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_has "联网搜索默认开启" "$SETTINGS_WS" '"webSearchEnabled":true'
assert_has "默认检索源是 DuckDuckGo" "$SETTINGS_WS" '"webSearchProvider":"ddg"'
assert_has "config 下发默认检索源" "$(curl -s "$BASE/api/config")" '"provider":"ddg"'
# 非法检索源回退到默认值 ddg,而不是 tavily
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"nonsense"}' > /dev/null
assert_has "非法检索源回退到 ddg" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"webSearchProvider":"ddg"'
# 管理员显式改回 tavily 时必须被尊重(默认值不能覆盖存量配置)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":false,"webSearchProvider":"tavily"}' > /dev/null
SETTINGS_WS2=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_has "显式选择 tavily 被保留" "$SETTINGS_WS2" '"webSearchProvider":"tavily"'
assert_has "显式关闭联网被保留" "$SETTINGS_WS2" '"webSearchEnabled":false'
# 恢复默认,避免影响后续用例
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":true,"webSearchProvider":"ddg"}' > /dev/null
say "== 搜索结果正文抓取 =="
# 用 mock 页面验证整条链路:搜索结果 -> 抓正文 -> 注入模型上下文。
# mock 页面刻意把导航放前面、正文里带裸 "<"(曾让 strip_tags 吞掉整段正文)。
cat > "$TMP/pf_echo.json" <<EOF
{"providerId":"$PROV","model":"mock-echo-system","webSearch":"1","messages":[{"role":"user","content":"上海天气"}]}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":true,"webSearchProvider":"ddg","webSearchMaxResults":3}' > /dev/null
PFRES=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/pf_echo.json")
assert_contains "联网搜索开启后请求走通" "$PFRES" 'MOCK-ECHO-OK'
assert_contains "搜索结果正文已注入上下文" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" 'MOCK-PAGE-BODY-OK'
assert_contains "正文里的温度数据被保留" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '21℃'
# 裸 <(风力「<3级」)之后的正文不能被 strip_tags 吞掉 —— 本次修复的核心回归
assert_contains "正文裸 < 不再吞掉后续内容" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '明天阴'
assert_contains "风力数据随裸 < 一起保留" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '3级'
if grep -qF 'MOCK-SCRIPT-SHOULD-NOT-APPEAR' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "脚本内容进了上下文"; else ok "脚本内容不进上下文"; fi
if grep -qF 'MOCK-COMMENT-SHOULD-NOT-APPEAR' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "注释内容进了上下文"; else ok "注释内容不进上下文"; fi
if grep -qF '天气地图' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "导航菜单未被瘦身"; else ok "导航菜单被瘦身"; fi
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":false}' > /dev/null

say "== 文档解析通道路由 =="
# 路由与凭据保存:pdf->mistral, image->paddle, office->mineru;key 掩码回显
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"pdf":"mistral","image":"paddle","office":"mineru"},"mistralOcrKey":"sk-mistral-e2e","paddleOcrUrl":"http://127.0.0.1:'"$MOCK_PORT"'/ocr","paddleOcrKey":""}' > /dev/null
SR=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_contains "路由表保存" "$SR" '"parseChannels":{"pdf":"mistral","image":"paddle","office":"mineru"}'
assert_has "mistral key 掩码回显" "$SR" '"mistralOcrKey":"sk-m'
assert_contains "config 暴露路由" "$(curl -s "$BASE/api/config")" '"routes":{"pdf":"mistral","image":"paddle","office":"mineru"}'
# 造测试文件(内容不校验,mock 只看路由与请求形状)
printf '%%PDF-1.4 mock pdf bytes' > "$TMP/doc.pdf"
printf 'PNG-mock-image-bytes' > "$TMP/img.png"
printf 'DOCX-mock-bytes' > "$TMP/notes.docx"
# 上传解析:原生 curl 读不了 -F 里 MSYS 风格的 /tmp 路径,统一在 $TMP 下用相对路径发起
parse_upload() { # $1=文件名(位于 $TMP) $2=token
  ( cd "$TMP" && curl -s -X POST "$BASE/api/documents/parse" -H "Authorization: Bearer $2" -F "file=@$1;filename=$1" )
}
# 图片走 paddle:两页 rec_texts 拼接
PADDLE=$(parse_upload img.png "$TOKEN")
assert_contains "图片走 PaddleOCR 通道" "$PADDLE" '"channel":"paddle"'
assert_contains "paddle rec_texts 拼接成 markdown" "$PADDLE" 'PaddleOCR 识别 第一行'
assert_contains "paddle 多页合并" "$PADDLE" '第二页识别'
# pdf 走 mistral:分页 markdown 拼接
MIST=$(parse_upload doc.pdf "$TOKEN")
assert_contains "pdf 走 Mistral 通道" "$MIST" '"channel":"mistral"'
assert_contains "mistral 分页 markdown" "$MIST" 'Mistral 第一页'
assert_contains "mistral 第二页合并" "$MIST" '第二页内容'
# 错误路由:office 指到 paddle → 明确报格式不支持
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"office":"paddle"}}' > /dev/null
MISR=$(parse_upload notes.docx "$TOKEN")
assert_contains "office 误路由 paddle 报格式不支持" "$MISR" 'PaddleOCR 仅支持 PDF 与图片'
# 通道未配置:清空 paddle 地址后图片解析报可定位错误
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"paddleOcrUrl":""}' > /dev/null
NOP=$(parse_upload img.png "$TOKEN")
assert_contains "paddle 未配置报可定位错误" "$NOP" '还没有填写服务地址'
# mistral 坏 key:上游 401 透传
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"mistralOcrKey":"sk-bad-mistral"}' > /dev/null
BADK=$(parse_upload doc.pdf "$TOKEN")
assert_contains "mistral 坏 key 错误透传" "$BADK" 'invalid mistral key'
# 恢复默认路由
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"pdf":"mineru","image":"mineru","office":"mineru"},"mistralOcrKey":"","paddleOcrUrl":"http://127.0.0.1:'"$MOCK_PORT"'/ocr"}' > /dev/null

# ---------- 第三方一键登录(微信 / QQ / LinuxDO / NodeLoc,走 mock 提供商) ----------
say "== 第三方一键登录 =="
OAUTHBASE="http://127.0.0.1:$OAUTH_PORT"
# 保存四家配置(含掩码回显与未配置时的行为)
cat > "$TMP/oauth_cfg.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true,"appId":"wx-e2e-app","appSecret":"wx-e2e-secret"},"qq":{"enabled":true,"appId":"123456","appKey":"qq-e2e-key"},"linuxdo":{"enabled":true,"clientId":"ldo-e2e-id","clientSecret":"ldo-e2e-secret"},"nodeloc":{"enabled":true,"clientId":"ndl-e2e-id","clientSecret":"ndl-e2e-secret"}},"oauthAutoRegister":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oauth_cfg.json" > /dev/null
OS=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_contains "第三方登录:微信可保存" "$OS" '"appId":"wx-e2e-app"'
assert_has "第三方登录:密钥掩码回显" "$OS" '"appSecret":"wx-e'
assert_contains "第三方登录:自动注册开关可保存" "$OS" '"oauthAutoRegister":true'
# config 下发已启用的提供商(登录页据此渲染图标)
OCFG=$(curl -s "$BASE/api/config")
for pid in wechat qq linuxdo nodeloc; do
  assert_contains "config 下发 $pid 图标" "$OCFG" "\"id\":\"$pid\""
done
assert_contains "config 带图标路径" "$OCFG" 'static/logo/weixin.svg'
# 掩码保存不覆盖真实密钥(只传掩码)
cat > "$TMP/oauth_mask.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true,"appSecret":"wx-••••cret"}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oauth_mask.json" > /dev/null
cat > "$TMP/getsecret.php" <<'PHPEOF'
<?php
$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
$s = json_decode($pdo->query('SELECT v FROM store WHERE k = "settings"')->fetchColumn(), true);
echo isset($s["oauthProviders"]["wechat"]["appSecret"]) ? $s["oauthProviders"]["wechat"]["appSecret"] : "";
PHPEOF
php_out=$(php "$TMP/getsecret.php" "$TMP/data")
assert_eq "掩码保存保留原密钥" "$php_out" "wx-e2e-secret"

# 未配置的提供商:发起授权应提示未启用
curl -s -o /dev/null -D "$TMP/h.disabled" "$BASE/auth/wechat?x=1" 2>/dev/null
# (先记下启用状态,再临时关掉微信验证提示)
cat > "$TMP/off.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/off.json" > /dev/null
DIS=$(curl -s -D - -o /dev/null "$BASE/auth/wechat" | grep -i '^location:' | head -1)
assert_has "未启用时提示未配置" "$DIS" 'oauth_error='
cat > "$TMP/on.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/on.json" > /dev/null

# 全链路(Nodeloc):发起 -> 授权 -> 回调 -> 票据 -> 换登录态
oauth_flow() { # $1=provider, 输出最终 location
  local pid="$1"
  local auth=$(curl -s -D - -o /dev/null "$BASE/auth/$pid" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r')
  local cb=$(curl -s -D - -o /dev/null "$auth" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r')
  curl -s -D - -o /dev/null "$cb" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r'
}
NODEID=""
for pid in nodeloc linuxdo; do
  LAND=$(oauth_flow "$pid")
  assert_contains "$pid 登录链路到达前台票据" "$LAND" 'oauth_ticket='
  TK=$(printf '%s' "$LAND" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
  cat > "$TMP/tk.json" <<EOF2
{"ticket":"$TK"}
EOF2
  EX=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk.json")
  assert_contains "$pid 票据可换登录态" "$EX" '"token":"'
  UNAME=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
  # 昵称重名时自动加数字后缀去重,因此只断言前缀
  case "$UNAME" in
    E2E测试用户*) ok "$pid 自动建号用户名($UNAME)" ;;
    *) bad "$pid 自动建号用户名(得到 $UNAME)" ;;
  esac
  if [ "$pid" = "nodeloc" ]; then
    NODEID=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
  fi
  # 同一票据只能换一次
  EX2=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk.json")
  assert_contains "$pid 票据不可重放" "$EX2" '已使用'
done
# 同一第三方账号二次登录(仍是 nodeloc):不再建号,直接复用原账号
LAND2=$(oauth_flow nodeloc)
TK2=$(printf '%s' "$LAND2" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/tk2.json" <<EOF3
{"ticket":"$TK2"}
EOF3
EX3=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk2.json")
ID3=$(printf '%s' "$EX3" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
assert_eq "同一第三方账号再次登录复用原账号" "$ID3" "$NODEID"

# 关闭自动注册:未绑定的第三方账号应被拒(先解绑 wechat,再关闭自动注册)
BTOKEN_TMP=$(printf '%s' "$EX3" | python -c "import sys,json;print(json.load(sys.stdin)['token'])" 2>/dev/null)
curl -s -X DELETE "$BASE/api/me/oauth/wechat" -H "Authorization: Bearer $BTOKEN_TMP" > /dev/null
cat > "$TMP/off2.json" <<'EOF'
{"oauthAutoRegister":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/off2.json" > /dev/null
LANDNR=$(oauth_flow wechat)
assert_has "关闭自动注册后未绑定账号被拒" "$LANDNR" 'oauth_error='
cat > "$TMP/on2.json" <<'EOF'
{"oauthAutoRegister":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/on2.json" > /dev/null

# 微信链路(独立端点形状:GET 换 token + openid 随 token 返回)
LANDW=$(oauth_flow wechat)
assert_contains "微信登录链路到达前台票据" "$LANDW" 'oauth_ticket='
# QQ 链路(需二次请求取 OpenID)
LANDQ=$(oauth_flow qq)
assert_contains "QQ 登录链路到达前台票据" "$LANDQ" 'oauth_ticket='

# 已登录用户:绑定 / 解绑 / 已绑定列表
# 注意:解绑唯一绑定需要账号已设置密码(防呆保护),这里先设密码再继续
BINDUSER=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
BTOKEN=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['token'])" 2>/dev/null)
cat > "$TMP/bpwd.json" <<'EOF'
{"oldPassword":"","newPassword":"bindsetup1"}
EOF
curl -s -X POST "$BASE/api/auth/password" -H "Authorization: Bearer $BTOKEN" -H "Content-Type: application/json" --data-binary @"$TMP/bpwd.json" > /dev/null
BUNAME=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
cat > "$TMP/blogin.json" <<EOF9
{"name":"$BUNAME","password":"bindsetup1"}
EOF9
BTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/blogin.json" | jget token)
BIND=$(curl -s "$BASE/api/me/oauth" -H "Authorization: Bearer $BTOKEN")
assert_contains "绑定列表含 wechat" "$BIND" '"id":"wechat"'
assert_contains "绑定列表标记已绑定" "$BIND" '"bound":true'
UNB=$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "Authorization: Bearer $BTOKEN")
assert_contains "解绑成功" "$UNB" '"ok":true'
BIND2=$(curl -s "$BASE/api/me/oauth" -H "Authorization: Bearer $BTOKEN")
if printf '%s' "$BIND2" | grep -q '"id":"linuxdo","name":"LINUX DO","logo":"[^"]*","enabled":true,"bound":true'; then
  bad "解绑后 linuxdo 仍显示已绑定"
else
  ok "解绑后状态刷新"
fi
UNB2=$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "Authorization: Bearer $BTOKEN")
assert_contains "重复解绑被拒" "$UNB2" '未绑定'

# ---------- 余量明细与第三方账号资料补全 ----------
say "== 余量明细 / 资料补全 =="
# 造一个有明确额度的用户,验证每笔扣减都带用途与前后余额
cat > "$TMP/qu.json" <<'EOF'
{"name":"ledgeruser","password":"test1234","quota":20}
EOF
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/qu.json" > /dev/null
LT=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"ledgeruser","password":"test1234"}' | jget token)
[ -n "$LT" ] && ok "余量明细测试用户登录" || bad "余量明细测试用户登录"
LAUTH="Authorization: Bearer $LT"
# 普通对话
cat > "$TMP/lc1.json" <<'EOF'
{"providerId":"x","model":"mock-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/lc1.json" <<EOF2
{"providerId":"$PROV","model":"mock-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF2
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc1.json" > /dev/null
# 带用途:生成标题 / 生成跟进建议
cat > "$TMP/lc2.json" <<EOF3
{"providerId":"$PROV","model":"mock-model","stream":false,"_purpose":"title","messages":[{"role":"user","content":"t"}]}
EOF3
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc2.json" > /dev/null
cat > "$TMP/lc3.json" <<EOF4
{"providerId":"$PROV","model":"mock-model","stream":false,"_purpose":"followup","messages":[{"role":"user","content":"f"}]}
EOF4
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc3.json" > /dev/null
LEDGER=$(curl -s "$BASE/api/me/quota/ledger" -H "$LAUTH")
assert_contains "明细记录普通对话" "$LEDGER" '对话'
assert_contains "明细记录生成标题" "$LEDGER" '生成标题'
assert_contains "明细记录生成跟进建议" "$LEDGER" '生成跟进建议'
assert_contains "明细带余额变化" "$LEDGER" '"before":'
LED_SPENT=$(printf '%s' "$LEDGER" | python -c "import sys,json;print(json.load(sys.stdin)['spent'])" 2>/dev/null)
if [ -n "$LED_SPENT" ] && [ "$LED_SPENT" != "0" ] && [ "$LED_SPENT" != "0.0" ]; then ok "明细汇总消耗为 $LED_SPENT"; else bad "明细汇总消耗为空($LED_SPENT)"; fi
# 分页参数
assert_contains "明细支持 limit" "$(curl -s "$BASE/api/me/quota/ledger?limit=1" -H "$LAUTH")" '"total":3'
# 充值/兑换码也进同一明细
cat > "$TMP/lpkg.json" <<'EOF'
{"name":"明细测试套餐","quota":10,"enabled":true}
EOF
LPKG=$(curl -s -X POST "$BASE/api/admin/packages" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lpkg.json" | jget id)
LCODE=$(curl -s -X POST "$BASE/api/admin/packages/$LPKG/codes" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":1}' | python -c "import sys,json;print(json.load(sys.stdin)['codes'][0])" 2>/dev/null)
cat > "$TMP/lrd.json" <<EOF5
{"code":"$LCODE"}
EOF5
curl -s -X POST "$BASE/api/packages/redeem" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lrd.json" > /dev/null
assert_contains "明细记录兑换码获得" "$(curl -s "$BASE/api/me/quota/ledger" -H "$LAUTH")" '兑换码'

# 第三方账号:改用户名 / 设密码(无密码用户不要求旧密码)
cat > "$TMP/ou_cfg.json" <<'EOF'
{"oauthProviders":{"nodeloc":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ou_cfg.json" > /dev/null
OLAND=$(oauth_flow nodeloc)
OTK=$(printf '%s' "$OLAND" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk.json" <<EOF6
{"ticket":"$OTK"}
EOF6
OEX=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk.json")
OT=$(printf '%s' "$OEX" | jget token)
OAUTH="Authorization: Bearer $OT"
assert_contains "第三方用户登录后无密码标记" "$(curl -s "$BASE/api/auth/me" -H "$OAUTH")" '"hasPassword":false'
# 无密码用户:直接设密码(不带 oldPassword)
cat > "$TMP/opw.json" <<'EOF'
{"oldPassword":"","newPassword":"oauthpass1"}
EOF
assert_contains "无密码用户可直接设密码" "$(curl -s -X POST "$BASE/api/auth/password" -H "$OAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/opw.json")" '"ok":true'
# 设密码后 tv 递增,用「自动建号时的实际用户名 + 刚设的密码」重新登录
OUNAME=$(printf '%s' "$OEX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
cat > "$TMP/ologin.json" <<EOF9
{"name":"$OUNAME","password":"oauthpass1"}
EOF9
OT2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/ologin.json" | jget token)
if [ -n "$OT2" ]; then ok "设密码后可用密码登录($OUNAME)"; else bad "设密码后无法用密码登录($OUNAME)"; fi
OAUTH2="Authorization: Bearer $OT2"
cat > "$TMP/oname.json" <<'EOF'
{"name":"oauthrenamed","password":"oauthpass1"}
EOF
RNAME=$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname.json")
assert_contains "第三方用户可改用户名" "$RNAME" '"name":"oauthrenamed"'
# 改名会让旧会话失效(tv 递增),用返回的新 token 继续做校验用例
AT3=$(printf '%s' "$RNAME" | jget token)
OAUTH2="Authorization: Bearer $AT3"
# 校验:密码错误 / 重名 / 非法名
cat > "$TMP/oname_bad.json" <<'EOF'
{"name":"anothername","password":"wrong"}
EOF
assert_contains "改名校验:密码错误被拒" "$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname_bad.json")" '请输入当前密码'
cat > "$TMP/oname_dup.json" <<'EOF'
{"name":"admin","password":"oauthpass1"}
EOF
assert_contains "改名校验:重名被拒" "$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname_dup.json")" '用户名已存在'
# 开启「强制补全」:exchange 返回 needsProfile,且已有密码的用户不再要求
cat > "$TMP/reqp.json" <<'EOF'
{"oauthRequireProfile":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/reqp.json" > /dev/null
assert_contains "config 下发补全开关" "$(curl -s "$BASE/api/config")" '"requireProfile":true'
OLAND2=$(oauth_flow wechat)
OTK2=$(printf '%s' "$OLAND2" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk2.json" <<EOF7
{"ticket":"$OTK2"}
EOF7
assert_contains "无密码新用户 exchange 要求补全" "$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk2.json")" '"needsProfile":true'
OLAND3=$(oauth_flow nodeloc)
OTK3=$(printf '%s' "$OLAND3" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk3.json" <<EOF8
{"ticket":"$OTK3"}
EOF8
assert_contains "已设密码用户不再要求补全" "$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk3.json")" '"needsProfile":false'
cat > "$TMP/reqp2.json" <<'EOF'
{"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/reqp2.json" > /dev/null

# ---------- 第三方登录回跳与提示标记 ----------
say "== 第三方登录回跳标记 =="
cat > "$TMP/rc.json" <<'EOF'
{"oauthProviders":{"nodeloc":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/rc.json" > /dev/null
# 未绑定新账号:落地地址应带 oauth_created=1(前端据此提示"已创建新账号")。
# 先清空该第三方 uid 的既有绑定,确保本次是"首次建号"。
cat > "$TMP/rcqq.json" <<'EOF'
{"oauthProviders":{"qq":{"enabled":true}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/rcqq.json" > /dev/null
cat > "$TMP/unbind_all.php" <<'PHPEOF'
<?php
// 清掉所有用户的 oauth 绑定,让后续第三方登录都走"首次建号"分支
$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
$u = json_decode($pdo->query('SELECT v FROM store WHERE k = "users"')->fetchColumn(), true);
foreach ($u as $i => $x) { $u[$i]["oauth"] = array(); }
$pdo->prepare('UPDATE store SET v = ? WHERE k = "users"')->execute(array(json_encode($u, JSON_UNESCAPED_UNICODE)));
PHPEOF
php "$TMP/unbind_all.php" "$TMP/data"
NEWLAND=$(oauth_flow qq)
assert_contains "新账号落地带 created 标记" "$NEWLAND" 'oauth_created=1'
assert_contains "新账号落地带票据" "$NEWLAND" 'oauth_ticket='
# 已绑定账号:落地不带 created 标记
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"oauthRequireProfile":false}' > /dev/null
# 同一第三方账号第二次登录:已绑定,落地不应再带 created 标记
BOUNDLAND=$(oauth_flow qq)
assert_contains "已绑定账号落地带票据" "$BOUNDLAND" 'oauth_ticket='
if printf '%s' "$BOUNDLAND" | grep -q 'oauth_created=1'; then bad "已绑定账号不应带 created 标记"; else ok "已绑定账号不带 created 标记"; fi
cat > "$TMP/oc_off.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":false},"linuxdo":{"enabled":false},"qq":{"enabled":false},"nodeloc":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oc_off.json" > /dev/null

# ---------- 第三方绑定的列表/防呆/后台管理 ----------
say "== 第三方绑定管理 =="
cat > "$TMP/ob_cfg.json" <<'EOF'
{"oauthProviders":{"linuxdo":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ob_cfg.json" > /dev/null
# 全新第三方账号:设密码前「解绑唯一绑定」应被拒(否则账号无法登录)
OLANDB=$(oauth_flow linuxdo)
OTKB=$(printf '%s' "$OLANDB" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otkb.json" <<EOF2
{"ticket":"$OTKB"}
EOF2
OEXB=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otkb.json")
OTB=$(printf '%s' "$OEXB" | jget token)
OUID=$(printf '%s' "$OEXB" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
OB="Authorization: Bearer $OTB"
UNAME_B=$(printf '%s' "$OEXB" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
assert_contains "绑定列表返回全部平台" "$(curl -s "$BASE/api/me/oauth" -H "$OB")" '"id":"wechat"'
# 接口返回 enabled 标记(前端据此过滤:未启用的平台对用户不可见,已绑定的除外)
assert_contains "绑定接口带 enabled 标记供前端过滤" "$(curl -s "$BASE/api/me/oauth" -H "$OB")" '"enabled":false'
assert_contains "无密码时解绑唯一绑定被拒" "$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "$OB")" '还没有设置密码'
# 管理端:查看该用户绑定(含 bindUrl)
AUSER=$(curl -s "$BASE/api/admin/users/oauth?userId=$OUID" -H "$AUTH")
assert_contains "管理端可见用户绑定" "$AUSER" '"bound":true'
assert_contains "管理端给出绑定链接" "$AUSER" '/auth/linuxdo?bind='
# 管理端解绑同样受防呆保护
assert_contains "管理端解绑也受防呆保护" "$(curl -s -X DELETE "$BASE/api/admin/users/$OUID/oauth/linuxdo" -H "$AUTH")" '还没有设置密码'
# 用户设密码后可解绑
cat > "$TMP/obpw.json" <<'EOF'
{"oldPassword":"","newPassword":"bindpass123"}
EOF
curl -s -X POST "$BASE/api/auth/password" -H "$OB" -H "Content-Type: application/json" --data-binary @"$TMP/obpw.json" > /dev/null
cat > "$TMP/oblogin.json" <<EOF10
{"name":"$UNAME_B","password":"bindpass123"}
EOF10
OTB2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/oblogin.json" | jget token)
ob='Authorization: Bearer '"$OTB2"
assert_contains "设密码后可解绑" "$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "$ob")" '"ok":true'
cat > "$TMP/ob_off.json" <<'EOF'
{"oauthProviders":{"linuxdo":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ob_off.json" > /dev/null

say "== 演示管理员对话自动清除 =="
# 回归:演示管理员只在前台聊天(不碰后台)时,快照也必须建立并在到期后清除其新对话。
# 缺陷背景:快照原先只在 tc_require_admin(后台操作)里拍摄,演示管理员纯聊天时不经过那里,
# 第一次到期还原后快照被消费、永久不再重建 —— 之后产生的对话就再也不会被自动清除。
# 先清掉早前演示用例遗留的活跃快照:演示快照是「全站单例」,若已有生效中的快照,
# 新建演示账号时不会重新拍摄,本段就测不到目标账号。这里显式重置,保证用例自洽。
php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite");
  $st=$pdo->prepare("DELETE FROM store WHERE k=? OR k=?");
  $st->execute(array("demoSnapshot","demoBaseline"));
  $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("users"));
  $us=json_decode($q->fetchColumn(),true);
  foreach($us as &$u) if(!empty($u["demo"]) && ($u["name"] ?? "") !== "chatdemo") $u["demo"]=false;
  unset($u);
  $up=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $up->execute(array(json_encode($us),"users"));
  $up2=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $up2->execute(array("null","demoSnapshot"));' "$TMP/data"
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"demoExpireMinutes":10}' > /dev/null
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"chatdemo","password":"demo1234","demo":true}' > /dev/null
CDT=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"chatdemo","password":"demo1234"}' | jget token)
CDA="Authorization: Bearer $CDT"
demo_chats() { # 读取该演示账号当前的对话条数(对话按 chat:<uid> 行存储)
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("users")); $us=json_decode($q->fetchColumn(),true); $id=""; foreach((array)$us as $u) if(($u["name"]??"")==="chatdemo") $id=$u["id"]; if($id===""){ echo 0; exit; } $q2=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q2->execute(array("chat:".$id)); $ch=json_decode($q2->fetchColumn(),true); echo count(is_array($ch)?$ch:array());' "$1"
}
demo_has_snapshot() { # 快照是否存在(直读库,避免走管理接口触发 rebaseline 重拍)
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("demoSnapshot")); $v=$q->fetchColumn(); $j=json_decode($v,true); echo (is_array($j) && !empty($j["expireAt"])) ? "yes" : "no";' "$1"
}
demo_expire_now() { # 把演示快照的到期时间拨到过去,模拟「10 分钟已到」
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("demoSnapshot")); $j=json_decode($q->fetchColumn(),true); if(!is_array($j)) exit(1); $j["expireAt"]=1; $st=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $st->execute(array(json_encode($j),"demoSnapshot"));' "$1"
}
demo_del() { # 删除测试用的演示账号
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("users")); foreach((array)json_decode($q->fetchColumn(),true) as $u) if(($u["name"]??"")==="chatdemo"){ echo $u["id"]; break; }' "$1"
}
demo_expire_in() { # 把到期时间设为「距现在 N 毫秒」,用于验证活动顺延
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("demoSnapshot")); $j=json_decode($q->fetchColumn(),true); if(!is_array($j)) exit(1); $j["expireAt"]=(int)round(microtime(true)*1000)+(int)$argv[2]; $st=$pdo->prepare("UPDATE store SET v=? WHERE k=?"); $st->execute(array(json_encode($j),"demoSnapshot"));' "$1" "$2"
}
demo_expire_at() { # 读当前到期时间
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("demoSnapshot")); $j=json_decode($q->fetchColumn(),true); echo (is_array($j) && !empty($j["expireAt"])) ? (int)$j["expireAt"] : 0;' "$1"
}
demo_reverted_at() { # 读还原标记(客户端据此整体采纳云端)
  php -r '$pdo=new PDO("sqlite:".$argv[1]."/tinychat.sqlite"); $q=$pdo->prepare("SELECT v FROM store WHERE k=?"); $q->execute(array("demoReverted")); $j=json_decode($q->fetchColumn(),true); $out=0; foreach((array)$j as $t) $out=(int)$t; echo $out;' "$1"
}

# 第一轮:只在前台聊天,完全不碰后台
cat > "$TMP/cd1.json" <<'EOF'
{"chats":[{"id":"cd1","title":"演示第一轮","messages":[{"role":"user","content":"你好"}],"createdAt":1790789000000,"updatedAt":1790789000000}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$CDA" -H "Content-Type: application/json" --data-binary @"$TMP/cd1.json" > /dev/null
assert_eq "演示账号聊天已保存" "$(demo_chats "$TMP/data")" "1"
assert_eq "聊天即建立还原快照(无需后台操作)" "$(demo_has_snapshot "$TMP/data")" "yes"
# 关键:演示中继续活动应把到期时间顺延(滑动窗口),不打断正在进行的对话
demo_expire_in "$TMP/data" 3000
EXPIRE_BEFORE=$(demo_expire_at "$TMP/data")
curl -s -X POST "$BASE/api/sync/chats" -H "$CDA" -H "Content-Type: application/json" --data-binary @"$TMP/cd1.json" > /dev/null
EXPIRE_AFTER=$(demo_expire_at "$TMP/data")
if [ "$EXPIRE_AFTER" -gt "$EXPIRE_BEFORE" ]; then ok "演示中继续活动:到期时间被顺延(不打断演示)"; else bad "演示中继续活动后到期时间未顺延 ($EXPIRE_BEFORE -> $EXPIRE_AFTER)"; fi
assert_eq "顺延后对话仍在(未被中途抹除)" "$(demo_chats "$TMP/data")" "1"
demo_expire_now "$TMP/data"
curl -s -o /dev/null "$BASE/"
assert_eq "第一轮到期后对话被清除" "$(demo_chats "$TMP/data")" "0"
# 客户端凭还原标记整体采纳云端(否则本地旧副本会把已还原内容推回来)
if [ "$(demo_reverted_at "$TMP/data")" -gt 0 ]; then ok "到期还原写入客户端还原标记"; else bad "到期还原未写入客户端还原标记"; fi
assert_contains "同步接口下发还原标记" "$(curl -s "$BASE/api/sync/chats" -H "$CDA")" '"demoRevertedAt":'
# 第二轮:还原后继续聊天 —— 快照必须自动重建,新对话同样要被清除(核心回归)
cat > "$TMP/cd2.json" <<'EOF'
{"chats":[{"id":"cd2","title":"演示第二轮","messages":[{"role":"user","content":"第二轮"}],"createdAt":1790789000000,"updatedAt":1790789000000}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$CDA" -H "Content-Type: application/json" --data-binary @"$TMP/cd2.json" > /dev/null
assert_eq "第二轮聊天已保存" "$(demo_chats "$TMP/data")" "1"
assert_eq "快照在消费后自动重建" "$(demo_has_snapshot "$TMP/data")" "yes"
demo_expire_now "$TMP/data"
curl -s -o /dev/null "$BASE/"
assert_eq "第二轮到期后新对话也被清除" "$(demo_chats "$TMP/data")" "0"
# 留档汇总的隐私边界:真实管理员能看到归属,演示管理员只拿到匿名汇总,且不能翻列表
cat > "$TMP/sd-demo.json" <<'EOF'
{"chats":[{"id":"sd-demo","title":"匿名边界","messages":[{"role":"user","content":"x"}],"updatedAt":1791000000500}],"deletedIds":["sd-demo"],"deletedChats":[{"id":"sd-demo","title":"匿名边界","messages":[{"role":"user","content":"x"}],"updatedAt":1791000000501}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/sd-demo.json" > /dev/null
assert_contains "真实管理员留档汇总带用户名" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" 'tester1'
DEMOSTOR=$(curl -s "$BASE/api/admin/storage" -H "$CDA")
assert_contains "演示管理员可见留档汇总" "$DEMOSTOR" '"deleted"'
if printf '%s' "$DEMOSTOR" | grep -q 'tester1'; then bad "演示管理员留档汇总暴露了用户名"; else ok "演示管理员留档汇总匿名化"; fi
assert_contains "演示管理员被拒访问留档列表" "$(curl -s "$BASE/api/admin/chats/deleted" -H "$CDA")" '演示管理员'
CDID=$(demo_del "$TMP/data")
[ -n "$CDID" ] && curl -s -X DELETE "$BASE/api/admin/users/$CDID" -H "$AUTH" > /dev/null
say "== 账号注销 =="
# 后台三种模式 + 用户自助注销。软注销后原用户名/邮箱必须能被重新注册(核心诉求)。
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"accountDeletionMode":"off"}' > /dev/null
assert_has "config 下发注销模式" "$(curl -s "$BASE/api/config")" '"accountDeletionMode":"off"'
# 建一个独占账号用于注销测试
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"delme1","password":"del12345","quota":30}' > /dev/null
D1T=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"delme1","password":"del12345"}' | jget token)
D1A="Authorization: Bearer $D1T"
assert_contains "关闭注销时接口拒绝" "$(curl -s -X POST "$BASE/api/auth/delete" -H "$D1A" -H "Content-Type: application/json" -d '{"password":"del12345"}')" '未开放账号注销'
# 软注销
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"accountDeletionMode":"soft"}' > /dev/null
assert_contains "错误密码被拒" "$(curl -s -X POST "$BASE/api/auth/delete" -H "$D1A" -H "Content-Type: application/json" -d '{"password":"wrongpass"}')" '密码不正确'
DELRES=$(curl -s -X POST "$BASE/api/auth/delete" -H "$D1A" -H "Content-Type: application/json" -d '{"password":"del12345"}')
assert_contains "软注销成功" "$DELRES" '"mode":"soft"'
assert_contains "软注销后用户名带已注销标记" "$DELRES" 'delme1-已注销-'
# 旧 token 失效
assert_contains "注销后旧令牌失效" "$(curl -s "$BASE/api/auth/me" -H "$D1A")" '未登录'
# 核心:原用户名可重新注册(本栈开启邀请码,故带上邀请码走真实注册路径)
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":1}' > /dev/null
INVD=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | python -c "
import sys,json
d=json.load(sys.stdin)
# 取一张「仍可用」的邀请码(列表里有已用尽的,不能盲取第一条)
for c in d.get('codes',[]):
    if c.get('usable'): print(c.get('code','')); break
")
cat > "$TMP/redel.json" <<EOF
{"name":"delme1","password":"brandnew1","invite":"$INVD","agreementAccepted":true}
EOF
RE1=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" --data-binary @"$TMP/redel.json")
assert_contains "原用户名可重新注册" "$RE1" '"token":'
assert_contains "新账号已成功登录态" "$(curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $(printf '%s' "$RE1" | jget token)")" '"name":"delme1"'
# 被注销账号仍在(软注销语义),但已改名且不可登录
assert_contains "软注销账号保留在用户列表" "$(curl -s "$BASE/api/admin/users" -H "$AUTH")" 'delme1-已注销-'
# 硬注销:账号彻底消失
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"accountDeletionMode":"hard"}' > /dev/null
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"delme2","password":"del23456","quota":30}' > /dev/null
D2T=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"delme2","password":"del23456"}' | jget token)
assert_contains "硬注销成功" "$(curl -s -X POST "$BASE/api/auth/delete" -H "Authorization: Bearer $D2T" -H "Content-Type: application/json" -d '{"password":"del23456"}')" '"mode":"hard"'
if curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -qF '"delme2"'; then bad "硬注销后账号仍存在"; else ok "硬注销后账号彻底消失"; fi
# 真实管理员仍可正常注销(管理员保护只在「唯一管理员」时生效,此处站内有多个管理员)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"accountDeletionMode":"soft"}' > /dev/null

say "== 余量明细分页 =="
LED1=$(curl -s "$BASE/api/me/quota/ledger?limit=5&offset=0" -H "$UAUTH")
LED2=$(curl -s "$BASE/api/me/quota/ledger?limit=5&offset=5" -H "$UAUTH")
assert_contains "余量明细返回总数" "$LED1" '"total":'
assert_contains "余量明细返回分页条目" "$LED1" '"entries":'
assert_contains "第二页可独立请求" "$LED2" '"entries":'

say "== 服务器状态看板 =="
SYS=$(curl -s "$BASE/api/admin/system" -H "$AUTH")
assert_contains "系统接口返回服务器信息" "$SYS" '"phpVersion"'
assert_contains "系统接口返回磁盘信息" "$SYS" '"freeBytes"'
assert_contains "系统接口返回存储分类" "$SYS" '"storage"'
assert_contains "统计在线用户" "$SYS" '"online"'
assert_contains "统计总用户" "$SYS" '"total":'
assert_contains "统计今日调用" "$SYS" '"today"'
assert_contains "统计对话总数" "$SYS" '"chats"'
assert_contains "返回版本号" "$SYS" '"version"'
# 虚拟主机配额字段:开发机没有 cgroup 时各值为 null,但键必须在,前端才能按层兜底
assert_has "系统接口返回配额字段" "$SYS" '"quota":{'
assert_has "配额字段带来源" "$SYS" '"source":'
assert_has "配额字段带内存上限" "$SYS" '"memLimitBytes":'
assert_has "配额字段带 CPU 百分比" "$SYS" '"cpuPercent":'
# 服务器状态块自带网速 / 运行时长 / 数据库体积(整机 /proc 取不到时为 null,键必须在)
assert_has "系统接口返回网速字段" "$SYS" '"net":{'
assert_has "网速含上下行速率" "$SYS" '"txBps":'
assert_has "网速含累计流量" "$SYS" '"rxBytes":'
assert_has "系统接口返回运行时长" "$SYS" '"uptime":{"systemSec":'
assert_has "系统接口返回数据库体积" "$SYS" '"db":{"bytes":'
# 非管理员不可访问
assert_contains "非管理员访问系统接口被拒" "$(curl -s "$BASE/api/admin/system" -H "$UAUTH")" '需要管理员权限'
assert_contains "非管理员访问存储接口被拒" "$(curl -s "$BASE/api/admin/storage" -H "$UAUTH")" '需要管理员权限'

say "== 模型连通性测试(超时与自动跳过) =="
# 正常模型:mock 上游据模型名返回内容
assert_contains "模型测试通过" "$(curl -s -X POST "$BASE/api/admin/providers/test" -H "$AUTH" -H "Content-Type: application/json" -d "{\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/v1\",\"apiKey\":\"sk-e2e\",\"apiFormat\":\"chat\",\"model\":\"mock-model\",\"prompt\":\"hi\",\"timeoutSec\":10}")" '"ok":true'
# 自定义超时:连一个不会响应的地址(TEST-NET),必须在超时后返回 timeout 标记
T0=$(date +%s)
TIMEOUT_RES=$(curl -s -X POST "$BASE/api/admin/providers/test" -H "$AUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://192.0.2.1/v1","apiKey":"sk-e2e","apiFormat":"chat","model":"slow-model","prompt":"hi","timeoutSec":3}')
T1=$(date +%s)
assert_has "超时结果带 timeout 标记" "$TIMEOUT_RES" '"timeout":true'
assert_has "超时说明包含设定的秒数" "$TIMEOUT_RES" '超过 3 秒仍未响应'
ELAPSED=$((T1 - T0))
if [ "$ELAPSED" -le 15 ]; then ok "超时按设定时长结束(耗时 ${ELAPSED}s)"; else bad "超时未生效,耗时 ${ELAPSED}s"; fi
# 超出范围的超时值被收敛到合法区间(不会因为传 0 或超大值卡住)
assert_has "超时下限被夹紧到 3 秒" "$(curl -s -X POST "$BASE/api/admin/providers/test" -H "$AUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://192.0.2.1/v1","apiKey":"sk-e2e","apiFormat":"chat","model":"m","prompt":"hi","timeoutSec":0}')" '超过 3 秒仍未响应'
say "== 存储管理 =="
ST=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "存储接口返回分类占用" "$ST" '"categories"'
assert_contains "存储接口返回数据目录" "$ST" '"dataDir"'
assert_contains "存储接口返回备份清单" "$ST" '"backups"'
assert_contains "存储接口返回生图留存清单" "$ST" '"images"'
assert_contains "存储接口返回日志统计" "$ST" '"logs"'
assert_contains "分类含数据库" "$ST" '"key":"database"'
assert_contains "分类含生图留存" "$ST" '"key":"imgstore"'
assert_contains "分类含运行日志" "$ST" '"key":"logs"'
# 时间戳是毫秒(前端直接 new Date 即可,避免 1970 显示)
assert_contains "文件时间戳为毫秒" "$(printf '%s' "$ST" | grep -o '"mtime":[0-9]\{13\}' | head -1)" '"mtime":'
# 未知清理目标应报错
cat > "$TMP/st_bad.json" <<'EOF'
{"target":"nope"}
EOF
assert_contains "未知清理目标被拒" "$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_bad.json")" '未知的清理目标'
# 写入图片缓存与生图留存文件,验证清理真实生效
mkdir -p "$TMP/data/imgcache" "$TMP/data/imgstore"
php -r '$d=$argv[1];file_put_contents($d."/imgcache/e2e-cache.bin",str_repeat("x",2048));file_put_contents($d."/imgstore/e2e-img.bin",str_repeat("y",4096));' "$TMP/data"
ST2=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "生图留存清单可读" "$ST2" '"images":{"items":'
assert_contains "写入的生图留存文件出现在清单" "$ST2" 'e2e-img.bin'
cat > "$TMP/st_imgcache.json" <<'EOF'
{"target":"imagecache"}
EOF
CL1=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_imgcache.json")
assert_contains "清理图片缓存成功" "$CL1" '"ok":true'
assert_contains "清理图片缓存统计到 1 个文件" "$CL1" '"removed":1'
assert_contains "清理后缓存占用归零" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" '"key":"imgcache"'
cat > "$TMP/st_images.json" <<'EOF'
{"target":"images"}
EOF
CL2=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_images.json")
assert_contains "清理生图留存成功" "$CL2" '"ok":true'
assert_contains "生图留存清理标签正确" "$CL2" '"label":"生图留存"'
cat > "$TMP/st_logs.json" <<'EOF'
{"target":"logs"}
EOF
assert_contains "清理运行日志成功" "$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_logs.json")" '"ok":true'
# 更新残留:目录里含子目录(真实结构是 update/backup/lib/... + update/package/...)。
# 递归删除曾因闭包未 use 自身而致命失败(「更新残留清理不了」),这里专门覆盖多级嵌套。
mkdir -p "$TMP/data/update/backup/lib" "$TMP/data/update/package/src" "$TMP/data/imgcache/nested/deep"
php -r '$d=$argv[1];
file_put_contents($d."/update/update-check.json","root");
file_put_contents($d."/update/backup/lib/core.php","backup-a");
file_put_contents($d."/update/backup/CHANGELOG.md","backup-b");
file_put_contents($d."/update/package/src/index.php","pkg");
file_put_contents($d."/imgcache/nested/deep/cache.bin","cache");' "$TMP/data"
ST3=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "多级子目录文件被计入占用" "$ST3" '"key":"update"'
cat > "$TMP/st_updates.json" <<'EOF'
{"target":"updates"}
EOF
CL3=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_updates.json")
assert_contains "更新残留(含子目录)清理成功" "$CL3" '"ok":true'
assert_contains "更新残留递归删到 4 个文件(含两级子目录)" "$CL3" '"removed":4'
assert_contains "更新残留标签正确" "$CL3" '"label":"更新残留"'
assert_contains "更新残留清理后归零" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" '"key":"update"'
# 图片代理缓存的子目录同样要能清掉
cat > "$TMP/st_ic2.json" <<'EOF'
{"target":"imagecache"}
EOF
CL4=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_ic2.json")
assert_contains "图片缓存(含子目录)清理成功" "$CL4" '"ok":true'
assert_contains "图片缓存递归删到 1 个文件" "$CL4" '"removed":1'
# 系统接口在清理后依然可用(不因日志/缓存被清而 500)
assert_contains "清理后系统接口仍正常" "$(curl -s "$BASE/api/admin/system" -H "$AUTH")" '"server"'

# ---------- AI 笔记 ----------
say "== AI 笔记:文档同步 =="
# 初始为空:folders/notes 都是空数组,tombs 是空对象
NOTES0=$(curl -s "$BASE/api/sync/notes" -H "$AUTH")
assert_has "初始笔记文档为空" "$NOTES0" '"notes":[]'
assert_contains "初始修订号为 0" "$NOTES0" '"revision":0'
# 未登录访问被拒
assert_contains "笔记同步需要登录" "$(curl -s "$BASE/api/sync/notes")" '未登录'
# 推送一份文档(一个文件夹 + 一篇笔记)
cat > "$TMP/notes1.json" <<'EOF'
{"baseRevision":0,"doc":{"folders":[{"id":"f1","parentId":null,"name":"技术","createdAt":1000,"updatedAt":1000}],"notes":[{"id":"n1","folderId":"f1","title":"SQLite 要点","content":"# 要点\n\n- WAL 模式\n- 单表快照","tags":["php","sqlite"],"isPinned":true,"shareMode":"private","createdAt":1000,"updatedAt":1000}],"tombs":{}}}
EOF
NS1=$(curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes1.json")
assert_contains "笔记文档推送成功" "$NS1" '"revision":1'
# baseRevision 过期 → 409 并带回云端文档
cat > "$TMP/notes-stale.json" <<'EOF'
{"baseRevision":0,"doc":{"folders":[],"notes":[],"tombs":{}}}
EOF
STALE=$(curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes-stale.json")
assert_contains "过期修订号冲突返回 409" "$STALE" '笔记已在其他页面更新'
assert_contains "冲突响应带回云端文档" "$STALE" 'SQLite 要点'
# 拉取可见推送内容
NOTES1=$(curl -s "$BASE/api/sync/notes" -H "$AUTH")
assert_contains "云端文档含文件夹" "$NOTES1" '技术'
assert_contains "云端文档含笔记" "$NOTES1" 'SQLite 要点'
# 分享状态列表随同步返回
assert_has "同步返回分享状态字段" "$NOTES1" '"shares":[]'

say "== AI 笔记:附件上传与签名输出 =="
python -c "import base64,sys; open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))" "$TMP/pixel.png"
printf 'PK\003\004fake-zip' > "$TMP/archive.zip"
# 原生 curl 读不了 -F 里 MSYS 风格的 /tmp 路径:与文档解析用例一致,进 $TMP 用相对路径发起
UP=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@pixel.png;type=image/png" ) )
assert_contains "图片上传成功返回签名 URL" "$UP" '/api/notes/file?id='
FURL=$(printf '%s' "$UP" | jget url | sed 's#\\/#/#g')
assert_contains "属主可读取附件" "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE$FURL")" "200"
assert_contains "图片内联输出正确 Content-Type" "$(curl -s -D - -o /dev/null -H "$AUTH" "$BASE$FURL")" "image/png"
# 图片不得带 attachment(预览要能直接显示)
if curl -s -D - -o /dev/null -H "$AUTH" "$BASE$FURL" | grep -qi 'content-disposition: attachment'; then bad "图片不应强制下载"; else ok "图片为内联输出(可直接预览)"; fi
# 签名被篡改 → 403(把签名首字符翻转成必然不同的值,避免与原签名恰好相同)
SIG="${FURL##*&s=}"; SIG="${SIG%%&*}"
FLIP="0"; [ "${SIG:0:1}" = "0" ] && FLIP="1"
BADSIG="$FLIP${SIG:1}"
BADURL="${FURL/&s=$SIG/&s=$BADSIG}"
if curl -s -o /dev/null -w '%{http_code}' "$BASE$BADURL" | grep -q '403'; then ok "签名被篡改返回 403"; else bad "签名被篡改返回 403"; fi
# 通用文件上传(zip):非图片一律强制下载,避免被当作图床/网页外链托管
UZ=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@archive.zip" ) )
assert_has "通用文件上传成功" "$UZ" '/api/notes/file?id='
ZURL=$(printf '%s' "$UZ" | jget url | sed 's#\\/#/#g')
ZURLID=$(printf '%s' "$UZ" | jget id)
assert_contains "非图片强制附件下载" "$(curl -s -D - -o /dev/null -H "$AUTH" "$BASE$ZURL")" "Content-Disposition: attachment"
assert_contains "非图片类型标注正确" "$(curl -s -D - -o /dev/null -H "$AUTH" "$BASE$ZURL")" "application/zip"
# 附件身份鉴权:复制链接给他人 / 未登录访问一律 404(不暴露存在性)
assert_contains "未登录访问附件被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$FURL")" "404"
assert_contains "未登录访问附件不暴露内容" "$(curl -s "$BASE$FURL")" '附件不存在'
# 另一个已登录用户同样被拒
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"notemate","password":"notemate123","quota":10}' > /dev/null
NMT=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"notemate","password":"notemate123"}' | jget token)
assert_contains "其他已登录用户访问附件被拒" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NMT" "$BASE$FURL")" "404"

# 浏览器加载正文里的 <img>/<a> 不会带 Authorization 头(登录态是 localStorage 里的
# Bearer 令牌,不是 Cookie),所以任一「已鉴权请求」都会补发一枚只对该路由有效的
# 附件 Cookie;没有它,笔记预览区永远是裂图(浏览器侧验证见 tests/notes-image-gui.mjs)。
CKJAR="$TMP/ck-admin.txt"
CKHDR=$(curl -s -D - -o /dev/null -c "$CKJAR" -H "$AUTH" "$BASE/api/auth/me")
assert_has "已鉴权请求补发附件 Cookie" "$CKHDR" 'tc_note_attach='
assert_contains "Cookie 作用路径收窄到附件路由" "$CKHDR" 'path=/api/notes/file'
assert_contains "Cookie 为 HttpOnly(脚本读不到)" "$CKHDR" 'HttpOnly'
assert_contains "只带附件 Cookie 即可读取自己的附件" "$(curl -s -o /dev/null -w '%{http_code}' -b "$CKJAR" "$BASE$FURL")" "200"
# 写操作仍只认请求头:Cookie 不能用来删附件(否则等于给跨站请求开了口子)
CKDEL=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@pixel.png;type=image/png" ) )
CKDELID=$(printf '%s' "$CKDEL" | jget id)
CKDELURL=$(printf '%s' "$CKDEL" | jget url | sed 's#\\/#/#g')
assert_contains "附件 Cookie 不能用于删除" "$(curl -s -o /dev/null -w '%{http_code}' -b "$CKJAR" -X DELETE "$BASE/api/notes/file?id=$CKDELID")" "401"
assert_contains "附件仍在自己名下(未被上面的 Cookie 删除)" "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE$CKDELURL")" "200"
# 他人的附件 Cookie 换不来本附件的读取权限
NCJAR="$TMP/ck-mate.txt"
curl -s -o /dev/null -c "$NCJAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"notemate","password":"notemate123"}'
assert_contains "他人附件 Cookie 不能读取本附件" "$(curl -s -o /dev/null -w '%{http_code}' -b "$NCJAR" "$BASE$FURL")" "404"
# 退出登录即作废:共享设备换人后不能靠旧 Cookie 继续读
curl -s -o /dev/null -b "$CKJAR" -c "$CKJAR" -X POST "$BASE/api/auth/logout" -H "$AUTH"
assert_contains "退出登录后附件 Cookie 失效" "$(curl -s -o /dev/null -w '%{http_code}' -b "$CKJAR" "$BASE$FURL")" "404"

# 附件按用户 ID 分目录存储(不再堆在单一目录)
NSDIR=$(ls "$TMP/data/notes" 2>/dev/null | grep -v '^index.json$' | head -1)
if [ -n "$NSDIR" ]; then ok "附件按用户 ID 分目录存储($NSDIR)"; else bad "附件按用户 ID 分目录存储"; fi
# 空间用量接口
USAGE=$(curl -s "$BASE/api/notes/usage" -H "$AUTH")
assert_contains "用量接口返回剩余配额" "$USAGE" '"quota":'
assert_contains "用量接口返回已用字节" "$USAGE" '"used":'

say "== AI 笔记:分享链接 =="
# view-link:创建分享 → 匿名可读 → 页面路由可达 → edit 被拒 → 关闭后失效
SH1=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"n1","mode":"view-link"}')
assert_contains "创建 view-link 分享" "$SH1" '"url":"\/n\/'
NTOK=$(printf '%s' "$SH1" | jget token)
assert_contains "分享链接匿名可读" "$(curl -s "$BASE/api/notes/shared/$NTOK")" 'SQLite 要点'
assert_contains "分享响应标记不可编辑" "$(curl -s "$BASE/api/notes/shared/$NTOK")" '"editable":false'
assert_contains "分享页 /n/ 路由可达" "$(curl -s "$BASE/n/$NTOK")" '笔记分享'
assert_contains "view-link 拒绝在线编辑" "$(curl -s -X POST "$BASE/api/notes/shared/$NTOK" -H "Content-Type: application/json" -d '{"title":"黑掉这篇"}')" '只允许查看'
# 重新生成 → 旧链接失效
SH2=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"n1","mode":"view-link"}')
NTOK2=$(printf '%s' "$SH2" | jget token)
if [ "$NTOK" != "$NTOK2" ]; then ok "重新生成产生新令牌"; else bad "重新生成产生新令牌"; fi
if curl -s "$BASE/api/notes/shared/$NTOK" | grep -q '分享不存在'; then ok "旧令牌已失效"; else bad "旧令牌已失效"; fi
# edit-link:匿名可编辑属主笔记(最后写入胜出);中文体走 heredoc,避免控制台码页问题
SH3=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"n1","mode":"edit-link"}')
NTOK3=$(printf '%s' "$SH3" | jget token)
cat > "$TMP/note-edit.json" <<'EOF'
{"title":"SQLite 要点(修订)","content":"# 要点(经分享链接修订)"}
EOF
ED1=$(curl -s -X POST "$BASE/api/notes/shared/$NTOK3" -H "Content-Type: application/json" --data-binary @"$TMP/note-edit.json")
assert_contains "edit-link 匿名编辑成功" "$ED1" 'SQLite 要点(修订)'
assert_contains "编辑响应标记可编辑" "$ED1" '"editable":true'
assert_contains "属主侧读到修订后内容" "$(curl -s "$BASE/api/sync/notes" -H "$AUTH")" '经分享链接修订'
# 关闭分享 → 链接失效,笔记回到 private
assert_contains "关闭分享成功" "$(curl -s -X DELETE "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"n1"}')" '"ok":true'
if curl -s "$BASE/api/notes/shared/$NTOK3" | grep -q '分享不存在'; then ok "关闭后链接失效"; else bad "关闭后链接失效"; fi
assert_contains "笔记分享状态复位" "$(curl -s "$BASE/api/sync/notes" -H "$AUTH")" '"shareMode":"private"'
# 不存在的笔记分享被拒
assert_contains "分享不存在的笔记被拒" "$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"ghost","mode":"view-link"}')" '笔记不存在'

say "== AI 笔记:管理端 =="
AN=$(curl -s "$BASE/api/admin/notes" -H "$AUTH")
assert_has "管理端列出使用笔记的用户" "$AN" '"users":['
assert_has "管理端返回用户笔记数" "$AN" '"notes":'
assert_contains "管理端返回附件用量" "$AN" '"totalUsed":'
assert_contains "管理端返回空间上限" "$AN" '"quota":'
# 审阅某用户笔记(取当前管理员的 userId)
AUID=$(curl -s "$BASE/api/auth/me" -H "$AUTH" | jget id)
AV=$(curl -s "$BASE/api/admin/notes/view?userId=$AUID" -H "$AUTH")
assert_contains "审阅接口返回该用户笔记" "$AV" 'SQLite 要点'
# 普通用户被拒
assert_contains "普通用户不能访问笔记管理" "$(curl -s "$BASE/api/admin/notes" -H "$UAUTH")" '需要管理员权限'
# 设置项可保存并下发
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesQuotaMb":321,"notesMaxFileMb":12,"notesAllowFiles":true}' > /dev/null
ASET=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_contains "笔记空间上限已保存" "$ASET" '"notesQuotaMb":321'
assert_contains "单附件上限已保存" "$ASET" '"notesMaxFileMb":12'
assert_contains "公开配置下发笔记开关" "$(curl -s "$BASE/api/config")" '"notesEnabled":true'
assert_contains "用量接口读取新配额" "$(curl -s "$BASE/api/notes/usage" -H "$AUTH")" '"quota":336592896'
# 关闭笔记功能后接口拒绝写入,公开配置同步
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesEnabled":false}' > /dev/null
assert_contains "关闭后同步接口被拒" "$(curl -s "$BASE/api/sync/notes" -H "$AUTH")" '未开放 AI 笔记功能'
assert_contains "关闭后公开配置同步" "$(curl -s "$BASE/api/config")" '"notesEnabled":false'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesEnabled":true}' > /dev/null
# (恢复功能后再验证分享策略,否则同步接口仍被总开关拒绝)
# 分享策略:仅正文时,正文里的附件引用被裁剪,附件不随分享暴露
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":true}' > /dev/null
AUID2=$(curl -s "$BASE/api/auth/me" -H "$AUTH" | jget id)
IMGREF=$(printf '%s' "$UP" | jget url | sed 's#\\/#/#g')
cat > "$TMP/notes-bodyonly.json" <<EOF
{"baseRevision":$(curl -s "$BASE/api/sync/notes" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['revision'])"),"doc":{"folders":[{"id":"fb","parentId":null,"name":"分享测试","createdAt":1,"updatedAt":1}],"notes":[{"id":"nb","folderId":"fb","title":"含图笔记","content":"正文。\n\n![图]($IMGREF)\n\n结尾。","tags":[],"isPinned":false,"shareMode":"private","createdAt":1,"updatedAt":1}],"tombs":{}}}
EOF
curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes-bodyonly.json" > /dev/null
SHT=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nb","mode":"view-link"}' | python -c "import sys,json;print(json.load(sys.stdin)['share']['token'])")
SB=$(curl -s "$BASE/api/notes/shared/$SHT")
assert_contains "仅正文:分享标记 bodyOnly" "$SB" '"bodyOnly":true'
if printf '%s' "$SB" | grep -qF '/api/notes/file'; then bad "仅正文时正文内不应残留附件链接"; else ok "仅正文:正文内附件链接已裁剪"; fi
assert_contains "仅正文:给出未显示提示" "$SB" '未在分享中显示'
# 关闭该策略后,引用与附件随分享可见
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":false}' > /dev/null
SB2=$(curl -s "$BASE/api/notes/shared/$SHT")
assert_contains "关闭后分享标记 bodyOnly=false" "$SB2" '"bodyOnly":false'
assert_contains "关闭后正文保留附件引用" "$SB2" '/api/notes/file'
# 附件通过分享下载:仅在「已分享 + 管理员关闭仅正文」时放行,其余一律 404
AUIDX=$(curl -s "$BASE/api/auth/me" -H "$AUTH" | jget id)
SPZ=$(printf '%s' "$UZ" | jget url | sed 's#\\/#/#g')
cat > "$TMP/notes-share-att.json" <<EOF
{"baseRevision":$(curl -s "$BASE/api/sync/notes" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['revision'])"),"doc":{"folders":[{"id":"fsa","parentId":null,"name":"附件分享","createdAt":1,"updatedAt":1}],"notes":[{"id":"nsa","folderId":"fsa","title":"带附件笔记","content":"附件：[文件]($SPZ)\n","tags":[],"isPinned":false,"shareMode":"private","createdAt":1,"updatedAt":1}],"tombs":{}}}
EOF
curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes-share-att.json" > /dev/null
# 上传时声明所属笔记(前端上传会带 noteId)
UZ2=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@archive.zip" -F "noteId=nsa" ) )
Z2=$(printf '%s' "$UZ2" | jget url | sed 's#\\/#/#g')
SAT=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nsa","mode":"view-link"}' | python -c "import sys,json;print(json.load(sys.stdin)['share']['token'])")
# 仅正文=开:分享页带令牌也不放行
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":true}' > /dev/null
assert_contains "仅正文时分享页也取不到附件" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$Z2&share=$SAT")" "404"
# 关闭仅正文:分享页凭令牌可取
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":false}' > /dev/null
assert_contains "关闭仅正文后分享页可下载附件" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$Z2&share=$SAT")" "200"
assert_contains "伪造分享令牌仍被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$Z2&share=deadbeef")" "404"
# 非属主即使拿到链接与真实令牌之外的信息也取不到(无令牌)
assert_contains "无令牌的其他用户仍被拒" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NMT" "$BASE$Z2")" "404"

say "== AI 笔记:附件删除/回收、魔数校验、超长与分享有效期 =="
# 伪造图片:HTML 内容配 .png 扩展名,应被魔数校验拒绝
printf '<html><script>alert(1)</script></html>' > "$TMP/fake.png"
FAKE=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@fake.png;type=image/png" ) )
assert_contains "伪装成图片的 HTML 被拒" "$FAKE" '文件内容与图片格式不符'
# 真实 PNG 仍可上传(regression)
OKP=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@pixel.png;type=image/png" ) )
assert_has "真实图片仍可上传" "$OKP" '/api/notes/file?id='
OKID=$(printf '%s' "$OKP" | jget id)
# 删除自己的附件:成功且配额回落
DELB=$(curl -s "$BASE/api/notes/usage" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['used'])")
assert_contains "删除自己的附件成功" "$(curl -s -X DELETE "$BASE/api/notes/file?id=$OKID" -H "$AUTH")" '"ok":true'
DELA=$(curl -s "$BASE/api/notes/usage" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['used'])")
if [ "$DELA" -lt "$DELB" ]; then ok "删除附件后已用配额下降($DELB→$DELA)"; else bad "删除附件后配额未下降"; fi
# 删除后不可再读,且他人无法删除
assert_contains "删除后附件不可读" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notes/file?id=$OKID&s=deadbeef")" "403"
assert_contains "他人不能删除他人附件" "$(curl -s -X DELETE "$BASE/api/notes/file?id=$ZURLID" -H "Authorization: Bearer $NMT")" '附件不存在'
# 孤儿回收:再传一个不绑定笔记的附件,GC 后应被清掉
ORPH=$( ( cd "$TMP" && curl -s -X POST "$BASE/api/notes/upload" -H "$AUTH" -F "file=@pixel.png;type=image/png" ) )
ORPHID=$(printf '%s' "$ORPH" | jget id)
GC=$(curl -s -X POST "$BASE/api/notes/files/gc" -H "$AUTH")
assert_contains "孤儿附件回收成功" "$GC" '"ok":true'
assert_contains "回收释放了字节数" "$GC" '"freed":'
assert_contains "孤儿附件已被清理" "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/notes/file?id=$ORPHID&s=$(python -c "import hashlib,hmac;print('x')")")" "403"
# 超长笔记:明确报错而不是静默截断
python -c "import json,sys; print(json.dumps({'baseRevision':0,'doc':{'folders':[],'notes':[{'id':'big1','folderId':'uncat','title':'超大','content':'x'*500001,'tags':[],'isPinned':False,'shareMode':'private','createdAt':1,'updatedAt':1}],'tombs':{}}}))" > "$TMP/huge.json"
BIGREV=$(curl -s "$BASE/api/sync/notes" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['revision'])")
sed -i "s/\"baseRevision\": *0/\"baseRevision\": $BIGREV/" "$TMP/huge.json"
assert_contains "超长笔记明确报错" "$(curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/huge.json")" '字符上限'
# 分享有效期:1 天
EXPREV=$(curl -s "$BASE/api/sync/notes" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['revision'])")
python -c "
import json, io
d = json.load(io.open('$TMP/notes-bodyonly.json')) if False else None
"
cat > "$TMP/notes-exp.json" <<EOF
{"baseRevision":$EXPREV,"doc":{"folders":[{"id":"fexp","parentId":null,"name":"有效期","createdAt":1,"updatedAt":1}],"notes":[{"id":"nexp","folderId":"fexp","title":"有效期笔记","content":"用于验证分享有效期。","tags":[],"isPinned":false,"shareMode":"private","createdAt":1,"updatedAt":1}],"tombs":{}}}
EOF
curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes-exp.json" > /dev/null
SHX=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nexp","mode":"view-link","expireDays":1}')
assert_contains "分享返回有效期" "$SHX" '"expireAt":'
XT=$(printf '%s' "$SHX" | jget token)
assert_contains "带有效期的分享可正常访问" "$(curl -s "$BASE/api/notes/shared/$XT")" '用于验证分享有效期'
assert_contains "分享列表带有效期" "$(curl -s "$BASE/api/sync/notes" -H "$AUTH")" '"expireAt":'
curl -s -X DELETE "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nexp"}' > /dev/null

# 演示管理员:不可查看用户笔记列表 / 审阅 / 清理
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoa1","password":"demoa12345","quota":50,"admin":true,"demo":true}' > /dev/null
DMT=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"demoa1","password":"demoa12345"}' | jget token)
assert_contains "演示管理员不可查看笔记用户列表" "$(curl -s "$BASE/api/admin/notes" -H "Authorization: Bearer $DMT")" '演示管理员不可查看用户笔记'
assert_contains "演示管理员不可审阅用户笔记" "$(curl -s "$BASE/api/admin/notes/view?userId=$AUID" -H "Authorization: Bearer $DMT")" '演示管理员不可查看用户笔记'
assert_contains "演示管理员不可清理用户笔记" "$(curl -s -X POST "$BASE/api/admin/notes/purge" -H "Authorization: Bearer $DMT" -H "Content-Type: application/json" -d "{\"userId\":\"$AUID\"}")" '演示管理员不能清理用户笔记'
assert_has "真实管理员仍可查看笔记用户" "$(curl -s "$BASE/api/admin/notes" -H "$AUTH")" '"users":['

# 笔记 AI 配额:每日上限与计数
AUSD=$(curl -s "$BASE/api/notes/usage" -H "$AUTH")
assert_contains "用量接口返回 AI 每日上限" "$AUSD" '"aiDailyLimit":'
assert_contains "用量接口返回今日 AI 已用" "$AUSD" '"aiUsedToday":'
assert_contains "用量接口返回可自定义开关" "$AUSD" '"aiCustomizable":'
assert_contains "AI 配额扣减成功" "$(curl -s -X POST "$BASE/api/notes/ai/consume" -H "$AUTH")" '"ok":true'
assert_contains "公开配置下发 AI 可自定义" "$(curl -s "$BASE/api/config")" '"notesAiCustomizable":true'
# 上限设为 0(不限)与恢复
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesAiDailyLimit":0}' > /dev/null
assert_contains "AI 上限可设为不限" "$(curl -s "$BASE/api/notes/usage" -H "$AUTH")" '"aiDailyLimit":0'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesAiDailyLimit":50}' > /dev/null
# 上限设为 1 时第二次应被拒
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesAiDailyLimit":1}' > /dev/null
curl -s -X POST "$BASE/api/notes/ai/consume" -H "$AUTH" > /dev/null
assert_contains "超出每日 AI 上限被拒" "$(curl -s -X POST "$BASE/api/notes/ai/consume" -H "$AUTH")" '今日笔记 AI 次数已用完'
assert_contains "被拒后用量接口反映已用" "$(curl -s "$BASE/api/notes/usage" -H "$AUTH")" '"aiUsedToday":1'

# 笔记 AI 用途标签:调用后余量明细应出现「AI 笔记编辑/问答」等可读用途
curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"notemate","quota":100,"groupId":null}' > /dev/null || true
NMT2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"notemate","password":"notemate123"}' | jget token)
PUP=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d "{\"name\":\"e2e-note-bill\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/v1\",\"apiKey\":\"k\",\"apiFormat\":\"chat\",\"scope\":\"global\",\"costPerCall\":3,\"models\":[{\"id\":\"e2e-bill\",\"name\":\"b\",\"enabled\":true}],\"enabled\":true}" | python -c "import sys,json;print(json.load(sys.stdin).get('provider',{}).get('id',''))")
if [ -n "$PUP" ]; then
  curl -s -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $NMT2" -H "Content-Type: application/json" -d "{\"model\":\"e2e-bill\",\"providerId\":\"$PUP\",\"stream\":false,\"_purpose\":\"note-edit\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" > /dev/null
  LED=$(curl -s "$BASE/api/me/quota/ledger?limit=5" -H "Authorization: Bearer $NMT2")
  assert_contains "笔记 AI 调用写入余量明细" "$LED" 'AI 笔记编辑'
  assert_contains "明细含扣费金额" "$LED" '"amount":-3'

say "== AI 笔记:分享管理(保留令牌改设置) =="
# 建一篇带分享的笔记
PMREV=$(curl -s "$BASE/api/sync/notes" -H "$AUTH" | python -c "import sys,json;print(json.load(sys.stdin)['revision'])")
cat > "$TMP/notes-shm.json" <<EOF
{"baseRevision":$PMREV,"doc":{"folders":[{"id":"fshm","parentId":null,"name":"分享管理","createdAt":1,"updatedAt":1}],"notes":[{"id":"nshm","folderId":"fshm","title":"分享管理笔记","content":"正文内容","tags":[],"isPinned":false,"shareMode":"private","createdAt":1,"updatedAt":1}],"tombs":{}}}
EOF
curl -s -X POST "$BASE/api/sync/notes" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/notes-shm.json" > /dev/null
SH1=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nshm","mode":"view-link","expireDays":7}')
TOK1=$(printf '%s' "$SH1" | jget token)
assert_contains "创建分享返回有效期" "$SH1" '"expireAt":'
assert_contains "新建分享 kept=false" "$SH1" '"kept":false'
# keepToken 修改设置:令牌应保持不变
SH2=$(curl -s -X POST "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nshm","mode":"edit-link","expireDays":30,"keepToken":true}')
TOK2=$(printf '%s' "$SH2" | jget token)
assert_contains "keepToken 返回 kept=true" "$SH2" '"kept":true'
if [ "$TOK1" = "$TOK2" ]; then ok "修改设置后链接不变($TOK1)"; else bad "修改设置后链接被更换"; fi
assert_contains "权限已改为可编辑" "$SH2" '"mode":"edit-link"'
assert_contains "旧链接仍可访问" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notes/shared/$TOK1")" "200"
# 分享列表带有效期(供管理界面展示)
assert_contains "分享列表含有效期字段" "$(curl -s "$BASE/api/sync/notes" -H "$AUTH")" '"expireAt":'
# 取消分享
curl -s -X DELETE "$BASE/api/notes/share" -H "$AUTH" -H "Content-Type: application/json" -d '{"noteId":"nshm"}' > /dev/null
assert_contains "取消后链接失效" "$(curl -s "$BASE/api/notes/shared/$TOK1")" '分享不存在'
  curl -s -X DELETE "$BASE/api/providers/$PUP" -H "$AUTH" > /dev/null
else bad "建测试供应商失败"; fi
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesAiDailyLimit":50}' > /dev/null
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":true}' > /dev/null
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"notesShareBodyOnly":true}' > /dev/null


say "== 用户设置云同步 =="
# 未登录访问被拒
assert_contains "设置同步需要登录" "$(curl -s "$BASE/api/sync/settings")" '未登录'
SET0=$(curl -s "$BASE/api/sync/settings" -H "$AUTH")
assert_has "初始偏好表为空" "$SET0" '"prefs":{}'
assert_contains "初始修订号为 0" "$SET0" '"revision":0'
assert_contains "默认开启设置云同步" "$SET0" '"syncSettings":true'
# 推送一份设置:偏好 + 布局 + 群聊 + 自定义字体 + 时间戳;故意混入越界值与垃圾键
cat > "$TMP/settings1.json" <<'EOF'
{"baseRevision":0,"settings":{"v":1,"prefs":{"theme":"dark","fontSize":18,"contextMessages":9999,"bogus":{"a":1},"futureFlag":true},"ui":{"sidebarWidth":320,"composerMode":"group","nope":"x"},"groups":{"groups":[{"id":"g1","name":"问题研讨","mode":"round","participants":[{"id":"p1","name":"群主","prompt":"你是群主","admin":true}]}],"activeId":"g1"},"fonts":{"我的字体":"@font-face{font-family:\"X\"}"},"tombs":{"groups.gone":1700000000000},"at":{"prefs.theme":1700000000000}}}
EOF
SS1=$(curl -s -X POST "$BASE/api/sync/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/settings1.json")
assert_contains "设置推送成功" "$SS1" '"revision":1'
SET1=$(curl -s "$BASE/api/sync/settings" -H "$AUTH")
assert_contains "云端保存主题" "$SET1" '"theme":"dark"'
assert_contains "云端保存字号" "$SET1" '"fontSize":18'
assert_contains "云端保存布局宽度" "$SET1" '"sidebarWidth":320'
assert_contains "云端保存模式" "$SET1" '"composerMode":"group"'
assert_contains "云端保存群聊配置" "$SET1" '问题研讨'
assert_contains "云端保存自定义字体" "$SET1" '我的字体'
assert_has "云端保留逐键时间戳" "$SET1" 'prefs.theme'
assert_has "云端保留删除墓碑" "$SET1" 'groups.gone'
assert_contains "越界数值被收敛" "$SET1" '"contextMessages":500'
if printf '%s' "$SET1" | grep -q '"bogus"'; then bad "非标量垃圾键被写入云端"; else ok "非标量垃圾键被丢弃"; fi
if printf '%s' "$SET1" | grep -q '"nope"'; then bad "未白名单的界面键被写入云端"; else ok "未白名单的界面键被丢弃"; fi
# baseRevision 过期 → 409 并带回云端设置
cat > "$TMP/settings-stale.json" <<'EOF'
{"baseRevision":0,"settings":{"prefs":{"theme":"light"}}}
EOF
STALES=$(curl -s -X POST "$BASE/api/sync/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/settings-stale.json")
assert_contains "过期修订号冲突返回 409" "$STALES" '设置已在其他设备更新'
assert_contains "冲突响应带回云端设置" "$STALES" '"theme":"dark"'
# 以最新修订号重推:成功且旧值被更新
SETREV=$(curl -s "$BASE/api/sync/settings" -H "$AUTH" | jget revision)
cat > "$TMP/settings2.json" <<EOF
{"baseRevision":$SETREV,"settings":{"prefs":{"theme":"light","fontSize":16}}}
EOF
assert_contains "按最新修订号重推成功" "$(curl -s -X POST "$BASE/api/sync/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/settings2.json")" '"ok":true'
assert_contains "重推后取到新值" "$(curl -s "$BASE/api/sync/settings" -H "$AUTH")" '"theme":"light"'
# 站点关闭设置云同步:接受请求但不落库(隐私开关,与 persistChats 同语义)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"syncSettings":false}' > /dev/null
OFF=$(curl -s -X POST "$BASE/api/sync/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"baseRevision":0,"settings":{"prefs":{"theme":"dark"}}}')
assert_contains "关闭后推送被忽略" "$OFF" '"syncSettings":false'
assert_contains "关闭后不写库" "$(curl -s "$BASE/api/sync/settings" -H "$AUTH")" '"theme":"light"'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"syncSettings":true}' > /dev/null

# ---------- 在线浏览器:服务端反向代理 ----------
# 目标站由 TC_WEB_FETCH_BASE 指向 mock 的 /page/*(与 TC_PAGE_FETCH_BASE 同一套约定):
# 被代理页面跑在 sandbox iframe 里,页面里所有地址都要回填成同源代理地址,否则用户浏览器会直连目标站。
# 另:站点默认开着「仅限访问中国 IP 网站」(webCnOnly),而 mock 跑在本机、解析结果不在境内,
# 所以这个实例用 TC_WEB_CN_ONLY=0 关掉该判定(在启动处)。这道判定本身由 tests/feature-access.php
# 用真实境内/境外网段单独覆盖,不在这里假装 mock 是境内站。
say ""
say "== 在线浏览器 =="
# base64url 编码(与 lib/web.php 的 tc_web_b64d 对应);用 php 保证跨平台一致
b64url() { php -r 'echo rtrim(strtr(base64_encode($argv[1]), "+/", "-_"), "=");' "$1"; }
assert_eq "/browser 返回会话页" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/browser")" "200"
TICKET_JSON=$(curl -s -X POST "$BASE/api/web/ticket" -H "$AUTH")
assert_contains "票据签发" "$TICKET_JSON" '"ticket":"'
TICKET=$(printf '%s' "$TICKET_JSON" | jget ticket)
assert_has "内置收藏夹含百度(默认站点以国内常用站为主)" "$TICKET_JSON" '百度'
assert_has "票据下发每日流量上限字段" "$TICKET_JSON" '"trafficLimitMb"'
assert_eq "未登录取票据被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/web/ticket")" "401"
PU=$(b64url "https://example.com/page/x")
wp=$(curl -s -D "$TMP/web.h" "$BASE/api/web/page?u=$PU&t=$TICKET")
assert_has "代理页面注入垫片配置" "$wp" 'window.__OCW'
assert_has "上游正文透传" "$wp" 'MOCK-PAGE-BODY-OK'
assert_has "站内链接改写到代理" "$wp" '/api/web/page?u='
if printf '%s' "$wp" | grep -qF 'href="/nav0"'; then bad "站内链接仍是原始地址"; else ok "站内链接已改写"; fi
if printf '%s' "$wp" | grep -qF '&amp;amp;'; then bad "属性被二次转义(t 参数失效)"; else ok "属性只转义一次"; fi
WEHHDR=$(cat "$TMP/web.h")
# 这里断言的**不是**「没有 X-Frame-Options」,而是「不是 DENY」。
# index.php 开头的 tc_send_cors() 会给每个响应发全局 `X-Frame-Options: DENY`,而 DENY
# 连本站自己的页面都嵌不了 —— 渲染被代理页的 iframe 正落在 /api/web/page 上,于是整页
# 被浏览器拦掉、界面一直空白。lib/web.php 显式写 SAMEORIGIN 把它覆盖回来才对。
# (一度以为 SAMEORIGIN 也会拦:sandbox 不带 allow-same-origin 看似成为非同源文档;
#  实测否定 —— 嵌它的父页面本身同源,SAMEORIGIN 放行,A/B 里 sandbox 与否结论一致。)
if printf '%s' "$WEHHDR" | grep -qi '^X-Frame-Options:[[:space:]]*DENY'; then
  bad "代理响应是 X-Frame-Options: DENY(iframe 里整页被拦,界面一直空白)"
elif printf '%s' "$WEHHDR" | grep -qi '^X-Frame-Options:[[:space:]]*SAMEORIGIN'; then
  ok "代理响应显式 SAMEORIGIN(覆盖全局 DENY,页面能渲染)"
else
  bad "代理响应没有 X-Frame-Options(会继承全局 DENY,页面渲染不出来)"
fi
assert_has "代理响应不缓存(避免跨用户串号)" "$WEHHDR" 'Cache-Control: no-store'
# 静态子资源短缓存:第一次出网、第二次命中本地。mock 每次请求的尾巴都是新的随机字节,
# 两次响应逐字节相同就证明第二次没有再出网(仅凭「200 且内容非空」证明不了缓存生效)。
CAU=$(b64url "https://example.com/page/cache-probe.png")
CR1=$(curl -s -D "$TMP/res1.h" "$BASE/api/web/res?u=$CAU&t=$TICKET")
CRH1=$(cat "$TMP/res1.h")
CR2=$(curl -s "$BASE/api/web/res?u=$CAU&t=$TICKET")
assert_has "静态子资源按图片类型透传" "$CRH1" 'Content-Type: image/png'
assert_has "静态子资源带私有缓存头" "$CRH1" 'Cache-Control: private, max-age='
assert_eq "第二次请求命中本地缓存(响应逐字节相同)" "$CR2" "$CR1"
# 按「这张图自己的缓存键落盘了」断言,不数目录里文件总数 —— 上面那个页面请求也会写入
# 自己的 HTML 缓存条目(top 上方 /page/x),数总数会把两件事混在一起。
CPKEY=$(php -r 'echo hash("sha256", $argv[1]);' "https://example.com/page/cache-probe.png")
if [ -f "$TMP/data/webcache/$CPKEY" ]; then ok "子资源缓存已落盘"; else bad "子资源缓存未落盘"; fi
# 带用户 cookie 的请求必须绕开缓存(同一地址对不同用户可能是个性化响应,复用就是串号)
CR3=$(curl -s "$BASE/api/web/res?u=$CAU&c=sid%3D1&t=$TICKET")
if [ -n "$CR3" ] && [ "$CR3" != "$CR1" ]; then ok "带 cookie 的子资源请求绕开缓存"; else bad "带 cookie 的请求仍命中缓存"; fi
assert_has "带 cookie 的子资源仍按图片类型透传" "$(curl -s -D - -o /dev/null "$BASE/api/web/res?u=$CAU&c=sid%3D1&t=$TICKET")" 'Content-Type: image/png'
assert_eq "伪造票据被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$PU&t=bad.ticket.sig")" "403"
# SSRF 闸门在测试钩子生效前先拦一道:内网/云元数据地址必须进不来
assert_eq "内网地址被 SSRF 闸门拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$(b64url 'http://169.254.169.254/latest/meta-data')&t=$TICKET")" "400"
# 变体写法与隧道路径:RFC6598 CGNAT、6to4 里藏 127.0.0.1、十进制 IP、本地文件协议
assert_eq "共享主机内网段(CGNAT)被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$(b64url 'http://100.64.0.1/')&t=$TICKET")" "400"
assert_eq "IPv6 隧道段藏内网被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$(b64url 'http://[2002:7f00:1::]/')&t=$TICKET")" "400"
assert_eq "十进制 IP 回环变体被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$(b64url 'http://2130706433/')&t=$TICKET")" "400"
assert_eq "本地文件协议被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$(b64url 'file:///etc/passwd')&t=$TICKET")" "400"
wr=$(curl -s "$BASE/api/web/read?u=$PU&t=$TICKET")
assert_contains "阅读模式抽到标题" "$wr" 'mock page'
assert_contains "阅读模式抽到正文" "$wr" '上海市气象局'
if printf '%s' "$wr" | grep -qF 'MOCK-SCRIPT-SHOULD-NOT-APPEAR'; then bad "正文混入脚本内容"; else ok "正文不含脚本内容"; fi
if printf '%s' "$wr" | grep -qF 'MOCK-COMMENT-SHOULD-NOT-APPEAR'; then bad "正文混入注释"; else ok "正文不含注释"; fi
assert_contains "内容超过上限时标记截断字段" "$wr" '"truncated"'
# 请求体走文件:Windows 的 curl 会把命令行参数里的非 ASCII 按本地码页重编码,
# 内联的中文收藏名会被送成别的字节(实测「站」变成 D5BE),断言就对不上了。
cat > "$TMP/web-bm.json" <<'EOF'
{"bookmarks":[{"name":"E2E 站","url":"example.org"},{"name":"","url":"bad"}]}
EOF
WBM=$(curl -s -X POST "$BASE/api/web/bookmarks" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/web-bm.json")
assert_contains "收藏夹保存并补全协议" "$WBM" '"url":"https://example.org"'
assert_contains "收藏夹读回一致" "$(curl -s "$BASE/api/web/bookmarks" -H "$AUTH")" 'E2E 站'
# 总开关:关闭后票据与代理都要拒绝(即便票据尚未过期)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"browserEnabled":false}' > /dev/null
assert_eq "关闭后票据接口拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/web/ticket" -H "$AUTH")" "403"
assert_eq "关闭后页面代理拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$PU&t=$TICKET")" "403"
# 子资源与阅读模式也必须一起关掉。子资源走的是「不读库」的快路径,一度只验签不判权限,
# 于是总开关关掉后页面 403、同一个票据的子资源却照常出网 —— 关一半等于没关。
assert_eq "关闭后子资源代理拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/res?u=$CAU&t=$TICKET")" "403"
assert_eq "关闭后阅读模式拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/read?u=$PU&t=$TICKET")" "403"
# 关掉后不能还能从缓存里取到东西(缓存命中必须排在权限判定之后)
assert_eq "关闭后子资源缓存不再命中" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/res?u=$CAU&t=$TICKET")" "403"
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"browserEnabled":true}' > /dev/null
assert_eq "重新开启后页面代理恢复" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/page?u=$PU&t=$TICKET")" "200"
assert_eq "重新开启后子资源代理恢复" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/res?u=$CAU&t=$TICKET")" "200"
assert_eq "重新开启后阅读模式恢复" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/read?u=$PU&t=$TICKET")" "200"
# 「仅管理员」同样要覆盖到子资源:只判页面的话,普通用户仍能拿别人的票据间接抓取任意子资源
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webAccess":"admin"}' > /dev/null
assert_eq "仅管理员时管理员子资源可用" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/web/res?u=$CAU&t=$TICKET")" "200"
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webAccess":"all"}' > /dev/null
assert_contains "公共配置暴露 browserEnabled" "$(curl -s "$BASE/api/config")" '"browserEnabled":true'
# 前台要靠这个字段区分「该站不在境内」与「服务器没装境内 IP 段数据」:
# 后者会让所有站点一起被拒,只说「该站点不在允许范围内」没法排查
assert_contains "公共配置暴露境内 IP 段数据就绪标记" "$(curl -s "$BASE/api/config")" '"webCnDataReady":true'
# 公共配置要下发「放行海外静态资源」开关与每日流量上限:前者是「百度等国内站打不开」的开关,
# 后者供前台展示今日剩余流量。
assert_contains "公共配置暴露放行海外静态资源开关" "$(curl -s "$BASE/api/config")" '"webCnAllowAssets":'
assert_contains "公共配置暴露每日流量上限" "$(curl -s "$BASE/api/config")" '"webDailyTrafficMb":'

# ---------- 登录弹窗与 /login 的能力对齐 ----------
# 主站登录弹窗(未登录点输入框时弹出)现在与 /login 同款:注册、找回密码、第三方登录。
# 这几项都由公共配置驱动,缺字段前台就不知道该露哪个入口:
#   allowRegister 决定要不要显示「立即注册」,passwordResetEnabled+mailReady 决定「忘记密码」。
# 用户协议启用时注册接口会拒掉没带 agreementAccepted 的请求,所以 agreementEnabled
# 必须下发 —— 否则注册表单不显示勾选框,用户填完永远失败。
assert_contains "公共配置暴露用户协议开关(注册勾选框据此显隐)" "$(curl -s "$BASE/api/config")" '"agreementEnabled":'
assert_contains "公共配置暴露是否开放注册" "$(curl -s "$BASE/api/config")" '"allowRegister":'
assert_contains "公共配置暴露找回密码开关" "$(curl -s "$BASE/api/config")" '"passwordResetEnabled":'
assert_contains "公共配置暴露邮件就绪标记" "$(curl -s "$BASE/api/config")" '"mailReady":'
# 邮箱验证开关:开启后注册接口会拒掉空邮箱,注册表单的邮箱要跟着从「可选」变必填 ——
# 前台拿不到这个字段,标签就会一直写着「(可选)」,用户照它留空提交只会吃一句后端报错。
assert_contains "公共配置暴露邮箱验证开关(注册邮箱据此去掉「可选」)" "$(curl -s "$BASE/api/config")" '"emailVerificationEnabled":'

# ---------- 每日流量上限 ----------
# 代理抓取的字节都算在本站出口上,按用户记账。把上限设成 0(不限)时永远放行;
# 设成极小值后新请求必须被拒,且返回的剩余流量字段要跟着变。
TRAFFIC0=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webDailyTrafficMb":0}')
assert_has "流量上限可设为 0(不限)" "$TRAFFIC0" '"webDailyTrafficMb":0'
WU0=$(curl -s "$BASE/api/web/usage" -H "$AUTH")
assert_has "不限流量时 dailyLimit 字段仍在" "$WU0" '"dailyLimit"'
# 上限设成 1MB:先取一次(会消耗流量),再把 mock 抓取灌到超限,随后新请求应 429。
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webDailyTrafficMb":1}' > /dev/null
WU1=$(curl -s "$BASE/api/web/usage" -H "$AUTH")
assert_has "设上限后 usage 下发流量字段" "$WU1" '"trafficLimitMb":1'
assert_has "usage 下发今日剩余流量" "$WU1" '"trafficRemainingMb"'
# 反复抓同一个不走缓存的地址,把 1MB 额度用光(mock 页面只有几百字节,但记账阈值按字节累加,
# 这里用带 cookie 的地址绕开缓存,确保每次都真出网并计数)。
for i in $(seq 1 40); do
  curl -s -o /dev/null "$BASE/api/web/page?u=$PU&t=$TICKET&c=probe=$i"
done
WU2=$(curl -s "$BASE/api/web/usage" -H "$AUTH")
assert_has "流量记账在多次抓取后仍返回数值字段" "$WU2" '"trafficRemainingMb"'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webDailyTrafficMb":500}' > /dev/null

# ---------- 会话内 @AI 召唤 ----------
# 会话内召唤走的是「有可用供应商」的分支:要先预扣额度,再把本会话最近若干条消息快照成上下文。
# 这段逻辑曾经在上下文快照处读了一个尚未赋值的变量,线上「@AI 回答」因此固定返回 500;
# 没有配供应商的冒烟用例进不到这个分支,所以这里用 mock 供应商把它走满。
say ""
say "== 会话内 @AI 召唤 =="
# 本段是最后一段注册:此时站点已开着「邀请码注册 + 同意用户协议」(见开头那条设置),
# 所以注册必须和前面几段一样带上邀请码与 agreementAccepted,否则用户建不出来、
# 后面所有用例都会因为拿不到令牌而 401。
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":2,"prefix":"SUMM"}' > /dev/null
SUMCODES=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | grep -o '"code":"SUMM-[A-F0-9]*"' | cut -d'"' -f4)
SUM_INV1=$(printf '%s' "$SUMCODES" | sed -n 1p)
SUM_INV2=$(printf '%s' "$SUMCODES" | sed -n 2p)
cat > "$TMP/summon1.json" <<EOF
{"name":"Summoner","password":"pass1234","invite":"$SUM_INV1","agreementAccepted":true}
EOF
cat > "$TMP/summon2.json" <<EOF
{"name":"Summoned","password":"pass1234","invite":"$SUM_INV2","agreementAccepted":true}
EOF
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" --data-binary @"$TMP/summon1.json" > /dev/null
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" --data-binary @"$TMP/summon2.json" > /dev/null
SU=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"Summoner","password":"pass1234"}' | jget token)
S2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"Summoned","password":"pass1234"}' | jget token)
SUAUTH="Authorization: Bearer $SU"
S2AUTH="Authorization: Bearer $S2"
SUID=$(curl -s "$BASE/api/im/users/search?q=Summoned" -H "$SUAUTH" | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
# 新装实例的用户发现默认是关的(可见性名单为空),搜索拿不到别人的 id;
# 从管理端用户列表取,免得这节用例依赖一个跟 @AI 召唤无关的开关。
[ -n "$SUID" ] || SUID=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"Summoned"' | cut -d'"' -f4)
# 双向请求自动匹配成好友;成功了才会有会话
curl -s -X POST "$BASE/api/friends/request" -H "$SUAUTH" -H "Content-Type: application/json" -d '{"name":"Summoned"}' > /dev/null
S2R=$(curl -s -X POST "$BASE/api/friends/request" -H "$S2AUTH" -H "Content-Type: application/json" -d '{"name":"Summoner"}')
assert_contains "召唤用例:双向请求自动匹配成好友" "$S2R" '"matched"'
# 会话 id 在 thread.id 里,且同一份 JSON 的 members[].id 也是 "id" 键;用 jget 那条
# 贪婪 sed 取到的是最后一个成员(对方)的 uid,拿它发消息必然 404「会话不存在」。
# 这里按路径解析,别再用 grep/sed 在这层嵌套上取 id。
STID=$(curl -s -X POST "$BASE/api/im/threads" -H "$SUAUTH" -H "Content-Type: application/json" -d "{\"type\":\"dm\",\"uid\":\"$SUID\"}" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('thread',{}).get('id',''))")
if [ -n "$STID" ]; then ok "召唤用例:取得单聊会话"; else bad "召唤用例:取得单聊会话 (SUID=[$SUID] STID 为空)"; fi
# 消息体同样走文件:命令行参数里的中文在 Windows 上会被 curl 按本地码页重编码成非法
# UTF-8,服务端 json_decode 直接失败(实测报「请求体格式错误」)。Linux 上两种写法等价。
im_msg_body() { printf '%s' "$2" > "$TMP/im-$1.json"; }
# 先塞历史,让「上下文快照」确实有内容可读(故障点就在这里)
im_msg_body h1 "{\"thread\":\"$STID\",\"text\":\"今天天气不错\"}"
im_msg_body h2 "{\"thread\":\"$STID\",\"text\":\"是挺晴朗的\"}"
curl -s -X POST "$BASE/api/im/messages" -H "$SUAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/im-h1.json" > /dev/null
curl -s -X POST "$BASE/api/im/messages" -H "$S2AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/im-h2.json" > /dev/null
im_msg_body a1 "{\"thread\":\"$STID\",\"text\":\"@AI 帮我总结一下\",\"providerId\":\"$PROV\",\"model\":\"mock-model\"}"
SUM=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/im/messages" -H "$SUAUTH" -H "Content-Type: application/json" \
  --data-binary @"$TMP/im-a1.json")
cp "$TMP/im-a1.json" "$TMP/im-a1.sent.json" 2>/dev/null || true
if [ "${E2E_DEBUG:-0}" = "1" ]; then
  say "    [debug] SUID=$SUID STID=$STID PROV=$PROV"
  say "    [debug] body=$(cat "$TMP/im-a1.json")"
  say "    [debug] resp=$(printf '%s' "$SUM" | tr '\n' ' ')"
fi
assert_eq "@AI 召唤不返回 500：上下文快照不再读未赋值变量" "$(printf '%s' "$SUM" | tail -1)" "200"
assert_contains "@AI 召唤进入异步回复" "$(printf '%s' "$SUM" | sed '$d')" '"pending":true'
# 关掉「AI 读取上下文」后同一分支仍要能走通
curl -s -X POST "$BASE/api/im/threads/$STID/ai" -H "$SUAUTH" -H "Content-Type: application/json" -d '{"context":false}' > /dev/null
im_msg_body a2 "{\"thread\":\"$STID\",\"text\":\"@AI 再总结一次\",\"providerId\":\"$PROV\",\"model\":\"mock-model\"}"
assert_eq "关闭上下文后召唤仍不 500" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/im/messages" -H "$SUAUTH" -H "Content-Type: application/json" \
  --data-binary @"$TMP/im-a2.json")" "200"
# 整会话 AI 模式:不带 @ 的普通消息也走召唤分支
curl -s -X POST "$BASE/api/im/threads/$STID/ai" -H "$SUAUTH" -H "Content-Type: application/json" -d '{"enabled":true}' > /dev/null
im_msg_body a3 "{\"thread\":\"$STID\",\"text\":\"不带 at 的一句\",\"providerId\":\"$PROV\",\"model\":\"mock-model\"}"
assert_eq "整会话 AI 模式普通消息不 500" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/im/messages" -H "$SUAUTH" -H "Content-Type: application/json" \
  --data-binary @"$TMP/im-a3.json")" "200"
# 供应商不存在时应回错误提示而不是 500
im_msg_body a4 "{\"thread\":\"$STID\",\"text\":\"@AI 用不存在的供应商\",\"providerId\":\"ffffffffffffffffffffffffffffffff\"}"
assert_contains "无效供应商回错误提示而非 500" "$(curl -s -X POST "$BASE/api/im/messages" -H "$SUAUTH" -H "Content-Type: application/json" \
  --data-binary @"$TMP/im-a4.json")" '"error"'


say ""
say "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
#!/usr/bin/env bash
# 模型汇总 E2E:同名自动汇总 / 自定义汇总 ID 对前台与开放 API 生效 /
#            跨渠道故障转移(连接被拒 + 上游 5xx)/ 轮询。
# 用法:bash tests/model-groups-e2e.sh
#      (端口可用 E2E_AGG_PORT / E2E_AGG_MOCK_A_PORT / E2E_AGG_MOCK_B_PORT /
#       E2E_AGG_FAIL_PORT / E2E_AGG_DEAD_PORT 覆盖)
# 说明:故障转移与轮询是纯运行期行为,单元自检覆盖不到,只能起真实服务 + 多端口 mock 上游验证。
#
# 注意:带中文的请求体一律先落到文件再用 -d @file 发送。Git Bash 下的 curl 是原生程序,
# 命令行参数会被按 ANSI 代码页转换,内联中文会变成非法 UTF-8(后端直接回「请求体格式错误」)。
set -u
cd "$(dirname "$0")/.."

PORT="${E2E_AGG_PORT:-8097}"
MOCK_A_PORT="${E2E_AGG_MOCK_A_PORT:-8111}"
MOCK_B_PORT="${E2E_AGG_MOCK_B_PORT:-8112}"
FAIL_PORT="${E2E_AGG_FAIL_PORT:-8114}"
DEAD_PORT="${E2E_AGG_DEAD_PORT:-8113}"   # 故意不监听:连接被拒,用于验证「渠道不可达」的故障转移
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); say "  ✗ $1"; }
assert_contains() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing: $3 | got: $(printf '%s' "$2" | head -c 220))"; fi
}
assert_has() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (missing literal: $3 | got: $(printf '%s' "$2" | head -c 220))"; fi
}
assert_not_has() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (unexpected: $3)"; else ok "$1"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3] got [$2])"; fi
}
jget() { sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" | head -1; }

kill_tree() {
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null
  if command -v taskkill > /dev/null 2>&1 && command -v ps > /dev/null 2>&1; then
    wpid=$(ps -W 2>/dev/null | awk -v p="$1" '$1==p && $4+0>0 {print $4; exit}')
    [ -n "$wpid" ] && taskkill //F //T //PID "$wpid" > /dev/null 2>&1
  fi
}
cleanup() {
  kill_tree "${APP_PID:-}"
  kill_tree "${MOCK_A_PID:-}"
  kill_tree "${MOCK_B_PID:-}"
  kill_tree "${MOCK_FAIL_PID:-}"
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

say "== 启动服务 (app :$PORT / mockA :$MOCK_A_PORT / mockB :$MOCK_B_PORT / 503 :$FAIL_PORT / 死渠道 :$DEAD_PORT) =="
# 端口预检:端口上已有别的服务时必须立刻失败。否则 wait_for 会把「别人的服务器」当成
# 自己刚起的那个(数据目录、渠道全是上一次跑剩的),整套断言跑出来是假的。
precheck_port() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    say "端口已被占用:$1 返回 $code。请先停掉占用进程,或用 E2E_AGG_*_PORT 换端口。"
    exit 1
  fi
}
precheck_port "$BASE/api/config"
precheck_port "http://127.0.0.1:$MOCK_A_PORT/models"
precheck_port "http://127.0.0.1:$MOCK_B_PORT/models"
precheck_port "http://127.0.0.1:$FAIL_PORT/models"
DATA_DIR="$TMP/data" ADMIN_NAME=admin ADMIN_PASSWORD=agg-pass \
  TC_ALLOW_PRIVATE_UPSTREAM=1 TC_WEB_CN_ONLY=0 \
  php -S "127.0.0.1:$PORT" router.php >"$TMP/app.log" 2>&1 &
APP_PID=$!
TC_MOCK_TAG=A php -S "127.0.0.1:$MOCK_A_PORT" tests/mock-agg-upstream.php >"$TMP/mockA.log" 2>&1 &
MOCK_A_PID=$!
TC_MOCK_TAG=B php -S "127.0.0.1:$MOCK_B_PORT" tests/mock-agg-upstream.php >"$TMP/mockB.log" 2>&1 &
MOCK_B_PID=$!
TC_MOCK_TAG=F TC_MOCK_STATUS=503 php -S "127.0.0.1:$FAIL_PORT" tests/mock-agg-upstream.php >"$TMP/mockF.log" 2>&1 &
MOCK_FAIL_PID=$!

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
wait_for "http://127.0.0.1:$MOCK_A_PORT/models" || { say "mock A 未启动"; exit 1; }
wait_for "http://127.0.0.1:$MOCK_B_PORT/models" || { say "mock B 未启动"; exit 1; }

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"admin","password":"agg-pass"}' | jget token)
[ -n "$TOKEN" ] || { say "管理员登录失败"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"

# 带中文的请求体先落盘再发(见文件头说明),回显响应体
post_body() { # $1=url $2=body
  printf '%s' "$2" > "$TMP/body.json"
  curl -s -X POST "$1" -H "$AUTH" -H "$JSON" -d @"$TMP/body.json"
}
post_code_body() { # $1=url $2=body $3=响应落盘路径
  printf '%s' "$2" > "$TMP/body.json"
  curl -s -o "$3" -w '%{http_code}' -X POST "$1" -H "$AUTH" -H "$JSON" -d @"$TMP/body.json"
}

# ---------- 造数据:4 个渠道都提供同一个模型名 agg-model,创建顺序即候选顺序 ----------
new_prov() { # $1=名称 $2=baseUrl $3=模型 -> 回显新渠道 id
  cat > "$TMP/p.json" <<EOF
{"name":"$1","baseUrl":"$2","apiKey":"sk-agg","apiFormat":"chat","models":[{"id":"$3","name":"$3"}],"costPerCall":1,"scope":"global"}
EOF
  curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "$JSON" -d @"$TMP/p.json" \
    | sed -n 's/^{"provider":{"id":"\([^"]*\)".*/\1/p'
}
P_DEAD=$(new_prov "死渠道" "http://127.0.0.1:$DEAD_PORT/v1" "agg-model")
P_B=$(new_prov "渠道B" "http://127.0.0.1:$MOCK_B_PORT/v1" "agg-model")
P_A=$(new_prov "渠道A" "http://127.0.0.1:$MOCK_A_PORT/v1" "agg-model")
P_F=$(new_prov "渠道F503" "http://127.0.0.1:$FAIL_PORT/v1" "agg-model")
# 只属于渠道A的独有模型名,用来验证「自定义汇总 ID 会把成员从列表里摘掉」
P_ONLY=$(new_prov "渠道A-独占" "http://127.0.0.1:$MOCK_A_PORT/v1" "vendor-only")
if [ -n "$P_DEAD" ] && [ -n "$P_B" ] && [ -n "$P_A" ] && [ -n "$P_F" ] && [ -n "$P_ONLY" ]; then
  ok "创建 5 个渠道(4 个提供 agg-model + 1 个提供 vendor-only)"
else
  bad "创建渠道失败(死=$P_DEAD B=$P_B A=$P_A F=$P_F only=$P_ONLY)"
  say "$(cat "$TMP/app.log" | tail -5)"
  exit 1
fi

FRONT=$(curl -s "$BASE/api/providers" -H "$AUTH")
KEY=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$AUTH" -H "$JSON" -d '{"name":"agg"}' | jget secret)
[ -n "$KEY" ] && ok "生成 API 密钥" || { bad "生成 API 密钥"; exit 1; }
V1="Authorization: Bearer $KEY"
v1_models() { curl -s "$BASE/v1/models" -H "$V1"; }
v1_chat() { # $1=请求体文件
  curl -s -X POST "$BASE/v1/chat/completions" -H "$V1" -H "$JSON" -d @"$1"
}
cat > "$TMP/c.json" <<'EOF'
{"model":"agg-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/my.json" <<'EOF'
{"model":"my-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/f.json" <<'EOF'
{"model":"fail-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/d.json" <<'EOF'
{"model":"dead-only","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/cs.json" <<'EOF'
{"model":"agg-model","stream":true,"messages":[{"role":"user","content":"hi"}]}
EOF

# ---------- 1. 默认关闭:行为必须与「没这个功能」完全一致 ----------
say "== 1. 默认关闭 =="
assert_has "关闭时后台开关为 false" "$(curl -s "$BASE/api/admin/model-groups" -H "$AUTH")" '"modelAggEnabled":false'
assert_not_has "关闭时前台不出现汇总条目" "$FRONT" '"agg":true'
assert_contains "关闭时 /v1/models 按原样列出模型" "$(v1_models)" '"id":"agg-model"'
assert_has "关闭时 vendor-only 也在列表里" "$(v1_models)" 'vendor-only'
code=$(curl -s -o "$TMP/r.json" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "$V1" -H "$JSON" -d @"$TMP/c.json")
assert_eq "关闭时直连 agg-model 落到第一个渠道(死),不悄悄换渠道" "$code" "502"
assert_has "关闭时给了明确的连接失败提示" "$(cat "$TMP/r.json")" '无法连接'

# ---------- 2. 开启同名自动汇总 ----------
say "== 2. 开启汇总(同名自动生成) =="
post_body "$BASE/api/admin/settings" '{"modelAggEnabled":true}' > /dev/null
GLIST=$(curl -s "$BASE/api/admin/model-groups" -H "$AUTH")
assert_has "自动生成 agg-model 汇总" "$GLIST" '"id":"agg-model"'
assert_has "自动汇总标记 auto=true" "$GLIST" '"auto":true'
assert_has "4 个渠道都被识别为候选" "$GLIST" '"candidateCount":4'
assert_has "同名提示包含 agg-model" "$GLIST" '"dupes":[{"name":"agg-model","count":4'
FRONT2=$(curl -s "$BASE/api/providers" -H "$AUTH")
assert_has "前台出现合成汇总条目" "$FRONT2" '"id":"agg:agg-model"'
assert_has "前台汇总条目是普通供应商形状(name=模型名)" "$FRONT2" '"name":"agg-model"'
assert_not_has "被汇总的原始渠道不再单独出现在前台" "$FRONT2" "\"id\":\"$P_DEAD\""
assert_not_has "渠道B 也被收起" "$FRONT2" "\"id\":\"$P_B\""
assert_has "front 列表带回 modelAgg.enabled" "$FRONT2" '"modelAgg":{"enabled":true}'
assert_has "汇总条目记录了候选渠道数" "$FRONT2" '"aggCount":4'
assert_has "汇总条目的 order 用分组顺序" "$FRONT2" '"aggStrategy":"failover"'
MODELS=$(v1_models)
assert_has "/v1/models 暴露汇总 ID" "$MODELS" '"id":"agg-model"'
assert_eq "/v1/models 里 agg-model 只出现一次" "$(printf '%s' "$MODELS" | grep -o '"id":"agg-model"' | wc -l | tr -d ' ')" "1"

# ---------- 3. 自定义汇总 ID:开放 API 拿到的是自定义 ID ----------
say "== 3. 自定义汇总 ID =="
post_body "$BASE/api/admin/model-groups" \
  "{\"group\":{\"id\":\"my-model\",\"label\":\"我的模型\",\"strategy\":\"failover\",\"members\":[{\"providerId\":\"$P_ONLY\",\"model\":\"vendor-only\"}]}}" > /dev/null
MODELS2=$(v1_models)
assert_has "/v1/models 出现自定义汇总 ID" "$MODELS2" '"id":"my-model"'
assert_has "自定义汇总的 owned_by 用分组标签" "$MODELS2" '"owned_by":"我的模型"'
assert_not_has "成员模型被摘掉,不再单独暴露" "$MODELS2" 'vendor-only'
assert_not_has "成员渠道的前台条目也已收起" "$(curl -s "$BASE/api/providers" -H "$AUTH")" "\"id\":\"$P_ONLY\""
assert_contains "对自定义 ID 发请求可正常应答" "$(v1_chat "$TMP/my.json")" 'AGG-A'

# ---------- 4. 故障自动转移 ----------
say "== 4. 故障自动转移 =="
# 4a 连接被拒(死渠道排在候选第 1 位) → 必须自动换到渠道B
assert_contains "非流式:死渠道打头,自动落到渠道B" "$(v1_chat "$TMP/c.json")" 'AGG-B'
SSTREAM=$(v1_chat "$TMP/cs.json")
assert_contains "流式:首字节未发出前同样自动换到渠道B" "$SSTREAM" 'AGG-B'
assert_contains "流式:正常收尾" "$SSTREAM" '\[DONE\]'
# 4b 上游 5xx(503)同样要触发转移:单独建一个 503 打头的汇总组
post_body "$BASE/api/admin/model-groups" \
  "{\"group\":{\"id\":\"fail-model\",\"label\":\"5xx\",\"strategy\":\"failover\",\"members\":[{\"providerId\":\"$P_F\",\"model\":\"agg-model\"},{\"providerId\":\"$P_B\",\"model\":\"agg-model\"}]}}" > /dev/null
assert_contains "上游 503 时转移到下一个渠道" "$(v1_chat "$TMP/f.json")" 'AGG-B'
# 4c 所有候选都不可用 → 明确报错,不得假装成功
post_body "$BASE/api/admin/model-groups" \
  "{\"group\":{\"id\":\"dead-only\",\"label\":\"全挂\",\"strategy\":\"failover\",\"members\":[{\"providerId\":\"$P_DEAD\",\"model\":\"agg-model\"},{\"providerId\":\"$P_F\",\"model\":\"agg-model\"}]}}" > /dev/null
DCODES=$(curl -s -o "$TMP/dres.json" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "$V1" -H "$JSON" -d @"$TMP/d.json")
assert_eq "所有候选都不可用时返回失败状态" "$DCODES" "503"
assert_has "错误信息指向最后失败的渠道(而不是假装成功)" "$(cat "$TMP/dres.json")" '渠道F503'

# ---------- 5. 轮询 ----------
say "== 5. 轮询 =="
# 只留渠道B / 渠道A 两个可用渠道,再把策略切成轮询,连续两次必须落到不同渠道
post_body "$BASE/api/admin/providers/$P_DEAD" '{"enabled":false}' > /dev/null
post_body "$BASE/api/admin/providers/$P_F" '{"enabled":false}' > /dev/null
assert_has "停用的渠道仍下发给管理员(后台才能重新启用)" "$(curl -s "$BASE/api/providers" -H "$AUTH")" "\"id\":\"$P_DEAD\""
# 改已有的组要带 __origId:不带会被当成新建,同 ID 冲突直接 409
post_body "$BASE/api/admin/model-groups" \
  '{"group":{"__origId":"agg-model","id":"agg-model","auto":true,"matchId":"agg-model","strategy":"roundrobin"}}' > /dev/null
assert_has "策略已切为轮询" "$(curl -s "$BASE/api/admin/model-groups" -H "$AUTH")" '"strategy":"roundrobin"'
R1=$(v1_chat "$TMP/c.json")
R2=$(v1_chat "$TMP/c.json")
T1=$(printf '%s' "$R1" | grep -o 'AGG-[A-Z]' | head -1)
T2=$(printf '%s' "$R2" | grep -o 'AGG-[A-Z]' | head -1)
if [ "$T1" != "$T2" ] && { [ "$T1" = "AGG-A" ] || [ "$T1" = "AGG-B" ]; } && { [ "$T2" = "AGG-A" ] || [ "$T2" = "AGG-B" ]; }; then
  ok "连续两次请求分别命中不同渠道(轮询生效:$T1 → $T2)"
else
  bad "轮询未生效(两次都是 $T1 / $T2)"
fi

# ---------- 6. 关闭后恢复原状 ----------
say "== 6. 关闭汇总恢复原状 =="
post_body "$BASE/api/admin/settings" '{"modelAggEnabled":false}' > /dev/null
FRONT3=$(curl -s "$BASE/api/providers" -H "$AUTH")
assert_not_has "关闭后不再出现汇总条目" "$FRONT3" '"agg:agg-model"'
assert_has "关闭后原始渠道重新出现在前台" "$FRONT3" "\"id\":\"$P_B\""
assert_has "关闭后 vendor-only 重新可见" "$(v1_models)" 'vendor-only'
assert_contains "关闭后 agg-model 仍可直连" "$(v1_chat "$TMP/c.json")" 'AGG-'

# ---------- 7. 后台自检:汇总记录不会因设置保存而丢失 ----------
say "== 7. 汇总记录保留 =="
GLAST=$(curl -s "$BASE/api/admin/model-groups" -H "$AUTH")
assert_has "手动汇总组在开关关闭后仍保留" "$GLAST" '"id":"my-model"'
assert_has "自动汇总组也保留(重新开启即生效)" "$GLAST" '"id":"agg-model"'
assert_has "后台列表给出渠道目录" "$GLAST" '"providers":[{'
assert_has "后台列表给出同名可汇总提示" "$GLAST" '"dupes":['

if grep -n "PHP Warning\|PHP Fatal\|Uncaught" "$TMP/app.log" > /dev/null 2>&1; then
  bad "服务端日志不应有 PHP 告警/致命错误"
  grep -n "PHP Warning\|PHP Fatal\|Uncaught" "$TMP/app.log" | head -5
else
  ok "服务端日志无 PHP 告警"
fi

say ""
say "通过 $PASS 项,失败 $FAIL 项"
[ "$FAIL" -eq 0 ] || exit 1

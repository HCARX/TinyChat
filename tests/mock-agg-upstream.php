<?php
/**
 * 模型汇总 E2E 专用 mock 上游:同一份代码可以起在多个端口上,用 TC_MOCK_TAG 区分应答内容,
 * 这样断言就能知道「这条回复到底来自哪个渠道」——跨渠道故障转移与轮询全靠它验证。
 * TC_MOCK_STATUS 设成 5xx 可模拟上游故障(验证状态码触发的故障转移,区别于连接被拒)。
 * 用法:TC_MOCK_TAG=A php -S 127.0.0.1:8111 tests/mock-agg-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$body = json_decode((string) file_get_contents('php://input'), true);
$tag = getenv('TC_MOCK_TAG');
$tag = $tag === false ? '' : $tag;
$status = (int) (getenv('TC_MOCK_STATUS') ?: 200);
header('Content-Type: application/json');
if (strpos($uri, 'chat/completions') !== false) {
    if ($status >= 400) {
        http_response_code($status);
        echo json_encode(array('error' => array('message' => 'mock 上游故障 ' . $status)));
        return;
    }
    if (is_array($body) && !empty($body['stream'])) {
        header('Content-Type: text/event-stream');
        echo 'data: ' . json_encode(array('id' => 'mock', 'object' => 'chat.completion.chunk',
            'choices' => array(array('index' => 0, 'delta' => array('content' => 'AGG-' . $tag))))) . "\n\n";
        echo "data: [DONE]\n\n";
        return;
    }
    echo json_encode(array(
        'id' => 'chatcmpl-' . $tag, 'object' => 'chat.completion', 'created' => time(),
        'model' => is_array($body) && isset($body['model']) ? $body['model'] : '',
        'choices' => array(array('index' => 0, 'message' => array(
            'role' => 'assistant', 'content' => 'AGG-' . $tag,
        ), 'finish_reason' => 'stop')),
        'usage' => array('prompt_tokens' => 5, 'completion_tokens' => 5),
    ));
    return;
}
if (strpos($uri, '/models') !== false) {
    echo json_encode(array('object' => 'list', 'data' => array(array('id' => 'agg-model', 'object' => 'model'))));
    return;
}
http_response_code(404);
echo json_encode(array('error' => array('message' => 'not found')));

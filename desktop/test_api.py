# -*- coding: utf-8 -*-
"""
test_api.py — 本地服务的冒烟测试（进程内起服务，mock AI / 假 client / 假 urllib 响应，不需要密钥、不联网）

用法：python -X utf8 desktop/test_api.py
退出码 0 = 全部通过。每条用例打印 PASS / FAIL。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# 测试用独立配置目录：不碰用户真实的 config.json
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="scene-dialog-test-")
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("DEEPSEEK_API_KEY", None)

import api_server  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, info: str = "") -> None:
    results.append((name, bool(cond), info))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not info else f"  —  {info}"))


def call(base: str, method: str, path: str, body=None, headers=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


class FakeBadRequest(Exception):
    """假的 anthropic.BadRequestError：只要有 status_code / message / body 三个属性，_structured 与 ai_error_payload 就能处理"""

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message, self.status_code = message, status_code
        self.body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}
        self.request_id = "req_fake"


def fake_resp(text, stop_reason="end_turn", category=None, iterations=None):
    from types import SimpleNamespace as NS
    usage = NS(input_tokens=1200, output_tokens=900, cache_read_input_tokens=1000, cache_creation_input_tokens=0, iterations=iterations)
    sd = NS(category=category, explanation="测试用拒绝") if stop_reason == "refusal" else None
    content = [NS(type="thinking", thinking="")] + ([NS(type="text", text=text)] if text is not None else [])
    return NS(content=content, stop_reason=stop_reason, stop_details=sd, usage=usage, model="claude-opus-5-5", _request_id="req_fake_ok")


def make_ai(beta_create, plain_create):
    """不走网络的 ClaudeAI：anthropic 命名空间与 client 都是假的；记录每次 create 收到的 kwargs"""
    import ai_service
    from types import SimpleNamespace as NS
    ai = object.__new__(ai_service.ClaudeAI)
    ai.anthropic = NS(BadRequestError=FakeBadRequest)
    ai.model = "claude-opus-5-5"
    ai.client = NS(beta=NS(messages=NS(create=beta_create)), messages=NS(create=plain_create))
    ai_service.ClaudeAI.fallback_beta_ok = True
    return ai


def unit_tests_claude_path() -> None:
    """ClaudeAI._structured 在 mock client 下能测的部分：请求形状、beta 回退、stop_reason、本地校验 / 夹取、usage、错误 payload"""
    import ai_service
    import schema_lite
    import copy
    calls = []

    def rec(name):
        def f(**kw):
            calls.append((name, kw))
            return fake_resp(json.dumps({"cards": [c0, c1, c2]}, ensure_ascii=False))
        return f
    c0 = copy.deepcopy(ai_service.EXAMPLE_CARD)
    c1 = copy.deepcopy(ai_service.MockAI().draft("x", None, None, None)["cards"][1])
    c2 = copy.deepcopy(ai_service.MockAI().draft("x", None, None, None)["cards"][2])

    check("EXAMPLE_CARD 合 CARD_SCHEMA（严格）", not schema_lite.validate(ai_service.CARD_SCHEMA, ai_service.EXAMPLE_CARD), str(schema_lite.validate(ai_service.CARD_SCHEMA, ai_service.EXAMPLE_CARD))[:200])
    check("SYSTEM_PROMPT 含示例卡与「三张卡结构不同」复述", json.dumps(ai_service.EXAMPLE_CARD, ensure_ascii=False) in ai_service.SYSTEM_PROMPT and "至少两项不同" in ai_service.SYSTEM_PROMPT)
    s = schema_lite.api_schema(ai_service.DRAFT_SCHEMA)
    check("api_schema 剥掉 API 不支持的 minimum/maximum/pattern/maxItems/minItems>1", not any(schema_lite.has_key(s, k) for k in schema_lite.UNSUPPORTED_BY_API + ("minItems",)) and "minimum: 3" in json.dumps(s))
    check("CARD_SCHEMA 本身仍严格（保留 minimum/pattern）", schema_lite.has_key(ai_service.CARD_SCHEMA, "minimum") and schema_lite.has_key(ai_service.CARD_SCHEMA, "pattern"))

    ai = make_ai(rec("beta"), rec("plain"))
    d = ai.draft("黄昏山城", None, None, None)
    name, kw = calls[-1]
    check("正常路径走 beta.messages.create 带 server-side-fallback-2026-07-01 + fallbacks=default", name == "beta" and kw.get("betas") == ["server-side-fallback-2026-07-01"] and kw.get("fallbacks") == "default")
    check("请求不带 thinking / temperature / top_p / top_k（Opus 5.5 会 400），effort 在 output_config 里", not any(k in kw for k in ("thinking", "temperature", "top_p", "top_k")) and kw["output_config"]["effort"] == "low" and kw["output_config"]["format"]["type"] == "json_schema")
    check("系统提示带 cache_control（> 512 token 可缓存）", kw["system"][0]["cache_control"] == {"type": "ephemeral"} and len(kw["system"][0]["text"]) > 1500)
    check("draft 的 user 文本重列题材词表与放置类含义", "valley_two_banks" in kw["messages"][0]["content"] and "cliff_edge" in kw["messages"][0]["content"] and "farmland" in kw["messages"][0]["content"])
    check("返回带 usage（input/output/cache_read/cache_write/request_id/ms/cost_usd）", d["_usage"]["cache_read"] == 1000 and d["_usage"]["request_id"] == "req_fake_ok" and d["_usage"]["cost_usd"] == round((1200 * 4 + 900 * 20 + 1000 * 0.2) / 1e6, 6), json.dumps(d["_usage"]))

    def beta_reject(**kw):
        calls.append(("beta", kw))
        raise FakeBadRequest("Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header")
    ai = make_ai(beta_reject, rec("plain"))
    calls.clear()
    ai.draft("山城", None, None, None)
    check("beta 头被 400 → 退回 messages.create，且不带 betas/fallbacks", [c[0] for c in calls] == ["beta", "plain"] and "betas" not in calls[1][1] and "fallbacks" not in calls[1][1])
    calls.clear()
    ai.draft("山城", None, None, None)
    check("退回后本进程内不再试 beta（省一次往返）", [c[0] for c in calls] == ["plain"])
    ai_service.ClaudeAI.fallback_beta_ok = True

    def beta_other(**kw):
        raise FakeBadRequest("messages: roles must alternate")
    ai = make_ai(beta_other, rec("plain"))
    try:
        ai.draft("山城", None, None, None)
        check("其它 400 原样抛出（不吞）", False)
    except FakeBadRequest as e:
        check("其它 400 原样抛出（不吞）", "alternate" in str(e))

    ai = make_ai(lambda **kw: fake_resp('{"cards": [', stop_reason="max_tokens"), None)
    try:
        ai.draft("山城", None, None, None); check("stop_reason=max_tokens → AIError(truncated)", False)
    except ai_service.AIError as e:
        check("stop_reason=max_tokens → AIError(truncated)", e.kind == "truncated" and "截断" in str(e) and e.detail["usage"]["output"] == 900)

    ai = make_ai(lambda **kw: fake_resp(None, stop_reason="refusal", category="cyber"), None)
    try:
        ai.draft("山城", None, None, None); check("stop_reason=refusal → AIError(refusal) 带类别", False)
    except ai_service.AIError as e:
        check("stop_reason=refusal → AIError(refusal) 带类别", e.kind == "refusal" and e.detail["category"] == "cyber" and "cyber" in str(e))

    bad = copy.deepcopy(c0); bad["regions"][0]["density"] = 1.9; bad["params"]["terraces"] = 9
    ai = make_ai(lambda **kw: fake_resp(json.dumps({"cards": [bad, c1, c2]}, ensure_ascii=False)), None)
    d = ai.draft("山城", None, None, None)
    check("越界数值本地夹回范围并记入 _fixes", d["cards"][0]["regions"][0]["density"] == 1.6 and d["cards"][0]["params"]["terraces"] == 7 and len(d.get("_fixes", [])) == 2, json.dumps(d.get("_fixes")))

    bad2 = copy.deepcopy(c0); bad2["landmark"]["placement"] = "roof"; bad2["palette"][0]["hex"] = "#12"
    ai = make_ai(lambda **kw: fake_resp(json.dumps({"cards": [bad2, c1, c2]}, ensure_ascii=False)), None)
    try:
        ai.draft("山城", None, None, None); check("枚举 / pattern 不合 → AIError(schema) 列出路径", False)
    except ai_service.AIError as e:
        check("枚举 / pattern 不合 → AIError(schema) 列出路径", e.kind == "schema" and any("placement" in x for x in e.detail["errors"]) and any("hex" in x for x in e.detail["errors"]), str(e)[:200])

    def revise_ok(**kw):
        calls.append(("beta", kw))
        return fake_resp(json.dumps({"understood": True, "patch": {"params": {"layer_height_m": 5}}, "restatement": "更陡", "ask_to_point": False}, ensure_ascii=False))
    ai = make_ai(revise_ok, None)
    calls.clear()
    r = ai.revise(c0, {"type": "text", "text": "更陡"}, None)
    kw = calls[-1][1]
    check("revise 的 user 文本要求「能不改的字段不要出现在 patch 里」，effort=medium，patch 合 REVISE_SCHEMA", "能不改的字段不要出现在 patch 里" in kw["messages"][0]["content"] and kw["output_config"]["effort"] == "medium" and r["patch"]["params"]["layer_height_m"] == 5 and r["provider"] == "claude")

    p = api_server.ai_error_payload(FakeBadRequest("invalid x-api-key", status_code=401))
    check("ai_error_payload：401 → 密钥提示 + request_id + 不可重试", p["status"] == 401 and "密钥" in p["hint"] and p["request_id"] == "req_fake" and p["retryable"] is False and p["type"] == "invalid_request_error", json.dumps(p, ensure_ascii=False))
    p = api_server.ai_error_payload(FakeBadRequest("overloaded", status_code=529))
    check("ai_error_payload：529 → 可重试", p["retryable"] is True and "过载" in p["hint"])


# ------------------------------------------------------------ DeepSeek（假的 urllib 响应，不联网）
class FakeHTTPResp:
    def __init__(self, obj):
        self.raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def ds_resp(content, finish="stop", prompt=2000, hit=1500, completion=1000, reasoning=0, model="deepseek-flash"):
    return {"id": "ds-req-1", "model": model, "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "prompt_cache_hit_tokens": hit, "prompt_cache_miss_tokens": prompt - hit,
                      "completion_tokens_details": {"reasoning_tokens": reasoning}}}


def http_error(code, message):
    import io
    body = json.dumps({"error": {"message": message, "type": "invalid_request_error"}}).encode("utf-8")
    return urllib.error.HTTPError("https://api.deepseek.com/chat/completions", code, message, {}, io.BytesIO(body))


def fake_opener(script, log):
    """script：依次返回的东西（dict = 200 响应体；Exception = 抛出）。log 记下每次请求的 (url, headers, body)"""
    seq = list(script)

    def urlopen(req, timeout=None):
        log.append((req.full_url, dict(req.header_items()), json.loads(req.data.decode("utf-8")), timeout))
        item = seq.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeHTTPResp(item)
    return urlopen


def make_ds(script, log, **kw):
    import ai_service
    ai = ai_service.DeepSeekAI("sk-test-deepseek-0000000000abcd", kw.pop("model", "deepseek-flash"), urlopen=fake_opener(script, log), **kw)
    ai.retry_sleep = 0
    return ai


def unit_tests_deepseek() -> None:
    import ai_service
    import ai_deepseek
    import schema_lite
    import copy
    import datetime as dt
    good = {"cards": [copy.deepcopy(ai_service.EXAMPLE_CARD)] + [copy.deepcopy(c) for c in ai_service.MockAI().draft("x", None, None, None)["cards"][1:]]}
    good_s = json.dumps(good, ensure_ascii=False)

    # 示例 / schema
    check("EXAMPLE_LEVELS 每项合 LEVEL_ITEM", all(not schema_lite.validate(ai_service.LEVEL_ITEM, l) for l in ai_service.EXAMPLE_LEVELS))
    check("CARD_SCHEMA / PATCH_SCHEMA 都有 levels（≤ 3 项）", ai_service.CARD_SCHEMA["properties"]["levels"]["maxItems"] == 3 and "levels" in ai_service.PATCH_SCHEMA["properties"])
    coord = {"position", "polygon", "x", "y", "z", "floor_y", "top_y", "bottom_y", "line", "points"}
    names = set()

    def walk(n):
        if isinstance(n, dict):
            names.update((n.get("properties") or {}).keys())
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk([ai_service.CARD_SCHEMA, ai_service.REVISE_SCHEMA])
    check("schema 里没有任何坐标 / 高度字段（LLM 永远不写坐标）", not (names & coord), str(names & coord))
    check("DeepSeek 系统提示含字段表、示例卡、levels 说明与「只输出一个 json」", "levels[].anchor" in ai_deepseek.SYSTEM_PROMPT_JSON and "只输出一个 json" in ai_deepseek.SYSTEM_PROMPT_JSON
          and json.dumps(ai_service.EXAMPLE_CARD, ensure_ascii=False) in ai_deepseek.SYSTEM_PROMPT_JSON and "每项字段同 levels[]" in ai_deepseek.SYSTEM_PROMPT_JSON)

    # 请求体形状
    log = []
    d = make_ds([ds_resp(good_s)], log).draft("黄昏山城", None, None, None)
    url, headers, body, timeout = log[-1]
    check("DeepSeek 请求：/chat/completions + Bearer 头 + model / response_format json_object / thinking disabled / max_tokens 6000",
          url == "https://api.deepseek.com/chat/completions" and headers.get("Authorization", "").startswith("Bearer ") and body["model"] == "deepseek-flash"
          and body["response_format"] == {"type": "json_object"} and body["thinking"] == {"type": "disabled"} and body["max_tokens"] == 6000 and body["stream"] is False and timeout == 90.0,
          json.dumps({k: v for k, v in body.items() if k != "messages"}))
    check("messages = [system(字段表), user(一句话 + 没提地下就不给 levels)]", [m["role"] for m in body["messages"]] == ["system", "user"] and body["messages"][0]["content"] == ai_deepseek.SYSTEM_PROMPT_JSON
          and "黄昏山城" in body["messages"][1]["content"] and "不要给 levels" in body["messages"][1]["content"])
    check("draft 结果 3 张卡、provider=deepseek", len(d["cards"]) == 3 and d["provider"] == "deepseek")
    u = d["_usage"]
    want = round((1500 * (0.04 if u["peak"] else 0.02) + 500 * (2 if u["peak"] else 1) + 1000 * (8 if u["peak"] else 4)) / 1e6, 6)
    check("usage：input / output / prompt_cache_hit_tokens / reasoning / request_id / cost_cny（按时段价目）", u["input"] == 2000 and u["output"] == 1000 and u["prompt_cache_hit_tokens"] == 1500
          and u["cache_read"] == 1500 and u["reasoning"] == 0 and u["request_id"] == "ds-req-1" and u["cost_cny"] == want, json.dumps(u))
    check("费用：空闲 flash 2000 入（1500 命中）+ 1000 出 = 0.00453 元；v4-pro 高峰另价",
          ai_deepseek.estimate_cost_cny({"input": 2000, "cache_read": 1500, "output": 1000}, "deepseek-flash", peak=False) == 0.00453
          and ai_deepseek.estimate_cost_cny({"input": 2000, "cache_read": 1500, "output": 1000}, "deepseek-v4-pro", peak=True) == round((1500 * 0.3 + 500 * 9 + 1000 * 27) / 1e6, 6)
          and ai_deepseek.estimate_cost_cny({"input": 1}, "unknown-model") is None)
    bj = dt.timezone(dt.timedelta(hours=8))
    check("高峰判定：北京周一 10 点高峰、13 点空闲、周六空闲", ai_deepseek.is_peak(dt.datetime(2026, 10, 19, 10, tzinfo=bj)) and not ai_deepseek.is_peak(dt.datetime(2026, 10, 19, 13, tzinfo=bj))
          and not ai_deepseek.is_peak(dt.datetime(2026, 10, 24, 10, tzinfo=bj)))

    log = []
    make_ds([ds_resp('{"understood": true, "patch": {}, "restatement": "好", "ask_to_point": false}')], log, thinking=True).revise(good["cards"][0], {"type": "text", "text": "再陡一点"}, None)
    check("thinking=true → thinking enabled，revise max_tokens 1500 + 思考余量", log[-1][2]["thinking"] == {"type": "enabled"} and log[-1][2]["max_tokens"] == 1500 + ai_deepseek.DeepSeekAI.THINKING_EXTRA)

    log = []
    r = make_ds([ds_resp('{"understood": true, "patch": {"params": {"layer_height_m": 5}}, "restatement": "更陡"}')], log).revise(good["cards"][0], {"type": "text", "text": "再陡一点"}, None)
    check("改卡漏了 ask_to_point → 本地由 understood 推出（不重试，省一次调用）", len(log) == 1 and r["ask_to_point"] is False and any("ask_to_point" in f for f in r.get("_fixes", [])))

    # schema 不合格 → 回喂错误重试一次
    bad = copy.deepcopy(good); bad["cards"][0]["landmark"]["placement"] = "roof"
    log = []
    d = make_ds([ds_resp(json.dumps(bad, ensure_ascii=False)), ds_resp(good_s)], log).draft("山城", None, None, None)
    msgs = log[-1][2]["messages"]
    check("schema 不合格 → 带错误清单重试一次后成功（usage 两次累加）", len(log) == 2 and [m["role"] for m in msgs] == ["system", "user", "assistant", "user"] and "placement" in msgs[-1]["content"]
          and d.get("_retried") and d["_usage"]["calls"] == 2 and d["_usage"]["input"] == 4000, json.dumps(d.get("_usage")))
    log = []
    try:
        make_ds([ds_resp(json.dumps(bad, ensure_ascii=False)), ds_resp(json.dumps(bad, ensure_ascii=False))], log).draft("山城", None, None, None)
        check("两次都不合格 → AIError(schema) 带累计 usage", False)
    except ai_service.AIError as e:
        check("两次都不合格 → AIError(schema) 带累计 usage", e.kind == "schema" and e.detail["usage"]["calls"] == 2 and len(log) == 2)
    log = []
    d = make_ds([ds_resp("这不是 json"), ds_resp(good_s)], log).draft("山城", None, None, None)
    check("不是 JSON → 回喂重试一次", len(log) == 2 and "不是合法 JSON" in log[-1][2]["messages"][-1]["content"] and len(d["cards"]) == 3)
    extra = copy.deepcopy(good); extra["cards"][0]["foo"] = 1; extra["cards"][1]["levels"] = None; extra["cards"][2]["params"]["terraces"] = 9
    d = make_ds([ds_resp("```json\n" + json.dumps(extra, ensure_ascii=False) + "\n```")], []).draft("山城", None, None, None)
    check("多余字段 / 可选 null 去掉、越界夹回、代码块围栏剥掉，记进 _fixes", "foo" not in d["cards"][0] and "levels" not in d["cards"][1] and d["cards"][2]["params"]["terraces"] == 7 and len(d["_fixes"]) == 3, json.dumps(d.get("_fixes"), ensure_ascii=False))
    try:
        make_ds([ds_resp('{"cards": [', finish="length")], []).draft("山城", None, None, None)
        check("finish_reason=length → AIError(truncated)", False)
    except ai_service.AIError as e:
        check("finish_reason=length → AIError(truncated)", e.kind == "truncated")

    # HTTP 错误分类与重试
    import api_server
    import socket
    for code, word, retry in ((401, "密钥", False), (402, "余额", False), (422, "模型名", False)):
        log = []
        try:
            make_ds([http_error(code, "Model Not Exist" if code == 422 else "err")], log).draft("山城", None, None, None)
            check(f"HTTP {code} → DeepSeekAPIError", False)
        except ai_service.DeepSeekAPIError as e:
            p = api_server.ai_error_payload(e)
            check(f"HTTP {code} → 不重试，payload 提示含「{word}」、provider=deepseek", len(log) == 1 and p["status"] == code and word in p["hint"] and p["provider"] == "deepseek" and p["retryable"] is retry, json.dumps(p, ensure_ascii=False))
    log = []
    d = make_ds([http_error(429, "rate"), ds_resp(good_s)], log).draft("山城", None, None, None)
    check("429 → 重试 1 次后成功", len(log) == 2 and len(d["cards"]) == 3)
    log = []
    try:
        make_ds([http_error(503, "busy"), http_error(503, "busy")], log).draft("山城", None, None, None)
        check("503 两次 → 抛出、可重试、提示繁忙", False)
    except ai_service.DeepSeekAPIError as e:
        p = api_server.ai_error_payload(e)
        check("503 两次 → 抛出、可重试、提示繁忙", len(log) == 2 and p["retryable"] and "繁忙" in p["hint"])
    log = []
    try:
        make_ds([urllib.error.URLError("refused"), urllib.error.URLError("refused")], log).draft("山城", None, None, None)
        check("断连 → 重试 1 次，type=APIConnectionError", False)
    except ai_service.DeepSeekAPIError as e:
        p = api_server.ai_error_payload(e)
        check("断连 → 重试 1 次，type=APIConnectionError", len(log) == 2 and p["type"] == "APIConnectionError" and p["status"] is None and "连不上" in p["hint"])
    log = []
    try:
        make_ds([socket.timeout("timed out")], log).draft("山城", None, None, None)
        check("超时 → 不重试，type=APITimeoutError", False)
    except ai_service.DeepSeekAPIError as e:
        check("超时 → 不重试，type=APITimeoutError", len(log) == 1 and api_server.ai_error_payload(e)["type"] == "APITimeoutError")
    log = []
    r = make_ds([ds_resp("ok", prompt=10, hit=0, completion=1)], log).ping()
    check("ping：最短请求（不开 json 模式、关思考、max_tokens 8）", r["ok"] and "response_format" not in log[-1][2] and log[-1][2]["thinking"] == {"type": "disabled"} and log[-1][2]["max_tokens"] == 8)

    # 模拟 AI 的多层空间
    m = ai_service.MockAI()
    d = m.draft("山城下面有个地宫，从井下去", None, None, None)
    lv = d["cards"][0].get("levels") or []
    check("mock：「山城下面有个地宫，从井下去」→ 地宫 + 井 + 锚在村子", lv and lv[0]["kind"] == "crypt" and lv[0]["connect"] == "well" and lv[0]["anchor"] == "village" and all(not schema_lite.validate(ai_service.CARD_SCHEMA, c) for c in d["cards"]), json.dumps(lv, ensure_ascii=False))
    d = m.draft("悬崖村，崖顶有栈道和浮岛", None, None, None)
    check("mock：「崖顶有栈道和浮岛」→ walkway + island，三张大小不同", [l["kind"] for l in d["cards"][0]["levels"]] == ["walkway", "island"] and len({c["levels"][0]["size"] for c in d["cards"]}) == 3)
    check("mock：没提地下 / 空中 → 不给 levels", all("levels" not in c for c in m.draft("黄昏山城", None, None, None)["cards"]))
    card = d["cards"][0]
    r = m.revise(card, {"type": "text", "text": "加一个地宫"}, None)
    check("mock revise「加一个地宫」→ patch.levels = 原有 + crypt", [l["kind"] for l in r["patch"]["levels"]] == ["walkway", "island", "crypt"] and not schema_lite.validate(ai_service.REVISE_SCHEMA, {k: v for k, v in r.items() if k != "provider"}), str(schema_lite.validate(ai_service.REVISE_SCHEMA, {k: v for k, v in r.items() if k != "provider"})))
    c2 = dict(card, levels=card["levels"] + [{"stratum": "sky", "kind": "platform", "anchor": "top", "height_layers": 2, "size": "small", "connect": "ladder", "label": "空中平台"}])
    r = m.revise(c2, {"type": "text", "text": "去掉空中平台"}, None)
    check("mock revise「去掉空中平台」→ 只删 platform", [l["kind"] for l in r["patch"]["levels"]] == ["walkway", "island"], json.dumps(r, ensure_ascii=False)[:200])
    r = m.revise(card, {"type": "text", "text": "去掉空中的"}, None)
    check("mock revise「去掉空中的」→ 整层删光（levels=[]）", r["patch"]["levels"] == [])
    r = m.revise(card, {"type": "text", "text": "换成夜里"}, None)
    check("mock revise「换成夜里」→ lighting night + 夜色板", r["patch"]["lighting"]["time_of_day"] == "night" and len(r["patch"]["palette"]) == 5)


def unit_tests_json_repair() -> None:
    """DeepSeek 偶尔吐坏 JSON：本地修（围栏 / 尾逗号 / 字符串里的英文双引号 / 裸换行），修好且合 schema 就不回喂"""
    import ai_deepseek
    import ai_service
    import copy
    rj = ai_deepseek.repair_json
    d, f = rj('```json\n{"a": [1, 2,], "b": {"c": "x",},}\n```')
    check("修 JSON：围栏 + 尾逗号", d == {"a": [1, 2], "b": {"c": "x"}} and "去掉代码块围栏" in f and any("尾逗号" in x for x in f), str(f))
    d, f = rj('{"one_liner": "进村先看见"寨门"，再上山", "label": "牌楼"}')
    check("修 JSON：字符串里没转义的英文双引号", d == {"one_liner": '进村先看见"寨门"，再上山', "label": "牌楼"} and any("双引号" in x for x in f), str(d))
    d, f = rj('{"summary": "第一行\n第二行", "k": 1}')
    check("修 JSON：字符串里的裸换行", d == {"summary": "第一行\n第二行", "k": 1} and any("换行" in x for x in f), str(d))
    d, f = rj('好的，结果如下：{"a": 1}')
    check("修 JSON：前面的杂字", d == {"a": 1} and any("杂字" in x for x in f), str(f))
    check("修不好 → None", rj("这不是 json") is None and rj('{"a": [1, 2') is None)
    good = {"cards": [copy.deepcopy(ai_service.EXAMPLE_CARD)] + [copy.deepcopy(c) for c in ai_service.MockAI().draft("x", None, None, None)["cards"][1:]]}
    good["cards"][0]["one_liner"] = "QUOTE_HERE"
    raw = json.dumps(good, ensure_ascii=False, indent=1).replace("QUOTE_HERE", '一进村就看见"山顶寺"的飞檐').replace("]\n}", "],\n}", 1)
    log = []
    d = make_ds([ds_resp(raw)], log).draft("山城", None, None, None)
    check("坏 JSON 本地修好且合 schema → 不回喂（只调 1 次），usage.repaired=true，记进 _fixes",
          len(log) == 1 and d["_usage"].get("repaired") is True and d["cards"][0]["one_liner"] == '一进村就看见"山顶寺"的飞檐' and any(x.startswith("本地修 JSON") for x in d.get("_fixes", [])),
          json.dumps([len(log), d.get("_fixes"), d["_usage"].get("repaired")], ensure_ascii=False))
    log = []
    d = make_ds([ds_resp('{"cards": [{"name": "x",}]}'), ds_resp(json.dumps(good, ensure_ascii=False))], log).draft("山城", None, None, None)
    check("修好了但不合 schema → 仍回喂重试一次", len(log) == 2 and len(d["cards"]) == 3)


def server_tests_entry_and_archetype(base: str) -> None:
    """端到端（force_mock，不花钱）：「村口」→ 地标放 entry；原型说死后三张都锁、换一批也不变"""
    import ai_service
    import schema_lite
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "一个很缓的小村，没有溪，村口一棵大树", "force_mock": True})
    cs = d.get("cards", [])
    check("「村口一棵大树」→ 三张都是大树、放村口（entry）、合 schema，条件里有「地标村口」",
          st == 200 and len(cs) == 3 and all(c["landmark"]["kind"] == "tree" and c["landmark"]["placement"] == "entry" and not schema_lite.validate(ai_service.CARD_SCHEMA, c) for c in cs)
          and "地标村口" in d.get("constraints", []), json.dumps([[c["landmark"] for c in cs], d.get("constraints")], ensure_ascii=False)[:400])
    st, r = call(base, "POST", "/api/ai/revise", {"card": cs[0] if cs else {}, "action": {"type": "text", "text": "把寨门挪到村口"}, "force_mock": True})
    check("revise「把寨门挪到村口」→ landmark placement=entry、kind=gate", st == 200 and r["patch"].get("landmark") == {"placement": "entry", "kind": "gate"}, json.dumps(r, ensure_ascii=False)[:300])
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "从村口进去，一路爬到山顶的寺", "force_mock": True})
    check("「从村口进去…山顶的寺」→ 地标仍在山顶（不是 entry）", st == 200 and all(c["landmark"]["placement"] == "top" for c in d.get("cards", [])), json.dumps([c["landmark"] for c in d.get("cards", [])], ensure_ascii=False))
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "溪谷两岸各一片房子，一座桥连起来", "force_mock": True})
    cs = d.get("cards", [])
    check("原型锁定：「两岸」→ 三张都是溪谷双坡且有溪", st == 200 and len(cs) == 3 and all(c["archetype"] == "valley_two_banks" and c["params"]["stream"] for c in cs) and "溪谷双坡" in d.get("constraints", []),
          json.dumps([c["archetype"] for c in cs], ensure_ascii=False))
    check("「一座桥」不被吞：锁定行写「桥：路过溪处」", "桥：路过溪处" in d.get("constraints", []), json.dumps(d.get("constraints"), ensure_ascii=False))
    check("原型被改回的卡：名字跟着换成原型名", all(c["name"] == "溪谷双坡型" for f in d.get("constraints_fixed", []) if "archetype" in f["fields"] for c in [cs[f["card"]]]),
          json.dumps([[c["name"], c["one_liner"]] for c in cs], ensure_ascii=False)[:300])
    st, d2 = call(base, "POST", "/api/ai/draft", {"intent": "溪谷两岸各一片房子，一座桥连起来", "axis": "台地层数", "force_mock": True,
                                                "targets": [{"params": {"terraces": 3}}, {"params": {"terraces": 5}}, {"params": {"terraces": 7}}], "locked": {"card": cs[0] if cs else {}}})
    c2 = d2.get("cards", [])
    check("换一批（按层数变）：原型仍锁定，层数按目标 3 / 5 / 7", st == 200 and [c["archetype"] for c in c2] == ["valley_two_banks"] * 3 and [c["params"]["terraces"] for c in c2] == [3, 5, 7],
          json.dumps([[c["archetype"], c["params"]["terraces"]] for c in c2], ensure_ascii=False))


def server_tests_providers(base: str) -> None:
    """服务端：配置读写不泄露明文、旧扁平配置兼容、force_mock、DeepSeek 路由（_post_once 打桩，不联网）"""
    import ai_service
    import ai_deepseek
    key = "sk-test-deepseek-secret-9876wxyz"
    st, c = call(base, "POST", "/api/config", {"provider": "deepseek", "mock": False, "providers": {"deepseek": {"api_key": key, "model": "deepseek-flash", "thinking": True}}})
    blob = json.dumps(c, ensure_ascii=False)
    check("POST config（deepseek）→ 回包不含明文，hint=sk-…wxyz，thinking=true", st == 200 and key not in blob and c["provider"] == "deepseek" and c["providers"]["deepseek"]["key_hint"] == "sk-…wxyz"
          and c["providers"]["deepseek"]["thinking"] is True and c["mock"] is False and c["providers"]["anthropic"]["has_key"], blob[:300])
    st, c = call(base, "GET", "/api/config")
    check("GET config 不含任何明文（两家都有密钥时）", key not in json.dumps(c) and "sk-ant-test-1234567890abcdef" not in json.dumps(c) and "api_key" not in json.dumps(c))
    raw = json.load(open(ai_service.config_path(), encoding="utf-8"))
    check("config.json 是新结构（provider + providers.*），不再有扁平 api_key", raw["provider"] == "deepseek" and raw["providers"]["deepseek"]["api_key"] == key and "api_key" not in raw)
    st, h = call(base, "GET", "/api/health")
    check("health 带 provider / model / thinking", h.get("provider") == "deepseek" and h.get("model") == "deepseek-flash" and h.get("thinking") is True and h.get("mock") is False, json.dumps(h, ensure_ascii=False))

    st, d = call(base, "POST", "/api/ai/draft", {"intent": "山城下面有个地宫，从井下去", "force_mock": True})
    check("force_mock → 这次走模拟：provider=mock、_usage.cost_cny=0、_ms、带 levels", st == 200 and d["provider"] == "mock" and d["_usage"]["cost_cny"] == 0 and "_ms" in d and d["cards"][0].get("levels"), json.dumps(d, ensure_ascii=False)[:200])
    st, r = call(base, "POST", "/api/ai/revise", {"card": d["cards"][0], "action": {"type": "text", "text": "去掉地下的"}, "force_mock": True})
    check("revise force_mock「去掉地下的」→ levels=[]，带 provider / _usage / _ms", st == 200 and r["provider"] == "mock" and r["patch"].get("levels") == [] and "_usage" in r and "_ms" in r)

    orig = ai_deepseek.DeepSeekAI._post_once
    sent = []

    def fake_post(self, body, timeout):
        sent.append(body)
        if body.get("max_tokens") == 8:
            return ds_resp("ok", prompt=10, hit=0, completion=1)
        return ds_resp(json.dumps({"cards": [ai_service.EXAMPLE_CARD] * 3}, ensure_ascii=False))
    ai_deepseek.DeepSeekAI._post_once = fake_post
    try:
        st, d = call(base, "POST", "/api/ai/draft", {"intent": "黄昏山城"})
        check("draft 走 DeepSeek（打桩）→ provider=deepseek、_usage.cost_cny、_ms、thinking enabled", st == 200 and d["provider"] == "deepseek" and d["_usage"]["cost_cny"] is not None and "_ms" in d and sent[-1]["thinking"] == {"type": "enabled"}, json.dumps(d.get("_usage")))
        st, t = call(base, "POST", "/api/config/test", {})
        check("config/test 按当前服务商（deepseek）发最短请求", st == 200 and t["ok"] and t["provider"] == "deepseek" and sent[-1]["max_tokens"] == 8)

        def fail_post(self, body, timeout):
            raise ai_deepseek.DeepSeekAPIError("Authentication Fails", status_code=401, body={"error": {"message": "Authentication Fails", "type": "authentication_error"}})
        ai_deepseek.DeepSeekAI._post_once = fail_post
        st, t = call(base, "POST", "/api/config/test", {"api_key": "sk-wrong-000000000000"})
        check("config/test 坏密钥 → ok=false + 中文提示，不回显密钥", st == 200 and t["ok"] is False and "密钥" in t["message"] and "sk-wrong" not in json.dumps(t))
        st, e = call(base, "POST", "/api/ai/draft", {"intent": "山城"})
        check("draft 遇 DeepSeek 401 → 502 带 status / hint / provider", st == 502 and e["status"] == 401 and e["provider"] == "deepseek" and "密钥" in e["hint"], json.dumps(e, ensure_ascii=False))
    finally:
        ai_deepseek.DeepSeekAI._post_once = orig

    with open(ai_service.config_path(), "w", encoding="utf-8") as f:
        json.dump({"api_key": "sk-ant-legacy-0000000000abcd", "model": "claude-opus-5-5", "mock": True}, f)
    st, c = call(base, "GET", "/api/config")
    check("旧的扁平 {api_key, model} → 视为 anthropic，hint 打码", c["provider"] == "anthropic" and c["providers"]["anthropic"]["has_key"] and c["key_hint"] == "sk-ant-…abcd" and not c["providers"]["deepseek"]["has_key"], json.dumps(c, ensure_ascii=False))
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": "sk-zzzzzzzzzzzz1234"}}, "provider": "deepseek"})
    raw = json.load(open(ai_service.config_path(), encoding="utf-8"))
    check("旧配置保存后迁移：anthropic 密钥保留、扁平字段去掉", raw["providers"]["anthropic"]["api_key"] == "sk-ant-legacy-0000000000abcd" and "api_key" not in raw and c["provider"] == "deepseek")
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": ""}}})
    check("清除 DeepSeek 密钥 → has_key=false、mock=true", not c["providers"]["deepseek"]["has_key"] and c["mock"] is True)


def main() -> int:
    srv, port = api_server.start_server(ROOT, 0)
    base = f"http://127.0.0.1:{port}"
    unit_tests_claude_path()
    unit_tests_deepseek()
    unit_tests_json_repair()
    try:
        st, h = call(base, "GET", "/api/health")
        check("health 200 且 mock=true（无密钥）", st == 200 and h.get("ok") and h.get("mock") is True, json.dumps(h, ensure_ascii=False))

        st, c = call(base, "GET", "/api/config")
        check("config 不含密钥明文", st == 200 and "api_key" not in c and c.get("has_key") is False)

        st, c = call(base, "POST", "/api/config", {"provider": "anthropic", "api_key": "sk-ant-test-1234567890abcdef", "model": "claude-opus-5-5"})
        check("写入密钥后 has_key=true，只回 hint", st == 200 and c.get("has_key") and "api_key" not in c and c["key_hint"].startswith("sk-ant-") and "…" in c["key_hint"], json.dumps(c, ensure_ascii=False))
        st, c = call(base, "POST", "/api/config", {"mock": True})
        check("可强制 mock", c.get("mock") is True)

        st, d = call(base, "POST", "/api/ai/draft", {"intent": "我要一个黄昏的山城村庄"})
        ok = st == 200 and d.get("provider") == "mock" and len(d.get("cards", [])) == 3
        check("draft（mock）返回 3 张卡", ok, json.dumps(d, ensure_ascii=False)[:300])
        if ok:
            import ai_service
            try:
                import jsonschema
                for i, card in enumerate(d["cards"]):
                    jsonschema.validate(card, ai_service.CARD_SCHEMA)
                check("mock 卡片符合 CARD_SCHEMA（严格）", True)
            except ImportError:
                check("mock 卡片符合 CARD_SCHEMA（跳过：无 jsonschema）", True)
            except Exception as e:  # noqa: BLE001
                check("mock 卡片符合 CARD_SCHEMA（严格）", False, str(e)[:300])
            kinds = {(c["archetype"], c["landmark"]["placement"]) for c in d["cards"]}
            check("3 张卡结构互不相同", len(kinds) == 3, str(kinds))
            check("黄昏 → lighting.time_of_day=dusk", all(c["lighting"]["time_of_day"] == "dusk" for c in d["cards"]))

        st, d2 = call(base, "POST", "/api/ai/draft", {"intent": "山城", "axis": "地标位置", "targets": [{"landmark": {"placement": "top"}}, {"landmark": {"placement": "cliff_edge"}}, {"landmark": {"placement": "plaza"}}], "locked": {"card": d["cards"][0]}})
        check("draft 按轴 + targets 出变体", st == 200 and [c["landmark"]["placement"] for c in d2["cards"]] == ["top", "cliff_edge", "plaza"], json.dumps([c["landmark"]["placement"] for c in d2.get("cards", [])], ensure_ascii=False))
        st, dc = call(base, "POST", "/api/ai/draft", {"intent": "夜里亮灯的小山村，溪边有水车", "force_mock": True})
        cc = dc.get("cards", [])
        check("说死的条件三张都锁定（夜 / 溪 / 水车 / 3–4 层）", st == 200 and len(cc) == 3 and all(c["lighting"]["time_of_day"] == "night" and c["params"]["stream"] and c["landmark"]["kind"] == "wheel" and 3 <= c["params"]["terraces"] <= 4 for c in cc) and "水车" in dc.get("constraints", []), json.dumps([dc.get("constraints"), dc.get("constraints_fixed")], ensure_ascii=False)[:300])

        card = d["cards"][0]
        st, r = call(base, "POST", "/api/ai/revise", {"card": card, "action": {"type": "text", "text": "再陡一点"}})
        check("revise 文本「再陡一点」→ layer_height_m +1.5", st == 200 and r.get("understood") and r["patch"].get("params", {}).get("layer_height_m") == card["params"]["layer_height_m"] + 1.5, json.dumps(r, ensure_ascii=False)[:300])
        st, r = call(base, "POST", "/api/ai/revise", {"card": card, "action": {"type": "text", "text": "更有感觉一点"}})
        check("revise 模糊形容词 → understood=false 且请人在图上指", st == 200 and r.get("understood") is False and r.get("ask_to_point") is True and r.get("question"), json.dumps(r, ensure_ascii=False)[:300])
        st, r = call(base, "POST", "/api/ai/revise", {"card": card, "action": {"type": "region", "tag": "forest", "tag_label": "这里是林子", "kind": "forest", "density": 1, "handled_by_program": True, "facts": {"levels_touched": [1, 2], "area_m2": 400}}})
        check("revise 圈用途区域（程序已处理）→ 只复述，不改 regions", st == 200 and r.get("understood") and not r["patch"].get("regions") and "林子" in r["restatement"], json.dumps(r, ensure_ascii=False)[:300])
        st, r = call(base, "POST", "/api/ai/revise", {"card": card, "action": {"type": "region", "tag": "dense", "tag_label": "这里更密", "kind": "other", "density": 1.4, "handled_by_program": False, "facts": {"levels_touched": [1, 2], "area_m2": 400}}})
        check("revise 圈密度区域 → regions density patch 带层号", st == 200 and r["patch"].get("regions") and [x["terrace"] for x in r["patch"]["regions"]] == [1, 2] and all(x["kind"] == "other" and x["density"] == 1.4 for x in r["patch"]["regions"]), json.dumps(r, ensure_ascii=False)[:300])
        st, r = call(base, "POST", "/api/ai/revise", {"card": card, "action": {"type": "choice", "field": "spawn.placement", "value": "E"}})
        check("revise 选项 → spawn patch", r["patch"].get("spawn", {}).get("placement") == "E")

        st, e = call(base, "POST", "/api/ai/revise", {"card": card})
        check("缺 action → 400", st == 400 and e.get("error") == "bad request", json.dumps(e, ensure_ascii=False))
        st, e = call(base, "POST", "/api/ai/draft", {"intent": "x"}, headers={"Origin": "http://evil.example"})
        check("外部 Origin → 403", st == 403)
        st, e = call(base, "GET", "/api/nope")
        check("未知路由 → 404", st == 404)

        sid = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "B-sid", "scene.sid.json"), encoding="utf-8"))
        rb = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "scoring", "readback.example-unity.json"), encoding="utf-8"))
        st, s = call(base, "POST", "/api/score", {"intent": sid, "readback": rb, "auto_map": True})
        check("score 走 score_readback，返回 summary 与 rows", st == 200 and "summary" in s and s["summary"]["matched"] > 0 and s.get("format", "").startswith("engine:"), json.dumps(s.get("summary") or s, ensure_ascii=False)[:300])

        st, w = call(base, "POST", "/api/save", {"name": "测试.sid.json", "content": {"a": 1}})
        check("save 写到 exports 目录", st == 200 and w.get("ok") and os.path.isfile(w["path"]) and w["path"].startswith(os.environ["LOCALAPPDATA"]), json.dumps(w, ensure_ascii=False))
        st, w = call(base, "POST", "/api/save", {"name": "../evil.json", "content": "x"})
        check("save 不允许路径穿越", st == 200 and os.path.basename(w["path"]) == "evil.json" and os.path.dirname(w["path"]).endswith("exports"), json.dumps(w, ensure_ascii=False))

        req = urllib.request.Request(base + "/", method="GET")
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            resp = opener.open(req, timeout=10)
            loc = resp.headers.get("Location")
        except urllib.error.HTTPError as ex:
            loc = ex.headers.get("Location")
        check("根路径重定向到 /medium/ 或 /app/", loc in ("/medium/", "/app/"), str(loc))

        with urllib.request.urlopen(base + "/medium/engine/terrain.js", timeout=10) as r2:
            check("静态文件可读（engine/terrain.js）", r2.status == 200 and b"buildTerrain" in r2.read())
        server_tests_entry_and_archetype(base)
        server_tests_providers(base)
    finally:
        srv.shutdown()

    failed = [r for r in results if not r[1]]
    print(f"\nDONE passed={len(results) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())

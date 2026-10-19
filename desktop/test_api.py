# -*- coding: utf-8 -*-
"""
test_api.py — 本地服务的冒烟测试（进程内起服务，mock AI，不需要密钥）

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


def main() -> int:
    srv, port = api_server.start_server(ROOT, 0)
    base = f"http://127.0.0.1:{port}"
    unit_tests_claude_path()
    try:
        st, h = call(base, "GET", "/api/health")
        check("health 200 且 mock=true（无密钥）", st == 200 and h.get("ok") and h.get("mock") is True, json.dumps(h, ensure_ascii=False))

        st, c = call(base, "GET", "/api/config")
        check("config 不含密钥明文", st == 200 and "api_key" not in c and c.get("has_key") is False)

        st, c = call(base, "POST", "/api/config", {"api_key": "sk-ant-test-1234567890abcdef", "model": "claude-opus-5-5"})
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

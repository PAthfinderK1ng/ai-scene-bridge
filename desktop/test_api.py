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


def main() -> int:
    srv, port = api_server.start_server(ROOT, 0)
    base = f"http://127.0.0.1:{port}"
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

# -*- coding: utf-8 -*-
"""
api_server.py — 「场景对话」本地服务：静态文件 + /api/*

路由（全部 JSON，仅监听 127.0.0.1）：
  GET  /api/health                → {ok, version, mock}
  GET  /api/config                → 公开配置（不回传密钥明文，只回 has_key / key_hint / model / mock）
  POST /api/config                → {api_key?, model?, mock?} 写入 %LOCALAPPDATA%/ai-scene-bridge/config.json
  POST /api/config/test           → 用当前密钥发一条最短请求，验证密钥可用
  POST /api/ai/draft              → {intent, axis?, targets?, locked?} → {cards:[3 张卡], provider}
  POST /api/ai/revise             → {card, action, locked?} → {understood, patch, restatement, question?, ask_to_point}
  POST /api/score                 → {intent: sid, readback: json, map?, auto_map?} → score_readback 的结果 JSON
  POST /api/save                  → {name, content} 把导出包 / SID 写到 %LOCALAPPDATA%/ai-scene-bridge/exports/

密钥只在这个进程里；前端 JS 永远拿不到明文。
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import ai_service  # noqa: E402

APP_VERSION = "0.2.0"
MAX_BODY = 32 * 1024 * 1024  # 读回 JSON 可能有几千个对象


def _score(root: str, payload: dict) -> dict:
    """直接调用 tools/score_readback.py 里的函数（不起子进程，打包后也能用）"""
    tdir = os.path.join(root, "tools")
    if tdir not in sys.path:
        sys.path.insert(0, tdir)
    import score_readback as sr

    sid = payload["intent"]
    include_areas = bool(payload.get("include_areas"))
    intent = sr.intent_objects(sid, include_areas)
    rb, fmt = sr.readback_objects(payload["readback"])
    unscored = set() if include_areas else sr.unscored_ids(sid)
    if include_areas:
        rb.update(sr.merge_path_readbacks(rb, [p["id"] for p in sid.get("paths", [])]))
        unscored = {sr.norm(f["id"]) for f in sid.get("terrain", {}).get("features", [])}
    mapping = {k: v for k, v in (payload.get("map") or {}).items() if not str(k).startswith("_")}
    # 传 sid 与原始读回：compare 才会算台地层 / 颜色（rows）与可见性 / 连通性（summary）
    res = sr.compare(intent, rb, mapping, bool(payload.get("auto_map", True)), unscored, sid=sid, rb_raw=payload["readback"])
    res["format"] = fmt
    # 给前端画红点用：每行附上引擎实际的位置 / 朝向 / 尺寸
    by_raw = {o.get("raw_name"): o for o in rb.values()}
    for row in res.get("rows", []):
        m = row.get("matched")
        o = by_raw.get(m) if m else None
        if o:
            row["readback_position"] = o.get("position")
            row["readback_rotation_y"] = o.get("rotation_y")
            row["readback_size"] = o.get("size")
    return res


def _ai_error_types():
    try:
        import anthropic
        return (anthropic.APIError,)  # APIStatusError（有状态码）与 APIConnectionError / APITimeoutError（没有）的共同基类
    except Exception:
        return (type("_Never", (Exception,), {}),)


# 按 HTTP 状态码给人看得懂的诊断（来源：claude-api 技能 shared/error-codes.md）
AI_HINTS = {
    400: "请求被 API 拒绝：多半是参数或 schema 的问题，把 message 原文发给开发者",
    401: "密钥无效、已撤销或格式不对：到 AI 设置里重新粘贴",
    402: "账户计费问题：到 console.anthropic.com 看余额 / 付款方式",
    403: "这把密钥没有权限用这个模型或功能",
    404: "模型名不存在或你的组织不可用：检查 AI 设置里的模型名（默认 claude-opus-5-5）",
    413: "请求过大",
    429: "触发限流：等几十秒再试",
    500: "Anthropic 服务异常：稍后重试",
    529: "Anthropic 过载：稍后重试",
}
RETRYABLE = {408, 409, 429, 500, 529}


def ai_error_payload(e: Exception) -> dict:
    """把 anthropic 的异常整理成前端能诊断的 JSON：状态码、错误类型、request_id、是否可重试、一句中文提示。"""
    status = getattr(e, "status_code", None)
    body = getattr(e, "body", None)
    etype = (body.get("error") or {}).get("type") if isinstance(body, dict) and isinstance(body.get("error"), dict) else None
    is_timeout = type(e).__name__ == "APITimeoutError"
    is_conn = status is None
    hint = AI_HINTS.get(status) or ("等太久没回：模型思考 + 三张卡输出可能超过 180 s，再试一次或降低 effort" if is_timeout else "连不上 api.anthropic.com：检查网络 / 代理" if is_conn else "")
    return {"error": "ai", "message": getattr(e, "message", None) or str(e), "status": status, "type": etype or type(e).__name__,
            "request_id": getattr(e, "request_id", None), "retryable": is_conn or status in RETRYABLE, "hint": hint}


class AppHandler(SimpleHTTPRequestHandler):
    """静态文件 + /api。root 由子类属性给出；AI 对象按请求懒建（配置改了立即生效）。"""

    server_version = "SceneDialog/" + APP_VERSION
    root: str = "."

    # ---------- 静态 ----------
    def log_message(self, *args):  # 不往（可能不存在的）控制台刷日志
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._dispatch("GET")
        if self.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/medium/" if os.path.isfile(os.path.join(self.root, "medium", "index.html")) else "/app/")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._dispatch("POST")
        self._json(404, {"error": "not found"})

    # ---------- API ----------
    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _dispatch(self, method: str) -> None:
        # 只接受本机页面的请求：带 Origin 且不是本服务的一律拒绝（防止别的网页调本地服务）
        origin = self.headers.get("Origin")
        host = self.headers.get("Host") or ""
        if origin and not origin.endswith("://" + host):
            return self._json(403, {"error": "forbidden origin"})
        path = self.path.split("?", 1)[0].rstrip("/")
        t0 = time.time()
        try:
            handler = ROUTES.get((method, path))
            if not handler:
                return self._json(404, {"error": f"no route {method} {path}"})
            payload = self._body() if method == "POST" else {}
            result = handler(self.root, payload)
            if isinstance(result, dict):
                result.setdefault("_ms", int((time.time() - t0) * 1000))
            self._json(200, result)
        except ai_service.AIError as e:  # 200 回来了但不能用：拒绝 / 截断 / 不合 schema
            self._json(502, {"error": "ai_" + e.kind, "kind": e.kind, "message": str(e), **e.detail})
        except _ai_error_types() as e:  # anthropic 的 API 错误：状态码、类型、request_id、提示一起透出
            self._json(502, ai_error_payload(e))
        except (ValueError, KeyError, TypeError) as e:
            self._json(400, {"error": "bad request", "message": f"{type(e).__name__}: {e}"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": "server", "message": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-2000:]})


# ---------- 路由实现 ----------
def r_health(root, _):
    cfg = ai_service.public_config()
    return {"ok": True, "version": APP_VERSION, "mock": cfg["mock"], "model": cfg["model"], "root": root}


def r_config_get(root, _):
    return ai_service.public_config()


def r_config_set(root, payload):
    ai_service.save_config(payload)
    return ai_service.public_config()


def r_config_test(root, payload):
    cfg = ai_service.load_config()
    if payload.get("api_key"):
        cfg["api_key"] = payload["api_key"]
    if not cfg.get("api_key"):
        return {"ok": False, "message": "没有密钥"}
    import anthropic
    client = anthropic.Anthropic(api_key=cfg["api_key"], timeout=30.0, max_retries=0)
    model = (payload.get("model") or cfg.get("model") or ai_service.DEFAULT_MODEL).strip()
    t0 = time.time()
    try:
        # 最短的一条：不传 thinking / 采样参数（Opus 5.5 会 400），effort=low 让它少想；max_tokens 要装得下思考 + 回复
        resp = client.messages.create(model=model, max_tokens=256, output_config={"effort": "low"}, messages=[{"role": "user", "content": "只回复两个字母：ok"}])
    except anthropic.APIError as e:
        p = ai_error_payload(e)
        return {"ok": False, **p, "message": (p["hint"] + "（" + p["message"] + "）") if p["hint"] else p["message"]}
    text = "".join(b.text for b in resp.content if b.type == "text")
    if resp.stop_reason == "refusal":
        return {"ok": False, "message": "模型拒绝了测试请求（stop_reason=refusal）", "model": resp.model}
    u = resp.usage
    return {"ok": True, "model": resp.model, "ms": int((time.time() - t0) * 1000), "text": text, "request_id": getattr(resp, "_request_id", None),
            "usage": {"input": u.input_tokens, "output": u.output_tokens}}


def r_ai_draft(root, payload):
    intent = (payload.get("intent") or "").strip()
    if not intent:
        raise ValueError("intent 不能为空")
    return ai_service.get_ai().draft(intent, payload.get("axis"), payload.get("targets"), payload.get("locked"))


def r_ai_revise(root, payload):
    if not payload.get("card") or not payload.get("action"):
        raise ValueError("需要 card 与 action")
    return ai_service.get_ai().revise(payload["card"], payload["action"], payload.get("locked"))


def r_score(root, payload):
    if "intent" not in payload or "readback" not in payload:
        raise ValueError("需要 intent 与 readback")
    return _score(root, payload)


def r_save(root, payload):
    name = os.path.basename(str(payload.get("name") or "scene.json"))
    if not name or name.startswith("."):
        raise ValueError("文件名非法")
    d = Path(ai_service.config_path()).parent / "exports"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    content = payload.get("content")
    if isinstance(content, str):
        p.write_text(content, encoding="utf-8")
    else:
        p.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(p)}


ROUTES = {
    ("GET", "/api/health"): r_health,
    ("GET", "/api/config"): r_config_get,
    ("POST", "/api/config"): r_config_set,
    ("POST", "/api/config/test"): r_config_test,
    ("POST", "/api/ai/draft"): r_ai_draft,
    ("POST", "/api/ai/revise"): r_ai_revise,
    ("POST", "/api/score"): r_score,
    ("POST", "/api/save"): r_save,
}


def start_server(root: str, port: int = 0):
    """起线程化服务，返回 (server, port)。"""
    handler = type("BoundHandler", (AppHandler,), {"root": root})
    srv = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=root))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

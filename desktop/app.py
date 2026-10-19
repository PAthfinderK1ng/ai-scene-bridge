#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — 「场景对话」入口：本地服务（静态文件 + /api/*）+ WebView2 窗口

  python -X utf8 desktop/app.py                    开窗口（WebView2；不可用时退回 Edge --app，再不行用默认浏览器）
  python -X utf8 desktop/app.py --no-window        只起服务并打印地址（调试 / 自动化测试）
  python -X utf8 desktop/app.py --port 8791        固定端口（默认随机）

只监听 127.0.0.1，拒绝外部 Origin。密钥只在这个进程里，网页永远拿不到明文。AI 全部在 ai.py。

路由（全部 JSON）：
  GET  /api/health      → {ok, version, mock, provider, provider_label, model, thinking, root}
  GET  /api/config      → 公开配置（只有 has_key / key_hint，没有明文）
  POST /api/config      → {provider?, mock?, providers?: {anthropic|deepseek: {api_key?, model?, thinking?, base_url?}}}，也收扁平 api_key / model / thinking
  POST /api/config/test → {provider?, api_key?, model?} 发一条最短请求验证密钥
  GET  /api/plan/schema → spec/plan.schema.json 原样（界面生成旋钮也可以直接读静态文件）
  POST /api/ai/draft    → 见 ai.draft
  POST /api/ai/revise   → 见 ai.revise
  POST /api/score       → {intent: sid, readback, map?, auto_map?} → tools/score_readback.py 的比对结果
  POST /api/save        → {name, content} 写到 %LOCALAPPDATA%/ai-scene-bridge/exports/
  POST /api/validate    → {doc, schema: sid|plan} → {ok, errors, count, engine}（有 jsonschema 用它）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import ai  # noqa: E402

APP_VERSION = "0.5.0"
APP_TITLE = "场景对话 · ai-scene-bridge"
MAX_BODY = 32 * 1024 * 1024  # 读回 JSON 可能有几千个对象


def log(msg: str) -> None:
    """--windowed 打包后 sys.stdout / stderr 是 None"""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            try:
                stream.write(msg + "\n")
                stream.flush()
            except Exception:
                pass
            return


# ------------------------------------------------------------ 路由
def r_health(root, _):
    cfg = ai.public_config()
    return {"ok": True, "version": APP_VERSION, "mock": cfg["mock"], "provider": cfg["provider"], "provider_label": cfg["provider_label"],
            "model": cfg["model"], "thinking": cfg["thinking"], "root": root}


def r_config_get(root, _):
    return ai.public_config()


def r_config_set(root, payload):
    ai.save_config(payload)
    return ai.public_config()


def r_config_test(root, payload):
    return ai.test_key(payload)


def r_schema(root, _):
    return ai.plan_schema()


def r_draft(root, payload):
    return ai.draft(payload)


def r_revise(root, payload):
    return ai.revise(payload)


def r_score(root, payload):
    """直接调 tools/score_readback.py 里的函数（不起子进程，打包后也能用）"""
    if "intent" not in payload or "readback" not in payload:
        raise ValueError("需要 intent 与 readback")
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
    res = sr.compare(intent, rb, mapping, bool(payload.get("auto_map", True)), unscored, sid=sid, rb_raw=payload["readback"])
    res["format"] = fmt
    by_raw = {o.get("raw_name"): o for o in rb.values()}
    for row in res.get("rows", []):  # 给前端画红点：引擎实际的位置 / 朝向 / 尺寸
        o = by_raw.get(row.get("matched")) if row.get("matched") else None
        if o:
            row["readback_position"], row["readback_rotation_y"], row["readback_size"] = o.get("position"), o.get("rotation_y"), o.get("size")
    return res


_score = r_score  # tools/test_score_readback.py 用


def r_validate(root, payload):
    """POST /api/validate {doc, schema: "sid"|"plan"} → {ok, errors, engine}：有 jsonschema 用它，没有用 ai.validate（同一套关键字）"""
    which = payload.get("schema") if payload.get("schema") in ("sid", "plan") else "sid"
    schema = ai.plan_schema() if which == "plan" else ai._load_json(ai.spec_path("sid.schema.json"))
    doc = payload.get("doc")
    try:
        import jsonschema
        errs = [f"$.{'.'.join(str(x) for x in e.absolute_path)}: {e.message}" for e in jsonschema.Draft7Validator(schema).iter_errors(doc)]
        engine = "jsonschema"
    except ImportError:
        errs, engine = ai.validate(schema, doc), "mini"
    return {"ok": not errs, "errors": errs[:50], "count": len(errs), "engine": engine}


def r_save(root, payload):
    name = os.path.basename(str(payload.get("name") or "scene.json"))
    if not name or name.startswith("."):
        raise ValueError("文件名非法")
    d = Path(ai.data_dir()) / "exports"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    content = payload.get("content")
    p.write_text(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(p)}


ROUTES = {
    ("GET", "/api/health"): r_health,
    ("GET", "/api/config"): r_config_get,
    ("POST", "/api/config"): r_config_set,
    ("POST", "/api/config/test"): r_config_test,
    ("GET", "/api/plan/schema"): r_schema,
    ("POST", "/api/ai/draft"): r_draft,
    ("POST", "/api/ai/revise"): r_revise,
    ("POST", "/api/score"): r_score,
    ("POST", "/api/save"): r_save,
    ("POST", "/api/validate"): r_validate,
}


class Handler(SimpleHTTPRequestHandler):
    server_version = "SceneDialog/" + APP_VERSION
    root: str = "."

    def log_message(self, *args):  # 打包后没有控制台
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._dispatch("GET")
        if self.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/medium/")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._dispatch("POST")
        self._json(404, {"error": "not found"})

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
        origin, host = self.headers.get("Origin"), self.headers.get("Host") or ""
        if origin and not origin.endswith("://" + host):  # 别的网页不许调本地服务
            return self._json(403, {"error": "forbidden origin"})
        path = self.path.split("?", 1)[0].rstrip("/")
        t0 = time.time()
        try:
            handler = ROUTES.get((method, path))
            if not handler:
                return self._json(404, {"error": f"no route {method} {path}"})
            result = handler(self.root, self._body() if method == "POST" else {})
            if isinstance(result, dict) and path.startswith("/api/ai/"):
                result.setdefault("_ms", int((time.time() - t0) * 1000))
            self._json(200, result)
        except ai.AIError as e:  # 200 回来了但不能用：拒绝 / 截断 / 不合 schema
            self._json(502, {"error": "ai_" + e.kind, "kind": e.kind, "message": str(e), **e.detail})
        except ai.api_error_types() as e:  # 服务商的 HTTP / 网络错误
            self._json(502, ai.error_payload(e))
        except (ValueError, KeyError, TypeError) as e:
            self._json(400, {"error": "bad request", "message": f"{type(e).__name__}: {e}"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": "server", "message": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-2000:]})


def start_server(root: str, port: int = 0):
    """起线程化服务，返回 (server, port)"""
    handler = type("BoundHandler", (Handler,), {"root": root})
    srv = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=root))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


# ------------------------------------------------------------ 窗口
def find_edge() -> str | None:
    for p in (
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
    ):
        if p and os.path.isfile(p):
            return p
    return None


def message_box(text: str) -> None:
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, APP_TITLE, 0x10)
    except Exception:
        log(text)


def run_webview(url: str) -> bool:
    try:
        import webview
    except Exception as e:  # pythonnet / WebView2 缺失
        log(f"pywebview 不可用：{e}")
        return False
    try:
        settings = getattr(webview, "settings", None)
        if isinstance(settings, dict):
            settings["ALLOW_DOWNLOADS"] = True  # 「导出」走浏览器下载
            settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        webview.create_window(APP_TITLE, url, width=1440, height=900, min_size=(1000, 640))
        webview.start(gui="edgechromium", private_mode=False, storage_path=os.path.join(ai.data_dir(), "webview"))
        return True
    except Exception as e:
        log(f"WebView2 窗口失败：{e}")
        return False


def run_edge_app(url: str) -> bool:
    edge = find_edge()
    if not edge:
        return False
    profile = os.path.join(ai.data_dir(), "edge-profile")  # 独立 profile：窗口关掉进程才退出
    subprocess.Popen([edge, f"--app={url}", "--window-size=1440,900", f"--user-data-dir={profile}", "--no-first-run"]).wait()
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="场景对话：本地服务 + 窗口")
    ap.add_argument("--port", type=int, default=0, help="本地服务端口（默认随机）")
    ap.add_argument("--no-window", action="store_true", help="只起服务，不开窗口")
    args = ap.parse_args(argv)

    root = ai.resource_root()
    if not os.path.isfile(os.path.join(root, "medium", "index.html")):
        message_box(f"找不到界面文件（{root}/medium）。请从仓库根目录运行，或重新打包。")
        return 2
    try:
        srv, port = start_server(root, args.port)
    except OSError as e:
        message_box(f"本地服务启动失败：{e}")
        return 2
    url = f"http://127.0.0.1:{port}/medium/"
    log(f"scene-dialog serving {root} at {url}")
    if args.no_window:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        srv.shutdown()
        return 0
    if not (run_webview(url) or run_edge_app(url)):
        webbrowser.open(url)
        message_box("没有找到 WebView2 或 Edge，已改用默认浏览器打开。关闭此提示后服务会停止。")
    srv.shutdown()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # --windowed 打包后没有控制台，异常要弹窗
        message_box(f"启动失败：{exc!r}")
        sys.exit(1)

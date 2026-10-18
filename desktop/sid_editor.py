#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sid_editor.py — SID 编辑器的桌面壳

做两件事：
1. 在 127.0.0.1 的随机端口起一个静态服务，根目录 = 仓库根（源码运行）或打包后的资源目录，
   这样 app/ 能用相对路径读到 spec/（示例、PROTOCOL）。
2. 用系统 WebView2（pywebview，Win11 自带运行时）开一个独立窗口加载 /app/；
   pywebview 不可用时回退到 Edge 的 --app 模式（无地址栏的独立窗口）。

用法：
  python desktop/sid_editor.py                 开窗口
  python desktop/sid_editor.py --no-window     只起服务并打印地址（调试 / 自动化测试）
  python desktop/sid_editor.py --port 8766     固定端口
打包见 desktop/build.bat，产物 dist/SIDEditor/SIDEditor.exe。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import webbrowser

APP_TITLE = "场景对话 · ai-scene-bridge"


def log(msg: str) -> None:
    """--windowed 打包后 sys.stdout / sys.stderr 是 None，print 会直接抛异常"""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            try:
                stream.write(msg + "\n")
                stream.flush()
            except Exception:
                pass
            return


def resource_root() -> str:
    """PyInstaller 打包后资源在 sys._MEIPASS（onedir 时是 _internal/）；源码运行时是仓库根目录"""
    base = getattr(sys, "_MEIPASS", None)
    if base and (os.path.isdir(os.path.join(base, "medium")) or os.path.isdir(os.path.join(base, "app"))):
        return base
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def data_dir() -> str:
    d = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ai-scene-bridge")
    os.makedirs(d, exist_ok=True)
    return d


def start_server(root: str, port: int = 0):
    """静态文件 + /api（AI 代理、读回评分）；实现见 desktop/api_server.py"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import api_server
    return api_server.start_server(root, port)


def find_edge() -> str | None:
    for p in (
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
    ):
        if p and os.path.isfile(p):
            return p
    return None


def message_box(text: str, title: str = APP_TITLE) -> None:
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
    except Exception:
        log(text)


def run_webview(url: str) -> bool:
    """用 pywebview + WebView2 开窗口；返回是否成功走到了事件循环"""
    try:
        import webview
    except Exception as e:  # pythonnet / WebView2 缺失
        log(f"pywebview 不可用：{e}")
        return False
    try:
        settings = getattr(webview, "settings", None)
        if isinstance(settings, dict):
            settings["ALLOW_DOWNLOADS"] = True            # 「保存」「导出实验包」走浏览器下载
            settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        webview.create_window(APP_TITLE, url, width=1440, height=900, min_size=(1000, 640))
        webview.start(gui="edgechromium", private_mode=False, storage_path=os.path.join(data_dir(), "webview"))
        return True
    except Exception as e:
        log(f"WebView2 窗口失败：{e}")
        return False


def run_edge_app(url: str) -> bool:
    """回退：Edge --app 模式。单独的 user-data-dir 保证是独立进程，窗口关掉进程才退出"""
    edge = find_edge()
    if not edge:
        return False
    profile = os.path.join(data_dir(), "edge-profile")
    proc = subprocess.Popen([edge, f"--app={url}", "--window-size=1440,900", f"--user-data-dir={profile}", "--no-first-run"])
    proc.wait()
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="SID 编辑器桌面壳")
    ap.add_argument("--port", type=int, default=0, help="本地服务端口（默认随机）")
    ap.add_argument("--no-window", action="store_true", help="只起服务，不开窗口")
    args = ap.parse_args(argv)

    root = resource_root()
    entry = "medium" if os.path.isfile(os.path.join(root, "medium", "index.html")) else "app"
    if not os.path.isdir(os.path.join(root, entry)):
        message_box(f"找不到界面文件（{root}/{entry}）。请从仓库根目录运行，或重新打包。")
        return 2
    try:
        srv, port = start_server(root, args.port)
    except OSError as e:
        message_box(f"本地服务启动失败：{e}")
        return 2
    url = f"http://127.0.0.1:{port}/{entry}/"
    log(f"SID editor serving {root} at {url}")

    if args.no_window:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        srv.shutdown()
        return 0

    ok = run_webview(url) or run_edge_app(url)
    if not ok:
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

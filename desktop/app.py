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
  POST /api/ai/draft    → 见 draft（本文件）：带 scene_id 取场景级记忆；「记住：…」本地存、不调 AI
  POST /api/ai/revise   → 见 revise（本文件）：带 refs[] / history[] / scene_id；「记住：… / 以后都… / 我不喜欢… / 别再…」本地存
  GET  /api/scenes[?trash=1]            → [{id, name, created, updated, thumb?}]（updated 倒序；trash=1 列回收站，多 deleted / purge_at）
  POST /api/scenes                      → {name?, data?, thumb?} → {id, name, created, updated}
  GET|PUT|DELETE /api/scenes/<id>       → {id, name, created, updated, data, thumb?} | {name?, data?, thumb?} → {id, name, updated} | 进回收站 7 天
  POST /api/scenes/<id>/duplicate|restore
  GET|POST /api/memory, PUT|DELETE /api/memory/<id>, POST /api/memory/clear（docs/07 §3）
数据都在 ai.data_dir()（%LOCALAPPDATA%/ai-scene-bridge，环境变量 SCENE_DIALOG_DATA_DIR 可整个换掉）；data 上限 5 MB（413）。
  POST /api/score       → {intent: sid, readback, map?, auto_map?} → tools/score_readback.py 的比对结果
  POST /api/save        → {name, content} 写到 %LOCALAPPDATA%/ai-scene-bridge/exports/
  POST /api/validate    → {doc, schema: sid|plan} → {ok, errors, count, engine}（有 jsonschema 用它）
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import ai  # noqa: E402
from ai import (  # noqa: E402  入口用到的
    MAX_SHAPES,
    ONE_GROUPS,
    _max_calls,
    _usage_zero,
    all_nodes,
    anchor_base,
    describe_ops,
    diversity,
    enforce,
    enforce_ops,
    extract,
    generate,
    get_ai,
    index,
    memory_context,
    plan_schema,
    ref_warnings,
    shape_count,
    summary,
    validate,
    walk_nodes,
)

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


# ------------------------------------------------------------ 场景与记忆的存储（docs/07 §2 §3）：数据目录下的 JSON 文件，先写临时文件再改名
class NotFound(Exception):
    """→ 404"""


class TooLarge(ValueError):
    """→ 413"""


_STORE_LOCK = threading.RLock()
SCENE_MAX_BYTES = 5 * 1024 * 1024  # 一个场景（程序 + 候选 + 聊天 + 撤销栈 + 视图）最多 5 MB
THUMB_MAX_BYTES = 400 * 1024
TRASH_DAYS = 7
MEMORY_CAP = 200
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _atomic_write(path: Path, obj) -> None:
    """先写同目录的临时文件、刷盘，再 os.replace（同一卷上是原子的：断电 / 崩溃不会留下半个文件）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def scenes_dir() -> Path:
    return Path(ai.data_dir()) / "scenes"


def trash_dir() -> Path:
    return scenes_dir() / ".trash"


def _scene_path(sid, trash: bool = False) -> Path:
    if not isinstance(sid, str) or not _ID_RE.match(sid):
        raise NotFound(f"没有场景 {sid!r}")
    return (trash_dir() if trash else scenes_dir()) / f"{sid}.json"


def _check_size(data, thumb) -> None:
    n = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    if n > SCENE_MAX_BYTES:
        raise TooLarge(f"场景数据 {n / 1048576:.1f} MB，超过上限 {SCENE_MAX_BYTES // 1048576} MB：多半是撤销栈或候选太大，清掉一些再存")
    if thumb is not None and (not isinstance(thumb, str) or not thumb.startswith("data:image/")):
        raise ValueError("thumb 应为 data:image/… 的字符串")
    if thumb is not None and len(thumb) > THUMB_MAX_BYTES:
        raise TooLarge(f"缩略图 {len(thumb) // 1024} KB，超过上限 {THUMB_MAX_BYTES // 1024} KB")


def _scene_name(v, default: str) -> str:
    s = re.sub(r"\s+", " ", str(v or "")).strip()[:40]
    return s or default


def purge_trash(now: int | None = None) -> list[str]:
    """回收站里超过 7 天的场景永久删掉，它的场景级记忆一起删"""
    now = now or _now_ms()
    gone = []
    with _STORE_LOCK:
        for p in trash_dir().glob("*.json") if trash_dir().is_dir() else []:
            doc = _read(p, {}) or {}
            if now - int(doc.get("deleted") or 0) > TRASH_DAYS * 86400_000:
                try:
                    p.unlink()
                    gone.append(p.stem)
                except OSError:
                    pass
        if gone:
            items = memory_list()
            keep = [m for m in items if not (m.get("scope") == "scene" and m.get("scene_id") in gone)]
            if len(keep) != len(items):
                _save_memory(keep)
    return gone


def scene_list(trash: bool = False) -> list[dict]:
    """[{id, name, updated, created, thumb?}] 按 updated 倒序；trash=True 列回收站（多 deleted、purge_at）"""
    purge_trash()
    d = trash_dir() if trash else scenes_dir()
    out = []
    for p in d.glob("*.json") if d.is_dir() else []:
        doc = _read(p)
        if not isinstance(doc, dict) or not doc.get("id"):
            continue
        row = {k: doc[k] for k in ("id", "name", "updated", "created", "thumb") if doc.get(k) is not None}
        if trash:
            row.update(deleted=doc.get("deleted"), purge_at=int(doc.get("deleted") or 0) + TRASH_DAYS * 86400_000)
        out.append(row)
    out.sort(key=lambda r: -int((r.get("deleted") if trash else r.get("updated")) or 0))
    return out


def scene_get(sid) -> dict:
    doc = _read(_scene_path(sid))
    if not isinstance(doc, dict):
        raise NotFound(f"没有场景 {sid!r}" + ("（在回收站里）" if _scene_path(sid, True).is_file() else ""))
    return doc


def scene_create(payload: dict) -> dict:
    data, thumb = payload.get("data"), payload.get("thumb")
    _check_size(data, thumb)
    with _STORE_LOCK:
        sid = f"s{_now_ms():x}{os.urandom(2).hex()}"
        now = _now_ms()
        doc = {"id": sid, "name": _scene_name(payload.get("name"), f"场景 {len(scene_list()) + 1}"), "created": now, "updated": now, "data": data}
        if thumb:
            doc["thumb"] = thumb
        _atomic_write(_scene_path(sid), doc)
    return {k: doc[k] for k in ("id", "name", "created", "updated")}


def scene_put(sid, payload: dict) -> dict:
    """改名 / 存数据 / 换缩略图（只改给了的字段）；不存在时按这个 id 新建（前端离线时先在本地起了 id）；在回收站里的不许写"""
    with _STORE_LOCK:
        path = _scene_path(sid)
        if _scene_path(sid, True).is_file():
            raise NotFound(f"场景 {sid} 在回收站里：先恢复再改")
        doc = _read(path)
        created = not isinstance(doc, dict)
        if created:
            doc = {"id": sid, "name": "", "created": _now_ms(), "data": None}
        if "data" in payload:
            doc["data"] = payload["data"]
        if "thumb" in payload:
            doc["thumb"] = payload["thumb"]
        _check_size(doc.get("data"), doc.get("thumb"))
        if "name" in payload or created:
            doc["name"] = _scene_name(payload.get("name"), doc.get("name") or "未命名场景")
        doc["updated"] = _now_ms()
        _atomic_write(path, doc)
    return {"id": sid, "name": doc["name"], "updated": doc["updated"], **({"created_new": True} if created else {})}


def scene_delete(sid) -> dict:
    """进回收站（7 天后永久删）"""
    with _STORE_LOCK:
        doc = scene_get(sid)
        doc["deleted"] = _now_ms()
        _atomic_write(_scene_path(sid, True), doc)
        _scene_path(sid).unlink()
    return {"ok": True, "id": sid, "trash_days": TRASH_DAYS}


def scene_restore(sid) -> dict:
    with _STORE_LOCK:
        doc = _read(_scene_path(sid, True))
        if not isinstance(doc, dict):
            raise NotFound(f"回收站里没有场景 {sid!r}")
        doc.pop("deleted", None)
        doc["updated"] = _now_ms()
        _atomic_write(_scene_path(sid), doc)
        _scene_path(sid, True).unlink()
    return {"id": sid, "name": doc.get("name"), "updated": doc["updated"]}


def scene_duplicate(sid) -> dict:
    doc = scene_get(sid)
    return scene_create({"name": (str(doc.get("name") or "场景") + " 副本")[:40], "data": doc.get("data"), "thumb": doc.get("thumb")})


# ---------- 记忆：memory.json = {version, items: [{id, text, kind, scope, scene_id?, source, enabled, created, uses, last_used?}]}
MEMORY_KINDS = ai.MEMORY_KINDS


def memory_path() -> Path:
    return Path(ai.data_dir()) / "memory.json"


def memory_list() -> list[dict]:
    doc = _read(memory_path(), {}) or {}
    items = [m for m in doc.get("items") or [] if isinstance(m, dict) and m.get("id")]
    return sorted(items, key=lambda m: -(m.get("created") or 0))


def _save_memory(items: list) -> None:
    with _STORE_LOCK:
        _atomic_write(memory_path(), {"version": 1, "items": items})


def memory_kind(t: str) -> str:
    if re.search(r"不喜欢|讨厌|受不了|别再|不要|不许|不用|避免|少用|别(?!墅)", t):
        return "dislike"
    if re.search(r"喜欢|偏爱|爱看|最爱|偏好", t):
        return "like"
    if re.search(r"^(?:我是|我在做|我做的|我们在做|我们做的|我们的|我的项目|项目是|游戏是|用的是|我用)", t):
        return "fact"
    return "rule"


_MEM_FILLER = re.compile(r"[\s，。,.;；:：！!？?、\"'“”‘’（）()]|不喜欢|喜欢|讨厌|受不了|偏爱|偏好|优先|尽量|最好|不要|别再|以后|今后|一律|总是|都|也|我|俺|的|了|请|要|用")


def _mem_norm(t: str) -> str:
    return _MEM_FILLER.sub("", str(t or ""))


def memory_similar(a: dict, b: dict) -> bool:
    """语义近似（本地，不调 AI）：去掉语气 / 极性词后相同、互相包含，或字二元组重合 ≥ 0.6；喜欢 vs 不喜欢不算重复"""
    ka, kb = a.get("kind"), b.get("kind")
    if {ka, kb} == {"like", "dislike"}:
        return False
    na, nb = _mem_norm(a.get("text")), _mem_norm(b.get("text"))
    if not na or not nb:
        return str(a.get("text")).strip() == str(b.get("text")).strip()
    if na == nb or (min(len(na), len(nb)) >= 2 and (na in nb or nb in na)):
        return True
    ga, gb = {na[i:i + 2] for i in range(len(na) - 1)}, {nb[i:i + 2] for i in range(len(nb) - 1)}
    return bool(ga and gb) and len(ga & gb) / len(ga | gb) >= 0.6


def memory_add(payload: dict) -> dict:
    """新增一条；和已有的近似 → 不重复存，回那条（duplicate: true，并重新启用）"""
    text = re.sub(r"\s+", " ", str(payload.get("text") or "")).strip()[:120]
    if len(text) < 2:
        raise ValueError("记忆内容至少 2 个字")
    kind = payload.get("kind") if payload.get("kind") in MEMORY_KINDS else memory_kind(text)
    scope = "scene" if payload.get("scope") == "scene" else "global"
    scene_id = payload.get("scene_id") if scope == "scene" else None
    if scope == "scene" and not (isinstance(scene_id, str) and _ID_RE.match(scene_id)):
        raise ValueError("scope=scene 要带 scene_id")
    new = {"text": text, "kind": kind, "scope": scope, **({"scene_id": scene_id} if scene_id else {})}
    with _STORE_LOCK:
        items = memory_list()
        for m in items:
            if memory_similar(m, new) and m.get("scope") == scope and m.get("scene_id") == scene_id:
                m["enabled"] = True
                _save_memory(items)
                return {**m, "duplicate": True}
        if len(items) >= MEMORY_CAP:
            raise ValueError(f"记忆最多 {MEMORY_CAP} 条：先删掉一些")
        item = {"id": f"m{_now_ms():x}{os.urandom(2).hex()}", **new, "source": "ai" if payload.get("source") == "ai" else "you",
                "enabled": payload.get("enabled") is not False, "created": _now_ms(), "uses": 0}
        _save_memory([item] + items)
    return item


def memory_update(mid, payload: dict) -> dict:
    with _STORE_LOCK:
        items = memory_list()
        m = next((x for x in items if x.get("id") == mid), None)
        if m is None:
            raise NotFound(f"没有记忆 {mid!r}")
        if "text" in payload:
            t = re.sub(r"\s+", " ", str(payload.get("text") or "")).strip()[:120]
            if len(t) < 2:
                raise ValueError("记忆内容至少 2 个字")
            m["text"] = t
        if payload.get("kind") in MEMORY_KINDS:
            m["kind"] = payload["kind"]
        if isinstance(payload.get("enabled"), bool):
            m["enabled"] = payload["enabled"]
        if payload.get("scope") in ("global", "scene"):
            sc = payload.get("scene_id", m.get("scene_id"))
            if payload["scope"] == "scene" and not (isinstance(sc, str) and _ID_RE.match(sc)):
                raise ValueError("scope=scene 要带 scene_id")
            m["scope"] = payload["scope"]
            if payload["scope"] == "scene":
                m["scene_id"] = sc
            else:
                m.pop("scene_id", None)
        _save_memory(items)
    return m


def memory_delete(mid) -> dict:
    with _STORE_LOCK:
        items = memory_list()
        keep = [m for m in items if m.get("id") != mid]
        if len(keep) == len(items):
            raise NotFound(f"没有记忆 {mid!r}")
        _save_memory(keep)
    return {"ok": True, "id": mid}


def memory_clear(payload: dict) -> dict:
    """{scope?: all|global|scene, scene_id?}：默认全清；scope=scene 带 scene_id 只清那个场景的"""
    scope, sc = payload.get("scope") or "all", payload.get("scene_id")
    with _STORE_LOCK:
        items = memory_list()
        keep = [m for m in items if not (scope == "all" or (m.get("scope", "global") == scope and (scope != "scene" or not sc or m.get("scene_id") == sc)))]
        _save_memory(keep)
    return {"ok": True, "removed": len(items) - len(keep)}


def memory_bump(ids) -> None:
    """这次 AI 调用用了哪几条：uses + 1、记下 last_used"""
    ids = set(ids or [])
    if not ids:
        return
    with _STORE_LOCK:
        items = memory_list()
        for m in items:
            if m.get("id") in ids:
                m["uses"] = int(m.get("uses") or 0) + 1
                m["last_used"] = _now_ms()
        _save_memory(items)


# ---------- 本地识别「记住：… / 以后都… / 我不喜欢… / 别再…」：直接存，不调 AI
_REMEMBER_HEAD = re.compile(r"^\s*(?:请|帮我|你)?(?:要)?(?:记住|记一下|记下|记着)(?:了|吧)?\s*[：:，,]?\s*")
_PREF_HEAD = re.compile(r"^(?:以后|今后|往后|从今以后|从现在起|从现在开始)|^(?:我|俺)?(?:很|最|特别|一直|一向|总是|比较)?(?:不喜欢|讨厌|受不了)|^(?:别再|不要再|再也别|再也不要)")
_DEICTIC = re.compile(r"这|那|它")  # 「我不喜欢这个塔」是这一次的改动，不是长期偏好
_SCENE_WORDS = re.compile(r"这个场景|本场景|这张图|这一张|这个地图")


def split_memory(text, scene_id=None) -> tuple[list[dict], str]:
    """一句话 → ([{text, kind, scope, scene_id?}], 剩下要交给 AI 的话)。「记住：」后面整句都是记忆（按逗号分条）；
    别的句子里以「以后… / 我不喜欢… / 别再…」开头的分句是记忆（带「这 / 那 / 它」的不算）。"""
    out, rest = [], []
    for sent in [x for x in re.split(r"[。！!？?\n]+", str(text or "")) if x.strip()]:
        head = _REMEMBER_HEAD.match(sent)
        clauses = [c.strip() for c in re.split(r"[，,；;]+", sent[head.end():] if head else sent) if c.strip()]
        keep = []
        for c in clauses:
            if head or (_PREF_HEAD.match(c) and not _DEICTIC.search(c)):
                t = re.sub(r"^(?:我|俺)(?=(?:很|最|特别|一直|一向|总是|比较)?(?:不?喜欢|讨厌|受不了|偏爱))", "", c)
                t = re.sub(r"^(?:还有|而且|并且|另外|然后|和|以及)", "", t).rstrip("了吧啊呀哦喔嘛")
                if len(t) >= 2:
                    scope = "scene" if scene_id and _SCENE_WORDS.search(sent) else "global"
                    out.append({"text": t[:120], "kind": memory_kind(t), "scope": scope, **({"scene_id": scene_id} if scope == "scene" else {})})
                    continue
            keep.append(c)
        if keep:
            rest.append("，".join(keep))
    left = "。".join(rest)
    if len(re.sub(r"[\s，。,.!！?？~～]|好的|好|谢谢|嗯|行|ok|OK", "", left)) < 2:
        left = ""
    return out, left


def remember(text, scene_id=None) -> tuple[list[dict], str]:
    """split_memory + 存进记忆库（近似的不重复存）→ (存下的条目, 剩下的话)"""
    found, rest = split_memory(text, scene_id)
    return [memory_add({**m, "source": "you"}) for m in found], rest


def memory_reply(saved: list, draft_mode: bool = False) -> dict:
    """整句都是「记住…」：不调 AI，直接回「记住了：…」（ops / plans 为空）"""
    note = "记住了：" + "；".join(m["text"] for m in saved)
    res = {"understood": True, "restatement": note[:80], "ops": [], "ask_to_point": False, "memory_saved": saved, "memory_note": note,
           "memory_suggestions": [], "constraints": [], "constraints_fixed": [], "provider": "local", "_usage": {**_usage_zero("local"), "memory_ids": []}, "_ms": 0}
    if draft_mode:
        res.update(plans=[], concepts=[], warnings=[], sources=[], fills=[])
    return res


def after_ai(res: dict, saved: list) -> dict:
    """AI 回来后：记忆建议去重（和已有的近似、彼此近似的不提）、用过的记忆 uses + 1、带上这句里本地存下的记忆"""
    items = memory_list()
    sug = []
    for s in res.get("memory_suggestions") or []:
        s = {"text": str(s.get("text") or "")[:40], "kind": s.get("kind") if s.get("kind") in MEMORY_KINDS else "rule"}
        if len(s["text"]) >= 2 and not any(memory_similar(s, m) for m in items + sug):
            sug.append(s)
    res["memory_suggestions"] = sug[:2]
    memory_bump((res.get("_usage") or {}).get("memory_ids"))
    if saved:
        res["memory_saved"] = saved
        res["memory_note"] = "记住了：" + "；".join(m["text"] for m in saved)
    return res


# ------------------------------------------------------------ AI 入口（两步之后的收尾、本地锁定；docs/06 §3、docs/07）
def _finish(res: dict, ai_obj: Any, t0: float) -> dict:
    ms = int((time.time() - t0) * 1000)
    res.setdefault("provider", getattr(ai_obj, "name", "mock"))
    if not res.get("_usage"):
        res["_usage"] = _usage_zero(getattr(ai_obj, "model", "mock"), ms)
    res["_ms"] = ms
    return res


def _keep_locked(plan: dict, locked: dict | None) -> tuple[dict, list[str]]:
    """「锁」住的项（locked.ids，取自 locked.plan）原样放回新 plan（换一批时不动）：同 id 的替换，没有的挂到根上（锚点沿用它的父组）"""
    if not locked or not isinstance(locked.get("plan"), dict) or not locked.get("ids"):
        return plan, []
    src = index(locked["plan"])
    parents = {id(n): par for n, _, par, _ in walk_nodes(locked["plan"].get("nodes") or [])}
    p = copy.deepcopy(plan)
    ch = []
    for lid in locked["ids"]:
        if lid not in src:
            continue
        g, el = src[lid]
        if g in ONE_GROUPS:
            if p.get(g) != el:
                p[g] = copy.deepcopy(el)
                ch.append(f"锁·{g}")
            continue
        if g not in ("node", "terrain"):
            continue
        cur = index(p).get(lid)
        if cur and cur[0] == g:
            if cur[1] != el:
                cur[1].clear()
                cur[1].update(copy.deepcopy(el))
                ch.append(f"锁·{el.get('label') or lid}")
            continue
        new = copy.deepcopy(el)
        if g == "terrain":
            p.setdefault("terrain", []).insert(0, new)
        else:
            par = parents.get(id(el))
            if not any(new.get(k) for k in ("at", "under", "over", "from", "area", "around", "along")):  # 原来在组里：挂到根上要有锚点
                at = (par or {}).get("at")
                new["at"] = at if at and anchor_base(at) in set(index(p)) | {"site"} else "site.center"
            p.setdefault("nodes", []).append(new)
        ch.append(f"锁·{el.get('label') or lid}")
    keep = [i for i in locked["ids"] if i in index(p)]
    if keep:
        p["locks"] = keep
    return p, ch


def draft(payload: dict, ai_obj: Any = None) -> dict:
    """POST /api/ai/draft：{intent, locked?: {plan, ids}, variant?, force_mock?, max_calls?（1–8，本次最多几次 HTTP，默认 8）, scene_id?, _memory?（app.py 从记忆库填）} →
    {plans: [3], concepts: [3], constraints, constraints_fixed, diversity, warnings, sources, fills, memory_suggestions, provider,
     _usage（合计 + parts + memory_ids）, _steps, _ms, _fixes?}"""
    intent = str(payload.get("intent") or "").strip()
    if not intent:
        raise ValueError("intent 不能为空")
    saved, rest = remember(intent, payload.get("scene_id"))  # 「记住：…」本地存，不调 AI
    if saved and not rest:
        return memory_reply(saved, draft_mode=True)
    intent = rest or intent
    if "_memory" not in payload:
        payload = {**payload, "_memory": memory_list()}
    t0 = time.time()
    ai_obj = ai_obj or get_ai(force_mock=bool(payload.get("force_mock")), max_calls=_max_calls(payload.get("max_calls")))
    cons = extract(intent)
    locked = payload.get("locked") if isinstance(payload.get("locked"), dict) else None
    if locked and isinstance(locked.get("plan"), dict):  # 锁住的 id：显式给的 + plan.locks
        locked = {**locked, "ids": sorted(set(locked.get("ids") or []) | set(locked["plan"].get("locks") or []))}
    variant = int(payload.get("variant") or payload.get("seed") or 0)
    mem = memory_context(payload.get("_memory"), payload.get("scene_id"))
    res = finish_draft(generate(ai_obj, intent, cons, locked, variant, mem), cons, locked)
    res = _finish(res, ai_obj, t0)
    res["_usage"]["memory_ids"] = mem["ids"]
    return after_ai(res, saved)


def finish_draft(res: dict, cons: dict, locked: dict | None = None) -> dict:
    """模型（或模拟）给的三张 → 补概念字段、放回锁住的项、本地锁定、检查引用 / schema / 形体数、算三张差异"""
    keep = set((locked or {}).get("ids") or [])
    fixed, warns = [], []
    plans = res.get("plans") or []
    for i, p in enumerate(plans):
        c = res["concepts"][i] if i < len(res.get("concepts") or []) else {}
        if not p.get("concept") and c.get("concept"):
            p["concept"] = str(c["concept"])[:120]
        if not p.get("key_structures") and c.get("key_structures"):
            p["key_structures"] = [str(x)[:24] for x in c["key_structures"]][:6]
        p, ch1 = _keep_locked(p, locked)
        if isinstance((locked or {}).get("plan"), dict) and locked["plan"].get("marks") and not p.get("marks"):
            p["marks"] = copy.deepcopy(locked["plan"]["marks"])  # 人画的标记跟着换一批走
        p, ch2 = enforce(p, cons, keep)
        plans[i] = p
        if ch1 or ch2:
            fixed.append({"plan": i, "fields": ch1 + ch2})
        warns += [f"plan {i + 1}：引用不存在 {w}" for w in ref_warnings(p)]
        bad = validate(plan_schema(), p)
        if bad:  # 锁定补出来的东西也必须合 schema
            warns += [f"plan {i + 1}：{e}" for e in bad[:5]]
        n = shape_count(p)
        if n > MAX_SHAPES:
            warns.append(f"plan {i + 1}：展开后约 {n} 个形体 > {MAX_SHAPES}")
    for f in res.get("fills") or []:
        warns.append(f"plan {f['plan'] + 1}：模型这张没写成，用模拟 AI 按同一概念补位（{f['reason'][:80]}）")
    res["plans"] = plans
    res["constraints"] = summary(cons)
    res["constraints_fixed"] = fixed
    res["diversity"] = diversity(plans)
    # 雷同：两张的骨架（地形操作序列 + 主体形体 + 重复签名，不比地面）一样 → 算同一个，org 差异记 0 并警告
    keys = [structure_key(p) for p in plans]
    clones = [[i, j] for i in range(len(plans)) for j in range(i + 1, len(plans)) if same_structure(keys[i], keys[j])]
    if clones:
        filled = {f["plan"] for f in res.get("fills") or []} | {i for i, s in enumerate(res.get("sources") or []) if s == "mock"}
        res["diversity"]["clones"] = clones
        res["diversity"]["org_min"] = 0
        warns += [f"plan {a + 1} 与 plan {b + 1}：{'都是补位，' if a in filled and b in filled else ''}骨架一样（雷同），建议换一批" for a, b in clones]
    res["warnings"] = warns
    return res


def structure_key(plan: dict) -> dict:
    """一张的骨架：地形操作序列（op / 形状 / 边）、主体形体（类型 / 排法 / 屋顶 / 空心）、重复签名（排法 × 模板类型 × 个数档）。不含地面——换个底不算不同"""
    nodes = all_nodes(plan)
    m = next((n for n in nodes if n.get("role") == "landmark"), None) or next((n for n in plan.get("nodes") or [] if isinstance(n, dict) and n.get("type") not in ("link", "space")), {})
    mc = (m.get("child") or {}) if m.get("type") == "repeat" else m
    def rsig(n: dict) -> str:
        c = n.get("count") or n.get("levels") or (n.get("rows") or 1) * (n.get("cols") or 1)
        return f"{n.get('pattern')}:{(n.get('child') or {}).get('type')}:{'1' if c <= 2 else 'few' if c <= 6 else 'many'}"
    return {"terrain": [f"{t.get('op')}:{t.get('shape')}:{t.get('edge')}" for t in plan.get("terrain") or [] if isinstance(t, dict)],
            "main": f"{m.get('type')}:{m.get('pattern')}:{mc.get('type')}:{mc.get('roof') or mc.get('shape')}:{bool(mc.get('hollow'))}",
            "repeats": sorted({rsig(n) for n in nodes if n.get("type") == "repeat"})}


def same_structure(a: dict, b: dict) -> bool:
    """地形操作序列一样 + 主体一样 + 重复签名重合一半以上 = 同一副骨架"""
    ra, rb = set(a["repeats"]), set(b["repeats"])
    return a["terrain"] == b["terrain"] and a["main"] == b["main"] and (not (ra | rb) or len(ra & rb) / len(ra | rb) >= 0.5)


RESTATE_MAX = 60  # definitions.revise.restatement.maxLength


def revise(payload: dict, ai_obj: Any = None) -> dict:
    """POST /api/ai/revise：{plan, action: {type:'text', text} | 字符串, locked?: {ids} | [ids], force_mock?, refs?: [{kind, id, instance?, label, facts, carried?}]（carried = 这句没加引用、前端带上的上一轮引用）,
    history?: [{role: user|ai, text, refs?（人那条指的 id）, ops?, ids?（AI 那条动了的 id）, effect?}]（只用最近 10 轮）, scene_id?, _memory?（app.py 从记忆库填）} →
    {understood, restatement, ops, question?, ask_to_point, memory_suggestions, constraints, constraints_fixed, provider, _usage（+ memory_ids）, _ms, _fixes?}"""
    plan, action = payload.get("plan"), payload.get("action")
    if isinstance(action, str):
        action = {"type": "text", "text": action}
    saved, rest = remember(action.get("text"), payload.get("scene_id")) if isinstance(action, dict) and action.get("type", "text") == "text" else ([], "")
    if saved and not rest:  # 整句都是「记住…」：不调 AI（还没有程序也行）
        return memory_reply(saved)
    if not isinstance(plan, dict) or not action:
        raise ValueError("需要 plan 与 action")
    if saved:
        action = {**action, "text": rest}
    if "_memory" not in payload:
        payload = {**payload, "_memory": memory_list()}
    lk = payload.get("locked")
    locked_ids = (set(lk.get("ids") or []) if isinstance(lk, dict) else set(lk or [])) | set(plan.get("locks") or [])
    t0 = time.time()
    ai_obj = ai_obj or get_ai(force_mock=bool(payload.get("force_mock")))
    mem = memory_context(payload.get("_memory"), payload.get("scene_id"))
    ctx = {"refs": payload.get("refs") if isinstance(payload.get("refs"), list) else [],
           "history": payload.get("history") if isinstance(payload.get("history"), list) else [], "mem": mem}
    res = ai_obj.revise(plan, action, locked_ids, ctx) if (ctx["refs"] or ctx["history"] or mem["text"]) else ai_obj.revise(plan, action, locked_ids)
    res["memory_suggestions"] = list(res.get("memory_suggestions") or [])
    text = str(action.get("text") or "")
    ops = res.get("ops") or []
    res["_model_ops"], res["_model_restatement"] = list(ops), res.get("restatement")
    extra, notes, say = enforce_ops(plan, ops, text, locked_ids) if text else ([], [], [])
    ops = ops + extra
    asks = [s for s in say if s.endswith("？")]
    say = [s for s in say if not s.endswith("？")]
    if asks and not ops:  # 锁定找不到要改的东西：先问，不新增
        res.update(understood=False, ask_to_point=False, question=asks[0], restatement="")
    rs = (res.get("restatement") or "").strip().rstrip("。；")
    key = lambda s: s.split("改成")[-1] if "改成" in s else s[2:] if s.startswith(("加了", "去掉")) else s  # noqa: E731  「矿洞改成迷宫平面」→「迷宫平面」
    must = [s for s in say if key(s) not in rs]  # 复述要说到锁定补的事；模型已经说了就不重复
    if must:
        room = RESTATE_MAX - len("；".join(must)) - 2
        rs = "；".join(must) + (("；" + rs[:room]) if rs and room > 4 else "")
    if ops and not res.get("understood"):
        res["understood"], res["ask_to_point"] = True, False
    if ops and not rs:
        rs = describe_ops(plan, ops)[:RESTATE_MAX - 1]
    if not ops and res["memory_suggestions"] and not rs:  # 只是说了个偏好：不追问，问要不要记住
        rs = "听起来是长期偏好，要记住吗"
    if not ops and res.get("provider") == "mock" and not rs and not res.get("question"):
        res.update(understood=False, ask_to_point=True, question="是位置、大小，还是长相的事？在图上画一笔或圈一块最准。")
        rs = "这句我没把握翻成结构改动"
    res["ops"] = ops
    rs = rs[:RESTATE_MAX - 1]
    res["restatement"] = rs + ("。" if rs and not rs.endswith(("。", "？", "！")) else "")
    res["constraints"] = summary(extract(text))
    res["constraints_fixed"] = notes
    res = _finish(res, ai_obj, t0)
    res["_usage"]["memory_ids"] = mem["ids"]
    return after_ai(res, saved)


# ------------------------------------------------------------ 路由
def r_health(root, _):
    cfg = ai.public_config()
    return {"ok": True, "version": APP_VERSION, "mock": cfg["mock"], "provider": cfg["provider"], "provider_label": cfg["provider_label"],
            "model": cfg["model"], "thinking": cfg["thinking"], "root": root,
            "data_dir_custom": bool(os.environ.get("SCENE_DIALOG_DATA_DIR"))}  # 只说换没换数据目录（测试页据此拒绝在真实数据上跑），不给路径


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
    payload.pop("_memory", None)  # 记忆只从记忆库来
    return draft(payload)


def r_revise(root, payload):
    payload.pop("_memory", None)
    return revise(payload)


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
    ("GET", "/api/scenes"): lambda root, p, q=None: scene_list(trash=(q or {}).get("trash") in ("1", "true")),
    ("POST", "/api/scenes"): lambda root, p: scene_create(p),
    ("GET", "/api/memory"): lambda root, p: memory_list(),
    ("POST", "/api/memory"): lambda root, p: memory_add(p),
    ("POST", "/api/memory/clear"): lambda root, p: memory_clear(p),
}
# 带 id 的路由：(方法, 前缀, 后缀) → f(id, payload)
ID_ROUTES = {
    ("GET", "/api/scenes/", ""): lambda i, p: scene_get(i),
    ("PUT", "/api/scenes/", ""): scene_put,
    ("DELETE", "/api/scenes/", ""): lambda i, p: scene_delete(i),
    ("POST", "/api/scenes/", "/duplicate"): lambda i, p: scene_duplicate(i),
    ("POST", "/api/scenes/", "/restore"): lambda i, p: scene_restore(i),
    ("PUT", "/api/memory/", ""): memory_update,
    ("DELETE", "/api/memory/", ""): lambda i, p: memory_delete(i),
}


def find_route(method: str, path: str):
    """→ (handler(root, payload, query), None) 或 None"""
    h = ROUTES.get((method, path))
    if h:
        return h
    for (m, pre, suf), f in ID_ROUTES.items():
        if m == method and path.startswith(pre) and path.endswith(suf):
            rid = path[len(pre):len(path) - len(suf)] if suf else path[len(pre):]
            if rid and "/" not in rid:
                return lambda root, p, q=None, f=f, rid=rid: f(rid, p)
    return None


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

    def do_PUT(self):
        if self.path.startswith("/api/"):
            return self._dispatch("PUT")
        self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            return self._dispatch("DELETE")
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
        path, _, qs = self.path.partition("?")
        path = path.rstrip("/")
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(qs).items()}
        t0 = time.time()
        try:
            handler = find_route(method, path)
            if not handler:
                return self._json(404, {"error": f"no route {method} {path}"})
            body = self._body() if method in ("POST", "PUT") else {}
            if not isinstance(body, dict):
                raise ValueError("请求体应为 JSON 对象")
            result = handler(self.root, body, query) if handler.__code__.co_argcount >= 3 else handler(self.root, body)
            if isinstance(result, dict) and path.startswith("/api/ai/"):
                result.setdefault("_ms", int((time.time() - t0) * 1000))
            self._json(200, result)
        except ai.AIError as e:  # 200 回来了但不能用：拒绝 / 截断 / 不合 schema
            self._json(502, {"error": "ai_" + e.kind, "kind": e.kind, "message": str(e), **e.detail})
        except ai.api_error_types() as e:  # 服务商的 HTTP / 网络错误
            self._json(502, ai.error_payload(e))
        except NotFound as e:
            self._json(404, {"error": "not found", "message": str(e)})
        except TooLarge as e:
            self._json(413, {"error": "too large", "message": str(e)})
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

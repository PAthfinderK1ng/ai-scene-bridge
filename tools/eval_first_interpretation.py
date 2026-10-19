#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_first_interpretation.py — 首次理解评测（v5：两步生成的场景程序）

做什么：
1. 固定的一句话输入（docs/06 §6 的验收句 + 矿洞迷宫），逐个走和 /api/ai/draft 同一条路：构思 1 次 → 展开 3 次（并行）→ 本地锁定。
   服务商取 config.json 的当前设置或 --provider；没有密钥 / --mock 走模拟 AI（报告里标明）。
2. 每个输入记：每一步的耗时 / token / 费用、展开是否一次过 schema（回喂 / 重试 / 补位）、三张的空间组织标签与两两差几个、
   是否出现台地 / 撒房子、本地锁定补了什么（= 模型漏掉的硬条件）、展开后形体数、引用告警。
3. 记录每次 HTTP 的请求摘要与原样回包（build/eval/raw-v5.json）；--replay 用记录的回包离线重放整条流程（改了后处理 / 锁定 / 提示词外的东西后验证，不花钱）。
4. --revise "多两座塔,加一座浮岛"：拿第一题的第 1 张逐句调 revise。
5. 写 build/eval/plans-v5.json（模型原样 + 锁定后的程序 + 概念）与 build/eval/report-v5.md。

省钱：--only q01,q03 只跑这几题；--max-calls N 是本次 HTTP 调用上限（构思 + 展开 + 回喂 + 重试都算；超了那张由模拟补位，不再发请求）。

用法：
  python -X utf8 tools/eval_first_interpretation.py --mock
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --only q01,q03 --max-calls 8
  python -X utf8 tools/eval_first_interpretation.py --replay build/eval/raw-v5.json --only q01,q03
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --concepts "我要生成魔法学院*3,海盗港口*2" --max-calls 6   # 只评构思
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import io
import json
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import ai  # noqa: E402
import app  # noqa: E402  入口 draft / revise / finish_draft

INPUTS = [
    "我要生成魔法学院",
    "赛博朋克夜市一角",
    "海盗港口",
    "沙漠里的古神殿",
    "空中花园",
    "山城村庄",
    "地下有个矿洞，是个两层的迷宫",
]
INPUT_ID = lambda i: f"q{i + 1:02d}"  # noqa: E731


def fmt_usage(u: dict | None) -> str:
    if not u:
        return "—"
    s = f"in {u.get('input') or 0} / out {u.get('output') or 0} / 命中 {u.get('cache_read') or 0}"
    if (u.get("calls") or 1) > 1:
        s += f" / {u['calls']} 次"
    return s


def cost_of(u: dict | None) -> dict | None:
    if not u:
        return None
    if u.get("cost_cny") is not None:
        return {"cny": u["cost_cny"]}
    if u.get("cost_usd") is not None:
        return {"usd": u["cost_usd"]}
    return None


def fmt_cost(c: dict | None) -> str:
    if not c:
        return "—"
    return f"¥{c['cny']:.4f}" if "cny" in c else f"${c['usd']:.4f}"


def missing_after_lock(plan: dict, cons: dict) -> list[str]:
    """锁定后复查：这张缺了哪些说死的东西（应为空）"""
    miss = [x["word"] for x in cons.get("structures", []) if not ai.has_structure(plan, x, loose=True)]
    for s in cons.get("spaces", []):
        if not any(n.get("type") == "space" and n.get("layout") in s["accept"] for n in ai.all_nodes(plan)):
            miss.append(s["word"])
    if cons.get("time_of_day") and (plan.get("lighting") or {}).get("time_of_day") != cons["time_of_day"]:
        miss.append("时段")
    return miss


def compo(plan: dict) -> str:
    """一张程序的骨架，一行：地面 / 地形操作 / 根节点（类型、重复、数量）"""
    def one(n: dict) -> str:
        t = n.get("type")
        lab = n.get("label") or n.get("id") or ""
        if t == "repeat":
            c = n.get("child") or {}
            k = n.get("count") or n.get("levels") or (f"{n.get('rows')}×{n.get('cols')}" if n.get("rows") else "")
            return f"{lab or c.get('label') or ''}[{n.get('pattern')} ×{k} {c.get('type')}]"
        if t == "group":
            return f"{lab}{{" + "、".join(one(c) for c in n.get("children") or []) + "}"
        if t == "link":
            return f"{lab}({n.get('style')} {n.get('from')}→{n.get('to')})"
        if t == "space":
            return f"{lab}[{n.get('stratum')} {n.get('layout')}{' ×' + str(n['sublevels']) if (n.get('sublevels') or 1) > 1 else ''}]"
        extra = f" 离地{n['elev_m']:g}" if n.get("elev_m") else ""
        return f"{lab}({t}{extra})"
    terr = "、".join(f"{t.get('label') or t.get('id') or ''}({t.get('op')})" for t in plan.get("terrain") or [])
    return f"地面 {(plan.get('site') or {}).get('ground', 'flat')}；地形 {terr or '—'}；节点 " + "、".join(one(n) for n in plan.get("nodes") or [])


# ---------- 记录 / 重放 HTTP
class Recorder:
    """包一层 urlopen：每次请求记 (步骤, 第几张, 第几轮, 回包原文)；--replay 时按 (题, 步骤, 第几张, 第几轮) 回放"""

    def __init__(self, base=None, replay: dict | None = None):
        self.base = base or urllib.request.urlopen
        self.replay = replay
        self.log: list = []
        self.qid = ""
        self.lock = threading.Lock()
        self.seen: dict = {}

    @staticmethod
    def kind(body: dict) -> tuple[str, int]:
        sysmsg, user = body["messages"][0]["content"], body["messages"][1]["content"]
        if "空间构思师" in sysmsg:
            return "concepts", -1
        m = re.search(r"你写第 (\d) 张", user)
        return ("expand", int(m.group(1)) - 1) if m else ("revise", -1)

    def __call__(self, req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        if "response_format" not in body:  # ping
            return self.base(req, timeout=timeout)
        k, i = self.kind(body)
        with self.lock:
            key = (self.qid, k, i)
            n = self.seen.get(key, 0)
            self.seen[key] = n + 1
        t0 = time.time()
        if self.replay is not None:
            hit = self.replay.get(f"{self.qid}|{k}|{i}|{n}")
            if hit is None:
                raise ai.DeepSeekAPIError(f"重放里没有 {key} 第 {n + 1} 轮", etype="APIConnectionError")
            raw = json.dumps(hit["response"], ensure_ascii=False).encode("utf-8")
        else:
            with self.base(req, timeout=timeout) as r:
                raw = r.read()
        resp = json.loads(raw.decode("utf-8"))
        with self.lock:
            self.log.append({"qid": self.qid, "step": k, "k": i, "round": n, "ms": int((time.time() - t0) * 1000), "turns": len(body["messages"]),
                             "user_head": body["messages"][-1]["content"][:160], "system_chars": len(body["messages"][0]["content"]), "response": resp})
        return _Resp(raw)


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run_draft(ai_obj, text: str) -> dict:
    cons = ai.extract(text)
    row = {"text": text, "constraints": ai.summary(cons), "error": None}
    t0 = time.time()
    try:
        res = ai.generate(ai_obj, text, cons)
        row["raw"] = copy.deepcopy(res["plans"])
        res = app.finish_draft(res, cons)
        row["ms"] = int((time.time() - t0) * 1000)
        row.update(plans=res["plans"], concepts=res["concepts"], sources=res["sources"], fills=res["fills"], usage=res["_usage"], steps=res["_steps"],
                   fixes=res.get("_fixes") or [], warnings=res["warnings"], locked=res["constraints_fixed"], diversity=res["diversity"],
                   diversity_raw=ai.diversity(row["raw"]), presets_raw=[ai.preset_flags(p) for p in row["raw"]],
                   shapes=[ai.shape_count(p) for p in res["plans"]], missing=[missing_after_lock(p, cons) for p in res["plans"]],
                   schema_errors=[f"plan {i + 1}: {e}" for i, p in enumerate(res["plans"]) for e in ai.validate(ai.plan_schema(), p)[:3]])
    except Exception as e:  # noqa: BLE001
        row["ms"] = int((time.time() - t0) * 1000)
        row["error"] = f"{type(e).__name__}: {e}"
        d = getattr(e, "detail", None)
        row["usage"] = d.get("usage") if isinstance(d, dict) else None
    row["cost"] = cost_of(row.get("usage"))
    return row


def run_revise(ai_obj, plan: dict, texts: list[str]) -> list[dict]:
    out = []
    for t in texts:
        row = {"text": t}
        t0 = time.time()
        try:
            r = app.revise({"plan": plan, "action": {"type": "text", "text": t}}, ai_obj)  # 和 /api/ai/revise 同一条路（含本地锁定）
            row.update({k: r.get(k) for k in ("understood", "restatement", "ops", "question", "ask_to_point")})
            row["model_ops"] = r.get("_model_ops") or []
            row["lock_added"] = (r.get("ops") or [])[len(row["model_ops"]):]
            good, errs, _ = ai.check_ops(plan, r.get("ops") or [])
            row["ops_errors"] = errs
            row["after_errors"] = ai.validate(ai.plan_schema(), ai.apply_ops(plan, good))[:5]
            row["usage"] = r.get("_usage")
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
            d = getattr(e, "detail", None)
            row["usage"] = d.get("usage") if isinstance(d, dict) else None
        row["ms"] = int((time.time() - t0) * 1000)
        out.append(row)
        print(f"[revise] {t} → {row.get('restatement') or row.get('error')} · 模型 ops {json.dumps(row.get('model_ops'), ensure_ascii=False)[:200]} · "
              f"锁定补 {len(row.get('lock_added') or [])} 条 · {row['ms'] / 1000:.1f} s · {fmt_usage(row.get('usage'))} · {fmt_cost(cost_of(row.get('usage')))}")
    return out


def run_browser(page: str | None) -> str:
    if not page:
        return "（没跑几何环节：加 --browser medium/engine/tests/<页>.test.html）"
    cmd = [sys.executable, "-X", "utf8", str(ROOT / "tools" / "run_browser_test.py"), page, "--timeout", "180"]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=240, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        return "（几何环节超时）"
    return res.stdout.decode("utf-8", errors="replace") + res.stderr.decode("utf-8", errors="replace")


def total_cost(rows: list[dict]) -> str:
    cny = sum((cost_of(r.get("usage")) or {}).get("cny", 0) for r in rows)
    usd = sum((cost_of(r.get("usage")) or {}).get("usd", 0) for r in rows)
    parts = ([f"¥{cny:.4f}"] if cny else []) + ([f"${usd:.4f}"] if usd else [])
    return " + ".join(parts) if parts else "—（模拟 AI 不计费）"


def step_cell(s: dict, mock_run: bool = False) -> str:
    u = s.get("usage") or {}
    flag = "" if s["step"] == "concepts" or mock_run else (" 补位" if s.get("provider") == "mock" else
                                              " 回喂" if s.get("feedback") else "") + (f" 重试×{s['attempts'] - 1}" if (s.get("attempts") or 1) > 1 else "") + (" 本地救回" if s.get("salvaged") else "")
    return f"{s['ms'] / 1000:.1f} s · {u.get('input') or 0}/{u.get('output') or 0} · {fmt_cost(cost_of(u))}{flag}"


def write_report(path: Path, meta: dict, inputs: list[dict], revs: list[dict] | None, geo_log: str) -> None:
    ok = [r for r in inputs if not r.get("error")]
    L = ["# 首次理解评测（v5 · 两步生成的场景程序）", "",
         f"- 生成时间：{meta['generated_at']}",
         f"- AI：**{'模拟 AI（不代表真实模型）' if meta['provider'] == 'mock' else meta['provider'] + ' · ' + str(meta['model'])}**" + ("（离线重放）" if meta.get("replay") else ""),
         f"- 输入 {len(inputs)} 条 · 成功 {len(ok)} · 三张空间组织两两差 ≥ 2（模型原样）：{sum(1 for r in ok if (r['diversity_raw'].get('org_min') or 0) >= 2)}/{len(ok)}"
         f" · 展开一次过 schema：{sum(1 for r in ok for s in r['steps'] if s['step'] == 'expand' and s.get('provider') != 'mock' and not s.get('feedback') and (s.get('attempts') or 1) == 1)}"
         f"/{sum(1 for r in ok for s in r['steps'] if s['step'] == 'expand')} · 补位 {sum(len(r['fills']) for r in ok)} 张",
         f"- HTTP 调用 {meta.get('calls')} 次 · 费用合计 {total_cost(inputs + (revs or []))}", "",
         "空间组织标签（plans.organization）：悬空 / 地下 / 水上 / 环形 / 轴线 / 垂直 / 散布 / 台地 / 围合 / 线性 / 峡谷 / 网格。「老三样」= terraces / scatter_houses / terrace 操作。", "",
         "## 总表", "", "| # | 输入 | 构思 | 展开 1 | 展开 2 | 展开 3 | 合计 | 组织差（原样 / 锁定后） | 台地 / 撒房子（原样） | 锁定补了 |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in inputs:
        if r.get("error"):
            L.append(f"| {r['id']} | {r['text']} | 失败：{r['error'][:120]} | | | | {fmt_cost(r.get('cost'))} | | | |")
            continue
        st = {(s["step"], s.get("k", -1)): s for s in r["steps"]}
        mk = meta["provider"] == "mock"
        cells = [step_cell(st[("concepts", -1)], mk)] + [step_cell(st[("expand", k)], mk) if ("expand", k) in st else "—" for k in range(3)]
        pre = "；".join(f"卡{i + 1}：{'、'.join(x)}" for i, x in enumerate(r["presets_raw"]) if x) or "无"
        lk = "；".join(f"卡{x['plan'] + 1}：{'、'.join(x['fields'])}" for x in r["locked"]) or "—"
        L.append(f"| {r['id']} | {r['text']} | " + " | ".join(cells) + f" | {(r['ms'] or 0) / 1000:.1f} s · {fmt_usage(r['usage'])} · {fmt_cost(r.get('cost'))} | "
                 f"{r['diversity_raw'].get('org_pairwise')} / {r['diversity'].get('org_pairwise')} | {pre} | {lk} |")
    L += ["", "## 每题三张", ""]
    for r in inputs:
        if r.get("error"):
            continue
        L += [f"### {r['id']} 「{r['text']}」", "", f"锁定条件：{'、'.join(r['constraints']) or '—'}", ""]
        for label, val in (("补位", "；".join(f"卡{f['plan'] + 1}：{f['reason']}" for f in r["fills"])), ("本地修正", "；".join(r["fixes"][:14])),
                           ("告警", "；".join(r["warnings"][:8])), ("锁定后仍缺", "；".join(f"卡{i + 1}：{'、'.join(m)}" for i, m in enumerate(r["missing"]) if m)),
                           ("schema 错", "；".join(r["schema_errors"][:6])),
                           ("回喂前的 schema 错（first_errors）", "；".join(f"卡{s['k'] + 1}：" + " | ".join(s["first_errors"][:6]) for s in r["steps"] if s.get("first_errors")))):
            if val:
                L += [f"**{label}**：{val}", ""]
        for i, (c, p) in enumerate(zip(r["concepts"], r["plans"])):
            org = "、".join(r["diversity"]["organization"][i])
            L += [f"{i + 1}. **{c.get('name')}**（{r['sources'][i]}，{r['shapes'][i]} 个形体，组织：{org}）：{c.get('concept')}",
                  f"   - 关键结构：{'、'.join(c.get('key_structures') or [])}；地形：{c.get('terrain_idea')}；差异：{c.get('why_different')}",
                  f"   - {compo(p)}"]
        L.append("")
    if revs:
        L += ["## revise", "", "| 说的话 | 模型 ops | 锁定补的 ops | 复述 | ops 合法 | 耗时 | usage | 费用 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for v in revs:
            L.append(f"| {v['text']} | `{json.dumps(v.get('model_ops'), ensure_ascii=False)[:240]}` | `{json.dumps(v.get('lock_added'), ensure_ascii=False)[:160]}` | {v.get('restatement') or v.get('error') or ''} | "
                     f"{'是' if not v.get('ops_errors') and not v.get('error') else '否：' + '；'.join(v.get('ops_errors') or [])[:120]} | {(v.get('ms') or 0) / 1000:.1f} s | {fmt_usage(v.get('usage'))} | {fmt_cost(cost_of(v.get('usage')))} |")
        L.append("")
    L += ["## 几何环节", "", "```", (geo_log or "").strip()[:4000], "```"]
    path.write_text("\n".join(L), encoding="utf-8")


# ---------- 只评构思（--concepts）：同一句话跑几次，看三张的组织方式、跨次变不变、还有没有「上 / 水 / 地下」三分法
DIR_WORDS = {  # 一个概念「往哪走」：按关键词粗分（报告里同时贴原文，人工复核）
    "上": ("塔", "崖", "峰", "尖顶", "高台", "悬", "浮", "空中", "云", "天穹", "垂直", "叠", "往上", "高耸", "山顶", "绝壁", "攀"),
    "水": ("湖", "海", "水", "港", "码头", "岛", "河", "渠", "潮", "船", "湾", "礁", "瀑"),
    "下": ("地下", "窟", "穴", "坑", "下沉", "地宫", "矿", "墓", "窖", "深渊", "洞", "地底", "竖井", "埋", "沉入", "地心"),
}


def concept_dir(c: dict, water_theme: bool = False) -> tuple[str, dict]:
    """概念的主方向：上 / 水 / 下 / 平（三类关键词都没有）。名字与一句话权重 2，关键结构与地形权重 1。题材本身在水上时不看「水」"""
    head = f"{c.get('name') or ''} {c.get('concept') or ''}"
    body = " ".join([*(c.get("key_structures") or []), str(c.get("terrain_idea") or "")])
    sc = {k: 2 * sum(head.count(w) for w in ws) + sum(body.count(w) for w in ws) for k, ws in DIR_WORDS.items() if not (water_theme and k == "水")}
    best = max(sc, key=lambda k: sc[k])
    return (best if sc[best] > 0 else "平"), sc


def is_triad(dirs: list[str], water_theme: bool) -> bool:
    """「一个往上、一个铺开或在水上、一个往地下」：三张恰好各占一个。题材本身就在水上（港口）时，水不算区分，看「上 + 下 + 其它」"""
    if len(dirs) != 3:
        return False
    if "上" not in dirs or "下" not in dirs:
        return False
    rest = [d for d in dirs if d not in ("上", "下")]
    return len(rest) == 1 and (rest[0] in ("水", "平") or water_theme)


def run_concepts(ai_obj, spec: str, rec) -> list[dict]:
    """spec："我要生成魔法学院*3,海盗港口*2" → 每句跑 n 次构思（只构思，不展开）"""
    rows = []
    for part in [x.strip() for x in spec.split(",") if x.strip()]:
        text, _, n = part.partition("*")
        for r in range(int(n or 1)):
            rec.qid = f"c:{text}:{r}"
            row = {"text": text, "run": r + 1}
            t0 = time.time()
            try:
                d = ai_obj.concepts(text, ai.extract(text), None)
                row.update(concepts=[{k: v for k, v in c.items() if not k.startswith("_")} for c in d["concepts"]], lenses=d.get("_lenses") or [],
                           usage=d.get("_usage"), fixes=d.get("_fixes") or [])
                wt = any(w in text for w in ("港", "海", "湖", "岛"))
                row["dirs"] = [concept_dir(c, wt)[0] for c in row["concepts"]]
                row["triad"] = is_triad(row["dirs"], wt)
            except Exception as e:  # noqa: BLE001
                row["error"] = f"{type(e).__name__}: {e}"
                dd = getattr(e, "detail", None)
                row["usage"] = dd.get("usage") if isinstance(dd, dict) else None
            row["ms"] = int((time.time() - t0) * 1000)
            row["cost"] = cost_of(row.get("usage"))
            rows.append(row)
            if row.get("error"):
                print(f"[构思] {text} #{r + 1} → {row['error']}")
            else:
                print(f"[构思] {text} #{r + 1} → " + " / ".join(f"{c['name']}({dd})" for c, dd in zip(row["concepts"], row["dirs"]))
                      + f" · 三分法 {'是' if row['triad'] else '否'} · 视角 {'、'.join(x.split('：')[0] for x in row['lenses'])} · {fmt_cost(row['cost'])}")
    return rows


def write_concepts_report(path: Path, meta: dict, rows: list[dict], extra: str = "") -> None:
    ok = [r for r in rows if not r.get("error")]
    L = ["# DeepSeek 构思评测（v5 第 4 轮：去掉固定例句与维度清单 + 随机视角）", "",
         f"- 生成时间：{meta['generated_at']} · AI：{meta['provider']} · {meta['model']} · HTTP {meta['calls']} 次 · 费用 {total_cost(rows)}",
         f"- 构思 {len(rows)} 次 · 成功 {len(ok)} · 出现「上 / 水 / 地下」三分法（关键词粗分，见下）：**{sum(1 for r in ok if r['triad'])}/{len(ok)}**", "",
         "方向粗分：名字 + 一句话里的词权重 2、关键结构 + 地形权重 1；上 = 塔 / 崖 / 悬 / 浮 / 云 …，水 = 湖 / 海 / 港 / 岛 …，下 = 地下 / 窟 / 坑 / 矿 …，都没有 = 平。"
         "题材本身在水上（港口）时水不算区分。粗分只是提示，下面贴了原文。", ""]
    by: dict = {}
    for r in ok:
        by.setdefault(r["text"], []).append(r)
    L += ["## 总表", "", "| 输入 | 第几次 | 三张（主方向） | 三分法 | 抽到的视角 | 费用 |", "| --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        if r.get("error"):
            L.append(f"| {r['text']} | {r['run']} | 失败：{r['error'][:100]} | | | {fmt_cost(r.get('cost'))} |")
            continue
        L.append(f"| {r['text']} | {r['run']} | " + " / ".join(f"{c['name']}（{d}）" for c, d in zip(r["concepts"], r["dirs"]))
                 + f" | {'是' if r['triad'] else '否'} | {'、'.join(x.split('：')[0] for x in r['lenses'])} | {fmt_cost(r.get('cost'))} |")
    L += ["", "## 跨次变化", ""]
    for t, rs in by.items():
        names = [c["name"] for r in rs for c in r["concepts"]]
        L.append(f"- 「{t}」{len(rs)} 次 · {len(names)} 张 · 不同名字 {len(set(names))} 个 · 方向组合：" + "；".join("/".join(r["dirs"]) for r in rs))
    L += ["", "## 原文", ""]
    for r in ok:
        L += [f"### 「{r['text']}」第 {r['run']} 次", "", f"视角：{'；'.join(r['lenses']) or '—'}", ""]
        for i, c in enumerate(r["concepts"]):
            L += [f"{i + 1}. **{c.get('name')}**（{r['dirs'][i]}）：{c.get('concept')}",
                  f"   - 关键结构：{'、'.join(c.get('key_structures') or [])}；地形：{c.get('terrain_idea')}；动机 / 差异：{c.get('why_different')}"]
        L.append("")
    if extra:
        L += [extra.strip(), ""]
    path.write_text("\n".join(L), encoding="utf-8")


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true", help="强制模拟 AI（不花钱）")
    ap.add_argument("--provider", choices=list(ai.PROVIDERS), default=None)
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", default="build/eval")
    ap.add_argument("--only", default=None, help="只跑这几题，如 q01,q03")
    ap.add_argument("--revise", default=None, help="逗号分隔的几句话，对第一题的第 1 张逐句调 revise")
    ap.add_argument("--max-calls", type=int, default=8, help="本次 HTTP 调用上限（构思 + 展开 + 回喂 + 重试都算）")
    ap.add_argument("--replay", default=None, help="用记录的回包（raw-v5.json）离线重放，不联网")
    ap.add_argument("--browser", default=None, help="可选：引擎测试页（读 build/eval/plans-v5.json）")
    ap.add_argument("--concepts", default=None, help="只评构思：'我要生成魔法学院*3,海盗港口*2'（每句跑几次，不展开）→ deepseek-v5-concepts.md")
    ap.add_argument("--concepts-report", default="deepseek-v5-concepts.md", help="--concepts 的报告文件名（在 --out 下）")
    args = ap.parse_args(argv)

    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    replay = None
    if args.replay:
        rec_in = json.loads(Path(args.replay).read_text(encoding="utf-8"))
        replay = {f"{x['qid']}|{x['step']}|{x['k']}|{x['round']}": x for x in rec_in.get("calls", [])}
        rec = Recorder(replay=replay)
        ai_obj = ai.DeepSeekAI("sk-replay-000000000000", rec_in.get("model") or ai.DS_DEFAULT_MODEL, urlopen=rec)
        ai_obj.retry_sleep = 0
    else:
        cfg = ai.config_for(args.provider) if args.provider else ai.load_config()
        if args.mock:
            cfg["mock"] = True
        if args.model:
            cfg["model"] = args.model
        ai_obj = ai.get_ai(cfg)
        rec = Recorder()
        if isinstance(ai_obj, ai.DeepSeekAI):
            ai_obj._urlopen = rec
            ai_obj.max_calls = args.max_calls
    provider, model = getattr(ai_obj, "name", "mock"), getattr(ai_obj, "model", "mock")
    print(f"AI: {provider} · model: {model}{' · 重放' if replay else ''} · 调用上限 {args.max_calls} · 输出到 {out_dir}")
    if args.concepts:
        rows = run_concepts(ai_obj, args.concepts, rec)
        calls = len(rec.log) if replay else getattr(ai_obj, "calls", 0)
        meta = {"generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "provider": provider, "model": model, "replay": bool(replay), "calls": calls}
        (out_dir / "concepts-v5.json").write_text(json.dumps({**meta, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
        if not replay and provider != "mock":
            (out_dir / "raw-concepts-v5.json").write_text(json.dumps({**meta, "calls": rec.log}, ensure_ascii=False, indent=1), encoding="utf-8")
        write_concepts_report(out_dir / args.concepts_report, meta, rows)
        ok = [r for r in rows if not r.get("error")]
        print(f"写出 {out_dir / args.concepts_report}\nDONE concepts={len(rows)} ok={len(ok)} triad={sum(1 for r in ok if r['triad'])} calls={calls} cost={total_cost(rows)}")
        return 0 if len(ok) == len(rows) else 1
    only = {x.strip() for x in args.only.split(",")} if args.only else None
    inputs = []
    for i, text in enumerate(INPUTS):
        iid = INPUT_ID(i)
        if only and iid not in only:
            continue
        rec.qid = iid
        row = run_draft(ai_obj, text)
        row.update(id=iid, provider=provider, model=model)
        inputs.append(row)
        if row.get("error"):
            print(f"[{iid}] {text} → {row['error']}")
            continue
        print(f"[{iid}] {text} → {' / '.join(c['name'] for c in row['concepts'])} · 来源 {row['sources']} · 组织差 {row['diversity_raw']['org_pairwise']}"
              f" · 老三样 {row['presets_raw']} · 锁定补 {sum(len(x['fields']) for x in row['locked'])} 处 · {(row['ms'] or 0) / 1000:.1f} s · {fmt_usage(row['usage'])} · {fmt_cost(row['cost'])}")
    calls = len(rec.log) if replay else getattr(ai_obj, "calls", 0)
    meta = {"generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "provider": provider, "model": model, "replay": bool(replay), "calls": calls}
    tag = "-replay" if replay else ""
    (out_dir / f"plans-v5{tag}.json").write_text(json.dumps({**meta, "inputs": inputs}, ensure_ascii=False, indent=1), encoding="utf-8")
    if not replay and provider != "mock":
        (out_dir / "raw-v5.json").write_text(json.dumps({**meta, "calls": rec.log}, ensure_ascii=False, indent=1), encoding="utf-8")
    revs = None
    if args.revise:
        base = next((r for r in inputs if r.get("plans")), None)
        texts = [t.strip() for t in args.revise.split(",") if t.strip()]
        revs = run_revise(ai_obj, base["plans"][0], texts) if base else None
    log = run_browser(args.browser)
    report = out_dir / f"report-v5{tag}.md"
    write_report(report, meta, inputs, revs, log)
    failed = [r for r in inputs if r.get("error") or len(r.get("plans") or []) != 3]
    print(f"写出 {report}\nDONE inputs={len(inputs)} failed={len(failed)} calls={calls} cost={total_cost(inputs + (revs or []))}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

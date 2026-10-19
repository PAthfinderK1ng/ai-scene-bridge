#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_first_interpretation.py — 首次理解评测（v4：plan 构成图）

做什么：
1. 固定的一句话输入（docs/05 §8 的 5 句 + 几句老题），逐个调 draft。服务商取 config.json 的当前设置或 --provider；
   没有密钥 / --mock 走模拟 AI（报告里标明）。
2. 每个输入记：耗时、usage、费用、**模型原样输出**是否合 plan schema（含回喂重试）、三张在构成上差几维（ai.diversity）、
   本地锁定补了什么（= 模型漏掉的硬条件）、锁定后三张是否都有那句话里说死的东西。
3. --revise "矿洞是个迷宫"：拿一张「含普通矿洞（galleries）」的 plan 逐句调 revise，记 ops 是否合法、锁定补了什么、复述。
4. 写 build/eval/plans.json（全部 plan，原样 + 锁定后）与 build/eval/report-v4.md（总表 + 每题三张的构成）。
   --browser PAGE：再用无头 Edge 跑一个引擎测试页（读 plans.json 编译几何），把它的 DATA 行附在报告里。

省钱：--only q02,q03 只跑这几题（结果并回 plans.json）；--max-calls N 是本次 HTTP 调用上限（含回喂重试，默认 10）。

用法：
  python -X utf8 tools/eval_first_interpretation.py --mock
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --only q02,q03 --max-calls 3
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --skip-draft --revise "矿洞是个迷宫" --max-calls 2
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import ai  # noqa: E402

INPUTS = [
    "我要生成山城村庄",
    "半山环台寨，吊脚木楼一圈圈往上长，崖边寨门",
    "地下有个矿洞，是个两层的迷宫",
    "寺下有地宫：前厅—甬道—主墓室，两侧耳室",
    "溪谷两岸，一座风雨桥，傍晚",
    "七层的大山城，很陡，夜景，塔在崖边最醒目的位置",
    "从东边进村，一路之字形石阶爬到山顶的寨门，阴天",
    "夜里亮着灯的小山村，一条溪从村中间下来，溪边有水车",
]
INPUT_ID = lambda i: f"q{i + 1:02d}"  # noqa: E731


def cost_of(u: dict | None) -> dict | None:
    if not u:
        return None
    if u.get("cost_cny") is not None:
        return {"cny": u["cost_cny"]}
    if u.get("cost_usd") is not None:
        return {"usd": u["cost_usd"]}
    return None


def fmt_usage(u: dict | None) -> str:
    if not u:
        return "—"
    s = f"in {u.get('input') or 0} / out {u.get('output') or 0} / 缓存命中 {u.get('cache_read') or 0}"
    if (u.get("calls") or 1) > 1:
        s += f" / {u['calls']} 次调用"
    return s


def fmt_cost(c: dict | None) -> str:
    if not c:
        return "—"
    return f"¥{c['cny']:.4f}" if "cny" in c else f"${c['usd']:.4f}"


def has_all(plan: dict, cons: dict) -> list[str]:
    """锁定后复查：这张 plan 缺了哪些说死的东西（应为空）"""
    miss = []
    lab = lambda g: "|".join(x.get("label") or "" for x in plan.get(g) or [])  # noqa: E731
    for x in cons.get("landmarks", []):
        if x["word"] not in lab("landmarks"):
            miss.append(x["word"])
    for b in cons.get("buildings", []):
        if b["word"] not in lab("buildings"):
            miss.append(b["word"])
    for t in cons.get("terrain", []):
        if not any(e.get("type") == t["type"] for e in plan.get("terrain") or []):
            miss.append(t["cn"])
    for s in cons.get("spaces", []):
        if not any(s["word"] in (e.get("label") or "") or s["word"] in ("迷宫", "地下", "空中") for e in plan.get("spaces") or []) \
                or not any(e.get("layout") in s["accept"] for e in plan.get("spaces") or []):
            miss.append(s["word"])
    if cons.get("time_of_day") and (plan.get("lighting") or {}).get("time_of_day") != cons["time_of_day"]:
        miss.append("时段")
    if cons.get("stream") is True and not any(w.get("type") == "stream" for w in plan.get("water") or []):
        miss.append("溪")
    return miss


def compo(plan: dict) -> str:
    """一张 plan 的构成，一行"""
    t = "、".join(f"{x.get('label') or x.get('type')}({x.get('type')})" for x in plan.get("terrain") or [])
    b = "、".join(f"{x.get('label')}({x.get('form')})" for x in plan.get("buildings") or [])
    lm = "、".join(f"{x.get('label')}@{(x.get('place') or {}).get('rel')}:{(x.get('place') or {}).get('target')}" for x in plan.get("landmarks") or [])
    sp = "、".join(f"{x.get('label')}[{x.get('layout')}{' ×' + str(x['sublevels']) if (x.get('sublevels') or 1) > 1 else ''}]" for x in plan.get("spaces") or [])
    pa = "、".join(f"{x.get('label') or x.get('id')}({x.get('style')})" for x in plan.get("paths") or [])
    return f"地形 {t or '—'}；建筑 {b or '—'}；地标 {lm or '—'}；路 {pa or '—'}；空间 {sp or '—'}；时段 {(plan.get('lighting') or {}).get('time_of_day', '—')}"


def run_draft(ai_obj, text: str) -> dict:
    cons = ai.extract(text)
    row = {"text": text, "constraints": ai.summary(cons), "raw": [], "plans": [], "ms": None, "usage": None, "error": None, "retried": False,
           "fixes": [], "retry_errors": [], "locked_fixes": [], "missing_after_lock": [], "diversity_raw": None, "diversity": None}
    t0 = time.time()
    try:
        res = ai_obj.draft(text, cons, None, 0)
        row["ms"] = int((time.time() - t0) * 1000)
        row["raw"] = res.get("plans") or []
        row["usage"] = res.get("_usage")
        row["fixes"] = res.get("_fixes") or []
        row["retried"] = bool(res.get("_retried"))
        row["retry_errors"] = res.get("_retry_errors") or []
        for i, p in enumerate(row["raw"]):
            q, ch = ai.enforce(p, cons)
            row["plans"].append(q)
            row["locked_fixes"].append(ch)
            row["missing_after_lock"].append(has_all(q, cons))
        row["schema_errors"] = [f"plan {i + 1}: {e}" for i, p in enumerate(row["plans"]) for e in ai.validate(ai.plan_schema(), p)[:3]]
        row["diversity_raw"] = ai.diversity(row["raw"])
        row["diversity"] = ai.diversity(row["plans"])
    except Exception as e:  # noqa: BLE001
        row["ms"] = int((time.time() - t0) * 1000)
        row["error"] = f"{type(e).__name__}: {e}"
        d = getattr(e, "detail", None)
        if isinstance(d, dict):
            row["usage"] = d.get("usage")
            row["error_detail"] = {k: v for k, v in d.items() if k != "usage"}
    row["cost"] = cost_of(row["usage"])
    return row


def with_plain_mine(plan: dict) -> dict:
    """给一张 plan 换上一个「普通矿洞」（galleries，一层）——revise「矿洞是个迷宫」的基准"""
    p = copy.deepcopy(plan)
    host = (p.get("zones") or p.get("terrain"))[0]["id"]
    p["spaces"] = [{"id": "mine", "stratum": "underground", "label": "矿洞", "under": host, "depth_layers": 2, "layout": "galleries",
                    "size_m": 44, "branching": "medium", "sublevels": 1, "corridor_m": 3, "connect": {"via": "shaft", "from": host}}]
    return p


def run_revise(ai_obj, plan: dict, texts: list[str]) -> list[dict]:
    out = []
    for t in texts:
        row = {"text": t}
        t0 = time.time()
        try:
            r = ai.revise({"plan": plan, "action": {"type": "text", "text": t}}, ai_obj)  # 和 /api/ai/revise 同一条路（含本地锁定）
            row.update({k: r.get(k) for k in ("understood", "restatement", "ops", "question", "ask_to_point")})
            row["model_ops"], row["model_restatement"] = r.get("_model_ops") or [], r.get("_model_restatement")
            row["lock_added"] = (r.get("ops") or [])[len(row["model_ops"]):]
            row["lock_notes"] = r.get("constraints_fixed")
            good, errs, _ = ai.check_ops(plan, r.get("ops") or [])
            row["ops_errors"] = errs
            row["after"] = ai.apply_ops(plan, good)
            row["after_errors"] = ai.validate(ai.plan_schema(), row["after"])[:5]
            row["usage"] = r.get("_usage")
            row["retry_errors"] = r.get("_retry_errors") or []
            row["fixes"] = r.get("_fixes") or []
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
            d = getattr(e, "detail", None)
            row["usage"] = d.get("usage") if isinstance(d, dict) else None
        row["ms"] = int((time.time() - t0) * 1000)
        out.append(row)
        print(f"[revise] {t} → {row.get('restatement') or row.get('error')} · 模型 ops {json.dumps(row.get('model_ops'), ensure_ascii=False)[:200]} · 锁定补 {len(row.get('lock_added') or [])} 条 · {row['ms'] / 1000:.1f} s · {fmt_usage(row.get('usage'))} · {fmt_cost(cost_of(row.get('usage')))}")
    return out


def run_browser(page: str | None) -> tuple[list | None, str]:
    if not page:
        return None, "（没跑几何环节：加 --browser medium/engine/tests/<页>.test.html）"
    cmd = [sys.executable, "-X", "utf8", str(ROOT / "tools" / "run_browser_test.py"), page, "--timeout", "180"]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=240, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        return None, "（几何环节超时）"
    text = res.stdout.decode("utf-8", errors="replace") + res.stderr.decode("utf-8", errors="replace")
    m = re.search(r"^DATA (.*)$", text, re.M)
    try:
        return (json.loads(m.group(1)) if m else None), text
    except json.JSONDecodeError:
        return None, text


def total_cost(rows: list[dict]) -> str:
    cny = sum((r.get("cost") or cost_of(r.get("usage")) or {}).get("cny", 0) for r in rows)
    usd = sum((r.get("cost") or cost_of(r.get("usage")) or {}).get("usd", 0) for r in rows)
    parts = ([f"¥{cny:.4f}"] if cny else []) + ([f"${usd:.4f}"] if usd else [])
    return " + ".join(parts) if parts else "—（模拟 AI 不计费）"


def write_report(path: Path, meta: dict, inputs: list[dict], revs: list[dict] | None, geo, geo_log: str) -> None:
    L = ["# 首次理解评测（v4 · plan 构成图）", "",
         f"- 生成时间：{meta['generated_at']}",
         f"- AI：**{'模拟 AI（不代表真实模型）' if meta['provider'] == 'mock' else meta['provider'] + ' · ' + str(meta['model'])}**",
         f"- 输入 {len(inputs)} 条 · 模型输出合 schema：{sum(1 for r in inputs if r['raw'] and not r['error'])}/{len(inputs)}"
         f" · 三张构成两两差 ≥ 2 维（模型原样）：{sum(1 for r in inputs if (r.get('diversity_raw') or {}).get('min') is not None and r['diversity_raw']['min'] >= 2)}/{len(inputs)}"
         f" · 锁定后说死的全有：{sum(1 for r in inputs if r['plans'] and not any(r['missing_after_lock']))}/{len(inputs)}",
         f"- 费用合计 {total_cost(inputs + (revs or []))}", "",
         "构成维度（ai.diversity）：地形组合 / 地标放置 / 空间布局 / 路的走法 / 区域用途 / 出生点。「锁定补了」= 模型漏掉、本地写死的硬条件。", "",
         "## 总表", "", "| # | 输入 | 合 schema | 构成差（原样 / 锁定后） | 锁定补了 | 耗时 | usage | 费用 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in inputs:
        ok = "失败" if r["error"] else ("是（回喂后）" if r["retried"] else "是")
        dv = f"{(r.get('diversity_raw') or {}).get('min')} / {(r.get('diversity') or {}).get('min')}"
        fixed = "；".join(f"卡{i + 1}：{'、'.join(c)}" for i, c in enumerate(r.get("locked_fixes") or []) if c) or "—"
        L.append(f"| {r['id']} | {r['text']} | {ok} | {dv} | {fixed} | {(r['ms'] or 0) / 1000:.1f} s | {fmt_usage(r['usage'])} | {fmt_cost(r.get('cost'))} |")
    L += ["", "## 每题三张", ""]
    for r in inputs:
        L += [f"### {r['id']} 「{r['text']}」", "", f"锁定条件：{'、'.join(r['constraints']) or '—'}", ""]
        for label, val in (("调用失败", r["error"]), ("首次输出的问题（已回喂）", "；".join(r.get("retry_errors") or [])), ("本地修正", "；".join((r.get("fixes") or [])[:12])),
                           ("锁定后仍缺", "；".join(f"卡{i + 1}：{'、'.join(m)}" for i, m in enumerate(r.get("missing_after_lock") or []) if m))):
            if val:
                L += [f"**{label}**：{val}", ""]
        for i, p in enumerate(r.get("plans") or []):
            L += [f"{i + 1}. **{p.get('name', '')}**：{p.get('one_liner', '')}", f"   - {compo(p)}"]
        L.append("")
    if revs:
        L += ["## revise", "", "| 说的话 | 模型 ops | 锁定补的 ops | 复述 | ops 合法 | 耗时 | usage | 费用 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for v in revs:
            L.append(f"| {v['text']} | `{json.dumps(v.get('model_ops'), ensure_ascii=False)[:240]}` | `{json.dumps(v.get('lock_added'), ensure_ascii=False)[:160]}` | {v.get('restatement') or v.get('error') or ''} | "
                     f"{'是' if not v.get('ops_errors') and not v.get('error') else '否：' + '；'.join(v.get('ops_errors') or [])[:120]} | {(v.get('ms') or 0) / 1000:.1f} s | {fmt_usage(v.get('usage'))} | {fmt_cost(cost_of(v.get('usage')))} |")
        L.append("")
    L += ["## 几何环节", "", "```", (geo_log or "").strip()[:4000], "```"]
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
    ap.add_argument("--only", default=None, help="只跑这几题，如 q02,q03")
    ap.add_argument("--skip-draft", action="store_true", help="不跑 draft，用已有 plans.json（配合 --revise）")
    ap.add_argument("--revise", default=None, help="逗号分隔的几句话，对一张含普通矿洞的 plan 逐句调 revise")
    ap.add_argument("--revise-on", default="q02", help="--revise 用哪题的第 1 张 plan 做底（再换上普通矿洞）")
    ap.add_argument("--max-calls", type=int, default=10, help="本次 HTTP 调用上限（含回喂重试）")
    ap.add_argument("--browser", default=None, help="可选：引擎测试页（读 build/eval/plans.json）")
    args = ap.parse_args(argv)

    cfg = ai.config_for(args.provider) if args.provider else ai.load_config()
    if args.mock:
        cfg["mock"] = True
    if args.model:
        cfg["model"] = args.model
    ai_obj = ai.get_ai(cfg)
    provider, model = getattr(ai_obj, "name", "mock"), getattr(ai_obj, "model", "mock")
    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    plans_path = out_dir / "plans.json"
    print(f"AI: {provider} · model: {model} · 输出到 {out_dir}")
    prev = {}
    if plans_path.exists():
        try:
            prev = {r["id"]: r for r in json.loads(plans_path.read_text(encoding="utf-8")).get("inputs", [])}
        except Exception:  # noqa: BLE001
            prev = {}
    only = {x.strip() for x in args.only.split(",")} if args.only else None
    calls, inputs = 0, []
    for i, text in enumerate(INPUTS):
        iid = INPUT_ID(i)
        if args.skip_draft or (only and iid not in only):
            if iid in prev and prev[iid].get("text") == text:
                inputs.append(prev[iid])
            continue
        if provider != "mock" and calls + 1 > args.max_calls:
            print(f"[{iid}] 跳过：已用 {calls} 次调用，上限 {args.max_calls}")
            continue
        row = run_draft(ai_obj, text)
        calls += (row["usage"] or {}).get("calls") or (1 if provider != "mock" else 0)
        row.update(id=iid, provider=provider, model=model)
        inputs.append(row)
        print(f"[{iid}] {text} → {row['error'] or str(len(row['plans'])) + ' 张'}{' · 回喂' if row['retried'] else ''} · 构成差 {(row.get('diversity_raw') or {}).get('min')}"
              f" · 锁定补 {sum(len(c) for c in row['locked_fixes'])} 处 · {(row['ms'] or 0) / 1000:.1f} s · {fmt_usage(row['usage'])} · {fmt_cost(row['cost'])}")
    meta = {"generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "provider": provider, "model": model}
    plans_path.write_text(json.dumps({**meta, "inputs": inputs}, ensure_ascii=False, indent=1), encoding="utf-8")
    revs = None
    rev_path = out_dir / "revise-v4.json"
    if args.revise:
        base = next((r for r in inputs if r["id"] == args.revise_on and r.get("plans")), None) or next((r for r in inputs if r.get("plans")), None)
        plan = with_plain_mine(base["plans"][0]) if base else with_plain_mine(next(iter(ai.example_plans().values())))
        texts = [t.strip() for t in args.revise.split(",") if t.strip()]
        if provider != "mock":
            texts = texts[: max(0, args.max_calls - calls)]
        revs = run_revise(ai_obj, plan, texts)
        rev_path.write_text(json.dumps({**meta, "plan": plan, "results": revs}, ensure_ascii=False, indent=1), encoding="utf-8")
    elif rev_path.exists():
        try:
            revs = json.loads(rev_path.read_text(encoding="utf-8")).get("results")
        except Exception:  # noqa: BLE001
            revs = None
    geo, log = run_browser(args.browser)
    report = out_dir / "report-v4.md"
    write_report(report, meta, inputs, revs, geo, log)
    failed = [r for r in inputs if r["error"] or len(r.get("plans") or []) != 3]
    print(f"写出 {plans_path} 与 {report}\nDONE inputs={len(inputs)} failed={len(failed)} calls={calls} cost={total_cost(inputs + (revs or []))}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

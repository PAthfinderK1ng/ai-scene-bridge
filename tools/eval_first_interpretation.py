#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_first_interpretation.py — D17「首次理解准确率」评测（docs/03 §9 D17：10 个一句话输入里 ≥ 8 个首次理解正确才算过）

做什么：
1. 10 个固定的一句话输入（黄昏 / 夜 / 清晨、有溪 / 无溪、寺 / 塔 / 水车、小村 / 大寨、陡 / 缓），逐个调 ai_service.get_ai().draft()。
   有密钥走真模型（Claude，默认 claude-opus-5-5），没有就走 MockAI，报告里标明。
2. 记录耗时、usage（input / output / cache_read / cache_write）与按 Opus 5.5 定价估算的费用；每张卡用 jsonschema（没装则用 desktop/schema_lite）校验 CARD_SCHEMA。
3. 全部卡写到 build/eval/cards.json；用无头 Edge 跑 medium/engine/tests/eval_cards.test.html（引擎算几何：房子数、检查通过数、三张是否够不同）。
4. 生成 build/eval/report.md：每个输入三张卡的 name / one_liner / 关键字段 + 几何事实 + 一个空的「首次理解正确？ 是/否」列给人填。

用法：
  python -X utf8 tools/eval_first_interpretation.py              # 有密钥走真模型，否则 mock
  python -X utf8 tools/eval_first_interpretation.py --mock       # 强制 mock（不花钱）
  python -X utf8 tools/eval_first_interpretation.py --skip-browser   # 不跑几何环节（没有 Edge 时）
  可选 --model claude-opus-5-5 --out build/eval
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import ai_service  # noqa: E402
import schema_lite  # noqa: E402

# 覆盖：时段（黄昏 / 夜 / 清晨 / 阴）、有溪 / 无溪、寺 / 塔 / 水车 / 大树 / 寨门、小村 / 大寨、陡 / 缓、入口方位
INPUTS = [
    "我要一个黄昏的山城村庄，山顶有座寺",
    "夜里亮着灯的小山村，一条溪从村中间下来，溪边有水车",
    "清晨有雾的大寨子，层层叠叠很陡，顶上一座塔",
    "一个很缓的小村，没有溪，村口一棵大树",
    "溪谷两岸各一片房子，一座桥连起来，傍晚",
    "半山一块广场，房子围着广场往上长，广场边有鼓楼，中午",
    "从东边进村，一路之字形石阶爬到山顶的寨门，阴天",
    "很小的三层山村，清晨，房子稀一点，顶上一座小庙",
    "七层的大山城，很陡，夜景，塔在崖边最醒目的位置",
    "有溪有水车的缓坡村子，下午，房子密一些",
]

INPUT_ID = lambda i: f"q{i + 1:02d}"  # noqa: E731


def validate_card(card: dict) -> list[str]:
    """优先 jsonschema（更严），没装则用 schema_lite"""
    try:
        import jsonschema
        try:
            jsonschema.validate(card, ai_service.CARD_SCHEMA)
            return []
        except jsonschema.ValidationError as e:
            return [f"{'/'.join(str(p) for p in e.absolute_path) or '$'}: {e.message}"]
    except ImportError:
        return schema_lite.validate(ai_service.CARD_SCHEMA, card)


def run_draft(ai, text: str) -> dict:
    t0 = time.time()
    row = {"text": text, "cards": [], "ms": None, "usage": None, "cost_usd": None, "schema_errors": [], "fixes": [], "error": None}
    try:
        res = ai.draft(text, None, None, None)
        row["ms"] = int((time.time() - t0) * 1000)
        row["cards"] = res.get("cards") or []
        row["usage"] = res.get("_usage")
        row["fixes"] = res.get("_fixes") or []
        if row["usage"]:
            row["cost_usd"] = row["usage"].get("cost_usd")
        for i, c in enumerate(row["cards"]):
            for e in validate_card(c):
                row["schema_errors"].append(f"卡 {i + 1} {e}")
    except Exception as e:  # noqa: BLE001  一条失败不影响其它九条
        row["ms"] = int((time.time() - t0) * 1000)
        row["error"] = f"{type(e).__name__}: {e}"
        d = getattr(e, "detail", None)
        if isinstance(d, dict) and d.get("usage"):
            row["usage"] = d["usage"]
            row["cost_usd"] = d["usage"].get("cost_usd")
    return row


def run_browser(skip: bool) -> tuple[list[dict] | None, str]:
    """跑 eval_cards.test.html，解析 DATA 行；返回 (每输入的几何事实, 原始输出文本)"""
    if skip:
        return None, "（跳过几何环节：--skip-browser）"
    cmd = [sys.executable, "-X", "utf8", str(ROOT / "tools" / "run_browser_test.py"), "medium/engine/tests/eval_cards.test.html", "--budget", "20000", "--timeout", "180"]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=240, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        return None, "（几何环节超时）"
    text = res.stdout.decode("utf-8", errors="replace") + res.stderr.decode("utf-8", errors="replace")
    m = re.search(r"^DATA (.*)$", text, re.M)
    if not m:
        return None, text
    try:
        return json.loads(m.group(1)), text
    except json.JSONDecodeError:
        return None, text


PLACEMENT_ZH = {"top": "顶层中央", "ridge_end": "顶层尽头", "cliff_edge": "崖边", "plaza": "中层广场"}
SPAWN_ZH = {"valley_bottom": "入口侧山脚", "side_slope": "侧坡半山", "summit": "山顶", "S": "南边", "E": "东边", "W": "西边"}
ARCH_ZH = {"slope_zigzag": "之字叠落", "ring_terrace": "环台广场", "valley_two_banks": "溪谷双坡"}
KIND_ZH = {"temple": "寺", "pagoda": "塔", "tree": "大树", "wheel": "水车", "gate": "寨门"}
TIME_ZH = {"dawn": "破晓", "morning": "清晨", "noon": "中午", "afternoon": "下午", "dusk": "黄昏", "night": "夜", "overcast": "阴"}


def fmt_usage(u: dict | None) -> str:
    if not u:
        return "—"
    return f"in {u.get('input') or 0} / out {u.get('output') or 0} / cache_read {u.get('cache_read') or 0} / cache_write {u.get('cache_write') or 0}"


def fmt_cost(c: float | None) -> str:
    return "—" if c is None else f"${c:.4f}"


def card_rows(cards: list[dict], geo: dict | None) -> list[str]:
    rows = []
    for i, c in enumerate(cards):
        p, lm = c.get("params", {}), c.get("landmark", {})
        g = (geo or {}).get("cards") or []
        gi = g[i] if i < len(g) else {}
        facts = "—"
        if gi:
            chk = gi.get("checks") or {}
            facts = (f"房 {gi.get('houses')} · 检查 {gi.get('checks_ok')}/{gi.get('checks_total')} · 地标在第 {gi.get('landmark_level')} 层 · 顶高 {gi.get('top_height_m')} m · 主路 {gi.get('trail_len_m')} m"
                     + (" · 入口看得见地标" if chk.get("spawn_sees_landmark") else " · 入口看不见地标") + (" · 有溪" if gi.get("has_stream") else ""))
        rows.append(f"| 卡 {i + 1} | {c.get('name', '')} | {c.get('one_liner', '')} | {ARCH_ZH.get(c.get('archetype'), c.get('archetype'))} · {p.get('terraces')} 层 · 每层 {p.get('layer_height_m')} m · 入口 {p.get('entry_side')} · {'有溪' if p.get('stream') else '无溪'} | "
                    f"{KIND_ZH.get(lm.get('kind'), lm.get('kind'))}「{lm.get('label', '')}」@{PLACEMENT_ZH.get(lm.get('placement'), lm.get('placement'))} | {SPAWN_ZH.get(c.get('spawn', {}).get('placement'), '')} | {TIME_ZH.get(c.get('lighting', {}).get('time_of_day'), '')} | {facts} |")
    return rows


def write_report(path: Path, meta: dict, inputs: list[dict], geo_rows: list[dict] | None, browser_log: str) -> None:
    geo_by_id = {g["id"]: g for g in (geo_rows or [])}
    n_ok = sum(1 for r in inputs if len(r["cards"]) == 3 and not r["schema_errors"] and not r["error"])
    n_distinct = sum(1 for r in inputs if (geo_by_id.get(r["id"]) or {}).get("distinct"))
    total_ms = sum(r["ms"] or 0 for r in inputs)
    costs = [r["cost_usd"] for r in inputs if r["cost_usd"] is not None]
    L = []
    L.append("# D17 首次理解准确率评测报告")
    L.append("")
    L.append(f"- 生成时间：{meta['generated_at']}")
    L.append(f"- AI：**{'模拟 AI（MockAI，无密钥或强制 mock；不代表真实模型的理解力）' if meta['provider'] == 'mock' else 'Claude · ' + meta['model']}**")
    L.append(f"- 输入 10 条 · 三张卡齐全且合 schema：{n_ok}/10 · 三张几何上够不同：{n_distinct}/10" + ("" if geo_rows is not None else "（几何环节未跑）"))
    L.append(f"- 总耗时 {total_ms / 1000:.1f} s · 平均 {total_ms / max(1, len(inputs)) / 1000:.1f} s / 输入 · 估算费用合计 {fmt_cost(sum(costs)) if costs else '—（模拟 AI 不计费，或模型不在定价表里）'}")
    L.append(f"- 定价依据：Opus 5.5 $4 / $20 每百万 token，缓存写 $5、缓存读 $0.20（claude-api 技能 shared/model-migration.md）；schema 校验器：{meta['validator']}")
    L.append("")
    L.append("## 怎么填")
    L.append("")
    L.append("对每个输入看三张卡：**人说的那句话里的每个意思（时段、溪、地标是什么、规模、陡缓、入口）是否都落到了卡上，且三张卡都是这句话的合理切法**——是，就在「首次理解正确？」填 **是**；有一项漏了或反了填 **否** 并写一句原因。")
    L.append("D17 判定：10 个里 ≥ 8 个「是」→ 过；否则按 D17 决策 a 给点 / 画动作加用途芯片确认。")
    L.append("")
    L.append("## 总表（填这里）")
    L.append("")
    L.append("| # | 输入 | 卡齐全 / 合 schema | 三张够不同 | 耗时 | usage | 费用 | 首次理解正确？（是 / 否 + 原因） |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in inputs:
        g = geo_by_id.get(r["id"]) or {}
        ok = "是" if (len(r["cards"]) == 3 and not r["schema_errors"] and not r["error"]) else "否"
        distinct = "—" if g.get("distinct") is None else ("是" if g["distinct"] else "否")
        L.append(f"| {r['id']} | {r['text']} | {ok} | {distinct} | {(r['ms'] or 0) / 1000:.1f} s | {fmt_usage(r['usage'])} | {fmt_cost(r['cost_usd'])} |  |")
    L.append("")
    L.append("合计「是」：____ / 10 → D17（≥ 8 过）：____")
    L.append("")
    L.append("## 每个输入的三张卡")
    L.append("")
    for r in inputs:
        g = geo_by_id.get(r["id"]) or {}
        L.append(f"### {r['id']} 「{r['text']}」")
        L.append("")
        if r["error"]:
            L.append(f"**调用失败**：{r['error']}")
            L.append("")
        if r["schema_errors"]:
            L.append("**schema 违规**：" + "；".join(r["schema_errors"]))
            L.append("")
        if r["fixes"]:
            L.append("**越界数值已夹回**：" + "；".join(r["fixes"]))
            L.append("")
        if g.get("error"):
            L.append(f"**几何环节失败**：{g['error']}")
            L.append("")
        if r["cards"]:
            L.append("| 卡 | 名字 | 一句话 | 原型 · 层数 · 层高 · 入口 · 溪 | 地标 | 出生点 | 时段 | 几何事实（引擎算） |")
            L.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
            L += card_rows(r["cards"], g)
            L.append("")
            if g.get("pairwise"):
                L.append(f"三张两两距离（≥ 1.0 算够不同）：1–2 {g['pairwise'][0]} · 1–3 {g['pairwise'][1]} · 2–3 {g['pairwise'][2]} → {'够不同' if g.get('distinct') else '**太像**'}")
                L.append("")
        L.append("首次理解正确？ 是 / 否：________　原因：____________________")
        L.append("")
    L.append("## 几何环节原始输出")
    L.append("")
    L.append("```")
    L.append(browser_log.strip()[:6000] if browser_log else "（无）")
    L.append("```")
    path.write_text("\n".join(L), encoding="utf-8")


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true", help="强制用 MockAI（不花钱）")
    ap.add_argument("--model", default=None, help="覆盖模型名（默认用 config.json 里的）")
    ap.add_argument("--out", default="build/eval", help="输出目录（相对仓库根）")
    ap.add_argument("--skip-browser", action="store_true", help="不跑无头 Edge 的几何环节")
    args = ap.parse_args(argv)

    cfg = ai_service.load_config()
    if args.mock:
        cfg["mock"] = True
    if args.model:
        cfg["model"] = args.model
    ai = ai_service.get_ai(cfg)
    provider = getattr(ai, "name", "mock")
    model = getattr(ai, "model", None) or (cfg.get("model") if provider != "mock" else "mock")
    try:
        import jsonschema  # noqa: F401
        validator = "jsonschema"
    except ImportError:
        validator = "desktop/schema_lite（未装 jsonschema）"
    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"AI: {provider} · model: {model} · 输出到 {out_dir}")

    inputs = []
    for i, text in enumerate(INPUTS):
        row = run_draft(ai, text)
        row["id"] = INPUT_ID(i)
        inputs.append(row)
        status = row["error"] or (f"{len(row['cards'])} 张卡" + (f" · schema 违规 {len(row['schema_errors'])}" if row["schema_errors"] else " · 合 schema"))
        print(f"[{row['id']}] {text}  →  {status} · {(row['ms'] or 0) / 1000:.1f} s · {fmt_usage(row['usage'])} · {fmt_cost(row['cost_usd'])}")

    meta = {"generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "provider": provider, "model": model, "validator": validator}
    cards_path = out_dir / "cards.json"
    cards_path.write_text(json.dumps({**meta, "inputs": [{k: v for k, v in r.items()} for r in inputs]}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写出 {cards_path}")

    geo_rows, log = run_browser(args.skip_browser)
    if geo_rows is None and not args.skip_browser:
        print("几何环节没有拿到 DATA 行：\n" + log[:1500])
    elif geo_rows is not None:
        print(f"几何环节：{sum(1 for g in geo_rows if g.get('distinct'))}/{len(geo_rows)} 组三张够不同")

    report = out_dir / "report.md"
    write_report(report, meta, inputs, geo_rows, log)
    print(f"写出 {report}")
    failed = [r for r in inputs if r["error"] or r["schema_errors"] or len(r["cards"]) != 3]
    print(f"\nDONE inputs={len(inputs)} failed={len(failed)}" + ("（几何环节未拿到结果）" if geo_rows is None and not args.skip_browser else ""))
    return 1 if failed or (geo_rows is None and not args.skip_browser) else 0


if __name__ == "__main__":
    sys.exit(main())

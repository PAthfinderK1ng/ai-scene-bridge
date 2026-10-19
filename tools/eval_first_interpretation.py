#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_first_interpretation.py — D17「首次理解准确率」评测（docs/03 §9 D17：10 个一句话输入里 ≥ 8 个首次理解正确才算过）+ docs/04 多层空间输入

做什么：
1. 12 个固定的一句话输入（10 个 D17 原题 + 2 个多层空间题），逐个调 draft()。服务商取 config.json 的当前设置，或 --provider 指定；
   没有密钥 / --mock 走 MockAI，报告里标明。
2. 记录耗时、usage（input / output / cache_read / reasoning）与费用（DeepSeek 人民币 / Claude 美元）；每张卡校验 CARD_SCHEMA；
   本地再查两件事：三张卡在「原型 / 地标位置 / 层数 / 入口」上两两至少差两项吗；该给 levels 的题（多层题）给了吗、不该给的没给吗。
3. 全部卡写到 build/eval/cards.json；用无头 Edge 跑 medium/engine/tests/eval_cards.test.html（引擎算几何：房子数、关系检查、三张是否够不同）。
4. 生成 build/eval/report.md：总表 + 每个输入三张卡的关键字段 + 一个空的「首次理解正确？」列给人填。
5. --revise "再陡一点,加一个地下溶洞,换成夜里"：拿 cards.json 里某题的第 1 张卡（--revise-on q01）逐句调 revise，结果写 build/eval/revise.json 并附在报告末尾。

省钱：--only q11,q12 只重跑这几题（结果并回 cards.json）；--max-calls N 是本次运行的 HTTP 调用上限（含 schema 回喂重试，默认 30）。

用法：
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek
  python -X utf8 tools/eval_first_interpretation.py --mock                 # 强制模拟（不花钱）
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --only q03,q11
  python -X utf8 tools/eval_first_interpretation.py --provider deepseek --revise "再陡一点,加一个地下溶洞,换成夜里" --skip-draft
  可选 --model deepseek-v4-pro --out build/eval --skip-browser
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import time
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import ai_service  # noqa: E402
import schema_lite  # noqa: E402

# 覆盖：时段（黄昏 / 夜 / 清晨 / 阴）、有溪 / 无溪、寺 / 塔 / 水车 / 大树 / 寨门、小村 / 大寨、陡 / 缓、入口方位；最后两题是多层空间
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
    "山城下面有个地宫，从井下去",
    "悬崖村，崖顶有栈道和浮岛",
]
# 每题期望的 levels：None = 不该给；集合 = 至少要出现这些 stratum / kind
EXPECT_LEVELS = {10: {"underground", "crypt"}, 11: {"sky", "walkway", "island"}}

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


def struct_diff(cards: list[dict]) -> int | None:
    """三张卡两两在「原型 / 地标位置 / 层数 / 入口方位(含出生点)」上差几项，取最小值（提示词要求 ≥ 2）"""
    if len(cards) != 3:
        return None
    key = lambda c: (c.get("archetype"), (c.get("landmark") or {}).get("placement"), (c.get("params") or {}).get("terraces"),  # noqa: E731
                     ((c.get("params") or {}).get("entry_side"), (c.get("spawn") or {}).get("placement")))
    return min(sum(x != y for x, y in zip(key(a), key(b))) for a, b in combinations(cards, 2))


def levels_check(i: int, cards: list[dict]) -> str:
    """该给 levels 的题三张都给了吗（且含期望的层 / 种类）；不该给的题有没有乱给"""
    want = EXPECT_LEVELS.get(i)
    got = [c.get("levels") or [] for c in cards]
    if not cards:
        return "—"
    if want is None:
        n = sum(1 for g in got if g)
        return "是（没乱给）" if n == 0 else f"否（{n} 张多给了）"
    miss = []
    for k, g in enumerate(got):
        have = {l.get("stratum") for l in g} | {l.get("kind") for l in g}
        if not want <= have:
            miss.append(f"卡 {k + 1} 缺 {'/'.join(sorted(want - have))}")
    return "是" if not miss else "否（" + "；".join(miss) + "）"


def run_draft(ai, text: str) -> dict:
    t0 = time.time()
    row = {"text": text, "cards": [], "ms": None, "usage": None, "cost": None, "schema_errors": [], "fixes": [], "error": None, "retried": False}
    try:
        res = ai.draft(text, None, None, None)
        row["ms"] = int((time.time() - t0) * 1000)
        row["cards"] = res.get("cards") or []
        row["usage"] = res.get("_usage")
        row["fixes"] = res.get("_fixes") or []
        row["retried"] = bool(res.get("_retried"))
        row["retry_errors"] = res.get("_retry_errors") or []
        for i, c in enumerate(row["cards"]):
            for e in validate_card(c):
                row["schema_errors"].append(f"卡 {i + 1} {e}")
    except Exception as e:  # noqa: BLE001  一条失败不影响其它
        row["ms"] = int((time.time() - t0) * 1000)
        row["error"] = f"{type(e).__name__}: {e}"
        d = getattr(e, "detail", None)
        if isinstance(d, dict) and d.get("usage"):
            row["usage"] = d["usage"]
    row["cost"] = cost_of(row["usage"])
    return row


def cost_of(u: dict | None) -> dict | None:
    if not u:
        return None
    if u.get("cost_cny") is not None:
        return {"cny": u["cost_cny"]}
    if u.get("cost_usd") is not None:
        return {"usd": u["cost_usd"]}
    return None


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
LEVEL_ZH = {"cave": "溶洞", "tunnel": "地道", "cellar": "地窖", "crypt": "地宫", "platform": "平台", "walkway": "栈道", "island": "浮岛", "bridge": "天桥"}


def fmt_usage(u: dict | None) -> str:
    if not u:
        return "—"
    s = f"in {u.get('input') or 0} / out {u.get('output') or 0} / 缓存命中 {u.get('cache_read') or 0}"
    if u.get("reasoning"):
        s += f" / 推理 {u['reasoning']}"
    if (u.get("calls") or 1) > 1:
        s += f" / {u['calls']} 次调用"
    return s


def fmt_cost(c: dict | None) -> str:
    if not c:
        return "—"
    return f"¥{c['cny']:.4f}" if "cny" in c else f"${c['usd']:.4f}"


def fmt_levels(c: dict) -> str:
    lv = c.get("levels") or []
    if not lv:
        return "—"
    return "；".join(f"{'地下' if l.get('stratum') == 'underground' else '空中'}{LEVEL_ZH.get(l.get('kind'), l.get('kind'))}「{l.get('label', '')}」@{l.get('anchor')} "
                     f"{l.get('depth_layers') or l.get('height_layers') or '?'} 层 {l.get('size')} 经 {l.get('connect')}" for l in lv)


def card_rows(cards: list[dict], geo: dict | None) -> list[str]:
    rows = []
    for i, c in enumerate(cards):
        p, lm = c.get("params", {}), c.get("landmark", {})
        g = (geo or {}).get("cards") or []
        gi = g[i] if i < len(g) else {}
        facts = "—"
        if gi:
            chk = gi.get("checks") or {}
            facts = (f"房 {gi.get('houses')} · 检查 {gi.get('checks_ok')}/{gi.get('checks_total')} · 地标在第 {gi.get('landmark_level')} 层 · 顶高 {gi.get('top_height_m')} m"
                     + (" · 入口看得见地标" if chk.get("spawn_sees_landmark") else " · 入口看不见地标") + (" · 有溪" if gi.get("has_stream") else ""))
        rows.append(f"| 卡 {i + 1} | {c.get('name', '')} | {c.get('one_liner', '')} | {ARCH_ZH.get(c.get('archetype'), c.get('archetype'))} · {p.get('terraces')} 层 · 每层 {p.get('layer_height_m')} m · 入口 {p.get('entry_side')} · {'有溪' if p.get('stream') else '无溪'} | "
                    f"{KIND_ZH.get(lm.get('kind'), lm.get('kind'))}「{lm.get('label', '')}」@{PLACEMENT_ZH.get(lm.get('placement'), lm.get('placement'))} | {SPAWN_ZH.get(c.get('spawn', {}).get('placement'), '')} | "
                    f"{TIME_ZH.get(c.get('lighting', {}).get('time_of_day'), '')} | {fmt_levels(c)} | {facts} |")
    return rows


def total_cost(rows: list[dict]) -> str:
    cny = sum((r.get("cost") or {}).get("cny", 0) for r in rows)
    usd = sum((r.get("cost") or {}).get("usd", 0) for r in rows)
    parts = ([f"¥{cny:.4f}"] if cny else []) + ([f"${usd:.4f}"] if usd else [])
    return " + ".join(parts) if parts else "—（模拟 AI 不计费）"


def write_report(path: Path, meta: dict, inputs: list[dict], geo_rows: list[dict] | None, browser_log: str, revs: list[dict] | None) -> None:
    geo_by_id = {g["id"]: g for g in (geo_rows or [])}
    n = len(inputs)
    n_ok = sum(1 for r in inputs if len(r["cards"]) == 3 and not r["schema_errors"] and not r["error"])
    n_distinct = sum(1 for r in inputs if (geo_by_id.get(r["id"]) or {}).get("distinct"))
    n_struct = sum(1 for r in inputs if (struct_diff(r["cards"]) or 0) >= 2)
    n_lv = sum(1 for r in inputs if r.get("levels_ok", "").startswith("是"))
    total_ms = sum(r["ms"] or 0 for r in inputs)
    prov = meta["provider"]
    L = ["# D17 首次理解准确率评测报告", ""]
    L.append(f"- 生成时间：{meta['generated_at']}")
    L.append(f"- AI：**{'模拟 AI（MockAI，无密钥或强制 mock；不代表真实模型的理解力）' if prov == 'mock' else prov + ' · ' + str(meta['model']) + (' · 思考开' if meta.get('thinking') else '')}**")
    L.append(f"- 输入 {n} 条 · 三张卡齐全且合 schema：{n_ok}/{n} · 结构两两差 ≥ 2 项：{n_struct}/{n} · 几何上够不同：{n_distinct}/{n}" + ("" if geo_rows is not None else "（几何环节未跑）") + f" · levels 该给就给、不该给不给：{n_lv}/{n}")
    L.append(f"- 总耗时 {total_ms / 1000:.1f} s · 平均 {total_ms / max(1, n) / 1000:.1f} s / 输入 · 费用合计 {total_cost(inputs)}")
    L.append("- 价目：DeepSeek 按官方人民币价目（deepseek-flash 每百万 token 缓存命中 0.04 / 0.02 元，未命中 2 / 1 元，输出 8 / 4 元，高峰 / 空闲）；Claude 按 Opus 5.5 $4 / $20。校验器：" + meta["validator"])
    L += ["", "## 怎么填", "",
          "对每个输入看三张卡：**那句话里的每个意思（时段、溪、地标、规模、陡缓、入口、地下 / 空中空间）是否都落到了卡上，且三张都是这句话的合理切法**——是就填 **是**；有一项漏了或反了填 **否** 并写原因。",
          "D17 判定：前 10 个里 ≥ 8 个「是」→ 过。", "", "## 总表", "",
          "| # | 输入 | 合 schema | 结构差（两两最少） | 几何够不同 | levels | 耗时 | usage | 费用 | 首次理解正确？ |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in inputs:
        g = geo_by_id.get(r["id"]) or {}
        ok = "是" if (len(r["cards"]) == 3 and not r["schema_errors"] and not r["error"]) else "否"
        if r.get("retried"):
            ok += "（回喂重试后）"
        distinct = "—" if g.get("distinct") is None else ("是" if g["distinct"] else "否")
        sd = struct_diff(r["cards"])
        L.append(f"| {r['id']} | {r['text']} | {ok} | {'—' if sd is None else sd} | {distinct} | {r.get('levels_ok', '—')} | {(r['ms'] or 0) / 1000:.1f} s | {fmt_usage(r['usage'])} | {fmt_cost(r.get('cost'))} |  |")
    L += ["", "## 每个输入的三张卡", ""]
    for r in inputs:
        g = geo_by_id.get(r["id"]) or {}
        L += [f"### {r['id']} 「{r['text']}」", ""]
        for label, val in (("调用失败", r["error"]), ("schema 违规", "；".join(r["schema_errors"])), ("本地修正（多余字段 / 越界夹回）", "；".join(r["fixes"])), ("首次输出的问题（已回喂重试）", "；".join(r.get("retry_errors") or [])), ("几何环节失败", g.get("error"))):
            if val:
                L += [f"**{label}**：{val}", ""]
        if r["cards"]:
            L += ["| 卡 | 名字 | 一句话 | 原型 · 层数 · 层高 · 入口 · 溪 | 地标 | 出生点 | 时段 | 地下 / 空中 | 几何事实（引擎算） |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
            L += card_rows(r["cards"], g)
            L.append("")
            if g.get("pairwise"):
                L += [f"三张两两距离（≥ 1.0 算够不同）：1–2 {g['pairwise'][0]} · 1–3 {g['pairwise'][1]} · 2–3 {g['pairwise'][2]} → {'够不同' if g.get('distinct') else '**太像**'}", ""]
        L += ["首次理解正确？ 是 / 否：________　原因：____________________", ""]
    if revs:
        L += ["## revise（改卡）", "", "| 说的话 | 理解了 | patch | 复述 | 耗时 | usage | 费用 |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for v in revs:
            L.append(f"| {v['text']} | {v.get('understood')} | `{json.dumps(v.get('patch'), ensure_ascii=False)[:300]}` | {v.get('restatement') or v.get('error') or ''} | {(v.get('ms') or 0) / 1000:.1f} s | {fmt_usage(v.get('usage'))} | {fmt_cost(cost_of(v.get('usage')))} |")
        L.append("")
    L += ["## 几何环节原始输出", "", "```", browser_log.strip()[:6000] if browser_log else "（无）", "```"]
    path.write_text("\n".join(L), encoding="utf-8")


def run_revise(ai, card: dict, texts: list[str]) -> list[dict]:
    out = []
    for t in texts:
        t0 = time.time()
        row = {"text": t}
        try:
            r = ai.revise(card, {"type": "text", "text": t}, None)
            row.update({k: r.get(k) for k in ("understood", "patch", "restatement", "question", "ask_to_point")})
            row["usage"] = r.get("_usage")
            row["retry_errors"] = r.get("_retry_errors") or []
            errs = schema_lite.validate(ai_service.REVISE_SCHEMA, {k: v for k, v in r.items() if not k.startswith("_") and k != "provider"})
            row["schema_errors"] = errs
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
            d = getattr(e, "detail", None)
            row["usage"] = d.get("usage") if isinstance(d, dict) else None
        row["ms"] = int((time.time() - t0) * 1000)
        out.append(row)
        print(f"[revise] {t} → {row.get('restatement') or row.get('error')} · {json.dumps(row.get('patch'), ensure_ascii=False)[:160]} · {row['ms'] / 1000:.1f} s · {fmt_usage(row.get('usage'))} · {fmt_cost(cost_of(row.get('usage')))}")
    return out


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true", help="强制用 MockAI（不花钱）")
    ap.add_argument("--provider", choices=list(ai_service.PROVIDERS), default=None, help="服务商（默认 config.json 的当前设置）")
    ap.add_argument("--model", default=None, help="覆盖模型名")
    ap.add_argument("--out", default="build/eval", help="输出目录（相对仓库根）")
    ap.add_argument("--only", default=None, help="只跑这几题，逗号分隔，如 q03,q11（结果并回 cards.json）")
    ap.add_argument("--skip-draft", action="store_true", help="不跑 draft，用已有的 cards.json（配合 --revise）")
    ap.add_argument("--revise", default=None, help="逗号分隔的几句话，逐句对一张卡调 revise")
    ap.add_argument("--revise-on", default="q01", help="--revise 用哪题的第 1 张卡（默认 q01）")
    ap.add_argument("--max-calls", type=int, default=30, help="本次运行的 HTTP 调用上限（含回喂重试）")
    ap.add_argument("--skip-browser", action="store_true", help="不跑无头 Edge 的几何环节")
    args = ap.parse_args(argv)

    cfg = ai_service.config_for(args.provider) if args.provider else ai_service.load_config()
    if args.mock:
        cfg["mock"] = True
    if args.model:
        cfg["model"] = args.model
    ai = ai_service.get_ai(cfg)
    provider = getattr(ai, "name", "mock")
    model = getattr(ai, "model", None) or "mock"
    try:
        import jsonschema  # noqa: F401
        validator = "jsonschema"
    except ImportError:
        validator = "desktop/schema_lite（未装 jsonschema）"
    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    cards_path = out_dir / "cards.json"
    print(f"AI: {provider} · model: {model} · 输出到 {out_dir}")

    prev = {}
    if cards_path.exists():
        try:
            prev = {r["id"]: r for r in json.loads(cards_path.read_text(encoding="utf-8")).get("inputs", [])}
        except Exception:  # noqa: BLE001
            prev = {}
    only = {x.strip() for x in args.only.split(",")} if args.only else None
    calls = 0
    inputs = []
    for i, text in enumerate(INPUTS):
        iid = INPUT_ID(i)
        if args.skip_draft or (only and iid not in only):
            if iid in prev and prev[iid].get("text") == text:
                inputs.append(prev[iid])
            continue
        if provider != "mock" and calls + 2 > args.max_calls:
            print(f"[{iid}] 跳过：已用 {calls} 次调用，再跑可能超过上限 {args.max_calls}")
            continue
        row = run_draft(ai, text)
        calls += (row["usage"] or {}).get("calls") or (1 if provider != "mock" else 0)
        row["id"] = iid
        row["levels_ok"] = levels_check(i, row["cards"])
        row["provider"], row["model"] = provider, model
        inputs.append(row)
        status = row["error"] or (f"{len(row['cards'])} 张卡" + (f" · schema 违规 {len(row['schema_errors'])}" if row["schema_errors"] else " · 合 schema") + (" · 回喂重试" if row["retried"] else ""))
        print(f"[{iid}] {text} → {status} · 结构差 {struct_diff(row['cards'])} · levels {row['levels_ok']} · {(row['ms'] or 0) / 1000:.1f} s · {fmt_usage(row['usage'])} · {fmt_cost(row['cost'])}")
    for r in inputs:  # 旧行也补上本地检查
        r.setdefault("levels_ok", levels_check(int(r["id"][1:]) - 1, r.get("cards") or []))
        r.setdefault("cost", cost_of(r.get("usage")))
        r.setdefault("retried", False)
        r.setdefault("fixes", [])
        r.setdefault("schema_errors", [])

    meta = {"generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "provider": provider, "model": model, "thinking": bool(cfg.get("thinking")) and provider == "deepseek", "validator": validator}
    cards_path.write_text(json.dumps({**meta, "inputs": inputs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写出 {cards_path}")

    revs = None
    rev_path = out_dir / "revise.json"
    if args.revise:
        base = next((r for r in inputs if r["id"] == args.revise_on and r.get("cards")), None)
        if not base:
            print(f"--revise：cards.json 里没有 {args.revise_on} 的卡")
        else:
            texts = [t.strip() for t in args.revise.split(",") if t.strip()]
            texts = texts[: max(0, args.max_calls - calls) // 2 or (len(texts) if provider == "mock" else 0)]
            revs = run_revise(ai, base["cards"][0], texts)
            rev_path.write_text(json.dumps({**meta, "on": args.revise_on, "card": base["cards"][0], "results": revs}, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"写出 {rev_path}")
    elif rev_path.exists():
        try:
            revs = json.loads(rev_path.read_text(encoding="utf-8")).get("results")
        except Exception:  # noqa: BLE001
            revs = None

    geo_rows, log = run_browser(args.skip_browser)
    if geo_rows is None and not args.skip_browser:
        print("几何环节没有拿到 DATA 行：\n" + log[:1500])
    elif geo_rows is not None:
        print(f"几何环节：{sum(1 for g in geo_rows if g.get('distinct'))}/{len(geo_rows)} 组三张够不同")

    report = out_dir / "report.md"
    write_report(report, meta, inputs, geo_rows, log, revs)
    print(f"写出 {report}")
    failed = [r for r in inputs if r["error"] or r["schema_errors"] or len(r["cards"]) != 3]
    print(f"\nDONE inputs={len(inputs)} failed={len(failed)} calls={calls} cost={total_cost(inputs)}" + ("（几何环节未拿到结果）" if geo_rows is None and not args.skip_browser else ""))
    return 1 if failed or (geo_rows is None and not args.skip_browser) else 0


if __name__ == "__main__":
    sys.exit(main())

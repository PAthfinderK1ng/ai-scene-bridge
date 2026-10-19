# -*- coding: utf-8 -*-
"""
providers.py — 场景程序从哪来：真模型的服务商底层 + 没有模型时的模拟配方

上半（怎么问、花多少、出了错怎么说）：
- DeepSeekClient：官方 /chat/completions（OpenAI 兼容），只用标准库 urllib；json_object；本地修 JSON → 后处理 → 不合格回喂一次；
  429 / 5xx / 断连重试 1 次；调用上限（max_calls，线程安全）；人民币计费（高峰 / 空闲）。
- ClaudeClient：官方 anthropic SDK，结构化输出 + 服务端 refusal fallback；美元计费。
- 配置（%LOCALAPPDATA%/ai-scene-bridge/config.json，密钥只在本进程）、打码、错误 payload、密钥测试。
下半（概念 → 场景程序：模拟 AI 的构思 / 展开，与真模型某张没写成时的补位；v5 第 1 轮从 rules.py 拆出、第 2 轮验收并进本文件，后端只多一个文件）：
- recipes_for：模拟 AI 的题材配方（数据 THEMES / DEFAULT_RECIPES 在 rules.py 片段库旁边；每个题材 4–6 个组织：散布、轴线、水网、残骸、环形、下沉 …，
  按 variant 轮换取三个，一批里最多一个往上、最多一个往下；auto 的配方只写概念，由 recipe_from_concept 按词搭）。
- recipe_from_concept：真模型给的概念 → 补位配方。不套预设：按 terrain_idea 雕地形，按 key_structures 逐条出形体，
  按词挑排法（环 / 一排 / 夹道 / 悬浮 / 散布 / 中轴长堤）；只有说到具体结构（金字塔、码头、迷宫…）才借片段。
- compose：配方 → 场景程序（只用锚点与组内偏移）。
ai.py 在这里的客户端上加「问什么」（构思 / 展开 / 改动），并把这里的名字再导出。
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import math
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from plans import all_nodes, config_path, item_schema, new_id
from rules import CN_NUM, DEFAULT_RECIPES, FRAG, THEMES, _free_dir, enforce, instantiate, main_id


class AIError(RuntimeError):
    """HTTP 200 回来了但结果不能用：kind ∈ refusal / truncated / empty / bad_json / schema / budget。detail 原样透给前端。"""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail


class DeepSeekAPIError(Exception):
    """DeepSeek 的 HTTP / 网络错误，字段与 anthropic.APIError 对齐（status_code / message / body / request_id）"""

    provider = "deepseek"

    def __init__(self, message: str, status_code: int | None = None, body: Any = None, etype: str | None = None):
        super().__init__(message)
        self.message, self.status_code, self.body, self.request_id = message, status_code, body, None
        err = body.get("error") if isinstance(body, dict) else None
        self.etype = etype or (err.get("type") if isinstance(err, dict) else None) or "DeepSeekAPIError"


# ============================================================ 5. JSON 修复
def repair_json(text: str) -> tuple[Any, list[str]] | None:
    """模型偶尔吐的坏 JSON 本地修（不花钱）：去 ```json 围栏与前后杂字；字符串里没转义的英文双引号 / 裸换行；尾逗号。修不好返回 None。"""
    t = (text or "").strip()
    fixes: list[str] = []
    if t.startswith("```"):
        t = t[3:]
        t = t[4:] if t[:4].lower() == "json" else t
        t = t.rstrip()
        t = t[:-3] if t.endswith("```") else t
        t = t.strip()
        fixes.append("去掉代码块围栏")
    starts = [i for i in (t.find("{"), t.find("[")) if i >= 0]
    if not starts:
        return None
    a, b = min(starts), max(t.rfind("}"), t.rfind("]"))
    if b <= a:
        return None
    if a > 0 or b < len(t) - 1:
        fixes.append("去掉 JSON 前后的杂字")
    t = t[a:b + 1]
    out: list[str] = []
    n_quote = n_nl = n_comma = 0
    in_str = esc = False
    i, L = 0, len(t)
    while i < L:
        ch = t[i]
        if in_str:
            if esc:
                esc = False
                out.append(ch)
            elif ch == "\\":
                esc = True
                out.append(ch)
            elif ch == '"':
                j = i + 1
                while j < L and t[j] in " \t\r\n":
                    j += 1
                if j >= L or t[j] in ",}]:":
                    in_str = False
                    out.append(ch)
                else:
                    out.append('\\"')
                    n_quote += 1
            elif ch in "\n\r\t":
                out.append({"\n": "\\n", "\r": "\\r", "\t": "\\t"}[ch])
                n_nl += 1
            else:
                out.append(ch)
        else:
            if ch == '"':
                in_str = True
                out.append(ch)
            elif ch == ",":
                j = i + 1
                while j < L and t[j] in " \t\r\n":
                    j += 1
                if j < L and t[j] in "}]":
                    n_comma += 1
                else:
                    out.append(ch)
            else:
                out.append(ch)
        i += 1
    if n_comma:
        fixes.append(f"去掉尾逗号 ×{n_comma}")
    if n_quote:
        fixes.append(f"转义字符串里的双引号 ×{n_quote}")
    if n_nl:
        fixes.append(f"转义字符串里的换行 ×{n_nl}")
    t = "".join(out)
    try:
        return json.loads(t), fixes
    except json.JSONDecodeError:
        pass
    t2, n = _fix_brackets(t)  # 深层嵌套里多 / 少一个括号：在出错位置试删 / 补一个括号，选走得最远的
    if t2 is None:
        return None
    fixes.append(f"修括号 ×{n}")
    return json.loads(t2), fixes


def _fix_brackets(t: str, max_edits: int = 6) -> tuple[str | None, int]:
    def err_pos(s: str) -> int:
        try:
            json.loads(s)
            return -1
        except json.JSONDecodeError as e:
            return e.pos
    for n in range(1, max_edits + 1):
        p = err_pos(t)
        if p < 0:
            return t, n - 1
        cands = []
        for q in (p, p - 1):
            if 0 <= q < len(t) and t[q] in "]}":
                cands.append(t[:q] + t[q + 1:])
        for ch in "]}":
            cands.append(t[:p] + ch + t[p:])
        if p >= len(t.rstrip()):
            cands.append(t + "}")
        best = max(cands, key=lambda s: (err_pos(s) == -1, err_pos(s)), default=None)
        if best is None or (err_pos(best) != -1 and err_pos(best) <= p):
            return None, n
        t = best
    return (t, max_edits) if err_pos(t) == -1 else (None, max_edits)


def _usage_zero(model: str = "mock", ms: int = 0) -> dict:
    return {"model": model, "input": 0, "output": 0, "cache_read": 0, "ms": ms, "cost_cny": 0.0, "calls": 0}


def _sum_usage(a: dict | None, b: dict | None) -> dict | None:
    if not a:
        return b
    if not b:
        return a
    s = dict(b)
    for k in ("input", "output", "cache_read", "cache_miss", "cache_write", "reasoning", "ms", "calls"):
        if a.get(k) is not None or b.get(k) is not None:
            s[k] = (a.get(k) or 0) + (b.get(k) or 0)
    for k in ("cost_cny", "cost_usd"):
        if k in a or k in b:
            s[k] = None if a.get(k) is None or b.get(k) is None else round(a[k] + b[k], 6)
    return s


# ---------- DeepSeek
DS_DEFAULT_MODEL = "deepseek-flash"
DS_DEFAULT_BASE_URL = "https://api.deepseek.com"
DS_MODELS = ["deepseek-flash", "deepseek-v4-pro"]
# 元 / 百万 token：(高峰, 空闲)。来源 api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-19 取）
DS_PRICING = {
    "deepseek-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},
    "deepseek-v4-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},
    "deepseek-v4-pro": {"hit": (0.30, 0.15), "miss": (9.0, 4.5), "output": (27.0, 13.5)},
}
DS_RETRYABLE = {429, 500, 502, 503, 504}


def is_peak(now: dt.datetime | None = None) -> bool:
    """北京时间周一至周五 9–12、14–18 点为高峰（不识别节假日）"""
    t = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone(dt.timedelta(hours=8)))
    return t.weekday() < 5 and (9 <= t.hour < 12 or 14 <= t.hour < 18)


def estimate_cost_cny(usage: dict | None, model: str | None = None, peak: bool | None = None) -> float | None:
    if not usage:
        return None
    m = model or usage.get("model") or ""
    key = next((k for k in DS_PRICING if m == k), None) or next((k for k in DS_PRICING if m.startswith(k)), None)
    if not key:
        return None
    p = DS_PRICING[key]
    i = 0 if (usage.get("peak") if peak is None else peak) else 1
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    hit = n("cache_read")
    miss = n("cache_miss") if usage.get("cache_miss") is not None else max(0.0, n("input") - hit)
    return round((hit * p["hit"][i] + miss * p["miss"][i] + n("output") * p["output"][i]) / 1e6, 6)


class DeepSeekClient:
    """DeepSeek 官方 /chat/completions（OpenAI 兼容），只用标准库。没有 json_schema：json_object + 系统提示里的语法表，
    回来后本地修 JSON → 去多余字段 → 夹取 → 小错本地修 → 校验，不合格把错误清单回喂、重试一次。
    max_calls：本实例最多发几次 HTTP（评测省钱用；超了抛 AIError(budget)，展开那一张由模拟 AI 补位）。线程安全。"""

    name = "deepseek"
    TIMEOUT = 120.0
    MAX_TOKENS = {"concepts": 1500, "expand": 6000, "revise": 2000}
    THINKING_EXTRA = 8000

    def __init__(self, api_key: str, model: str = DS_DEFAULT_MODEL, base_url: str = DS_DEFAULT_BASE_URL, thinking: bool = False, urlopen=None, max_calls: int | None = None,
                 log_dir: str | None = None):
        self.api_key = api_key
        self.log_dir = log_dir  # 每次 HTTP 的原样回包落盘（不含密钥）：/api/ai/draft 走 %LOCALAPPDATA%/ai-scene-bridge/logs/
        self.model = model or DS_DEFAULT_MODEL
        self.base_url = (base_url or DS_DEFAULT_BASE_URL).rstrip("/")
        self.thinking = bool(thinking)
        self._urlopen = urlopen or urllib.request.urlopen
        self.retry_sleep = 2.0
        self.max_calls = max_calls
        self.calls = 0
        self._lock = threading.Lock()
        self.pending_first = 0  # 还没发出第一次请求的展开张数：回喂 / 重试不许占它们的名额（并行时快的那张不能把慢的那张的第一次挤掉）
        self._tl = threading.local()

    def begin_task(self) -> None:
        """generate 每张展开开始时调：本线程下一次请求算这张的「第一次」（用 pending_first 预留的名额）"""
        self._tl.claimed = False

    def _post_once(self, body: dict, timeout: float) -> dict:
        with self._lock:
            first = not getattr(self._tl, "claimed", True)
            if self.max_calls is not None and (self.calls >= self.max_calls or (not first and self.calls + self.pending_first >= self.max_calls)):
                raise AIError("budget", f"已到本次调用上限 {self.max_calls} 次，不再发请求")
            if first:
                self._tl.claimed = True
                self.pending_first = max(0, self.pending_first - 1)
            self.calls += 1
        req = urllib.request.Request(self.base_url + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + self.api_key})
        try:
            with self._urlopen(req, timeout=timeout) as r:
                resp = json.loads(r.read().decode("utf-8"))
            self._log(body, resp)
            return resp
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
            self._log(body, {"http_status": e.code, "body": raw[:4000]})
            try:
                b = json.loads(raw)
            except Exception:
                b = {"error": {"message": raw[:300]}}
            err = b.get("error") if isinstance(b, dict) else None
            raise DeepSeekAPIError((err.get("message") if isinstance(err, dict) else None) or f"HTTP {e.code}", status_code=e.code, body=b) from None
        except (socket.timeout, TimeoutError) as e:
            raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
                raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
            raise DeepSeekAPIError(f"连不上 {self.base_url}：{getattr(e, 'reason', e)}", etype="APIConnectionError") from e
        except json.JSONDecodeError as e:
            raise DeepSeekAPIError(f"响应不是 JSON：{e}", etype="APIConnectionError") from e

    def _log(self, body: dict, resp: Any) -> None:
        """原样回包落盘（诊断模型错在哪）：请求只记模型 / max_tokens / 非系统消息（系统提示只记长度），不记请求头（密钥在头里）。写不了就算了。"""
        if not self.log_dir:
            return
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            msgs = body.get("messages") or []
            rec = {"ts": dt.datetime.now().isoformat(timespec="seconds"), "model": body.get("model"), "max_tokens": body.get("max_tokens"),
                   "system_chars": sum(len(m.get("content") or "") for m in msgs if m.get("role") == "system"),
                   "messages": [m for m in msgs if m.get("role") != "system"], "response": resp}
            name = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + f"-{threading.get_ident() % 10000:04d}.json"
            with open(os.path.join(self.log_dir, name), "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False, indent=1)
        except Exception:
            pass

    def _post(self, body: dict) -> dict:
        """429 / 5xx / 断连重试 1 次；超时不重试"""
        try:
            return self._post_once(body, self.TIMEOUT)
        except DeepSeekAPIError as e:
            if not (e.status_code in DS_RETRYABLE or e.etype == "APIConnectionError"):
                raise
            time.sleep(self.retry_sleep)
            return self._post_once(body, self.TIMEOUT)

    def _body(self, messages: list, max_tokens: int) -> dict:
        return {"model": self.model, "messages": messages, "max_tokens": max_tokens + (self.THINKING_EXTRA if self.thinking else 0), "stream": False,
                "thinking": {"type": "enabled" if self.thinking else "disabled"}, "response_format": {"type": "json_object"}}

    def _usage(self, resp: dict, ms: int) -> dict:
        u = resp.get("usage") or {}
        det = u.get("completion_tokens_details") or {}
        out = {"input": u.get("prompt_tokens"), "output": u.get("completion_tokens"), "cache_read": u.get("prompt_cache_hit_tokens"),
               "cache_miss": u.get("prompt_cache_miss_tokens"), "reasoning": det.get("reasoning_tokens"), "model": resp.get("model") or self.model,
               "request_id": resp.get("id"), "ms": ms, "finish_reason": ((resp.get("choices") or [{}])[0] or {}).get("finish_reason"), "peak": is_peak(), "calls": 1}
        out["cost_cny"] = estimate_cost_cny(out, self.model)
        return out

    def structured(self, system: str, user_text: str, post: Callable[[Any], tuple[dict, list, list]], max_tokens: int,
                   salvage: Callable[[Any, list], tuple[dict, list, list]] | None = None) -> dict:
        """一次结构化调用（含至多一次回喂重试）。post(data) → (data, fixes, errors)。
        没有回喂预算（第二次请求撞上调用上限）时：salvage(第一轮后处理过的 data, errors) 能本地救回（去掉出错的少数节点）就用它；
        救不回 → AIError(budget) 带上第一轮的 errors[:12] 与回包开头 sample，调用方写进 _steps[k].first_errors。"""
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user_text}]
        usage = None
        first_errors: list[str] = []
        first_data, first_text, first_fixes = None, "", []
        last: AIError | None = None
        for attempt in range(2):
            t0 = time.time()
            try:
                resp = self._post(self._body(messages, max_tokens))
            except AIError as e:  # 调用上限：带上已经花的、第一轮错在哪；能本地救回就不补位
                e.detail["usage"] = usage
                if attempt:
                    e.detail.update(errors=first_errors[:12], sample=first_text[:300])
                    if salvage is not None and first_data is not None:
                        d2, fx2, er2 = salvage(first_data, first_errors)
                        if not er2:
                            d2["_usage"], d2["_salvaged"], d2["_retry_errors"] = usage, True, first_errors[:12]
                            d2["_fixes"] = first_fixes + fx2
                            return d2
                raise
            u = self._usage(resp, int((time.time() - t0) * 1000))
            usage = _sum_usage(usage, u)
            choice = (resp.get("choices") or [{}])[0] or {}
            text = ((choice.get("message") or {}).get("content") or "").strip()
            fin = choice.get("finish_reason")
            if fin == "content_filter":
                raise AIError("refusal", "DeepSeek 的内容过滤拦下了这次输出", category="content_filter", usage=usage)
            if fin == "length":
                raise AIError("truncated", f"输出到 {u.get('output')} token 被截断（max_tokens={max_tokens}），JSON 不完整", usage=usage, sample=text[-200:])
            if not text:
                raise AIError("empty", f"模型没有返回内容（finish_reason={fin}）", usage=usage)
            repaired: list[str] = []
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                fixed = repair_json(text)
                data = None
                if fixed is None:
                    errors = [f"不是合法 JSON：{e}"]
                    last = AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300])
                else:
                    data, repaired = fixed
                    usage["repaired"] = True
            if data is not None:
                data, fixes, errors = post(data)
                if errors and not attempt:
                    first_data, first_fixes = copy.deepcopy(data), list(fixes)
                if repaired:
                    fixes = ["本地修 JSON：" + "、".join(repaired)] + fixes
                if not errors:
                    data["_usage"] = usage
                    if attempt:
                        data["_retried"], data["_retry_errors"] = True, first_errors[:8]
                    if fixes:
                        data["_fixes"] = fixes
                    return data
                last = AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors[:40], usage=usage, sample=text[:300])
            if attempt == 0:
                first_errors, first_text = errors, text
                messages = messages + [{"role": "assistant", "content": text},
                                       {"role": "user", "content": "上面的 json 有这些问题：\n" + "\n".join("- " + x for x in errors[:12]) + "\n改正后重新输出完整的 json（只输出 json）。"}]
        assert last is not None
        last.detail["usage"] = usage
        if salvage is not None and last.kind == "schema":  # 回喂后还不过：本地去掉出错的少数节点能过就用（不再整张重来，省两次调用）
            for d0, e0 in ((data, errors), (first_data, first_errors)):
                if d0 is not None and e0:
                    d2, fx2, er2 = salvage(copy.deepcopy(d0), e0)
                    if not er2:
                        d2["_usage"], d2["_salvaged"], d2["_retried"], d2["_retry_errors"] = usage, True, True, first_errors[:12]
                        d2["_fixes"] = fx2
                        return d2
        last.detail.setdefault("first_errors", first_errors[:12])
        raise last

    def ping(self) -> dict:
        t0 = time.time()
        body = {"model": self.model, "messages": [{"role": "user", "content": "只回复两个字母：ok"}], "max_tokens": 8, "stream": False, "thinking": {"type": "disabled"}}
        resp = self._post_once(body, 30.0)
        u = self._usage(resp, int((time.time() - t0) * 1000))
        text = (((resp.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        return {"ok": True, "model": resp.get("model") or self.model, "ms": u["ms"], "text": text, "usage": {"input": u["input"], "output": u["output"], "cost_cny": u["cost_cny"]}}


# ---------- Claude
CLAUDE_DEFAULT_MODEL = "claude-opus-5-5"
# 美元 / 百万 token（claude-api 技能：Opus 5.5 $4 / $20，缓存写 $5，缓存读 $0.20）
CLAUDE_PRICING = {"claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.20}}


def estimate_cost_usd(usage: dict | None, model: str | None = None) -> float | None:
    if not usage:
        return None
    key = next((k for k in CLAUDE_PRICING if (model or usage.get("model") or "").startswith(k)), None)
    if not key:
        return None
    p = CLAUDE_PRICING[key]
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    return round((n("input") * p["input"] + n("output") * p["output"] + n("cache_write") * p["cache_write"] + n("cache_read") * p["cache_read"]) / 1e6, 6)


class ClaudeClient:
    """官方 anthropic SDK。结构化输出 output_config.format（schema 发前经 api_schema 剥掉不支持的约束，回来后本地校验 + 夹取 + 小错修）；
    Opus 5.5 不传 thinking / 采样参数，深度只用 effort；默认开服务端 refusal fallback（beta 被拒就退回普通调用）；先看 stop_reason 再读内容。
    本机没有 Claude 密钥：这条路径只用假 client 测过（场景树是递归 schema，真机是否接受未验证）。"""

    name = "claude"
    fallback_beta_ok = True
    MAX_TOKENS = 16000

    def __init__(self, api_key: str, model: str = CLAUDE_DEFAULT_MODEL, timeout: float = 180.0, max_retries: int = 2):
        import anthropic  # 延迟导入：没装 / 没密钥时不影响服务启动
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)
        self.model = model or CLAUDE_DEFAULT_MODEL

    def _usage(self, resp: Any, ms: int) -> dict:
        u = getattr(resp, "usage", None)
        g = lambda k: getattr(u, k, None)  # noqa: E731
        out = {"input": g("input_tokens"), "output": g("output_tokens"), "cache_read": g("cache_read_input_tokens"), "cache_write": g("cache_creation_input_tokens"),
               "model": getattr(resp, "model", None), "stop_reason": getattr(resp, "stop_reason", None), "request_id": getattr(resp, "_request_id", None), "ms": ms,
               "fallback_used": any(getattr(it, "type", None) == "fallback_message" for it in (g("iterations") or [])), "calls": 1}
        out["cost_usd"] = estimate_cost_usd(out)
        return out

    def structured(self, system: str, user_text: str, schema: dict, post: Callable[[Any], tuple[dict, list, list]], effort: str) -> dict:
        a = self.anthropic
        kw = dict(model=self.model, max_tokens=self.MAX_TOKENS, system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                  messages=[{"role": "user", "content": user_text}], output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
        t0 = time.time()
        resp = None
        if type(self).fallback_beta_ok:
            try:
                resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
            except a.BadRequestError as e:
                body = getattr(e, "body", None)
                msg = (str((body.get("error") or {}).get("message")) if isinstance(body, dict) and isinstance(body.get("error"), dict) else "") + " " + str(e)
                if "anthropic-beta" not in msg.lower() and "fallback" not in msg.lower():
                    raise
                type(self).fallback_beta_ok = False
        if resp is None:
            resp = self.client.messages.create(**kw)
        usage = self._usage(resp, int((time.time() - t0) * 1000))
        stop = getattr(resp, "stop_reason", None)
        if stop == "refusal":
            sd = getattr(resp, "stop_details", None)
            cat, expl = getattr(sd, "category", None), getattr(sd, "explanation", None)
            raise AIError("refusal", "模型拒绝了这个请求" + (f"（类别 {cat}）" if cat else "") + (f"：{expl}" if expl else ""), category=cat, explanation=expl, usage=usage)
        text = next((b.text for b in (getattr(resp, "content", None) or []) if getattr(b, "type", None) == "text"), "")
        if stop == "max_tokens":
            raise AIError("truncated", f"输出到 {usage.get('output')} token 被截断（max_tokens={self.MAX_TOKENS}），JSON 不完整", usage=usage, sample=text[-200:])
        if not text:
            raise AIError("empty", f"模型没有返回文本块（stop_reason={stop}）", usage=usage)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300]) from e
        data, fixes, errors = post(data)
        if errors:
            raise AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors[:40], usage=usage)
        data["_usage"] = usage
        if fixes:
            data["_fixes"] = fixes
        return data


# ============================================================ 7. 配置、错误
PROVIDERS = ("anthropic", "deepseek")
PROVIDER_LABEL = {"anthropic": "Claude", "deepseek": "DeepSeek", "mock": "模拟"}
PROVIDER_DEFAULTS = {
    "anthropic": {"api_key": "", "model": CLAUDE_DEFAULT_MODEL},
    "deepseek": {"api_key": "", "model": DS_DEFAULT_MODEL, "base_url": DS_DEFAULT_BASE_URL, "thinking": False},
}
MODEL_CHOICES = {"anthropic": ["claude-opus-5-5", "claude-sonnet-5-5"], "deepseek": list(DS_MODELS)}
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}


def _read_raw() -> dict:
    try:
        with open(config_path(), encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _normalize(raw: dict) -> dict:
    """文件里的配置 → 规范结构。旧的扁平 {api_key, model} 归到 anthropic。"""
    provs = {p: dict(PROVIDER_DEFAULTS[p]) for p in PROVIDERS}
    for p, v in (raw.get("providers") or {}).items():
        if p in provs and isinstance(v, dict):
            provs[p].update({k: x for k, x in v.items() if x is not None and k != "key_source"})
    if raw.get("api_key") and not provs["anthropic"]["api_key"]:
        provs["anthropic"]["api_key"] = raw["api_key"]
    if raw.get("model") and "providers" not in raw:
        provs["anthropic"]["model"] = raw["model"]
    prov = raw.get("provider")
    if prov not in PROVIDERS:
        prov = "anthropic" if provs["anthropic"]["api_key"] else "deepseek"
    return {"provider": prov, "mock": bool(raw.get("mock")), "providers": provs}


def load_config() -> dict:
    """规范配置 + 环境变量补的密钥（key_source=env）+ 当前服务商的扁平镜像"""
    cfg = _normalize(_read_raw())
    for p, pc in cfg["providers"].items():
        pc["key_source"] = "config" if pc.get("api_key") else ""
        if not pc.get("api_key") and os.environ.get(ENV_KEYS[p]):
            pc["api_key"], pc["key_source"] = os.environ[ENV_KEYS[p]], "env"
    cur = cfg["providers"][cfg["provider"]]
    cfg.update({"api_key": cur.get("api_key", ""), "model": cur.get("model"), "thinking": bool(cur.get("thinking")), "base_url": cur.get("base_url"), "key_source": cur.get("key_source", "")})
    return cfg


def save_config(patch: dict) -> dict:
    """patch：{provider?, mock?, providers?: {p: {api_key?, model?, thinking?, base_url?}}}，也收扁平 {api_key?, model?, thinking?}（写给当前服务商）。
    api_key 给空串 = 清除。只写文件里的值，不把环境变量里的密钥写回。"""
    cfg = _normalize(_read_raw())
    if patch.get("provider") in PROVIDERS:
        cfg["provider"] = patch["provider"]
    if patch.get("mock") is not None:
        cfg["mock"] = bool(patch["mock"])
    per = {p: dict(v) for p, v in (patch.get("providers") or {}).items() if p in PROVIDERS and isinstance(v, dict)}
    flat = {k: patch[k] for k in ("api_key", "model", "thinking", "base_url") if k in patch and patch[k] is not None}
    if flat:
        per.setdefault(cfg["provider"], {}).update(flat)
    for p, v in per.items():
        pc = cfg["providers"][p]
        if v.get("api_key") is not None:
            pc["api_key"] = str(v["api_key"]).strip()
        if v.get("model"):
            pc["model"] = str(v["model"]).strip()
        if v.get("thinking") is not None and p == "deepseek":
            pc["thinking"] = bool(v["thinking"])
        if v.get("base_url") and p == "deepseek":
            pc["base_url"] = str(v["base_url"]).strip()
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return load_config()


def key_hint(key: str) -> str:
    """打码：只露前缀与末 4 位"""
    if not key:
        return ""
    if len(key) <= 12:
        return "已设置"
    return (key[:7] if key.startswith("sk-ant-") else key[:3]) + "…" + key[-4:]


def public_config() -> dict:
    """给前端看的配置：绝不含密钥明文"""
    cfg = load_config()
    provs = {}
    for p, pc in cfg["providers"].items():
        provs[p] = {"has_key": bool(pc.get("api_key")), "key_hint": key_hint(pc.get("api_key") or ""), "model": pc.get("model"), "key_source": pc.get("key_source", ""), "models": MODEL_CHOICES[p]}
        if p == "deepseek":
            provs[p]["thinking"] = bool(pc.get("thinking"))
    cur = provs[cfg["provider"]]
    return {"provider": cfg["provider"], "provider_label": PROVIDER_LABEL[cfg["provider"]], "mock": bool(cfg["mock"]) or not cur["has_key"], "mock_forced": bool(cfg["mock"]),
            "has_key": cur["has_key"], "key_hint": cur["key_hint"], "model": cur["model"], "key_source": cur["key_source"], "thinking": bool(cur.get("thinking")), "providers": provs}


def config_for(provider: str, cfg: dict | None = None) -> dict:
    """同一份配置换个服务商看（评测脚本 --provider 用）"""
    cfg = dict(cfg or load_config())
    if provider not in PROVIDERS:
        raise ValueError(f"未知服务商 {provider}，可选 {PROVIDERS}")
    pc = cfg["providers"][provider]
    cfg.update({"provider": provider, "api_key": pc.get("api_key", ""), "model": pc.get("model"), "thinking": bool(pc.get("thinking")), "base_url": pc.get("base_url"), "key_source": pc.get("key_source", "")})
    return cfg


def api_error_types() -> tuple:
    try:
        import anthropic
        return (anthropic.APIError, DeepSeekAPIError)
    except Exception:
        return (DeepSeekAPIError,)


CLAUDE_HINTS = {400: "请求被 API 拒绝：多半是参数或 schema 的问题，把 message 原文发给开发者", 401: "密钥无效、已撤销或格式不对：到 AI 设置里重新粘贴",
                402: "账户计费问题：到 console.anthropic.com 看余额 / 付款方式", 403: "这把密钥没有权限用这个模型或功能",
                404: "模型名不存在或不可用：检查 AI 设置里的模型名（默认 claude-opus-5-5）", 413: "请求过大", 429: "触发限流：等几十秒再试",
                500: "Anthropic 服务异常：稍后重试", 529: "Anthropic 过载：稍后重试"}
DS_HINTS = {400: "请求格式错误：把 message 原文发给开发者", 401: "DeepSeek 密钥无效：到 AI 设置里重新粘贴", 402: "DeepSeek 余额不足：到 platform.deepseek.com 充值",
            422: "参数错误：多半是模型名不对（默认 deepseek-flash）", 429: "请求太频繁：等几十秒再试", 500: "DeepSeek 服务异常：稍后重试", 503: "DeepSeek 繁忙：稍后重试"}
RETRYABLE = {408, 409, 429, 500, 502, 503, 529}


def error_payload(e: Exception) -> dict:
    """服务商的 HTTP / 网络错误 → 前端能诊断的 JSON：状态码、类型、request_id、能否重试、一句中文提示"""
    status = getattr(e, "status_code", None)
    body = getattr(e, "body", None)
    provider = getattr(e, "provider", None) or "anthropic"
    err = body.get("error") if isinstance(body, dict) else None
    etype = err.get("type") if isinstance(err, dict) else None
    if provider == "deepseek" and not etype:
        etype = getattr(e, "etype", None)
    is_timeout = type(e).__name__ == "APITimeoutError" or etype == "APITimeoutError"
    is_conn = status is None
    msg = getattr(e, "message", None) or str(e)
    if provider == "deepseek":
        bad_model = status in (400, 404, 422) and "model" in msg.lower()
        hint = ("模型名不对：检查 AI 设置里的模型名（默认 deepseek-flash）" if bad_model else DS_HINTS.get(status)) \
            or ("等太久没回：再试一次" if is_timeout else "连不上 api.deepseek.com：检查网络 / 代理" if is_conn else "")
    else:
        hint = CLAUDE_HINTS.get(status) or ("等太久没回：再试一次或降低 effort" if is_timeout else "连不上 api.anthropic.com：检查网络 / 代理" if is_conn else "")
    return {"error": "ai", "provider": provider, "message": msg, "status": status, "type": etype or type(e).__name__,
            "request_id": getattr(e, "request_id", None), "retryable": is_conn or status in RETRYABLE, "hint": hint}


def test_key(payload: dict) -> dict:
    """POST /api/config/test：按服务商发一条最短请求。可带 provider / api_key / model 测还没保存的密钥。"""
    cfg = load_config()
    prov = payload.get("provider") if payload.get("provider") in PROVIDERS else cfg["provider"]
    pc = cfg["providers"][prov]
    key = (payload.get("api_key") or pc.get("api_key") or "").strip()
    model = (payload.get("model") or pc.get("model") or "").strip()
    if not key:
        return {"ok": False, "provider": prov, "message": "没有密钥"}
    try:
        if prov == "deepseek":
            return {"provider": prov, **DeepSeekClient(key, model or DS_DEFAULT_MODEL, pc.get("base_url") or DS_DEFAULT_BASE_URL).ping()}
        import anthropic
        client = anthropic.Anthropic(api_key=key, timeout=30.0, max_retries=0)
        t0 = time.time()
        resp = client.messages.create(model=model or CLAUDE_DEFAULT_MODEL, max_tokens=256, output_config={"effort": "low"}, messages=[{"role": "user", "content": "只回复两个字母：ok"}])
        if resp.stop_reason == "refusal":
            return {"ok": False, "provider": prov, "message": "模型拒绝了测试请求（stop_reason=refusal）", "model": resp.model}
        text = "".join(b.text for b in resp.content if b.type == "text")
        return {"ok": True, "provider": prov, "model": resp.model, "ms": int((time.time() - t0) * 1000), "text": text,
                "usage": {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}}
    except api_error_types() as e:
        p = error_payload(e)
        return {**p, "ok": False, "provider": prov, "message": (p["hint"] + "（" + p["message"] + "）") if p["hint"] else p["message"]}


# ============================================================ 概念 → 场景程序（模拟 AI 的配方与补位）
PALETTES = {
    "arcane": [("roof", "#3b3f8f"), ("wall", "#d9d2c3"), ("stone", "#6e6a7c"), ("foliage", "#4f7a5a"), ("mist", "#b9c4ff")],
    "sea": [("roof", "#8a3b2e"), ("wall", "#c9b58f"), ("stone", "#5f5a52"), ("foliage", "#4d7a4f"), ("mist", "#a9cbd6")],
    "desert": [("roof", "#b9783e"), ("wall", "#e2c48f"), ("stone", "#a8865c"), ("foliage", "#7b8a4a"), ("mist", "#f0d9a8")],
    "neon": [("roof", "#2a2a3a"), ("wall", "#3d3f55"), ("stone", "#24252e"), ("foliage", "#3f6f5f"), ("mist", "#ff4fd8")],
    "garden": [("roof", "#5e7f9e"), ("wall", "#f1ece0"), ("stone", "#9a9488"), ("foliage", "#5fa060"), ("mist", "#dff0ff")],
    "village": [("roof", "#4a3a2e"), ("wall", "#b89a74"), ("stone", "#7b746a"), ("foliage", "#4f7a3e"), ("mist", "#c9d4d8")],
    "stone": [("roof", "#5a4a3e"), ("wall", "#a39a8a"), ("stone", "#6b655c"), ("foliage", "#566b3e"), ("mist", "#c4c8cc")],
}


def palette(key: str) -> list:
    """色板按 schema 的 palette 项格式（{role, hex} 或 {role, color}）"""
    it = item_schema("palette") or {}
    props = it.get("properties") or {}
    hk = "hex" if "hex" in props or not props else next((k for k in props if k != "role"), "hex")
    rk = "role" if "role" in props or not props else next(iter(props))
    return [{rk: r, hk: h} for r, h in PALETTES.get(key, PALETTES["stone"])]


def compose(recipe: dict, cons: dict | None = None, time_of_day: str | None = None) -> dict:
    """配方 {name, concept, frags: [主, 次…], ground, size, palette, mood, extra_terrain?} → 场景程序。
    第一个片段锚 site.center，往后的地下 / 围合片段锚主体，其余锚场地上没用过的方位；出生点在南边看主体。"""
    S = int(recipe.get("size") or 220)
    p: dict = {"name": recipe["name"][:10], "concept": recipe.get("concept", ""), "site": {"size_m": [S, S], "ground": recipe.get("ground") or "flat"},
               "terrain": [], "nodes": []}
    main = None
    for t in recipe.get("terrain") or []:
        p["terrain"].append({**copy.deepcopy(t), "id": new_id(p, t.get("id") or t.get("op") or "t")})
    if recipe.get("frags_after"):  # 补位：主体是按概念搭的组，片段只作配角（锚到主体或空方位）
        for n in recipe.get("extra_nodes") or []:
            p["nodes"].append({**copy.deepcopy(n), "id": new_id(p, n.get("id") or n.get("type") or "n")})
        main = main_id(p)
    for k, key in enumerate(recipe.get("frags") or []):
        f = FRAG[key]
        if recipe.get("frags_after"):
            anchor = main if key in ("underground_hall", "maze_space", "wall_gate", "sky_islands") and main else f"site.{_free_dir(p)}"
        elif k == 0:
            anchor = recipe.get("at0") or "site.center"
        elif key in ("underground_hall", "maze_space", "wall_gate") and main:
            anchor = main
        elif key == "sky_islands" and main:
            anchor = main
        else:
            anchor = f"site.{_free_dir(p)}"
        terr, nodes, mid = instantiate(p, key, anchor)
        p["terrain"] += terr
        p["nodes"] += nodes
        main = main or mid
        if k == 0 and f.get("ground") and not recipe.get("ground"):
            p["site"]["ground"] = f["ground"]
    for t in recipe.get("extra_terrain") or []:
        p["terrain"].append({**copy.deepcopy(t), "id": new_id(p, t.get("op") or "t")})
    for n in ([] if recipe.get("frags_after") else recipe.get("extra_nodes") or []):
        p["nodes"].append({**copy.deepcopy(n), "id": new_id(p, n.get("id") or n.get("type") or "n")})
    for n in all_nodes(p):  # 片段里的通用名换成这个题材的名字
        lab = n.get("label")
        if lab in (recipe.get("rename") or {}):
            n["label"] = recipe["rename"][lab]
    main = main or main_id(p)
    p["spawn"] = {**(recipe.get("spawn") or {"at": "site.S"}), **({"look_at": main} if main else {})}
    if main:
        p["relations"] = [{"type": "visible_from", "a": main, "b": "spawn"}, {"type": "reachable", "a": "spawn", "b": main}]
    p["palette"] = palette(recipe.get("palette") or "stone")
    p["lighting"] = {"time_of_day": time_of_day or recipe.get("time") or "afternoon"}
    p["mood"] = list(recipe.get("mood") or ["开阔"])[:4]
    if not p["terrain"]:
        del p["terrain"]
    if cons:
        p, _ = enforce(p, cons)
    return p


# 概念里的词 → 片段：补位只借「说到具体结构」的片段（金字塔、码头、窄巷…）；浮岛 / 迷宫 / 地下厅按概念自己搭，不借。(词, 片段, 还要出现的词)
FRAG_WORDS = [
    (("金字塔",), "step_pyramid", ()), (("码头", "港池", "防波堤"), "harbor", ("港", "海")), (("栈道", "峡湾"), "canyon_walk", ("峡", "崖")),
    (("窄巷", "叠楼"), "narrow_lane", ()), (("湖心岛", "湖心阁", "湖心亭"), "lake_isle", ()), (("瀑布",), "waterfall_steps", ()),
    (("台地", "梯田", "村落"), "terraced_village", ()), (("城堡", "孤崖", "主堡"), "cliff_keep", ()), (("城墙", "围墙"), "wall_gate", ()),
]
SKY_WORDS = ("空中", "天空", "云上", "云端", "天上", "悬空", "浮空", "悬浮", "云海", "凌空", "半空")
_NUM = r"([一二两三四五六七八九十]{1,3}|\d{1,3})\s*([座根个栋条道块处间尊层圈株段节列排组盏艘扇级口片棵])"
_NOUN = "塔楼柱像岛洲摊档棚门厅殿堂房屋井台桥阶梯笼灯池亭廊龛室窟仪球环圈船墙碑园树林架站堤道"
_RING_WORDS = ("首尾相接", "围成", "环形", "一圈", "圆环", "环状", "环线", "成环")
_UNDER_WORDS = ("地下", "地底", "岩腔", "暗河", "洞窟", "学窟", "地窟", "矿脉", "地宫", "溶洞", "岩洞", "地窖", "密室")
_FLOAT_WORDS = ("悬浮", "悬空", "浮空", "空中", "凌空", "漂浮", "垂下", "吊在")


def _cn_int(t: str) -> int:
    if t.isdigit():
        return int(t)
    if t in CN_NUM:
        return CN_NUM[t]
    if "十" in t:  # 十二 / 四十 / 二十四
        a, _, b = t.partition("十")
        return (CN_NUM.get(a, 1) if a else 1) * 10 + (CN_NUM.get(b, 0) if b else 0)
    return 0


def _qty(t: str) -> tuple[int, str]:
    """「七段首尾相接…」→ (7, 段)；没写数量 → (0, "")"""
    m = re.search(_NUM, t)
    if not m or (m.group(2) == "圈" and _cn_int(m.group(1)) == 1):  # 「一圈」是排法，不是数量
        return 0, m.group(2) if m else ""
    return max(1, min(48, _cn_int(m.group(1)))), m.group(2)


def _short_label(k: str) -> str:
    """「中央立着被沙埋到半身的沙岩神像」→「沙岩神像」：取第一个分句里最后一个「的」后面的名词，去掉数量；
    「十二根残柱夹出的中轴大道」→「残柱」：数量后面紧跟的是个结构名词时取它（「两列错接的雨棚摊档」的「错接」不是，取「雨棚摊档」）"""
    k1 = re.split(r"[，,；;：:（(]", k)[0] or k
    m = re.search(_NUM, k1)
    if m and _cn_int(m.group(1)) > 1:
        noun = re.split(r"[的夹围环沿排组成]", k1[m.end():])[0][:6]
        if len(noun) >= 2 and any(ch in _NOUN for ch in noun):
            return noun
    tail = k1.rsplit("的", 1)[-1] if "的" in k1 else k1
    tail = re.sub(_NUM, "", tail).strip() or k1
    return (tail if len(tail) >= 2 else k1)[:12]


_LINK_HEADS = ("桥", "栈道", "飞廊", "索道", "小径", "参道", "步道", "山道", "坡道", "通道")
_STRIP_WORDS = ("堤", "甬道", "中轴路", "中轴道", "中轴大道", "长廊道")


def _is_strip(k: str) -> bool:
    """长堤 / 堤道 / 中轴甬道：沿中轴铺开的一条长台面（不是一栋楼，也不只是一条路）。看中心词（「堤中段的穹顶大讲堂」是讲堂）"""
    h = _short_label(k)
    return any(w in h for w in _STRIP_WORDS) or ("中轴" in k and "栈道" in h)


def _is_link(k: str) -> bool:
    """中心词是桥 / 栈道 / 小径…才是连接（「桥侧外挂的吊笼摊」「高架桥面主摊台」「桥墩下的小吃摊」是摊，不是桥）"""
    h = _short_label(k)
    return any(w in h for w in _LINK_HEADS) and not any(w in h for w in ("桥面", "桥墩", "高架", "摊", "台", "柱", "像", "楼"))


# 中心词 → 形体类别：一句话里**最后出现**的类别词说了算（「塔基一圈附属见习生小屋」是屋，「高架桥面主摊台」是台，「弧形塔楼」的「塔楼」比「楼」长）
_CATS = [(("串灯", "灯笼", "旗", "管线", "电缆", "钢索", "藤蔓", "绳"), "detail"), (("栏", "墙", "垣", "篱", "城垛"), "wall"), (("塔", "塔楼"), "tower"),
         (("梯", "台阶"), "stairs"), (("井",), "shaft"), (("仪", "星象", "天球", "球"), "sphere"), (("圈", "环", "光环", "圆环"), "torus"), (("岛", "洲"), "island"),
         (("园", "花", "圃", "林"), "garden"), (("摊台",), "deck"), (("摊", "档", "铺", "食肆"), "stall"), (("棚",), "shed"), (("笼",), "cage"),
         (("台", "广场", "坛", "庭"), "platform"), (("柱",), "column"), (("拱", "拱门"), "arch"), (("门", "牌坊", "牌楼"), "gate"), (("像", "雕"), "statue"),
         (("碑", "方尖"), "obelisk"), (("池", "泉", "渠", "水井", "水镜"), "water"), (("晶",), "crystal"), (("树", "木"), "tree"), (("船",), "boat"),
         (("架", "招牌"), "frame"), (("廊",), "gallery"), (("龛",), "niche"), (("厅", "堂", "殿", "馆", "阁", "宫", "院", "所", "楼", "屋", "房", "室"), "hall")]


def _cat(h: str) -> str | None:
    best, bk = None, (-1, 0)
    for ws, cat in _CATS:
        for w in ws:
            j = h.rfind(w)
            if j >= 0 and (j + len(w), len(w)) > bk:
                best, bk = cat, (j + len(w), len(w))
    return best


def _form_of(w: str, i: int) -> dict:
    """关键结构的一句话 → 一个形体模板（看中心词挑形体，尺寸按真实世界）。_stack / _arc 是给主体用的提示（中空塔 / 弧形段）"""
    big, cat = i == 0, _cat(_short_label(w))
    if cat == "tower":
        if any(x in w for x in ("中空", "空心")):
            return {"type": "cylinder", "hollow": True, "size_m": [26, 7], "_stack": True}
        if any(x in w for x in ("弧", "段")):
            return {"type": "box", "size_m": [24, 22, 12], "_arc": True}
        return {"type": "tower", "size_m": [10 if big else 7, 34 if big else 22], "roof": "spire" if any(x in w for x in ("尖", "法师")) else "cone"}
    if cat == "stairs":
        return {"type": "stairs", "shape": "cylinder", "size_m": [10, 16]} if "螺旋" in w else {"type": "stairs", "size_m": [5, 6, 10]}
    if cat == "shaft":
        deep = any(x in w for x in ("升降", "贯穿", "通天"))
        return {"type": "cylinder", "hollow": True, "size_m": [8 if deep else 12, 40 if deep else 8]}
    if cat == "garden":
        return {"type": "platform", "size_m": [34 if big else 22, 2, 34 if big else 22],
                "children": [{"type": "grove", "label": "花木", "size_m": [24 if big else 16, 24 if big else 16], "density": 1.1}]}
    if cat == "stall":
        return {"type": "building", "size_m": [7, 3.5, 5], "roof": "gable" if "棚" in w else "flat"}
    if cat == "hall" or cat is None:
        roof = "dome" if any(k in w for k in ("穹", "圆顶", "钟")) else "spire" if "尖" in w else "flat" if any(k in w for k in ("下沉", "沙", "窟", "坑")) else "hip"
        small = "小" in w or not big
        return {"type": "building", "size_m": [14, 9, 12] if small else [30, 16, 22], "roof": roof}
    return copy.deepcopy({
        "detail": {"type": "detail"}, "wall": {"type": "wall", "around": "main", "wall_h_m": 3, "thickness_m": 1.5},
        "sphere": {"type": "sphere", "size_m": [16 if big else 12]}, "torus": {"type": "torus", "size_m": [40, 3], "thickness_m": 2},
        "island": {"type": "island", "size_m": [30 if big else 20, 10, 30 if big else 20], "elev_m": 30}, "deck": {"type": "platform", "size_m": [20, 1.5, 24]},
        "shed": {"type": "building", "size_m": [12, 5, 8], "roof": "gable"}, "cage": {"type": "box", "size_m": [5, 4, 5]},
        "platform": {"type": "platform", "size_m": [24 if big else 16, 3, 24 if big else 16]}, "column": {"type": "column", "size_m": [2.4, 10]},
        "arch": {"type": "arch", "size_m": [16, 12, 4]}, "gate": {"type": "gate", "size_m": [16, 12, 6]}, "statue": {"type": "statue", "size_m": [5, 12, 5]},
        "obelisk": {"type": "prism", "sides": 4, "size_m": [3, 20]}, "water": {"type": "water", "size_m": [14, 14]}, "crystal": {"type": "crystal", "size_m": [5, 14, 5]},
        "tree": {"type": "tree", "size_m": [12, 18]}, "boat": {"type": "box", "size_m": [8, 6, 26]}, "frame": {"type": "box", "size_m": [24, 3, 1.2]},
        "gallery": {"type": "building", "size_m": [20, 5, 6], "roof": "flat"}, "niche": {"type": "box", "size_m": [4, 4, 3]}}[cat])


def _terrain_of(idea: str, ground: str, ring_r: float = 0, fit_r: float = 0) -> list[dict]:
    """只看 terrain_idea 雕地形（抬起 / 坑 / 环形岛 / 湖 / 峡谷 / 沙丘）；关键结构里的「一圈」「环绕」是排法，不出环形地形。
    ring_r = 主体成环的半径（坑在环里、环形岛托着环）；fit_r = 主体组的外沿半径（台顶要放得下）"""
    if ground == "sky":  # 没有地面：只有「抬起」有意义（从云海里升起一根岩柱 / 高台）
        if any(w in idea for w in ("抬", "升起", "隆起", "高台", "台基", "岩柱", "峰", "石柱")):
            return [{"op": "raise", "id": "rise", "label": "云中高台", "at": "site.center", "shape": "circle", "size_m": [120, 120], "height_m": 48, "edge": "cliff"}]
        return []
    ops: list[dict] = []
    if any(w in idea for w in ("峡谷", "裂谷", "深沟", "沟壑")):
        ops.append({"op": "carve", "id": "gorge", "label": "峡谷", "shape": "line", "from": "site.N", "to": "site.S", "width_m": 26, "depth_m": 20, "edge": "cliff"})
    if any(w in idea for w in ("湖", "水面", "潭")) and ground != "lake":
        ops.append({"op": "lake", "id": "pond", "label": "湖", "at": "site.center", "shape": "circle", "size_m": [170, 170], "depth_m": 5})
    pit = any(w in idea for w in ("坑", "凹", "漏斗", "盆地", "洼", "下沉"))
    stepped = any(w in idea for w in ("台阶", "层层", "阶梯", "一级级"))
    if pit:
        d = max(30, round(2 * ring_r - 44)) if ring_r else 90  # 环形主体中间下沉：坑在环里面
        ops.append({"op": "lower", "id": "pit", "label": "坑", "at": "site.center", "shape": "circle", "size_m": [d, d], "depth_m": 14,
                    "edge": "terraced" if stepped else "slope", **({"steps": 4} if stepped else {})})
    if "环形" in idea and any(w in idea for w in ("岛", "堤", "台", "石", "岩", "丘")):  # 地形本身就说成环（环形石岛）
        dd = round(max(80, 2 * ring_r + 10)) if ring_r else 120
        ops.append({"op": "raise", "id": "ring_isle", "label": "环形石岛", "at": "site.center", "shape": "ring", "size_m": [dd, dd], "ring_m": 26, "height_m": 6, "edge": "slope"})
    elif not pit and any(w in idea for w in ("抬", "升起", "隆起", "高台", "台基", "崖", "岩柱", "山丘", "脊", "峰", "孤丘", "拔起")):
        if "脊" in idea:
            ops.append({"op": "raise", "id": "rise", "label": "脊", "at": "site.center", "shape": "rect", "size_m": [44, 170], "height_m": 18, "edge": "slope"})
        elif any(w in idea for w in ("崖", "柱", "峰")):
            d = max(60, round(2 * fit_r + 12))
            ops.append({"op": "raise", "id": "rise", "label": "崖柱" if "柱" in idea else "崖台", "at": "site.center", "shape": "circle", "size_m": [d, d], "height_m": 30, "edge": "cliff"})
        else:
            d = max(90, round(2 * fit_r + 30))
            ops.append({"op": "raise", "id": "rise", "label": "高台", "at": "site.center", "shape": "circle", "size_m": [d, d], "height_m": 16, "edge": "slope"})
    if ground == "desert" and not any(o["op"] == "dune" for o in ops):
        ops.append({"op": "dune", "id": "dunes", "label": "沙丘", "at": "site.center", "shape": "rect", "size_m": [220, 220], "amplitude_m": 3, "scale_m": 30})
    return ops[:4]


def _half(t: dict) -> float:
    s = t.get("size_m") or [8]
    s = s if isinstance(s, list) else [s]
    return max(s[0], s[2] if len(s) >= 3 else s[0]) / 2


def _main_of(k: str, ring: bool) -> tuple[dict, float]:
    """第一条关键结构 → 主体节点（不带 id / at）与外沿半径：「七段首尾相接的弧形塔楼」= 7 段沿圆周首尾相接（radial + 切向的段）；
    「中空主塔」= 叠层的空心圆柱、每层一圈外环（stack + torus）；「环形站台摊档带」= 一圈台面段、段上立摊；其余 = 这条结构自己的形体"""
    t, (n, unit), lab = _form_of(k, 0), _qty(k), _short_label(k)
    if t["type"] in ("detail", "wall"):
        t = {"type": "building", "size_m": [22, 14, 18], "roof": "hip"}
    if lab.endswith(("环", "圈")) and _cat(lab[:-1]) not in (None, "torus"):  # 「断柱环」= 一圈断柱，不是一个环
        t, ring, n = _form_of(lab[:-1], 1), True, n or 12
    stack, arc = t.pop("_stack", False), t.pop("_arc", False)
    if stack:
        lv = n if unit == "层" and n > 1 else 6
        lvl = {**t, "label": lab + "层", "children": [{"type": "torus", "label": "层环", "size_m": [t["size_m"][0] + 8, 1.6], "thickness_m": 3}]}
        return {"type": "repeat", "pattern": "stack", "levels": min(lv, 10), "taper": 0.05, "label": lab, "child": lvl}, t["size_m"][0] / 2 + 6
    if arc or (ring and n > 1):
        cnt = n if n > 1 else 8
        R = round(max(28, cnt * 6.5), 1)
        seg = {**t, "label": lab, "size_m": [round(2 * math.pi * (R - 6) / cnt * 0.95, 1), (t.get("size_m") or [0, 22])[1], 12]} if t["type"] in ("box", "building") else {**t, "label": lab}
        return {"type": "repeat", "pattern": "radial", "count": cnt, "radius_m": R, "start_deg": 180, "face": "center", "label": lab, "child": seg}, R + 8
    u = {a: b for a, b in _form_of(k, 1).items() if not a.startswith("_")}  # 小一号的它（成组时的单个）
    if u["type"] in ("detail", "wall"):
        u = {"type": "building", "size_m": [14, 9, 12], "roof": "hip"}
    if any(w in k for w in ("网格", "棋盘", "方阵")):  # 「棚屋平台网格」：网格排开
        sp = round(_half(u) * 2 + 8)
        return {"type": "repeat", "pattern": "grid", "rows": 3, "cols": 4, "spacing_m": sp, "label": lab, "child": {**u, "label": lab}}, sp * 2 + 8
    if not ring and (n > 1 or any(w in k for w in ("链", "串", "一排", "一列", "一线"))):  # 「园岛链」：一串小一号的它，从南往北（第 0 个在南边，出生点先到它）
        cnt = min(n, 8) if n > 1 else 5
        sp = round(_half(u) * 2 + 10)
        if any(w in k for w in ("夹", "两侧", "两旁", "对列")):  # 「十二根残柱夹出的中轴大道」：两排对称
            return {"type": "repeat", "pattern": "mirror", "axis": "x", "label": lab, "child": {"type": "repeat", "pattern": "linear", "axis": "z", "count": max(2, cnt // 2),
                    "spacing_m": sp, "offset_m": [-round(_half(u) + 6), 0], "child": {**u, "label": lab}}}, sp * cnt / 4 + 8
        return {"type": "repeat", "pattern": "linear", "axis": "z", "count": cnt, "spacing_m": sp, "rotate_deg": 180, "label": lab, "child": {**u, "label": lab}}, sp * cnt / 2 + 6
    if ring:
        R, cnt = 44.0, 14
        band = {"type": "platform", "label": "环形台面", "size_m": [round(2 * math.pi * (R - 6) / cnt * 0.92, 1), 1.2, 12], "children": [{**t, "label": lab}]}
        return {"type": "repeat", "pattern": "radial", "count": cnt, "radius_m": R, "start_deg": 180, "face": "center", "label": lab, "child": band}, R + 8
    return {**t, "label": lab}, _half(t) + 4


def recipe_from_concept(c: dict) -> dict:
    """真模型给的概念 → 配方（真模型的展开没写成时的补位）。不套预设：
    主体 = 第一条关键结构（「七段首尾相接」→ 7 段成环，「中空高塔」→ 叠层空心塔）；其余逐条按词挑放法：
    顶上 / 中央 / 一圈（排法，不出环形地形）/ 两列 / 外挂 / 桥下 / 跨头顶 / 一排 / 散布 / 悬浮（只抬它自己）；
    地下的概念把地下的结构写成一个空间的房间；地形只看 terrain_idea；只有说到具体结构（金字塔、码头…）才借片段。"""
    keys = [str(k) for k in (c.get("key_structures") or []) if str(k).strip()][:5] or [str(c.get("name") or "主体")]
    concept, idea, name = str(c.get("concept") or ""), str(c.get("terrain_idea") or ""), str(c.get("name") or "")
    text = " ".join([concept, " ".join(keys), idea, name])
    plain = text.replace("云海", "云")
    sky = any(w in text for w in SKY_WORDS)
    ground = ("sky" if sky and any(w in text for w in ("没有地面", "云海", "无地面")) else "lake" if "湖心" in plain
              else "coast" if any(w in plain for w in ("海", "港")) else "desert" if "沙" in plain else "canyon" if "峡谷" in plain else None)
    under = ground != "sky" and any(w in concept + name + idea for w in _UNDER_WORDS + ("迷宫", "往地下", "地下"))
    ring = any(w in concept + keys[0] for w in _RING_WORDS)
    parts = [x for x in re.split(r"[与和及]", keys[0]) if len(x) >= 2] if under else [keys[0]]
    main, outer = _main_of(parts[0], ring)
    main_elev = 14 if any(w in keys[0] for w in ("高架", "桥面", "悬空", "空中", "凌空")) else 0
    if main_elev and main.get("type") == "platform":
        main["size_m"] = [20, 1.5, 120]
    kids: list = [{"id": "main", "role": "landmark", **main, **({"elev_m": main_elev} if main_elev else {})}]
    ring_r = main.get("radius_m") or 0 if main.get("pattern") == "radial" else 0
    tids = [t["id"] for t in _terrain_of(idea, ground or "", ring_r)]  # 先看有哪些地形（放法要知道），尺寸等排完再定
    to_main = "main[0]" if main.get("type") == "repeat" and main.get("pattern") != "stack" else "main"  # 成环 / 成串的主体：第 0 个在南边，路通到它
    far = outer  # 往北排的东西（两列 / 跨头顶）排到哪了：「巷底」放在最里头
    roots: list = []
    rooms: list = [_short_label(x) for x in parts[1:]]
    long_side = main.get("type") == "platform" and (main.get("size_m") or [0, 0, 0])[-1] >= 60  # 长条主体（高架桥面）：两侧外挂、桥下、跨头顶
    side_d = (main["size_m"][0] / 2 if long_side else outer)
    singles: list = []
    if main_elev and long_side:  # 高架：两排桥墩撑着（中间留出桥下的空当）
        kids.append({"id": "piers", "type": "repeat", "pattern": "mirror", "axis": "x", "label": "桥墩", "child": {
            "type": "repeat", "pattern": "linear", "axis": "z", "count": 5, "spacing_m": 28, "offset_m": [7, 0], "child": {"type": "column", "label": "桥墩", "size_m": [2.5, main_elev]}}})
    for i, k in enumerate(keys[1:], 1):
        lab, (n, unit) = _short_label(k), _qty(k)
        if under and any(w in k for w in _UNDER_WORDS + ("廊道", "窟", "室", "暗河", "栈桥")):
            rooms.append(lab)  # 地下的结构 = 地下空间的房间
            continue
        if _is_link(k):
            style = "bridge" if "桥" in lab or "飞廊" in lab else "stairs" if any(w in lab for w in ("阶", "梯")) else "ramp" if "坡" in lab else "path"
            roots.append({"id": f"link{i}", "type": "link", "style": style, "label": lab, "from": "spawn", "to": to_main, "width_m": 3 if style == "bridge" else 4})
            continue
        t = {"label": lab, **_form_of(k, 1)}
        t.pop("_stack", None), t.pop("_arc", None)
        if t["type"] == "detail":
            continue
        if t["type"] == "wall":
            roots.append({"id": f"part{i}", **t})
            continue
        fl = any(w in k for w in _FLOAT_WORDS) or t["type"] == "island"
        if t["type"] == "island":
            t.pop("elev_m", None)
            t["label"] = "浮洲" if "洲" in k else lab
        el = lambda v: {"elev_m": v} if v else {}  # noqa: E731
        if any(w in k for w in ("塔顶", "顶上", "顶部", "顶端", "屋顶", "台顶")):
            kids.append({"id": f"part{i}", **t, "at": "main.top", **el(8 if fl else 0)})
        elif any(w in k for w in ("中心", "中央", "中庭", "贯穿", "正中", "核心", "内立面", "环内", "圆环内", "环顶")):
            if t["type"] == "torus":
                t["size_m"] = [round(max(16, (ring_r or outer) * 1.4)), 3]
            if n > 1 and t["type"] != "torus":  # 「中央下沉的四层食摊」：围着中心一小圈
                kids.append({"id": f"part{i}", "type": "repeat", "pattern": "radial", "count": min(n * 2, 12), "radius_m": 16, "face": "center", "child": t})
            elif ring_r or main.get("pattern") == "stack" or main.get("hollow"):
                inner = "内立面" in k or "环内" in k
                kids.append({"id": f"part{i}", **t, **({"offset_m": [0, -round(ring_r - 12)]} if inner and ring_r else {}),
                             **el(20 if fl else 0)})
            else:
                kids.append({"id": f"part{i}", **t, "at": "main.top", **el(8 if fl else 0)})
        elif long_side and any(w in k for w in ("外挂", "桥侧", "桥沿", "侧", "挂")):
            cnt = max(2, (n or 8) // 2)
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "mirror", "axis": "x", "child": {
                "type": "repeat", "pattern": "linear", "axis": "z", "count": cnt, "spacing_m": 14, "offset_m": [round(side_d + _half(t) + 0.5), 0],
                "child": {**t, **el(max(2, main_elev - 6))}}})
        elif long_side and any(w in k for w in ("墩下", "桥下", "脚下", "底下", "下方")):  # 桥下：桥墩之间，压在桥面底下
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "linear", "axis": "z", "count": n or 4, "spacing_m": 28, "child": t})
        elif any(w in k for w in ("跨", "横跨", "头顶")):  # 跨在头顶：沿纵深一道道排（主体后面，不挡出生点看主体）
            cnt = min(n or 5, 6)
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "linear", "axis": "z", "count": cnt, "spacing_m": 10,
                         "offset_m": [0, -round(outer + 5 * cnt)] if not long_side else [0, 0], "child": {**t, **el(main_elev + 9)}})
            far = max(far, outer + 10 * cnt)
        elif any(w in k for w in ("巷底", "尽头", "末端", "最里", "深处")):
            singles.append({"id": f"part{i}", **t, "_far": True})
        elif any(w in k for w in ("一圈", "环绕", "外缘", "四周", "周围", "围绕", "塔基", "绕")) or (n > 1 and any(w in lab for w in ("口", "入口"))):
            r = round(outer + _half(t) + 4, 1)
            cnt = n or 8  # 起始角错开半格：正南（出生点那边）留出空当，挡不住视线
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "radial", "count": cnt, "radius_m": r, "start_deg": round(180 / cnt, 1), "face": "center", "child": {**t, **el(16 if fl else 0)}})
            outer = r + _half(t) + 2
        elif unit in ("列", "排") or any(w in k for w in ("两侧", "两旁", "夹", "对列")):
            cnt, sz = (6 if unit in ("列", "排") else max(2, (n or 12) // 2)), t.get("size_m") or [8]
            sp = max(8, (sz[2] if len(sz) >= 3 else sz[0]) + 3)
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "mirror", "axis": "x", "child": {
                "type": "repeat", "pattern": "linear", "axis": "z", "count": cnt, "spacing_m": sp, "offset_m": [-round(max(9, outer * 0.6)), -round(outer + sp * cnt / 2)], "child": t}})
            far = max(far, outer + sp * cnt)
        elif any(w in k for w in ("链", "串", "一排", "一列", "一线", "沿")):
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "linear", "axis": "z", "count": n or 5, "spacing_m": 30 if t["type"] == "island" else 12,
                         "offset_m": [0, round(outer + 30)], "child": {**t, **el(24 if fl else 0)}})
        elif any(w in k for w in ("散", "星罗", "零星", "点缀")):
            roots.append({"id": f"part{i}", "type": "repeat", "pattern": "scatter", "count": n or 6, "at": "site.center", "child": t})
        elif fl and n > 1:
            roots.append({"id": f"part{i}", "type": "repeat", "pattern": "radial", "count": n, "radius_m": round(outer + 30), "at": "core", "elev_m": 28, "child": t})
        elif n > 1:
            kids.append({"id": f"part{i}", "type": "repeat", "pattern": "linear", "count": min(n, 6), "spacing_m": max(8, (t.get("size_m") or [8])[0] + 3),
                         "offset_m": [0, -round(outer + _half(t) + 4)], "child": t})
        else:
            singles.append({"id": f"part{i}", **t, **el(18 if fl else 0)})
    for j, t in enumerate(singles):  # 单件：放在最外一圈外面，西、东、北、南轮着放；「巷底」放在纵深最里头
        d = outer + _half(t) + 6
        kids.append({**{a: b for a, b in t.items() if a != "_far"}, "offset_m": [0, -round(min(far, 50) + _half(t) + 2)] if t.get("_far") else [[-d, 0], [d, 0], [0, -d], [0, d]][j % 4]})
    strip = next((k for k in keys[1:] if _is_strip(k)), None)
    if strip and not long_side:  # 中轴长堤：一条贯穿的长台面，主体立在它中段
        kids[0] = {"id": "axis_strip", "type": "platform", "label": _short_label(strip), "size_m": [10, 1.2, min(170, max(110, round(2 * outer + 70)))], "children": [kids[0]]}
    if any(w in concept for w in ("岛", "洲")) and not any(x.get("type") == "repeat" and (x.get("child") or {}).get("type") == "island" for x in kids + roots):
        cnt = (_qty(concept)[0] if _qty(concept)[0] > 1 else 0) or (8 if "十几" in concept or "几十" in concept else 5)
        chain = any(w in concept for w in ("链", "串", "一线", "一条线", "一列"))
        roots.append({"id": "isles", "type": "repeat", "pattern": "linear" if chain else "radial", **({"axis": "z", "spacing_m": 34} if chain else {"radius_m": round(outer + 34)}),
                      "count": min(cnt, 9), "at": "core", "elev_m": 28 if sky else 22,
                      "child": {"type": "island", "label": "浮洲" if "洲" in concept else "浮岛", "size_m": [22, 8, 22],
                                "children": [{"type": "grove", "label": "花木", "size_m": [14, 14], "density": 1.0}]}})
    if rooms:  # 地下的结构：一个地下空间，房间按关键结构起名，主体是入口
        maze = any(w in text for w in ("迷宫", "乱拐", "分岔", "蜂窝"))
        roots.append({"id": "under", "type": "space", "stratum": "underground", "label": (name or "地下")[:8] + "地下", "under": "main", "depth_m": 12,
                      "layout": "rooms", "size_m": 56, "branching": "high" if maze else "medium", "sublevels": 2 if any(w in text for w in ("两层", "层层", "多层")) else 1,
                      "rooms": [{"id": f"r{j + 1}", "label": lab[:12], "size": "l" if j == 0 else "m"} for j, lab in enumerate(rooms[:8])],
                      "links": [["entry", "r1"]] + [[f"r{(j // 2) + 1}" if maze else f"r{j}", f"r{j + 1}"] for j in range(1, min(len(rooms), 8))],
                      "connect": {"via": "shaft" if "井" in keys[0] else "stairs", "from": "main"}})
    terr = _terrain_of(idea, ground or "", ring_r, outer)
    frags = [key for ws, key, need in FRAG_WORDS if any(w in text for w in ws) and (not need or any(w in plain for w in need))][:2]
    spawn = None
    if ground == "sky" and "rise" not in tids:  # 没有地面：整组放在一块悬空台面上，出生点站在台面南沿
        kids = [{"id": "deck", "type": "platform", "label": "悬空台面", "size_m": [round(2 * outer + 8), 3, round(2 * outer + 8)], "children": kids}]
        spawn = {"at": "deck", "offset_m": [0, round(outer)]}
    elif ground == "sky":
        spawn = {"at": "rise.top", "offset_m": [0, 40]}
    anchor = "rise.top" if "rise" in tids else "pit.bottom" if "pit" in tids and not ring_r else "site.center"
    core = {"id": "core", "type": "group", "label": name[:10] or "主体", "at": anchor, "children": kids}
    if not any(r.get("from") == "spawn" for r in roots):  # 主体在半空 / 崖上 / 湖心：出生点补一段上去的路
        if main_elev or any(t.get("edge") == "cliff" for t in terr if t["id"] == "rise"):
            roots.append({"id": "up_stair", "type": "link", "style": "stairs", "label": "登高石阶", "from": "spawn", "to": to_main, "width_m": 3})
        elif ground == "lake" or "pond" in tids:
            roots.append({"id": "lake_bridge", "type": "link", "style": "bridge", "label": "长桥", "from": "spawn", "to": to_main, "width_m": 4})
    pal = ("desert" if "沙" in plain else "garden" if any(w in plain for w in ("花", "园", "云")) else "sea" if any(w in plain for w in ("海", "港")) else
           "neon" if any(w in plain for w in ("霓虹", "赛博")) else "arcane" if any(w in plain for w in ("魔法", "学院", "法师")) else "village" if "村" in plain else "stone")
    return {"name": name[:10] or "方案", "concept": concept, "terrain": terr, "frags": frags, "frags_after": True,
            "extra_nodes": [core] + roots, "ground": ground, "palette": pal, "mood": ["补位"], **({"spawn": spawn} if spawn else {})}


def subject(intent: str) -> str:
    """「我要生成魔法学院」→「魔法学院」（模拟 AI 起名用）"""
    s = re.sub(r"^(我想要|我要|我想|请|帮我|给我)?(生成|做|搭|来|建|设计)?(一个|一座|一片|一处|个|座)?", "", (intent or "").strip())
    s = re.split(r"[，,。；;！!？?\s]", s)[0]
    s = re.sub(r"(的场景|场景|的地图|地图)$", "", s)
    return s[-4:] if len(s) > 4 else s or "场景"


def _fmt(r: dict, sub: str) -> dict:
    r = copy.deepcopy(r)
    r["name"] = r["name"].format(s=sub[-2:])
    r["concept"] = r["concept"].format(s=sub)
    return r


def recipes_for(intent: str, variant: int = 0) -> list[dict]:
    """句子 → 三个概念配方（题材命中就用题材的，否则用通用的；variant 换一批：接着轮到通用配方里没用过的组织方式）"""
    sub = subject(intent)
    pool, best = None, 0
    for words, rs in THEMES:
        hit = sum(1 for w in words if w in intent)
        if hit > best:
            pool, best = rs, hit
    pool = [copy.deepcopy(r) for r in pool] if pool else [_fmt(r, sub) for r in DEFAULT_RECIPES]
    if variant:
        used = {f for r in pool for f in r.get("frags") or []}
        names = {r["name"] for r in pool}
        pool = pool + [d for d in (_fmt(r, sub) for r in DEFAULT_RECIPES if r["frags"][0] not in used) if d["name"] not in names]
    k = (variant * 3) % len(pool)
    out, dirs = [], []
    for r in pool[k:] + pool[:k]:  # 一批里最多一个「往上」（塔 / 崖 / 浮空）、最多一个「往下」：不出「上 / 水 / 地下」三分法
        if r.get("dir") and r["dir"] in dirs:
            continue
        out.append(r)
        dirs.append(r.get("dir"))
        if len(out) == 3:
            break
    return out


def auto_recipe(r: dict) -> dict:
    """只写了概念的配方（auto）→ 按概念的词搭（recipe_from_concept），心情 / 时段沿用配方自己的"""
    out = recipe_from_concept(concept_of(r))
    out["mood"] = list(r.get("mood") or [x.strip() for x in str(r.get("org") or "").split("+") if x.strip()][:2] or ["开阔"])
    for k in ("time", "palette"):
        if r.get(k):
            out[k] = r[k]
    return out


def concept_of(r: dict) -> dict:
    """配方 → 构思调用的输出格式（模拟 AI 的第一步）"""
    return {"name": r["name"][:10], "concept": r["concept"], "key_structures": list(r.get("key") or [])[:5],
            "terrain_idea": r.get("terrain_idea") or "", "why_different": "空间组织：" + (r.get("org") or "")}

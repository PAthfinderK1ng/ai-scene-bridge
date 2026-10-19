# -*- coding: utf-8 -*-
"""
ai_deepseek.py — DeepSeek 官方 API（OpenAI 兼容 /chat/completions），只用标准库 urllib，不加依赖。

- 没有 json_schema 结构化输出：用 response_format = json_object，系统提示里给「由 CARD_SCHEMA / REVISE_SCHEMA 生成的字段表 + 示例卡 + 只输出 json」。
- thinking 默认 disabled（docs/04 §6：开着思考时 token 全花在推理上）；config 里 providers.deepseek.thinking=true 可开。
- 回来后 json.loads；解析失败先本地修（repair_json：去 ```json 围栏、去尾逗号、转义字符串里没转义的英文双引号与换行），
  修好且合 schema 就不再回喂（省一次调用，usage.repaired = true）；修不好才回喂重试。
- 然后去掉多余字段 / 可选字段的 null → schema_lite.clamp → validate；不合格把错误清单回喂、重试一次。
- 429 / 5xx / 断连重试 1 次；单次超时 90 s。
- usage：prompt / completion / prompt_cache_hit_tokens / reasoning，按官方价目（人民币，分高峰 / 空闲时段）估费用。
  价目来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-19 取）：
  deepseek-flash 每百万 token：缓存命中 0.04 / 0.02 元，未命中 2 / 1 元，输出 8 / 4 元（高峰 / 空闲）；
  deepseek-v4-pro：0.30 / 0.15，9.0 / 4.5，27 / 13.5 元。高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（不含法定节假日，这里不识别节假日，按高峰算会略高估）。
"""
from __future__ import annotations

import datetime as dt
import json
import socket
import time
import urllib.error
import urllib.request
from typing import Any

import schema_lite
from ai_common import CARD_SCHEMA, DRAFT_SCHEMA, REVISE_SCHEMA, SYSTEM_PROMPT, AIError, draft_user_text, field_table, revise_user_text

DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com"
MODELS = ["deepseek-flash", "deepseek-v4-pro"]
# 元 / 百万 token：(高峰, 空闲)
PRICING_CNY_PER_MTOK = {
    "deepseek-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},
    "deepseek-v4-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},  # 旧名，按 flash 计价
    "deepseek-v4-pro": {"hit": (0.30, 0.15), "miss": (9.0, 4.5), "output": (27.0, 13.5)},
}
RETRYABLE = {429, 500, 502, 503, 504}

_SEEN: dict = {}
SYSTEM_PROMPT_JSON = (
    SYSTEM_PROMPT
    + "\n\n输出格式：只输出一个 json 对象，不要 markdown 代码块，不要任何解释。不要出现下表以外的字段。\n"
    + "出三张卡时输出 {\"cards\": [卡1, 卡2, 卡3]}，每张卡的字段：\n" + "\n".join(field_table(CARD_SCHEMA, seen=_SEEN))
    + "\n\n改卡时输出：\n" + "\n".join(field_table(REVISE_SCHEMA, seen=_SEEN))
    + "\n改卡输出示例：" + json.dumps({"understood": True, "patch": {"params": {"layer_height_m": 5}}, "restatement": "每层从 3.5 m 提到 5 m，更陡。", "ask_to_point": False}, ensure_ascii=False)
    + "\n\n可选字段不用就省略，不要写 null；必填字段一个都不能少（改卡时 understood / patch / restatement / ask_to_point 四个都要有）。"
)


class DeepSeekAPIError(Exception):
    """DeepSeek 的 HTTP / 网络错误。字段与 anthropic.APIError 对齐（status_code / message / body / request_id），api_server 统一处理。"""

    provider = "deepseek"

    def __init__(self, message: str, status_code: int | None = None, body: Any = None, etype: str | None = None):
        super().__init__(message)
        self.message, self.status_code, self.body = message, status_code, body
        self.request_id = None
        self.etype = etype or (((body or {}).get("error") or {}).get("type") if isinstance(body, dict) and isinstance(body.get("error"), dict) else None) or "DeepSeekAPIError"


def is_peak(now: dt.datetime | None = None) -> bool:
    """北京时间周一至周五 9–12、14–18 点为高峰"""
    t = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone(dt.timedelta(hours=8)))
    return t.weekday() < 5 and (9 <= t.hour < 12 or 14 <= t.hour < 18)


def estimate_cost_cny(usage: dict | None, model: str | None = None, peak: bool | None = None) -> float | None:
    if not usage:
        return None
    key = next((k for k in PRICING_CNY_PER_MTOK if (model or usage.get("model") or "") == k), None) \
        or next((k for k in PRICING_CNY_PER_MTOK if (model or usage.get("model") or "").startswith(k)), None)
    if not key:
        return None
    p = PRICING_CNY_PER_MTOK[key]
    i = 0 if (usage.get("peak") if peak is None else peak) else 1
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    hit = n("cache_read")
    miss = n("cache_miss") if usage.get("cache_miss") is not None else max(0.0, n("input") - hit)
    return round((hit * p["hit"][i] + miss * p["miss"][i] + n("output") * p["output"][i]) / 1e6, 6)


def _usage_of(resp: dict, ms: int, model: str) -> dict:
    u = resp.get("usage") or {}
    det = u.get("completion_tokens_details") or {}
    out = {"input": u.get("prompt_tokens"), "output": u.get("completion_tokens"), "cache_read": u.get("prompt_cache_hit_tokens"),
           "cache_miss": u.get("prompt_cache_miss_tokens"), "prompt_cache_hit_tokens": u.get("prompt_cache_hit_tokens"),
           "reasoning": det.get("reasoning_tokens"), "model": resp.get("model") or model, "request_id": resp.get("id"), "ms": ms,
           "finish_reason": ((resp.get("choices") or [{}])[0] or {}).get("finish_reason"), "peak": is_peak(), "calls": 1}
    out["cost_cny"] = estimate_cost_cny(out, model)
    return out


def _sum_usage(a: dict, b: dict) -> dict:
    s = dict(b)
    for k in ("input", "output", "cache_read", "cache_miss", "prompt_cache_hit_tokens", "reasoning", "ms", "calls"):
        if a.get(k) is not None or b.get(k) is not None:
            s[k] = (a.get(k) or 0) + (b.get(k) or 0)
    s["cost_cny"] = None if a.get("cost_cny") is None or b.get("cost_cny") is None else round(a["cost_cny"] + b["cost_cny"], 6)
    return s


def strip_extra(schema: dict, data: Any, path: str = "$") -> list[str]:
    """原地去掉 additionalProperties=false 下多出的字段、可选字段的 null。返回改动清单。"""
    fixes: list[str] = []
    if isinstance(data, dict) and isinstance(schema, dict) and schema.get("type") == "object":
        props, req = schema.get("properties") or {}, set(schema.get("required") or [])
        for k in list(data):
            if str(k).startswith("_"):
                continue
            if (schema.get("additionalProperties") is False and k not in props) or (data[k] is None and k not in req):
                fixes.append(f"{path}.{k}: 去掉")
                del data[k]
            elif k in props:
                fixes += strip_extra(props[k], data[k], f"{path}.{k}")
    elif isinstance(data, list) and isinstance(schema, dict) and isinstance(schema.get("items"), dict):
        for i, v in enumerate(data):
            fixes += strip_extra(schema["items"], v, f"{path}[{i}]")
    return fixes


def fill_defaults(schema: dict, data: Any) -> list[str]:
    """实测 deepseek-flash 改卡时常漏掉布尔字段 ask_to_point（首轮 3 次改卡全漏，回喂重试才补上，白花一次调用）。
    它的值能从 understood 推出来（翻不了才请人指），本地补上；understood=false 时漏了 patch 按空补。只补这两个推得出的，别的照常回喂重试。"""
    fixes: list[str] = []
    if schema is REVISE_SCHEMA and isinstance(data, dict):
        if "ask_to_point" not in data and isinstance(data.get("understood"), bool):
            data["ask_to_point"] = not data["understood"]
            fixes.append(f"$.ask_to_point: 缺 → {data['ask_to_point']}（由 understood 推出）")
        if "patch" not in data and data.get("understood") is False:
            data["patch"] = {}
            fixes.append("$.patch: 缺 → {}")
    return fixes


def repair_json(text: str) -> tuple[Any, list[str]] | None:
    """模型偶尔吐出的坏 JSON 本地修一遍（不花钱）。修好返回 (数据, 改了什么)，修不好返回 None。
    依次：去 ```json 围栏与前后杂字 → 一遍状态机扫描：
      - 字符串里遇到 " 但其后（跳过空白）不是 , } ] : 也不是结尾 → 当成内容，转义成 \"
      - 字符串里的裸换行 / 回车 / 制表符 → \n / \r / \t
      - 字符串外的逗号后面（跳过空白）紧跟 } 或 ] → 尾逗号，去掉
    """
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
    a = min(starts)
    b = max(t.rfind("}"), t.rfind("]"))
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
    try:
        return json.loads("".join(out)), fixes
    except json.JSONDecodeError:
        return None


class DeepSeekAI:
    name = "deepseek"
    TIMEOUT = 90.0
    MAX_TOKENS = {"draft": 6000, "revise": 1500}
    THINKING_EXTRA = 8000  # 开思考时推理 token 也算在 max_tokens 里

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, base_url: str = DEFAULT_BASE_URL, thinking: bool = False, urlopen=None):
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.thinking = bool(thinking)
        self._urlopen = urlopen or urllib.request.urlopen
        self.retry_sleep = 2.0

    # ---------- HTTP ----------
    def _post_once(self, body: dict, timeout: float) -> dict:
        req = urllib.request.Request(self.base_url + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + self.api_key})
        try:
            with self._urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
            try:
                b = json.loads(raw)
            except Exception:
                b = {"error": {"message": raw[:300]}}
            msg = ((b.get("error") or {}).get("message") if isinstance(b, dict) and isinstance(b.get("error"), dict) else None) or f"HTTP {e.code}"
            raise DeepSeekAPIError(msg, status_code=e.code, body=b) from None
        except (socket.timeout, TimeoutError) as e:
            raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
                raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
            raise DeepSeekAPIError(f"连不上 {self.base_url}：{getattr(e, 'reason', e)}", etype="APIConnectionError") from e
        except json.JSONDecodeError as e:
            raise DeepSeekAPIError(f"响应不是 JSON：{e}", status_code=None, etype="APIConnectionError") from e

    def _post(self, body: dict, timeout: float | None = None) -> dict:
        """429 / 5xx / 断连重试 1 次（超时不重试：再等 90 s 不如让人重点）"""
        try:
            return self._post_once(body, timeout or self.TIMEOUT)
        except DeepSeekAPIError as e:
            if not (e.status_code in RETRYABLE or e.etype == "APIConnectionError"):
                raise
            time.sleep(self.retry_sleep)
            return self._post_once(body, timeout or self.TIMEOUT)

    def _body(self, messages: list, max_tokens: int, json_mode: bool = True) -> dict:
        b = {"model": self.model, "messages": messages, "max_tokens": max_tokens + (self.THINKING_EXTRA if self.thinking else 0), "stream": False,
             "thinking": {"type": "enabled" if self.thinking else "disabled"}}
        if json_mode:
            b["response_format"] = {"type": "json_object"}
        return b

    # ---------- 结构化一次调用（含一次回喂重试） ----------
    def _structured(self, user_text: str, schema: dict, max_tokens: int) -> dict:
        messages = [{"role": "system", "content": SYSTEM_PROMPT_JSON}, {"role": "user", "content": user_text}]
        usage: dict | None = None
        last_err: AIError | None = None
        first_errors: list[str] = []
        for attempt in range(2):
            t0 = time.time()
            resp = self._post(self._body(messages, max_tokens))
            u = _usage_of(resp, int((time.time() - t0) * 1000), self.model)
            usage = u if usage is None else _sum_usage(usage, u)
            choice = (resp.get("choices") or [{}])[0] or {}
            text = ((choice.get("message") or {}).get("content") or "").strip()
            fin = choice.get("finish_reason")
            if fin == "content_filter":
                raise AIError("refusal", "DeepSeek 的内容过滤拦下了这次输出", category="content_filter", usage=usage)
            if fin == "length":
                raise AIError("truncated", f"输出到 {u.get('output')} token 被截断（max_tokens={max_tokens}），JSON 不完整", usage=usage, sample=text[-200:])
            if not text:
                raise AIError("empty", f"模型没有返回内容（finish_reason={fin}）", usage=usage)
            if text.startswith("```"):
                text = text.strip("`").removeprefix("json").strip()
            repaired: list[str] = []
            parsed = True
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                fixed = repair_json(text)  # 本地修：修好且合 schema 就不回喂，省一次调用
                if fixed is None:
                    parsed = False
                    last_err = AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300])
                    errors = [f"不是合法 JSON：{e}"]
                else:
                    data, repaired = fixed
                    usage["repaired"] = True
            if parsed:
                if schema is DRAFT_SCHEMA and isinstance(data, list):
                    data = {"cards": data}
                fixes = ["本地修 JSON：" + "、".join(repaired)] if repaired else []
                fixes += strip_extra(schema, data) + fill_defaults(schema, data) + schema_lite.clamp(schema, data)
                errors = schema_lite.validate(schema, data)
                if not errors:
                    data["_usage"] = usage
                    if attempt:
                        data["_retried"] = True
                        data["_retry_errors"] = first_errors[:6]
                    if fixes:
                        data["_fixes"] = fixes
                    return data
                last_err = AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors, usage=usage)
            if attempt == 0:
                first_errors = errors
                messages = messages + [{"role": "assistant", "content": text},
                                       {"role": "user", "content": "上面的 json 有这些问题：\n" + "\n".join("- " + x for x in errors[:12]) + "\n请改正后重新输出完整的 json（只输出 json）。"}]
        assert last_err is not None
        last_err.detail["usage"] = usage
        raise last_err

    def draft(self, intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> dict:
        data = self._structured(draft_user_text(intent, axis, targets, locked), DRAFT_SCHEMA, self.MAX_TOKENS["draft"])
        data["provider"] = self.name
        return data

    def revise(self, card: dict, action: dict, locked: dict | None) -> dict:
        data = self._structured(revise_user_text(card, action, locked), REVISE_SCHEMA, self.MAX_TOKENS["revise"])
        data["provider"] = self.name
        return data

    def ping(self) -> dict:
        """最短的一条请求，验证密钥 / 模型可用（不开 json 模式、不开思考）"""
        t0 = time.time()
        body = {"model": self.model, "messages": [{"role": "user", "content": "只回复两个字母：ok"}], "max_tokens": 8, "stream": False, "thinking": {"type": "disabled"}}
        resp = self._post_once(body, 30.0)
        u = _usage_of(resp, int((time.time() - t0) * 1000), self.model)
        text = (((resp.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        return {"ok": True, "model": resp.get("model") or self.model, "ms": u["ms"], "text": text, "usage": {"input": u["input"], "output": u["output"], "cost_cny": u["cost_cny"]}}

# -*- coding: utf-8 -*-
"""
ai_service.py — 「场景对话」的 AI 调用层（跑在本地 Python 服务里，密钥不进浏览器）

两个调用，全部结构化输出，LLM 永远不写坐标：
- draft(intent, axis, targets, locked)   一句话 → 3 张卡（原型 + 参数 + 放置类 + 密度 + 调色板 + 文案 + 可选的地下 / 空中空间 levels）
- revise(card, action, locked)            人的一句话（或结构化动作事实）→ 对当前卡的结构 patch + 复述 + 可选的一个追问

服务商（config.provider）：
- "deepseek"：DeepSeekAI（ai_deepseek.py，官方 OpenAI 兼容接口，urllib，json_object + 字段表提示，默认 deepseek-flash、关思考）
- "anthropic"：ClaudeAI（本文件，官方 anthropic SDK，json_schema 结构化输出，默认 claude-opus-5-5）
没有当前服务商的密钥、勾了 mock、或请求带 force_mock 时走 MockAI（ai_mock.py，确定性脚本），整条链路照样能跑。
共用的词表 / schema / 示例卡 / 系统提示在 ai_common.py。

配置：%LOCALAPPDATA%/ai-scene-bridge/config.json
  {"provider": "deepseek", "mock": false,
   "providers": {"anthropic": {"api_key": "...", "model": "claude-opus-5-5"},
                 "deepseek": {"api_key": "...", "model": "deepseek-flash", "base_url": "https://api.deepseek.com", "thinking": false}}}
兼容旧的扁平 {"api_key", "model"}（视为 anthropic）。环境变量 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY 在配置里没有密钥时补上（不写回文件）。

Claude 调用路径（对照 claude-api 技能文档核过，anthropic SDK 1.15.0）：
- 不传 thinking（Opus 5.5 思考常开，disabled / budget_tokens 都 400）、不传 temperature / top_p / top_k（400）；深度只用 output_config.effort。
- 结构化输出用 output_config.format；schema 先经 schema_lite.api_schema 剥掉 API 不支持的 minimum / maximum / pattern / minItems(>1) / maxItems
  （SDK 只在 messages.parse() 自动剥；create() 原样发会 400），模型回来后本地校验 + 夹取。
- 默认开服务端 refusal fallback（betas=server-side-fallback-2026-07-01 + fallbacks="default"）；beta 被 400 时退回普通 messages.create 且本进程内不再试。
- stop_reason 先看再读 content：refusal → AIError(refusal, 带 stop_details.category)；max_tokens → AIError(truncated)。
- usage 记 input / output / cache_read / cache_write / request_id / 耗时 / 是否 fallback 代答 / 按 Opus 5.5 定价估算的费用（美元）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import schema_lite  # noqa: E402
import ai_deepseek  # noqa: E402
from ai_common import (  # noqa: E402,F401  re-export：api_server / 测试 / 评测脚本都从 ai_service 取这些名字
    ARCHETYPES, CARD_SCHEMA, DRAFT_SCHEMA, EXAMPLE_CARD, EXAMPLE_LEVELS, LANDMARK_KINDS, LEVEL_ITEM, LEVEL_WORDS, PATCH_SCHEMA, PLACEMENTS,
    REGION_KINDS, REGION_LABELS, REVISE_SCHEMA, ROLES, SPAWNS, SYSTEM_PROMPT, TIMES, AIError, draft_user_text, field_table, revise_user_text,
)
from ai_deepseek import DeepSeekAI, DeepSeekAPIError, estimate_cost_cny  # noqa: E402,F401
from ai_mock import MOCK_BASE, MOCK_PALETTES, MockAI, levels_from_text  # noqa: E402,F401

DEFAULT_MODEL = "claude-opus-5-5"
# 美元 / 百万 token。来源：claude-api 技能 shared/model-migration.md「Migrating to Claude Opus 5.5」：$4 / $20，5 分钟缓存写 $5（1.25×），缓存读 $0.20（0.05×）。
PRICING_USD_PER_MTOK = {"claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.20}}

PROVIDERS = ("anthropic", "deepseek")
PROVIDER_LABEL = {"anthropic": "Claude", "deepseek": "DeepSeek", "mock": "模拟"}
PROVIDER_DEFAULTS = {
    "anthropic": {"api_key": "", "model": DEFAULT_MODEL},
    "deepseek": {"api_key": "", "model": ai_deepseek.DEFAULT_MODEL, "base_url": ai_deepseek.DEFAULT_BASE_URL, "thinking": False},
}
MODEL_CHOICES = {"anthropic": ["claude-opus-5-5", "claude-sonnet-4-5"], "deepseek": list(ai_deepseek.MODELS)}
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}


# ------------------------------------------------------------ 配置
def config_path() -> str:
    d = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ai-scene-bridge")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "config.json")


def _read_raw() -> dict:
    try:
        with open(config_path(), encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _normalize(raw: dict) -> dict:
    """文件里的配置 → 规范结构（不含环境变量、不含扁平镜像）。旧的扁平 {api_key, model} 归到 anthropic。"""
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
    """规范配置 + 环境变量补的密钥（key_source=env）+ 当前服务商的扁平镜像（api_key / model / thinking / base_url / key_source）"""
    cfg = _normalize(_read_raw())
    for p, pc in cfg["providers"].items():
        pc["key_source"] = "config" if pc.get("api_key") else ""
        if not pc.get("api_key") and os.environ.get(ENV_KEYS[p]):
            pc["api_key"], pc["key_source"] = os.environ[ENV_KEYS[p]], "env"
    cur = cfg["providers"][cfg["provider"]]
    cfg.update({"api_key": cur.get("api_key", ""), "model": cur.get("model"), "thinking": bool(cur.get("thinking")), "base_url": cur.get("base_url"), "key_source": cur.get("key_source", "")})
    return cfg


def save_config(patch: dict) -> dict:
    """patch：{provider?, mock?, providers?: {p: {api_key?, model?, thinking?, base_url?}}}，也接受扁平 {api_key?, model?, thinking?}（写给 patch.provider 或当前服务商）。
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
    """打码：只露前缀（sk-ant- / sk-）与末 4 位"""
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
    """同一份配置换个服务商看（评测脚本 --provider 用）：扁平镜像换成该服务商的密钥 / 模型 / 思考"""
    cfg = dict(cfg or load_config())
    if provider not in PROVIDERS:
        raise ValueError(f"未知服务商 {provider}，可选 {PROVIDERS}")
    pc = cfg["providers"][provider]
    cfg.update({"provider": provider, "api_key": pc.get("api_key", ""), "model": pc.get("model"), "thinking": bool(pc.get("thinking")), "base_url": pc.get("base_url"), "key_source": pc.get("key_source", "")})
    return cfg


def get_ai(cfg: dict | None = None, force_mock: bool = False):
    """按配置选服务商；没密钥 / mock / force_mock 时给 MockAI"""
    cfg = cfg or load_config()
    if force_mock or cfg.get("mock") or not cfg.get("api_key"):
        return MockAI()
    if cfg.get("provider") == "deepseek":
        return DeepSeekAI(cfg["api_key"], cfg.get("model") or ai_deepseek.DEFAULT_MODEL, cfg.get("base_url") or ai_deepseek.DEFAULT_BASE_URL, bool(cfg.get("thinking")))
    try:
        return ClaudeAI(cfg["api_key"], cfg.get("model") or DEFAULT_MODEL)
    except ImportError as e:  # 有密钥却没装 SDK：明说，不悄悄退回模拟（否则人以为在用真模型）
        raise RuntimeError("anthropic SDK 未安装：在仓库根目录执行 .venv\\Scripts\\pip install anthropic，或在 AI 设置里换 DeepSeek / 勾「模拟」") from e


# ------------------------------------------------------------ 真 AI（Claude）
def estimate_cost_usd(usage: dict | None, model: str | None = None) -> float | None:
    """按 PRICING_USD_PER_MTOK 估费用；模型不在表里（或没有 usage）返回 None，报告里留空。"""
    if not usage:
        return None
    key = next((k for k in PRICING_USD_PER_MTOK if (model or usage.get("model") or "").startswith(k)), None)
    if not key:
        return None
    p = PRICING_USD_PER_MTOK[key]
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    return round((n("input") * p["input"] + n("output") * p["output"] + n("cache_write") * p["cache_write"] + n("cache_read") * p["cache_read"]) / 1e6, 6)


def _usage_of(resp: Any, ms: int) -> dict:
    u = getattr(resp, "usage", None)
    g = lambda k: getattr(u, k, None)  # noqa: E731
    served_by_fallback = any(getattr(it, "type", None) == "fallback_message" for it in (g("iterations") or []))
    out = {"input": g("input_tokens"), "output": g("output_tokens"), "cache_read": g("cache_read_input_tokens"), "cache_write": g("cache_creation_input_tokens"),
           "model": getattr(resp, "model", None), "stop_reason": getattr(resp, "stop_reason", None), "request_id": getattr(resp, "_request_id", None), "ms": ms, "fallback_used": served_by_fallback}
    out["cost_usd"] = estimate_cost_usd(out)
    return out


def _is_beta_rejection(e: Any) -> bool:
    """服务端 fallback 这个 beta 不开放时的 400：错误信息提到 anthropic-beta 头或 fallbacks 参数。其它 400 是我们的请求有错，要抛出去。"""
    body = getattr(e, "body", None)
    msg = str((body.get("error") or {}).get("message") if isinstance(body, dict) and isinstance(body.get("error"), dict) else "") + " " + str(e)
    low = msg.lower()
    return "anthropic-beta" in low or "fallback" in low


class ClaudeAI:
    name = "claude"
    fallback_beta_ok = True  # 服务端 fallback beta 被 400 后本进程内不再带它（省一次往返）
    MAX_TOKENS = 16000  # 含思考 token；三张卡 JSON 约 3k，留足余量

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, timeout: float = 180.0, max_retries: int = 2):
        import anthropic  # 延迟导入：没装 / 没密钥时不影响服务启动
        self.anthropic = anthropic
        # timeout 是单次请求的秒数；SDK 对 408/409/429/5xx/超时/断连自动重试 max_retries 次，最坏墙钟 = timeout × (max_retries + 1)
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)
        self.model = model or DEFAULT_MODEL

    def _request_kwargs(self, user_text: str, schema: dict, effort: str) -> dict:
        return dict(
            model=self.model,
            max_tokens=self.MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],  # 系统提示 > 512 token，Opus 5.5 可缓存
            messages=[{"role": "user", "content": user_text}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema_lite.api_schema(schema)}},
        )

    def _structured(self, user_text: str, schema: dict, effort: str = "medium") -> dict:
        """结构化输出一次调用：带服务端 refusal fallback → 退回普通调用 → 看 stop_reason → 解析 → 本地校验 / 夹取 → 附 usage。"""
        a = self.anthropic
        kwargs = self._request_kwargs(user_text, schema, effort)
        t0 = time.time()
        resp = None
        if ClaudeAI.fallback_beta_ok:
            try:
                resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            except a.BadRequestError as e:
                if not _is_beta_rejection(e):
                    raise
                ClaudeAI.fallback_beta_ok = False
        if resp is None:
            resp = self.client.messages.create(**kwargs)
        usage = _usage_of(resp, int((time.time() - t0) * 1000))
        stop = getattr(resp, "stop_reason", None)
        if stop == "refusal":  # 先看 stop_reason 再读 content；stop_details 可能为 None
            sd = getattr(resp, "stop_details", None)
            cat, expl = getattr(sd, "category", None), getattr(sd, "explanation", None)
            raise AIError("refusal", "模型拒绝了这个请求" + (f"（类别 {cat}）" if cat else "") + (f"：{expl}" if expl else ""), category=cat, explanation=expl, usage=usage)
        text = next((b.text for b in (getattr(resp, "content", None) or []) if getattr(b, "type", None) == "text"), "")
        if stop == "max_tokens":
            raise AIError("truncated", f"输出到 {usage.get('output')} token 被截断（max_tokens={self.MAX_TOKENS}），JSON 不完整；可换更低 effort 或减少要求", usage=usage, sample=text[-200:])
        if not text:
            raise AIError("empty", f"模型没有返回文本块（stop_reason={stop}）", usage=usage)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300]) from e
        fixes = schema_lite.clamp(schema, data)
        errors = schema_lite.validate(schema, data)
        if errors:
            raise AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors, usage=usage)
        data["_usage"] = usage
        if fixes:
            data["_fixes"] = fixes
        return data

    def draft(self, intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> dict:
        data = self._structured(draft_user_text(intent, axis, targets, locked), DRAFT_SCHEMA, effort="low")
        data["provider"] = "claude"
        return data

    def revise(self, card: dict, action: dict, locked: dict | None) -> dict:
        data = self._structured(revise_user_text(card, action, locked), REVISE_SCHEMA, effort="medium")
        data["provider"] = "claude"
        return data

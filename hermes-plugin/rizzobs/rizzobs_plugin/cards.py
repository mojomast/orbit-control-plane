"""Build A2UI Express cards and plain fallback text from a snapshot.

Every value is coerced here (numbers via num(), text via txt()), and text is
always emitted through json.dumps, so a hostile label can only ever be a string
literal. Cards have no buttons, images or links.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable

MAX_ROWS = 8
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")


def txt(value: Any, limit: int = 60) -> str:
    text = _CONTROL.sub(" ", str(value if value is not None else ""))
    text = text.replace("${", "$ {")
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def num(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    if isinstance(value, float) and not math.isfinite(value):
        return default
    return float(value)


def fmt_tokens(value: Any) -> str:
    n = num(value)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(int(n))


def fmt_cost(value: Any) -> str:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return "n/a"
    n = num(value, -1)
    return "n/a" if n < 0 else f"${n:,.2f}"


def fmt_age(minutes: Any) -> str:
    m = int(num(minutes))
    if m < 60:
        return f"{m}m"
    if m < 24 * 60:
        return f"{m // 60}h {m % 60}m"
    return f"{m // (24 * 60)}d"


def bar(pct: Any, width: int = 20) -> str:
    p = max(0.0, min(100.0, num(pct)))
    filled = round(p / 100 * width)
    return "█" * filled + "░" * (width - filled) + f" {int(round(p))}%"


def _s(text: Any, limit: int = 60) -> str:
    return json.dumps(txt(text, limit), ensure_ascii=False)


def T(text: Any, variant: str | None = None, limit: int = 60, weight: int | None = None) -> str:
    extra = (f", variant={json.dumps(variant)}" if variant else "") + (f", weight={weight}" if weight else "")
    return f"Text({_s(text, limit)}{extra})"


def col(*children: str, weight: int | None = None) -> str:
    inner = "[" + ", ".join(children) + "]"
    return f"Column({inner}, weight={weight})" if weight else f"Column({inner})"


def row(*children: str) -> str:
    return f"Row([{', '.join(children)}])"


def card(child: str, weight: int | None = None) -> str:
    return f"Card({child}, weight={weight})" if weight else f"Card({child})"


def kpi(label: str, value: str, weight: int = 1) -> str:
    return card(col(T(label, "caption"), T(value, "body")), weight)


def table(headers: list[tuple[str, int]], rows: list[list[str]]) -> list[str]:
    # Text cells straight in a Row keep us far under uirizz's 100-component cap.
    out = [row(*[T(h, "caption", weight=w) for h, w in headers])]
    for r in rows:
        out.append(row(*[T(c, weight=w) for c, (_, w) in zip(r, headers)]))
    return out


def _header(title: str, subtitle: str, stale: bool, age: float) -> list[str]:
    parts = [T(title, "body"), T(subtitle, "caption", 120)]
    if stale:
        parts.append(T(f"Stale: snapshot is {fmt_age(age)} old. Numbers may be out of date.", "caption", 120))
    return parts


def _footer(snap: dict, age: float) -> str:
    srcs = snap.get("sources") if isinstance(snap.get("sources"), list) else []
    names = ", ".join(txt(x, 20) for x in srcs[:6])
    return T(f"Live snapshot, {fmt_age(age)} ago. Sources: {names or 'none'}. Read-only.", "caption", 140)


def _d(snap: dict, key: str) -> dict:
    v = snap.get(key)
    return v if isinstance(v, dict) else {}


def _l(obj: dict, key: str) -> list:
    v = obj.get(key)
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def _stale_line(stale: bool, age: float) -> str:
    return f"STALE: snapshot is {fmt_age(age)} old. " if stale else ""


# --- views -----------------------------------------------------------------

def view_bees(snap, age, stale):
    b = _d(snap, "bees")
    active, queued = int(num(b.get("active"))), int(num(b.get("queued")))
    cap = b.get("cap")
    cap_text = f"{active} / {int(num(cap))}" if cap is not None else str(active)
    items = _l(b, "items")[:MAX_ROWS]
    rows = [[txt(i.get("id"), 12), txt(i.get("project") or "-", 24), txt(i.get("provider"), 16),
             txt(i.get("state"), 10), fmt_age(i.get("elapsedMin"))] for i in items]
    body = table([("bee", 1), ("repo", 2), ("provider", 2), ("state", 1), ("elapsed", 1)], rows) if rows else [
        T("No bees in flight right now.")]
    ex = col(*_header("Bees in flight", "OpenCode Go / DeepSeek / OpenRouter workers from Orbit", stale, age),
             row(kpi("Active", str(active)), kpi("Cap use", cap_text), kpi("Queued", str(queued))),
             *body, _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}Bees in flight: {active} active ({cap_text}), {queued} queued."]
    lines += [f"- {r[0]} {r[1]} {r[2]} {r[3]} {r[4]}" for r in rows]
    return ex, "\n".join(lines)


def view_tokens(snap, age, stale):
    t = _d(snap, "tokens")
    w = int(num(t.get("windowHours"), 24))
    provs = _l(t, "providers")[:5]
    total = _d(t, "total")
    rows = [[txt(p.get("provider"), 20), str(int(num(p.get("runs")))), fmt_tokens(p.get("tokensIn")),
             fmt_tokens(p.get("tokensOut")), fmt_tokens(p.get("tokensCached")), fmt_cost(p.get("costUsd"))] for p in provs]
    ex = col(*_header("Token usage and spend", f"Last {w}h from finished bee runs. Cost is n/a unless a rate is configured.", stale, age),
             *table([("provider", 2), ("runs", 1), ("in", 1), ("out", 1), ("cached", 1), ("spend", 1)], rows),
             card(col(T("Total", "caption"), T(
                 f"{int(num(total.get('runs')))} runs · in {fmt_tokens(total.get('tokensIn'))} · out {fmt_tokens(total.get('tokensOut'))}"
                 f" · cached {fmt_tokens(total.get('tokensCached'))} · spend {fmt_cost(total.get('costUsd'))}", "body", 120))),
             _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}Token usage, last {w}h:"]
    lines += [f"- {r[0]}: {r[1]} runs, in {r[2]}, out {r[3]}, cached {r[4]}, spend {r[5]}" for r in rows]
    lines.append(f"Total: {int(num(total.get('runs')))} runs, spend {fmt_cost(total.get('costUsd'))}")
    return ex, "\n".join(lines)


def view_problems(snap, age, stale):
    p = _d(snap, "problems")
    c = _d(p, "counts")
    w = int(num(p.get("windowHours"), 24))
    failed, ci, wait = (int(num(c.get(k))) for k in ("failedRuns", "ciRed", "awaitingReview"))
    f_rows = [f"{txt(i.get('id'), 12)} {txt(i.get('project') or '-', 20)}: {txt(i.get('reason'), 50)} ({fmt_age(i.get('agoMin'))} ago)" for i in _l(p, "failedRuns")[:4]]
    ci_rows = [f"{txt(i.get('repo'), 24)}: {txt(i.get('check'), 40)} on {txt(i.get('ref'), 20)}" for i in _l(p, "ciRed")[:4]]
    w_rows = [f"{txt(i.get('id'), 12)} {txt(i.get('project') or '-', 20)} ({fmt_age(i.get('agoMin'))} ago)" for i in _l(p, "awaitingReview")[:4]]

    def block(title, count, rows, empty):
        return card(col(T(title, "caption"), T(str(count), "body"), *([T(r, limit=100) for r in rows] or [T(empty)])), 1)

    ex = col(*_header("Failures and blockers", f"Last {w}h. Awaiting review = succeeded but not yet accepted.", stale, age),
             row(block("Failed runs", failed, f_rows, "None."), block("CI red on main", ci, ci_rows, "All green."),
                 block("Awaiting your review", wait, w_rows, "Nothing waiting.")),
             _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}Failures and blockers, last {w}h: {failed} failed runs, {ci} CI red, {wait} awaiting review."]
    lines += [f"- failed {r}" for r in f_rows] + [f"- CI red {r}" for r in ci_rows] + [f"- review {r}" for r in w_rows]
    return ex, "\n".join(lines)


def view_board(snap, age, stale):
    b = _d(snap, "board")
    d = int(num(b.get("windowDays"), 7))
    if not b.get("available"):
        ex = col(*_header("Board stats", "GitHub data was not collected in this snapshot.", stale, age), _footer(snap, age))
        return ex, f"{_stale_line(stale, age)}Board stats unavailable (GitHub was not collected)."
    t = _d(b, "totals")
    rows = [[txt(r.get("repo"), 24), str(int(num(r.get("open")))), str(int(num(r.get("merged")))), str(int(num(r.get("commits"))))] for r in _l(b, "repos")[:MAX_ROWS]]
    skipped = [txt(x, 24) for x in b.get("skipped", []) if isinstance(x, str)][:6] if isinstance(b.get("skipped"), list) else []
    ex = col(*_header("Board stats", f"PRs and commits across the rizzstack repos, last {d} days", stale, age),
             row(kpi("Open PRs", str(int(num(t.get("open"))))), kpi(f"Merged ({d}d)", str(int(num(t.get("merged"))))),
                 kpi(f"Commits ({d}d)", str(int(num(t.get("commits")))))),
             *table([("repo", 3), ("open", 1), (f"merged {d}d", 1), (f"commits {d}d", 1)], rows),
             *([T("Skipped (gh error): " + ", ".join(skipped), "caption", 120)] if skipped else []),
             _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}Board, last {d}d: {int(num(t.get('open')))} open PRs, {int(num(t.get('merged')))} merged, {int(num(t.get('commits')))} commits."]
    lines += [f"- {r[0]}: open {r[1]}, merged {r[2]}, commits {r[3]}" for r in rows]
    if skipped:
        lines.append("Skipped: " + ", ".join(skipped))
    return ex, "\n".join(lines)


def view_resources(snap, age, stale):
    r = _d(snap, "resources")
    if not r.get("available"):
        ex = col(*_header("Resources", "Host resources were not collected in this snapshot.", stale, age), _footer(snap, age))
        return ex, f"{_stale_line(stale, age)}Resources unavailable."
    items = [("CPU (load per core)", r.get("cpuPct")), ("Memory", r.get("memPct")), ("Disk /", r.get("diskPct"))]
    cards = [card(col(T(lbl, "caption"), T(bar(v), "body", 40))) for lbl, v in items if v is not None]
    cores = int(num(r.get("cores")))
    ex = col(*_header("Resources", f"The orchestration box, {cores} cores. Percentages only; no host names.", stale, age),
             row(*cards), _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}Resources: " + ", ".join(f"{lbl} {int(round(num(v)))}%" for lbl, v in items if v is not None)]
    return ex, "\n".join(lines)


def view_overview(snap, age, stale):
    b, p, t, bd = _d(snap, "bees"), _d(snap, "problems"), _d(snap, "tokens"), _d(snap, "board")
    c = _d(p, "counts")
    active, queued = int(num(b.get("active"))), int(num(b.get("queued")))
    cap = b.get("cap")
    cap_text = f"{active} / {int(num(cap))}" if cap is not None else str(active)
    total = _d(t, "total")
    bt = _d(bd, "totals")
    provs = [f"{txt(x.get('provider'), 16)}: {int(num(x.get('runs')))} runs, {fmt_tokens(num(x.get('tokensIn')) + num(x.get('tokensOut')))} tok, {fmt_cost(x.get('costUsd'))}" for x in _l(t, "providers")]
    ci = [f"{txt(x.get('repo'), 20)}: {txt(x.get('check'), 30)}" for x in _l(p, "ciRed")][:3]
    board_line = (f"{int(num(bt.get('open')))} open · {int(num(bt.get('merged')))} merged · {int(num(bt.get('commits')))} commits"
                  if bd.get("available") else "not collected")
    r = _d(snap, "resources")
    res_line = (f"CPU {int(num(r.get('cpuPct')))}% · Mem {int(num(r.get('memPct')))}% · Disk {int(num(r.get('diskPct')))}%"
                if r.get("available") else "not collected")
    ex = col(*_header("rizzstack observability", "Bees, tokens, blockers, board and resources in one view", stale, age),
             row(kpi("Bees active", cap_text), kpi("Queued", str(queued)), kpi("Failed runs", str(int(num(c.get("failedRuns"))))),
                 kpi("CI red", str(int(num(c.get("ciRed"))))), kpi("Awaiting review", str(int(num(c.get("awaitingReview")))))),
             row(card(col(T(f"Tokens, last {int(num(t.get('windowHours'), 24))}h", "caption"), *[T(x, limit=90) for x in provs]), 3),
                 card(col(T("CI red on main", "caption"), *([T(x, limit=70) for x in ci] or [T("All green.")]),
                          T("Board (7d)", "caption"), T(board_line, limit=70),
                          T("Resources", "caption"), T(res_line, limit=70)), 2)),
             _footer(snap, age))
    lines = [f"{_stale_line(stale, age)}rizzstack: bees {cap_text} active, {queued} queued; {int(num(c.get('failedRuns')))} failed runs, "
             f"{int(num(c.get('ciRed')))} CI red, {int(num(c.get('awaitingReview')))} awaiting review; "
             f"{int(num(total.get('runs')))} runs, spend {fmt_cost(total.get('costUsd'))}; board {board_line}; resources {res_line}."]
    return ex, "\n".join(lines)


BUILDERS: dict[str, Callable[[dict, float, bool], tuple[str, str]]] = {
    "overview": view_overview,
    "bees": view_bees,
    "tokens": view_tokens,
    "problems": view_problems,
    "board": view_board,
    "resources": view_resources,
}

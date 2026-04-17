#!/usr/bin/env python3
"""Interactive importer: Claude Code JSONL sessions -> OpenCode DB.

Usage:
  python import_claude_to_opencode.py            # interactive browser
  python import_claude_to_opencode.py openbao    # filter by keyword in prompt or path
  python import_claude_to_opencode.py --dir dmm  # filter by cwd path substring
  python import_claude_to_opencode.py --last 20  # show only last 20 by mtime

After filtering, a numbered list is shown. Type the numbers to import
(space-separated, e.g. "1 3 5"), or "all", or "q" to quit.

Ownership:
  Sessions are imported into the OpenCode project whose worktree equals the
  JSONL's cwd. If no matching project exists, the import is skipped with a
  warning — open that folder once in OpenCode so the project row gets created,
  then re-run.

Flags:
  --model <opus|sonnet|haiku>   Override modelID in the imported message
  --project-id <id>              Force a specific project_id for all selections
  --db <path>                    OpenCode DB path (default: ~/.local/share/opencode/opencode.db)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
OPENCODE_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
OPENCODE_VERSION = "1.4.3"
PLACEHOLDER_SNAPSHOT = "0" * 40

OPENCODE_HANDLED_TOOLS = {
    "Edit", "Write", "Bash", "NotebookEdit", "TodoWrite", "Read", "Glob", "Grep",
}
CLAUDE_INTERNAL_TOOLS = {"ToolSearch", "Agent", "AskFollowupQuestion"}


# ---------- tool mapping (mirrors tool-mapping.ts) ----------

def map_tool_input(name, inp):
    if not inp:
        return inp
    if name == "Write":
        return {"filePath": inp.get("file_path") or inp.get("filePath"),
                "content": inp.get("content")}
    if name == "Edit":
        return {"filePath": inp.get("file_path") or inp.get("filePath"),
                "oldString": inp.get("old_string") or inp.get("oldString"),
                "newString": inp.get("new_string") or inp.get("newString"),
                "replaceAll": inp.get("replace_all") or inp.get("replaceAll")}
    if name == "Read":
        return {"filePath": inp.get("file_path") or inp.get("filePath"),
                "offset": inp.get("offset"), "limit": inp.get("limit")}
    if name == "Bash":
        cmd = inp.get("command", "") or ""
        desc = inp.get("description") or (
            f"Execute: {cmd[:50]}{'...' if len(cmd) > 50 else ''}")
        return {"command": cmd, "description": desc, "timeout": inp.get("timeout")}
    if name == "Grep":
        return {"pattern": inp.get("pattern"), "path": inp.get("path"),
                "include": inp.get("include")}
    if name == "Glob":
        return {"pattern": inp.get("pattern"), "path": inp.get("path")}
    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
        return {"todos": [
            {"content": t.get("content"),
             "status": t.get("status", "pending"),
             "priority": t.get("priority", "medium"),
             "id": t.get("id", f"todo_{int(time.time() * 1000)}_{i}")}
            for i, t in enumerate(inp["todos"])
        ]}
    return inp


def map_tool(name, inp):
    if name in CLAUDE_INTERNAL_TOOLS:
        return {"name": name, "input": inp, "executed": True, "skip": True}
    if name == "EnterPlanMode":
        return {"name": "plan_enter", "input": {}, "executed": False, "skip": False}
    if name == "ExitPlanMode":
        return {"name": "plan_exit", "input": inp, "executed": False, "skip": False}
    if name in ("WebSearch", "web_search"):
        q = inp.get("query") if isinstance(inp, dict) else None
        mi = {"query": q} if q else inp
        return {"name": "websearch_web_search_exa", "input": mi,
                "executed": False, "skip": False}
    if name == "TaskOutput":
        if not inp:
            return {"name": "bash", "input": None, "executed": False, "skip": False}
        out = inp.get("content") or inp.get("output") or json.dumps(inp)
        return {"name": "bash",
                "input": {"command": f'echo "TASK OUTPUT: {str(out).replace(chr(34), chr(92)+chr(34))}"',
                          "description": "Displaying task output"},
                "executed": False, "skip": False}
    if name.startswith("mcp__"):
        parts = name[5:].split("__")
        if len(parts) >= 2:
            return {"name": f"{parts[0]}_{'_'.join(parts[1:])}", "input": inp,
                    "executed": False, "skip": False}
    if name in OPENCODE_HANDLED_TOOLS:
        return {"name": name.lower(), "input": map_tool_input(name, inp),
                "executed": True, "skip": False}
    return {"name": name, "input": inp, "executed": True, "skip": False}


# ---------- util ----------

def make_id(prefix):
    return f"{prefix}_{format(int(time.time() * 1_000_000), 'x')}{secrets.token_hex(8)}"


def parse_ts(iso_str):
    if not iso_str:
        return int(time.time() * 1000)
    try:
        return int(datetime.fromisoformat(iso_str.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def normalize_model_id(raw):
    if not raw:
        return "opus"
    if "opus" in raw:
        return "opus"
    if "sonnet" in raw:
        return "sonnet"
    if "haiku" in raw:
        return "haiku"
    return raw


# ---------- indexing ----------

def index_jsonl(path: Path):
    """Return metadata dict or None.

    Extracts: cwd, first user prompt, custom-title (if present), turn count,
    timestamp of the last user interaction (for ordering).
    """
    cwd = None
    first_text = None
    custom_title = None
    turns = 0
    last_user_ts = None
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get("type")
                if t == "custom-title":
                    ct = d.get("customTitle")
                    if ct:
                        custom_title = ct.strip()
                    continue
                if cwd is None and d.get("cwd"):
                    cwd = d["cwd"]
                if t != "user" or d.get("isSidechain"):
                    continue
                content = d.get("message", {}).get("content")
                if isinstance(content, list) and content and all(
                    isinstance(x, dict) and x.get("type") == "tool_result"
                    for x in content
                ):
                    continue
                turns += 1
                last_user_ts = parse_ts(d.get("timestamp"))
                if first_text is None:
                    if isinstance(content, str):
                        first_text = content.strip()
                    elif isinstance(content, list):
                        chunks = []
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "text":
                                tx = c.get("text", "")
                                if tx.startswith("<") or tx.startswith("[Image "):
                                    continue
                                chunks.append(tx)
                        first_text = "\n".join(chunks).strip() or None
    except Exception:
        return None
    if not cwd or not first_text:
        return None
    display_title = custom_title or first_text
    return {"path": path, "cwd": cwd,
            "title": display_title, "custom_title": custom_title,
            "first_prompt": first_text,
            "turns": turns, "mtime": path.stat().st_mtime,
            "last_user_ts": last_user_ts or 0}


def collect_sessions(dir_filter=None):
    sessions = []
    if not CLAUDE_PROJECTS.exists():
        return sessions
    for proj in CLAUDE_PROJECTS.iterdir():
        if not proj.is_dir():
            continue
        for fp in proj.glob("*.jsonl"):
            info = index_jsonl(fp)
            if not info:
                continue
            if dir_filter and dir_filter.lower() not in info["cwd"].lower():
                continue
            sessions.append(info)
    return sessions


def filter_sessions(sessions, query):
    if not query:
        return sessions
    q = query.lower()
    out = []
    for s in sessions:
        hay = " ".join([
            s.get("title") or "",
            s.get("first_prompt") or "",
            s.get("custom_title") or "",
            s.get("cwd") or "",
        ]).lower()
        if q in hay:
            out.append(s)
    return out


def _format_ts(ts_ms_or_s):
    if not ts_ms_or_s:
        return "-" * 16
    ts = ts_ms_or_s / 1000 if ts_ms_or_s > 1e12 else ts_ms_or_s
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def print_sessions(sessions, limit=None):
    if limit:
        sessions = sessions[:limit]
    for i, s in enumerate(sessions, 1):
        # order key is last_user_ts (ms since epoch); fallback to mtime
        ts = s.get("last_user_ts") or int(s.get("mtime", 0) * 1000)
        dt = _format_ts(ts)
        cwd = s["cwd"]
        if len(cwd) > 45:
            cwd = "..." + cwd[-42:]
        title = s["title"].replace("\n", " ").strip()
        marker = "*" if s.get("custom_title") else " "
        if len(title) > 70:
            title = title[:67] + "..."
        print(f"  [{i:>3}]{marker} {dt}  T={s['turns']:>3}  {cwd:<45}  {title}")


def prompt_selection(total):
    print()
    raw = input("Select (e.g. '1 3', 'all', or 'q'): ").strip().lower()
    if not raw or raw == "q":
        return []
    if raw == "all":
        return list(range(1, total + 1))
    picks = []
    for tok in re.split(r"[\s,]+", raw):
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-", 1)
            picks.extend(range(int(a), int(b) + 1))
        else:
            picks.append(int(tok))
    return [p for p in picks if 1 <= p <= total]


# ---------- import logic (unchanged core, refactored) ----------

def load_events(path):
    out = []
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def is_tool_result_only(event):
    c = event.get("message", {}).get("content")
    if not isinstance(c, list) or not c:
        return False
    return all(isinstance(x, dict) and x.get("type") == "tool_result" for x in c)


def extract_user_text(event):
    content = event.get("message", {}).get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                t = c.get("text", "")
                if t.startswith("<system-reminder>") or t.startswith("<command-"):
                    continue
                chunks.append(t)
        return "\n".join(chunks).strip()
    return ""


def group_turns(events):
    turns = []
    cur = None
    for e in events:
        if e.get("type") not in ("user", "assistant"):
            continue
        if e.get("isSidechain"):
            continue
        role = e.get("message", {}).get("role")
        if role == "user" and not is_tool_result_only(e):
            if cur is not None:
                turns.append(cur)
            cur = {"user": e, "events": []}
        else:
            if cur is None:
                continue
            cur["events"].append(e)
    if cur:
        turns.append(cur)
    return turns


def build_tool_results_map(turn_events):
    m = {}
    for e in turn_events:
        if e.get("message", {}).get("role") != "user":
            continue
        content = e.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        end_ts = parse_ts(e.get("timestamp"))
        for c in content:
            if not isinstance(c, dict) or c.get("type") != "tool_result":
                continue
            tid = c.get("tool_use_id")
            raw = c.get("content")
            if isinstance(raw, list):
                raw = "\n".join(x.get("text", "") for x in raw
                                if isinstance(x, dict) and x.get("type") == "text")
            m[tid] = {"content": raw or "",
                      "is_error": bool(c.get("is_error")),
                      "end_ts": end_ts}
    return m


def import_one(db, jsonl_path, project_id_override=None, model_override=None):
    events = load_events(jsonl_path)
    if not events:
        return None, "empty jsonl"

    first_cwd = None
    for e in events:
        if e.get("cwd"):
            first_cwd = e["cwd"]
            break
    if not first_cwd:
        return None, "no cwd in jsonl"

    if project_id_override:
        row = db.execute("SELECT worktree FROM project WHERE id=?",
                         (project_id_override,)).fetchone()
        if not row:
            return None, f"project_id {project_id_override} not found"
        project_id = project_id_override
    else:
        row = db.execute("SELECT id FROM project WHERE worktree=?",
                         (first_cwd,)).fetchone()
        if row:
            project_id = row[0]
        else:
            fallback = db.execute(
                "SELECT id FROM project WHERE id='global' OR worktree='/' LIMIT 1"
            ).fetchone()
            if not fallback:
                return None, f"no project match for cwd={first_cwd!r} and no global fallback"
            project_id = fallback[0]

    turns = group_turns(events)
    if not turns:
        return None, "no user turns"

    custom_title = None
    for e in events:
        if e.get("type") == "custom-title":
            ct = e.get("customTitle")
            if ct:
                custom_title = ct.strip()

    session_id = make_id("ses")
    first_prompt = extract_user_text(turns[0]["user"])
    title_source = custom_title or first_prompt or "Imported Claude session"
    title = title_source[:80].replace("\n", " ").strip()
    first_ts = parse_ts(turns[0]["user"].get("timestamp"))
    last_ts = first_ts

    msg_rows, part_rows = [], []

    for turn in turns:
        user_ev = turn["user"]
        user_ts = parse_ts(user_ev.get("timestamp"))
        user_text = extract_user_text(user_ev)

        user_msg_id = make_id("msg")
        msg_rows.append((user_msg_id, session_id, user_ts, user_ts,
                         json.dumps({
                             "role": "user",
                             "time": {"created": user_ts},
                             "agent": "build",
                             "model": {"providerID": "claude-code",
                                       "modelID": model_override or "opus"},
                             "summary": {"diffs": []},
                         }, ensure_ascii=False)))
        part_rows.append((make_id("prt"), user_msg_id, session_id, user_ts, user_ts,
                          json.dumps({"type": "text", "text": user_text}, ensure_ascii=False)))

        assist_msg_id = make_id("msg")
        assist_start_ts = user_ts + 1
        end_ts = assist_start_ts
        assist_parts = [{"type": "step-start", "snapshot": PLACEHOLDER_SNAPSHOT}]
        tool_results = build_tool_results_map(turn["events"])
        tok = {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0}
        model_seen = None

        for e in turn["events"]:
            if e.get("message", {}).get("role") != "assistant":
                continue
            e_ts = parse_ts(e.get("timestamp"))
            end_ts = max(end_ts, e_ts)
            if model_seen is None:
                model_seen = e.get("message", {}).get("model")
            # Usage on each assistant event is cumulative for the turn
            # (same input/cache fields repeat, output grows). Take the max of
            # each field to get the final turn totals, mirroring what the
            # plugin does with lastIterationUsage().
            usage = e.get("message", {}).get("usage") or {}
            tok["input"] = max(tok["input"], int(usage.get("input_tokens") or 0))
            tok["output"] = max(tok["output"], int(usage.get("output_tokens") or 0))
            tok["cache_read"] = max(tok["cache_read"], int(usage.get("cache_read_input_tokens") or 0))
            tok["cache_write"] = max(tok["cache_write"], int(usage.get("cache_creation_input_tokens") or 0))
            content = e.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                ct = c.get("type")
                if ct == "thinking" and c.get("thinking"):
                    assist_parts.append({"type": "reasoning", "text": c["thinking"]})
                elif ct == "text" and c.get("text"):
                    assist_parts.append({"type": "text", "text": c["text"]})
                elif ct == "tool_use":
                    mapped = map_tool(c.get("name", ""), c.get("input") or {})
                    if mapped["skip"]:
                        continue
                    call_id = c.get("id") or make_id("toolu")
                    res = tool_results.get(call_id, {})
                    status = "error" if res.get("is_error") else "completed"
                    title_str = (mapped["name"][:1].upper() + mapped["name"][1:]) if mapped["name"] else ""
                    assist_parts.append({
                        "type": "tool",
                        "tool": mapped["name"],
                        "callID": call_id,
                        "state": {
                            "status": status,
                            "input": mapped["input"] or {},
                            "output": res.get("content", ""),
                            "metadata": {},
                            "title": title_str,
                            "time": {"start": e_ts, "end": res.get("end_ts", e_ts)},
                        },
                        "metadata": {"providerExecuted": mapped["executed"]},
                    })

        total_tok = tok["input"] + tok["output"] + tok["cache_read"] + tok["cache_write"]
        assist_parts.append({
            "type": "step-finish", "reason": "stop", "snapshot": PLACEHOLDER_SNAPSHOT,
            "tokens": {"total": total_tok, "input": tok["input"],
                       "output": tok["output"], "reasoning": tok["reasoning"],
                       "cache": {"write": tok["cache_write"], "read": tok["cache_read"]}},
            "cost": 0,
        })

        model_id = model_override or normalize_model_id(model_seen)
        msg_rows.append((assist_msg_id, session_id, assist_start_ts, end_ts,
                         json.dumps({
                             "parentID": user_msg_id, "role": "assistant",
                             "mode": "build", "agent": "build",
                             "path": {"cwd": first_cwd, "root": first_cwd},
                             "cost": 0,
                             "tokens": {"total": total_tok, "input": tok["input"],
                                        "output": tok["output"], "reasoning": tok["reasoning"],
                                        "cache": {"write": tok["cache_write"], "read": tok["cache_read"]}},
                             "modelID": model_id, "providerID": "claude-code",
                             "time": {"created": assist_start_ts, "completed": end_ts},
                             "finish": "stop",
                         }, ensure_ascii=False)))

        pt = assist_start_ts
        for p in assist_parts:
            pt += 1
            part_rows.append((make_id("prt"), assist_msg_id, session_id, pt, pt,
                              json.dumps(p, ensure_ascii=False)))
        last_ts = max(last_ts, end_ts)

    slug = f"imported-{hashlib.md5(jsonl_path.name.encode()).hexdigest()[:8]}"
    session_row = (session_id, project_id, None, slug, first_cwd, title,
                   OPENCODE_VERSION, None, 0, 0, 0, None, None, None,
                   first_ts, last_ts, None, None, None)

    db.execute("BEGIN")
    try:
        db.execute(
            "INSERT INTO session (id, project_id, parent_id, slug, directory, "
            "title, version, share_url, summary_additions, summary_deletions, "
            "summary_files, summary_diffs, revert, permission, time_created, "
            "time_updated, time_compacting, time_archived, workspace_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", session_row)
        db.executemany(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) "
            "VALUES (?,?,?,?,?)", msg_rows)
        db.executemany(
            "INSERT INTO part (id, message_id, session_id, time_created, "
            "time_updated, data) VALUES (?,?,?,?,?,?)", part_rows)
        db.execute("COMMIT")
    except Exception as ex:
        db.execute("ROLLBACK")
        return None, f"db error: {ex}"
    return session_id, None


# ---------- main ----------

HELP_TEXT = """
Commands:
  <keyword>       search sessions (keyword in title/prompt/cwd)
  <keyword> | 20  show only top 20 results
  <N>             import session at index N
  <N> <M> <K>     import multiple
  N-M             import range
  all             import everything currently shown
  last <N>         show top N latest without a keyword filter
  clear           show back the full list (no keyword)
  help            this help
  q / exit        quit
"""


def _perform_import(db, targets, project_id_override, model_override):
    ok = fail = 0
    for idx, s in targets:
        print(f"\nImporting [{idx}] {s['path'].name}  ({s['title'][:60]})")
        sid, err = import_one(db, s["path"],
                              project_id_override=project_id_override,
                              model_override=model_override)
        if err:
            print(f"  SKIP: {err}")
            fail += 1
        else:
            print(f"  OK: session {sid} -> {s['cwd']}")
            ok += 1
    print(f"\nDone. imported={ok}  skipped={fail}")


def _parse_indices(tokens, total):
    picks = []
    for tok in tokens:
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-", 1)
            picks.extend(range(int(a), int(b) + 1))
        else:
            picks.append(int(tok))
    return [p for p in picks if 1 <= p <= total]


def interactive_loop(all_sessions, db, project_id_override, model_override,
                     initial_query=None, initial_limit=20):
    """Read-eval loop: keyword to filter, number(s) to import."""
    current = all_sessions
    limit = initial_limit
    if initial_query:
        current = filter_sessions(all_sessions, initial_query)
    print(f"\nShowing top {limit} of {len(current)} session(s). "
          f"Type 'help' for commands.\n")
    print_sessions(current, limit=limit)

    while True:
        try:
            raw = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not raw:
            continue
        low = raw.lower()
        if low in ("q", "exit", "quit"):
            return
        if low == "help":
            print(HELP_TEXT)
            continue
        if low == "clear":
            current = all_sessions
            limit = initial_limit
            print(f"Cleared filter. {len(current)} sessions total.\n")
            print_sessions(current, limit=limit)
            continue
        if low.startswith("last "):
            try:
                limit = int(low.split(None, 1)[1])
            except Exception:
                print("usage: last <N>")
                continue
            print_sessions(current, limit=limit)
            continue
        if low == "all":
            visible = current[:limit]
            if not visible:
                print("nothing to import")
                continue
            _perform_import(db, list(enumerate(visible, 1)),
                            project_id_override, model_override)
            continue
        # maybe indices: tokens that are all numeric or ranges
        tokens = re.split(r"[\s,]+", raw)
        if all(re.fullmatch(r"\d+(-\d+)?", t) for t in tokens if t):
            visible = current[:limit]
            picks = _parse_indices(tokens, len(visible))
            if picks:
                _perform_import(db,
                                [(i, visible[i - 1]) for i in picks],
                                project_id_override, model_override)
                continue
        # otherwise treat as keyword filter (allow "keyword | N" to set limit)
        if "|" in raw:
            kw, lim = raw.rsplit("|", 1)
            raw = kw.strip()
            try:
                limit = int(lim.strip())
            except Exception:
                pass
        current = filter_sessions(all_sessions, raw) if raw else all_sessions
        print(f"\n{len(current)} match(es) for {raw!r}. Showing top {limit}.\n")
        print_sessions(current, limit=limit)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="?", default=None,
                    help="Initial filter keyword (searched in title, first prompt, cwd)")
    ap.add_argument("--dir", dest="dir_filter", default=None,
                    help="Pre-filter by cwd path substring")
    ap.add_argument("--limit", type=int, default=20,
                    help="How many results to show per page (default: 20)")
    ap.add_argument("--batch", action="store_true",
                    help="Non-interactive: print the matches, prompt once, exit")
    ap.add_argument("--model", default=None,
                    help="Override modelID (opus|sonnet|haiku)")
    ap.add_argument("--project-id", default=None,
                    help="Force a target project_id")
    ap.add_argument("--db", type=Path, default=OPENCODE_DB)
    args = ap.parse_args()

    if not args.db.exists():
        raise SystemExit(f"OpenCode DB not found: {args.db}")

    print(f"Indexing {CLAUDE_PROJECTS}...")
    sessions = collect_sessions(dir_filter=args.dir_filter)
    # order by last user activity (newest first); fallback to mtime
    sessions.sort(key=lambda s: s.get("last_user_ts") or int(s["mtime"] * 1000),
                  reverse=True)
    if not sessions:
        print("No sessions found with given filters.")
        return
    print(f"Indexed {len(sessions)} session(s).")

    db = sqlite3.connect(str(args.db))
    db.execute("PRAGMA foreign_keys = ON")
    try:
        if args.batch:
            current = filter_sessions(sessions, args.query)
            current = current[:args.limit]
            if not current:
                print("No matches.")
                return
            print_sessions(current)
            picks = prompt_selection(len(current))
            if not picks:
                print("No selection, exiting.")
                return
            _perform_import(db,
                            [(i, current[i - 1]) for i in picks],
                            args.project_id, args.model)
        else:
            interactive_loop(sessions, db, args.project_id, args.model,
                             initial_query=args.query,
                             initial_limit=args.limit)
    finally:
        db.close()


if __name__ == "__main__":
    main()

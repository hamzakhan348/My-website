"""
C++ StepView Pro - Backend
A Flask server that compiles C++ code, drives GDB in MI mode, and exposes
a step-forward / step-back debugging API to the frontend.
"""

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid

from flask import Flask, jsonify, request, session, send_from_directory

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")

# In-memory session store: session_id -> DebugSession
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()

SESSION_TIMEOUT_SECONDS = 120  # kill idle GDB processes after 2 minutes

# ----------------------------------------------------------------------------
# Language guard
# ----------------------------------------------------------------------------

# Extremely lightweight heuristics to reject obviously non-C++ submissions.
# This is not a real language classifier -- it exists to satisfy the
# "only C++ is allowed" product constraint with cheap, fast checks.
PYTHON_SIGNS = re.compile(r"^\s*def\s+\w+\(.*\):|^\s*import\s+\w+$|print\(.*\)\s*$", re.MULTILINE)
JAVA_SIGNS = re.compile(r"\bpublic\s+class\s+\w+|\bSystem\.out\.println\(")
CPP_SIGNS = re.compile(r"#include\s*<\w+>|::|std::|int\s+main\s*\(")


def looks_like_cpp(code: str) -> bool:
    if not code or not code.strip():
        return False
    if JAVA_SIGNS.search(code) and not CPP_SIGNS.search(code):
        return False
    if PYTHON_SIGNS.search(code) and not CPP_SIGNS.search(code):
        return False
    # Require at least a couple of C++-ish tokens to reduce false positives.
    return bool(CPP_SIGNS.search(code))


# ----------------------------------------------------------------------------
# GDB/MI helpers
# ----------------------------------------------------------------------------

MI_RECORD_RE = re.compile(r'^(\d*)([\^*+=~@&])(.*)$')


def parse_mi_value(s, i):
    """Recursively parse a GDB/MI value starting at index i. Returns (value, next_i)."""
    if s[i] == '"':
        i += 1
        out = []
        escapes = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\'}
        while s[i] != '"':
            if s[i] == '\\':
                nxt = s[i + 1]
                out.append(escapes.get(nxt, nxt))
                i += 2
            else:
                out.append(s[i])
                i += 1
        return ''.join(out), i + 1
    if s[i] == '{':
        i += 1
        obj = {}
        idx = 0
        while s[i] != '}':
            # key=value or bare value (for arrays of tuples)
            m = re.match(r'([A-Za-z_][A-Za-z0-9_\-]*)=', s[i:])
            if m:
                key = m.group(1)
                i += len(m.group(0))
                val, i = parse_mi_value(s, i)
                obj[key] = val
            else:
                val, i = parse_mi_value(s, i)
                obj[str(idx)] = val
                idx += 1
            if i < len(s) and s[i] == ',':
                i += 1
        return obj, i + 1
    if s[i] == '[':
        i += 1
        arr = []
        while s[i] != ']':
            m = re.match(r'([A-Za-z_][A-Za-z0-9_\-]*)=', s[i:])
            if m:
                i += len(m.group(0))
            val, i = parse_mi_value(s, i)
            arr.append(val)
            if i < len(s) and s[i] == ',':
                i += 1
        return arr, i + 1
    # Fallback: read until comma or closing bracket
    j = i
    while j < len(s) and s[j] not in ',}]':
        j += 1
    return s[i:j], j


def parse_mi_results(rest):
    """Parse the comma-separated key=value results portion of an MI record."""
    results = {}
    i = 0
    rest = rest.lstrip(',')
    while i < len(rest):
        m = re.match(r'([A-Za-z_][A-Za-z0-9_\-]*)=', rest[i:])
        if not m:
            break
        key = m.group(1)
        i += len(m.group(0))
        val, i = parse_mi_value(rest, i)
        results[key] = val
        if i < len(rest) and rest[i] == ',':
            i += 1
    return results


def parse_mi_line(line):
    """Parse one line of GDB/MI output into a dict describing the record."""
    m = MI_RECORD_RE.match(line)
    if not m:
        return {"type": "raw", "text": line}
    token, kind, rest = m.groups()
    if kind in ('^', '*', '=', '+'):
        # class,result-pairs
        m2 = re.match(r'([A-Za-z\-]+)(.*)$', rest)
        if not m2:
            return {"type": "raw", "text": line}
        cls, remainder = m2.groups()
        results = parse_mi_results(remainder)
        return {"type": kind, "class": cls, "results": results}
    if kind in ('~', '@', '&'):
        # console/target/log stream output, a quoted string
        val, _ = parse_mi_value(rest, 0)
        return {"type": kind, "text": val}
    return {"type": "raw", "text": line}


class DebugSession:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.workdir = tempfile.mkdtemp(prefix="cppstepview_")
        self.source_path = os.path.join(self.workdir, "temp_code.cpp")
        self.binary_path = os.path.join(self.workdir, "temp_bin")
        self.proc = None
        self.history = []  # list of snapshot dicts, most recent last
        self.output_buffer = []  # accumulated stdout/stderr lines
        self.last_active = time.time()
        self.finished = False
        self.lock = threading.Lock()

    # -- GDB process management -------------------------------------------------

    def start_gdb(self):
        self.proc = subprocess.Popen(
            ["gdb", "--interpreter=mi", "--quiet", self.binary_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    def send(self, cmd):
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def read_until_prompt(self, timeout=10):
        """Read MI records from GDB until the '(gdb)' prompt line, or timeout."""
        records = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            line = line.rstrip("\n").rstrip("\r")
            if line == "(gdb)":
                break
            if not line:
                continue
            records.append(parse_mi_line(line))
        return records

    def extract_stopped_line(self, records):
        """Find the *stopped record and pull out line/file info + stop reason."""
        for rec in records:
            if rec.get("type") == "*" and rec.get("class") == "stopped":
                results = rec["results"]
                frame = results.get("frame", {})
                reason = results.get("reason", "")
                return {
                    "line": frame.get("line"),
                    "file": frame.get("file"),
                    "func": frame.get("func"),
                    "reason": reason,
                    "signal_name": results.get("signal-name"),
                    "signal_meaning": results.get("signal-meaning"),
                }
        return None

    def collect_console_text(self, records):
        text_chunks = []
        for rec in records:
            if rec.get("type") in ("~", "@"):
                text_chunks.append(rec.get("text", ""))
        return "".join(text_chunks)

    def fetch_variables(self):
        self.send("-stack-list-variables --all-values")
        records = self.read_until_prompt()
        for rec in records:
            if rec.get("type") == "^" and rec.get("class") == "done":
                variables = rec["results"].get("variables", [])
                out = {}
                if isinstance(variables, list):
                    for v in variables:
                        if isinstance(v, dict):
                            out[v.get("name", "?")] = v.get("value", "")
                return out
        return {}

    def fetch_stack(self):
        self.send("-stack-list-frames")
        records = self.read_until_prompt()
        for rec in records:
            if rec.get("type") == "^" and rec.get("class") == "done":
                stack = rec["results"].get("stack", [])
                frames = []
                if isinstance(stack, list):
                    for f in stack:
                        frame = f.get("frame", f) if isinstance(f, dict) else {}
                        frames.append({
                            "level": frame.get("level"),
                            "func": frame.get("func"),
                            "line": frame.get("line"),
                        })
                return frames
        return []

    def snapshot(self, stop_info, new_output):
        if new_output:
            self.output_buffer.append(new_output)
        variables = self.fetch_variables()
        stack = self.fetch_stack()
        snap = {
            "line": int(stop_info["line"]) if stop_info and stop_info.get("line") else None,
            "file": stop_info.get("file") if stop_info else None,
            "reason": stop_info.get("reason") if stop_info else None,
            "signal_name": stop_info.get("signal_name") if stop_info else None,
            "signal_meaning": stop_info.get("signal_meaning") if stop_info else None,
            "variables": variables,
            "stack": stack,
            "output": "".join(self.output_buffer),
        }
        return snap

    def touch(self):
        self.last_active = time.time()

    def cleanup(self):
        try:
            if self.proc and self.proc.poll() is None:
                self.send("-gdb-exit")
                self.proc.terminate()
        except Exception:
            pass
        try:
            for f in (self.source_path, self.binary_path):
                if os.path.exists(f):
                    os.remove(f)
            os.rmdir(self.workdir)
        except Exception:
            pass


def reap_idle_sessions():
    while True:
        time.sleep(30)
        now = time.time()
        with SESSIONS_LOCK:
            stale = [sid for sid, s in SESSIONS.items()
                     if now - s.last_active > SESSION_TIMEOUT_SECONDS]
            for sid in stale:
                SESSIONS[sid].cleanup()
                del SESSIONS[sid]


threading.Thread(target=reap_idle_sessions, daemon=True).start()


def get_session():
    sid = session.get("debug_session_id")
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid) if sid else None
    return s


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("templates", "index.html")


@app.route("/api/run", methods=["POST"])
def api_run():
    data = request.get_json(force=True, silent=True) or {}
    code = data.get("code", "")

    if not looks_like_cpp(code):
        return jsonify({"error": "Unsupported language. Only C++ is allowed."}), 400

    # Tear down any previous session tied to this browser session.
    old = get_session()
    if old:
        old.cleanup()
        with SESSIONS_LOCK:
            SESSIONS.pop(old.id, None)

    dbg = DebugSession()
    with open(dbg.source_path, "w") as f:
        f.write(code)

    compile_proc = subprocess.run(
        ["g++", "-g", "-o", dbg.binary_path, dbg.source_path],
        capture_output=True, text=True, timeout=20,
    )

    if compile_proc.returncode != 0:
        line_no = None
        m = re.search(r"temp_code\.cpp:(\d+):", compile_proc.stderr)
        if m:
            line_no = int(m.group(1))
        dbg.cleanup()
        return jsonify({
            "error": "compile_error",
            "line": line_no,
            "message": compile_proc.stderr,
        }), 400

    try:
        dbg.start_gdb()
    except FileNotFoundError:
        dbg.cleanup()
        return jsonify({"error": "GDB is not installed. Please install GDB to use this application."}), 500

    dbg.read_until_prompt()  # initial banner / prompt
    dbg.send("-break-insert main")
    dbg.read_until_prompt()
    dbg.send("-exec-run")
    records = dbg.read_until_prompt()

    stop_info = dbg.extract_stopped_line(records)
    console_text = dbg.collect_console_text(records)

    with SESSIONS_LOCK:
        SESSIONS[dbg.id] = dbg
    session["debug_session_id"] = dbg.id

    if not stop_info:
        dbg.finished = True
        return jsonify({
            "status": "finished",
            "output": console_text,
            "message": "Program exited before reaching main().",
        })

    snap = dbg.snapshot(stop_info, console_text)
    dbg.history.append(snap)

    return jsonify({"status": "stopped", "snapshot": snap, "history_length": len(dbg.history)})


@app.route("/api/step", methods=["POST"])
def api_step():
    data = request.get_json(force=True, silent=True) or {}
    direction = data.get("direction", "forward")

    dbg = get_session()
    if not dbg:
        return jsonify({"error": "No active debug session. Click Run first."}), 400

    dbg.touch()

    with dbg.lock:
        if direction == "back":
            if len(dbg.history) <= 1:
                return jsonify({
                    "status": "stopped",
                    "snapshot": dbg.history[0] if dbg.history else None,
                    "history_length": len(dbg.history),
                    "note": "Already at the first step.",
                })
            dbg.history.pop()
            snap = dbg.history[-1]
            return jsonify({"status": "stopped", "snapshot": snap, "history_length": len(dbg.history)})

        # direction == "forward"
        if dbg.finished:
            return jsonify({"status": "finished", "snapshot": dbg.history[-1] if dbg.history else None})

        dbg.send("-exec-next")
        records = dbg.read_until_prompt()
        console_text = dbg.collect_console_text(records)

        # Did the program run to completion?
        for rec in records:
            if rec.get("type") == "*" and rec.get("class") == "running":
                continue
            if rec.get("type") == "=" and rec.get("class") == "thread-group-exited":
                dbg.finished = True

        stop_info = dbg.extract_stopped_line(records)

        if stop_info and stop_info.get("reason") in ("exited-normally", "exited"):
            dbg.finished = True
            if dbg.output_buffer or console_text:
                dbg.output_buffer.append(console_text)
            return jsonify({
                "status": "finished",
                "output": "".join(dbg.output_buffer),
                "history_length": len(dbg.history),
            })

        if not stop_info:
            dbg.finished = True
            if console_text:
                dbg.output_buffer.append(console_text)
            return jsonify({
                "status": "finished",
                "output": "".join(dbg.output_buffer),
                "history_length": len(dbg.history),
            })

        is_crash = stop_info.get("reason") == "signal-received"
        snap = dbg.snapshot(stop_info, console_text)
        snap["crashed"] = is_crash
        dbg.history.append(snap)

        if is_crash:
            dbg.finished = True

        return jsonify({"status": "stopped", "snapshot": snap, "history_length": len(dbg.history)})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    dbg = get_session()
    if dbg:
        dbg.cleanup()
        with SESSIONS_LOCK:
            SESSIONS.pop(dbg.id, None)
    session.pop("debug_session_id", None)
    return jsonify({"status": "reset"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)

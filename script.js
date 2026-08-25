(() => {
  "use strict";

  const codeInput = document.getElementById("codeInput");
  const codeViewInner = document.getElementById("codeViewInner");
  const codeView = document.getElementById("codeView");
  const gutter = document.getElementById("gutter");

  const btnRun = document.getElementById("btnRun");
  const btnStop = document.getElementById("btnStop");
  const btnBack = document.getElementById("btnBack");
  const btnForward = document.getElementById("btnForward");

  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const varsBody = document.getElementById("varsBody");
  const consoleBody = document.getElementById("consoleBody");
  const frameHint = document.getElementById("frameHint");
  const stepHint = document.getElementById("stepHint");

  const DEFAULT_CODE =
`#include <iostream>
using namespace std;

int square(int x) {
    int result = x * x;
    return result;
}

int main() {
    int a = 3;
    int b = square(a);
    cout << "a = " << a << ", b = " << b << endl;
    return 0;
}
`;

  // ---------------------------------------------------------------------
  // Debug session state (all client-side, backed by the JSCPP interpreter)
  // ---------------------------------------------------------------------

  let mydebugger = null;   // JSCPP debugger instance
  let outputBuf = "";      // accumulated stdout for the running session
  let history = [];        // snapshots: { line, output, variables }
  let finished = false;
  let sessionActive = false;
  let currentLine = null;
  let currentIsCrash = false;

  // ---------------------------------------------------------------------
  // Editor: line numbers + highlight overlay
  // ---------------------------------------------------------------------

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderEditor() {
    const lines = codeInput.value.split("\n");

    gutter.innerHTML = lines
      .map((_, i) => `<div data-line="${i + 1}">${i + 1}</div>`)
      .join("");

    codeViewInner.innerHTML = lines
      .map((line, i) => `<span class="line" data-line="${i + 1}">${escapeHtml(line) || " "}</span>`)
      .join("\n");

    applyLineHighlight();
  }

  function applyLineHighlight() {
    gutter.querySelectorAll("div").forEach((el) => {
      el.classList.remove("active-line", "crash-line");
    });
    codeView.querySelectorAll(".line").forEach((el) => {
      el.classList.remove("active-line", "crash-line");
    });

    if (currentLine == null) return;

    const cls = currentIsCrash ? "crash-line" : "active-line";
    const gutterEl = gutter.querySelector(`div[data-line="${currentLine}"]`);
    const lineEl = codeView.querySelector(`.line[data-line="${currentLine}"]`);
    if (gutterEl) gutterEl.classList.add(cls);
    if (lineEl) {
      lineEl.classList.add(cls);
      lineEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function syncScroll() {
    gutter.scrollTop = codeInput.scrollTop;
    codeView.scrollTop = codeInput.scrollTop;
    codeView.scrollLeft = codeInput.scrollLeft;
  }

  codeInput.addEventListener("input", renderEditor);
  codeInput.addEventListener("scroll", syncScroll);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = codeInput.selectionStart;
      const end = codeInput.selectionEnd;
      codeInput.value = codeInput.value.slice(0, start) + "    " + codeInput.value.slice(end);
      codeInput.selectionStart = codeInput.selectionEnd = start + 4;
      renderEditor();
    }
  });

  codeInput.value = DEFAULT_CODE;
  renderEditor();

  // ---------------------------------------------------------------------
  // Status + panel rendering
  // ---------------------------------------------------------------------

  function setStatus(kind, text) {
    statusDot.className = "dot " + (kind || "");
    statusText.textContent = text;
  }

  function renderVariables(vars) {
    if (!vars || Object.keys(vars).length === 0) {
      varsBody.innerHTML = `<p class="empty-hint">No local variables in this frame.</p>`;
      return;
    }
    varsBody.innerHTML = Object.entries(vars)
      .map(([name, value]) => `
        <div class="var-row">
          <span class="var-name">${escapeHtml(name)}</span>
          <span class="var-value">${escapeHtml(String(value))}</span>
        </div>
      `)
      .join("");
  }

  function renderConsole(text, isError) {
    consoleBody.textContent = text && text.length ? text : "(no output yet)";
    consoleBody.classList.toggle("err-line", !!isError);
  }

  function renderFrameHint(text) {
    frameHint.textContent = text || "—";
  }

  function updateButtons() {
    btnStop.disabled = !sessionActive && history.length === 0;
    btnBack.disabled = history.length <= 1;
    btnForward.disabled = !sessionActive || finished;
  }

  // ---------------------------------------------------------------------
  // Pulling readable variable values out of JSCPP's debugger
  // ---------------------------------------------------------------------

  function readVariables() {
    if (!mydebugger || typeof mydebugger.variable !== "function") return {};
    let raw;
    try {
      raw = mydebugger.variable();
    } catch (e) {
      return {};
    }
    if (!raw || typeof raw !== "object") return {};

    const out = {};
    for (const name of Object.keys(raw)) {
      if (name === "this" || name.startsWith("__")) continue;
      const entry = raw[name];
      out[name] = stringifyValue(entry);
    }
    return out;
  }

  function stringifyValue(entry) {
    try {
      if (entry == null) return "null";
      // JSCPP variable entries are typically { t: <type>, v: <value> }
      if (typeof entry === "object" && "v" in entry) {
        const v = entry.v;
        if (v && typeof v === "object" && "value" in v) return String(v.value);
        if (Array.isArray(v)) return "[" + v.map(stringifyValue).join(", ") + "]";
        return String(v);
      }
      if (typeof entry === "object") return JSON.stringify(entry);
      return String(entry);
    } catch (e) {
      return "?";
    }
  }

  function currentFunctionName() {
    try {
      const node = mydebugger.nextNode ? mydebugger.nextNode() : null;
      return node && node.sLine ? `near line ${node.sLine}` : "—";
    } catch (e) {
      return "—";
    }
  }

  // ---------------------------------------------------------------------
  // Snapshot / history (drives Step Back — a replay of recorded state,
  // since true reverse execution isn't something the interpreter offers)
  // ---------------------------------------------------------------------

  function pushSnapshot(line, crashed) {
    const snap = {
      line,
      output: outputBuf,
      variables: readVariables(),
      frame: currentFunctionName(),
      crashed: !!crashed,
    };
    history.push(snap);
    return snap;
  }

  function applySnapshot(snap) {
    if (!snap) return;
    currentLine = snap.line;
    currentIsCrash = !!snap.crashed;
    applyLineHighlight();
    renderVariables(snap.variables);
    renderFrameHint(snap.frame);
    renderConsole(snap.output, currentIsCrash);
    stepHint.textContent = `step ${history.indexOf(snap) + 1} / ${history.length}`;

    if (currentIsCrash) {
      setStatus("error", `Crashed at line ${snap.line}`);
    } else {
      setStatus("running", `Stopped at line ${snap.line}`);
    }
  }

  // ---------------------------------------------------------------------
  // Run / Step controls
  // ---------------------------------------------------------------------

  function resetState() {
    mydebugger = null;
    outputBuf = "";
    history = [];
    finished = false;
    sessionActive = false;
    currentLine = null;
    currentIsCrash = false;
  }

  function runProgram() {
    if (typeof JSCPP === "undefined") {
      setStatus("error", "Interpreter failed to load");
      renderConsole(
        "The JSCPP interpreter script didn't load (check your internet connection or the CDN link in index.html).",
        true
      );
      return;
    }

    resetState();
    applyLineHighlight();
    renderVariables(null);
    renderFrameHint(null);
    stepHint.textContent = "step 0 / 0";
    setStatus("running", "Starting…");
    renderConsole("Running…", false);

    const config = {
      stdio: {
        write: (s) => { outputBuf += s; },
      },
      debug: true,
      unsigned_overflow: "ignore",
    };

    try {
      mydebugger = JSCPP.run(codeInput.value, "", config);
    } catch (err) {
      sessionActive = false;
      finished = true;
      updateButtons();
      const msg = (err && err.message) ? err.message : String(err);
      const lineMatch = /line[:\s]+(\d+)/i.exec(msg);
      currentLine = lineMatch ? parseInt(lineMatch[1], 10) : null;
      currentIsCrash = true;
      applyLineHighlight();
      setStatus("error", "Interpreter error");
      renderConsole("Error: " + msg, true);
      return;
    }

    sessionActive = true;
    finished = false;
    updateButtons();

    // Land on the first executable line.
    advanceToNextStatement(true);
  }

  function advanceToNextStatement(isFirstStep) {
    if (!mydebugger) return;

    try {
      let node = null;
      let done = false;

      if (!isFirstStep) {
        done = mydebugger.next();
      }

      if (done !== false && done !== undefined) {
        finishRun(done);
        return;
      }

      // Some breakpoints land between statements (e.g. entering a call);
      // keep stepping until we have a concrete statement to show.
      let guard = 0;
      node = mydebugger.nextNode ? mydebugger.nextNode() : null;
      while (node == null && guard < 200) {
        done = mydebugger.next();
        if (done !== false && done !== undefined) {
          finishRun(done);
          return;
        }
        node = mydebugger.nextNode ? mydebugger.nextNode() : null;
        guard++;
      }

      const line = node ? node.sLine : currentLine;
      const snap = pushSnapshot(line, false);
      applySnapshot(snap);
      updateButtons();
    } catch (err) {
      finished = true;
      sessionActive = true; // keep history/back available
      const msg = (err && err.message) ? err.message : String(err);
      const snap = pushSnapshot(currentLine, true);
      snap.output = outputBuf + "\n\n[Runtime error] " + msg;
      applySnapshot(snap);
      updateButtons();
    }
  }

  function finishRun(done) {
    finished = true;
    sessionActive = true; // history + Step Back stay usable
    updateButtons();
    const code = (done && typeof done === "object" && "v" in done) ? done.v : done;
    setStatus("done", `Finished (exit code ${code})`);
    const snap = pushSnapshot(currentLine, false);
    snap.output = outputBuf + `\n\n[Program exited with code ${code}]`;
    applySnapshot(snap);
  }

  function stepForward() {
    if (!sessionActive || finished) return;
    advanceToNextStatement(false);
  }

  function stepBack() {
    if (history.length <= 1) return;
    history.pop();
    finished = false;
    const snap = history[history.length - 1];
    updateButtons();
    applySnapshot(snap);
  }

  function stopReset() {
    resetState();
    applyLineHighlight();
    renderVariables(null);
    renderFrameHint(null);
    renderConsole("Ready. Paste C++ code and hit Run.", false);
    stepHint.textContent = "step 0 / 0";
    setStatus("", "Idle");
    updateButtons();
  }

  btnRun.addEventListener("click", runProgram);
  btnForward.addEventListener("click", stepForward);
  btnBack.addEventListener("click", stepBack);
  btnStop.addEventListener("click", stopReset);

  updateButtons();
})();
        

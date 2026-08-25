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

int square(int x) {
    int result = x * x;
    return result;
}

int main() {
    int a = 3;
    int b = square(a);
    std::cout << "a = " << a << ", b = " << b << std::endl;
    return 0;
}
`;

  let sessionActive = false;
  let historyLength = 0;
  let currentLine = null;
  let currentIsCrash = false;

  // ---------------------------------------------------------------------
  // Editor: line numbers + syntax-free highlight overlay
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

  function renderFrameHint(snapshot) {
    if (!snapshot) { frameHint.textContent = "—"; return; }
    const stackTop = (snapshot.stack && snapshot.stack[0]) || {};
    frameHint.textContent = stackTop.func ? `in ${stackTop.func}()` : "—";
  }

  function updateButtons() {
    btnStop.disabled = !sessionActive;
    btnBack.disabled = !sessionActive || historyLength <= 1;
    btnForward.disabled = !sessionActive || (sessionActive && window.__finished === true);
  }

  function applySnapshot(snapshot, opts = {}) {
    if (!snapshot) return;
    currentLine = snapshot.line;
    currentIsCrash = !!snapshot.crashed || snapshot.reason === "signal-received";
    applyLineHighlight();
    renderVariables(snapshot.variables);
    renderFrameHint(snapshot);
    renderConsole(snapshot.output, currentIsCrash);
    stepHint.textContent = `step ${opts.historyLength ?? historyLength} / ${opts.historyLength ?? historyLength}`;

    if (currentIsCrash) {
      const sig = snapshot.signal_meaning || snapshot.signal_name || "runtime error";
      setStatus("error", `Crashed: ${sig} (line ${snapshot.line})`);
    } else {
      setStatus("running", `Stopped at line ${snapshot.line}`);
    }
  }

  // ---------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    return { ok: res.ok, status: res.status, data };
  }

  function showCompileError(line, message) {
    currentLine = line;
    currentIsCrash = true;
    applyLineHighlight();
    renderConsole(message || "Compilation failed.", true);
    setStatus("error", line ? `Compile error at line ${line}` : "Compile error");
  }

  async function runProgram() {
    setStatus("running", "Compiling…");
    renderConsole("Compiling…", false);
    currentLine = null;
    currentIsCrash = false;
    applyLineHighlight();

    btnRun.disabled = true;

    const { ok, status, data } = await postJson("/api/run", { code: codeInput.value });

    btnRun.disabled = false;

    if (!ok) {
      sessionActive = false;
      historyLength = 0;
      updateButtons();
      if (data.error === "compile_error" || status === 400 && data.line !== undefined) {
        showCompileError(data.line, data.message);
      } else {
        setStatus("error", data.error || "Run failed.");
        renderConsole(data.error || "Run failed.", true);
      }
      return;
    }

    if (data.status === "finished") {
      sessionActive = false;
      historyLength = 0;
      window.__finished = true;
      updateButtons();
      setStatus("done", "Finished (no breakpoint hit)");
      renderConsole(data.output || data.message || "Program finished.", false);
      return;
    }

    sessionActive = true;
    historyLength = data.history_length || 1;
    window.__finished = false;
    updateButtons();
    applySnapshot(data.snapshot, { historyLength });
  }

  async function stepForward() {
    if (!sessionActive) return;
    const { ok, data } = await postJson("/api/step", { direction: "forward" });
    if (!ok) {
      setStatus("error", data.error || "Step failed.");
      return;
    }
    if (data.status === "finished") {
      window.__finished = true;
      sessionActive = true; // keep Step Back / Stop usable
      updateButtons();
      setStatus("done", "Program finished");
      renderConsole(data.output || "Program finished.", false);
      currentLine = null;
      currentIsCrash = false;
      applyLineHighlight();
      return;
    }
    historyLength = data.history_length || historyLength;
    updateButtons();
    applySnapshot(data.snapshot, { historyLength });
  }

  async function stepBack() {
    if (!sessionActive || historyLength <= 1) return;
    const { ok, data } = await postJson("/api/step", { direction: "back" });
    if (!ok) {
      setStatus("error", data.error || "Step back failed.");
      return;
    }
    window.__finished = false;
    historyLength = data.history_length || historyLength;
    updateButtons();
    if (data.snapshot) applySnapshot(data.snapshot, { historyLength });
  }

  async function stopReset() {
    await postJson("/api/reset", {});
    sessionActive = false;
    historyLength = 0;
    window.__finished = false;
    currentLine = null;
    currentIsCrash = false;
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

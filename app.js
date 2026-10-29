(() => {
  "use strict";

  const BOOK = window.BOOK;
  const STORE_KEY = "moby-type:v1";
  const IDLE_MS = 5000; // gaps longer than this don't count as typing time
  const TOTAL_CHARS = BOOK.reduce((n, c) => n + c.text.length, 0);
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------

  const defaults = () => ({
    v: 1,
    current: 2, // Chapter 1. Etymology and Extracts are there if you want them.
    chapters: {},
    days: {},
    missedWords: {},
    missedKeys: {},
    settings: { strict: false, fade: true, size: 22, theme: "system" },
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaults();
        return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
      }
    } catch (e) {
      console.warn("could not load progress", e);
    }
    return defaults();
  }

  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } catch (e) {
        toast("Couldn't save progress in this browser. Use export in settings to keep a copy.");
      }
    };
    if (now) write();
    else saveTimer = setTimeout(write, 800);
  }
  addEventListener("beforeunload", () => save(true));
  document.addEventListener("visibilitychange", () => document.hidden && save(true));

  function chap(i) {
    return (state.chapters[i] ||= { pos: 0, wrong: {}, ok: 0, bad: 0, ms: 0, done: false });
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function day() {
    return (state.days[today()] ||= { chars: 0, bad: 0, ms: 0 });
  }

  // ---------- matching ----------

  const FOLD = {
    "’": "'‘’`", "‘": "'‘’`", "'": "'‘’`",
    "“": "\"“”", "”": "\"“”", "\"": "\"“”",
    "—": "-—–", "–": "-—–",
    "æ": "aæ", "œ": "oœ", "Œ": "OŒ", "£": "£#",
  };

  function matches(exp, c) {
    if (exp === c) return true;
    if (exp === "\n") return c === "\n" || c === " ";
    if (FOLD[exp]) return FOLD[exp].includes(c);
    const base = exp.normalize("NFD")[0];
    if (base !== exp && base.charCodeAt(0) < 128) return c === base; // é -> e
    if (exp.charCodeAt(0) > 127) return c !== " " && c !== "\n"; // Hebrew, Greek: any key
    return false;
  }

  const WORD_CH = /[\p{L}\p{N}'’-]/u;
  function wordAt(text, i) {
    if (!WORD_CH.test(text[i])) return null;
    let a = i, b = i;
    while (a > 0 && WORD_CH.test(text[a - 1])) a--;
    while (b < text.length && WORD_CH.test(text[b])) b++;
    const w = text.slice(a, b).replace(/’/g, "'").replace(/^['-]+|['-]+$/g, "").toLowerCase();
    return w || null;
  }

  const showKey = (c) => (c === " " ? "␣" : c === "\n" ? "↵" : c);

  // ---------- typing view ----------

  let idx, text, paraStarts, para; // current chapter
  let spans = []; // spans of the current paragraph, indexed from paraStarts[para]
  let lastKey = 0;
  let paused = false;
  const session = { ok: 0, bad: 0, ms: 0 };

  const textEl = $("text"), caretEl = $("caret"), scroller = $("scroller"), input = $("input");

  function openChapter(i) {
    idx = i;
    state.current = i;
    text = BOOK[i].text;
    paraStarts = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === "\n") paraStarts.push(k + 1);
    $("chap-label").textContent = BOOK[i].label;
    $("chap-title").textContent = BOOK[i].title ? "· " + BOOK[i].title : "";
    $("done-card").hidden = true;
    render(true);
    if (chap(i).pos >= text.length) showDone();
    save();
  }

  function paraOf(pos) {
    let lo = 0, hi = paraStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (paraStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const paraEnd = (p) => (p + 1 < paraStarts.length ? paraStarts[p + 1] : text.length); // exclusive

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  function plainPara(p, done) {
    const c = chap(idx), a = paraStarts[p], b = paraEnd(p);
    let html = "", run = a;
    if (done) {
      for (let k = a; k < b; k++) {
        if (c.wrong[k] !== undefined && text[k] !== "\n") {
          html += esc(text.slice(run, k)) + `<span class="bad">${esc(text[k])}</span>`;
          run = k + 1;
        }
      }
    }
    html += esc(text.slice(run, b).replace(/\n$/, ""));
    return `<p class="${done ? "done" : "todo"}">${html}</p>`;
  }

  function charClass(k) {
    const c = chap(idx);
    const base = text[k] === "\n" ? "nl " : "";
    if (k >= c.pos) return base;
    return base + (c.wrong[k] !== undefined ? "bad" : "ok");
  }

  // Re-render the window of paragraphs around the caret.
  function render(jump) {
    const c = chap(idx);
    const pos = Math.min(c.pos, text.length);
    const before = caretEl.offsetTop - scroller.scrollTop;
    para = paraOf(pos);
    // While paused, render the whole chapter so far so it can be re-read.
    const from = paused ? 0 : Math.max(0, para - 3), to = Math.min(paraStarts.length - 1, para + 4);
    let html = "";
    for (let p = from; p <= to; p++) {
      if (p !== para) { html += plainPara(p, p < para); continue; }
      html += "<p class=\"cur\">";
      for (let k = paraStarts[p]; k < paraEnd(p); k++) {
        const ch = text[k] === "\n" ? "¶" : esc(text[k]);
        html += `<span class="${charClass(k)}">${ch}</span>`;
      }
      html += "</p>";
    }
    textEl.innerHTML = html;
    textEl.prepend(caretEl);
    spans = textEl.querySelector("p.cur").children;
    if (!jump) scroller.scrollTop = caretPos().top - before; // keep caret visually still
    placeCaret(jump);
  }

  function caretPos() {
    const pos = chap(idx).pos;
    const s = spans[pos - paraStarts[para]];
    if (s) return { left: s.offsetLeft, top: s.offsetTop, h: s.offsetHeight };
    const last = spans[spans.length - 1]; // end of book chapter
    return last ? { left: last.offsetLeft + last.offsetWidth, top: last.offsetTop, h: last.offsetHeight } : { left: 0, top: 0, h: 20 };
  }

  function placeCaret(jump) {
    const { left, top, h } = caretPos();
    caretEl.style.left = left - 1 + "px";
    caretEl.style.top = top + h * 0.12 + "px";
    caretEl.style.height = h * 0.76 + "px";
    const target = top - scroller.clientHeight * 0.33;
    if (jump) scroller.scrollTop = target;
    else if (Math.abs(scroller.scrollTop - target) > h * 0.5) scroller.scrollTo({ top: target, behavior: "smooth" });
  }

  function refresh(k) {
    const s = spans[k - paraStarts[para]];
    if (s) s.className = charClass(k);
  }

  function tick() {
    const now = performance.now();
    const dt = now - lastKey;
    lastKey = now;
    if (dt < IDLE_MS) {
      chap(idx).ms += dt;
      day().ms += dt;
      session.ms += dt;
    }
    document.body.classList.add("typing");
    clearTimeout(tick.t);
    tick.t = setTimeout(() => document.body.classList.remove("typing"), 2500);
  }

  function type(ch) {
    if (!$("done-card").hidden) return;
    const c = chap(idx);
    if (c.pos >= text.length) return;
    tick();
    const exp = text[c.pos];
    const ok = matches(exp, ch);
    if (ok) {
      c.ok++; session.ok++; day().chars++;
    } else {
      c.bad++; session.bad++; day().bad++;
      const w = wordAt(text, c.pos);
      if (w) state.missedWords[w] = (state.missedWords[w] || 0) + 1;
      const key = showKey(exp) + "→" + showKey(ch);
      state.missedKeys[key] = (state.missedKeys[key] || 0) + 1;
      if (state.settings.strict || exp === "\n") { shake(); stats(); save(); return; }
      c.wrong[c.pos] = ch;
    }
    c.pos++;
    if (c.pos >= text.length) {
      c.done = true;
      refresh(c.pos - 1);
      placeCaret();
      showDone();
    } else if (c.pos >= paraEnd(para)) {
      render();
    } else {
      refresh(c.pos - 1);
      placeCaret();
    }
    stats();
    save();
  }

  function back(word) {
    const c = chap(idx);
    const floor = paraStarts[para];
    if (c.pos <= floor || c.pos > text.length || !$("done-card").hidden) return;
    tick();
    do {
      c.pos--;
      delete c.wrong[c.pos];
      refresh(c.pos);
    } while (word && c.pos > floor && !(text[c.pos - 1] === " " && text[c.pos] !== " "));
    placeCaret();
    stats();
    save();
  }

  function shake() {
    textEl.classList.remove("shake");
    void textEl.offsetWidth;
    textEl.classList.add("shake");
  }

  const pct = (n) => Math.floor(n * 100);
  const wpm = (chars, ms) => (ms > 1000 ? Math.round(chars / 5 / (ms / 60000)) : 0);
  const acc = (ok, bad) => (ok + bad ? Math.round((ok / (ok + bad)) * 100) : 100);
  const typedTotal = () => Object.values(state.chapters).reduce((n, c) => n + c.pos, 0);

  function stats() {
    const c = chap(idx);
    $("live-wpm").textContent = wpm(session.ok, session.ms);
    $("live-acc").textContent = acc(session.ok, session.bad);
    $("live-chap").textContent = pct(c.pos / text.length);
    $("live-book").textContent = ((typedTotal() / TOTAL_CHARS) * 100).toFixed(1);
  }

  function showDone() {
    const c = chap(idx);
    $("done-label").textContent = BOOK[idx].label + " complete";
    $("done-title").textContent = BOOK[idx].title || BOOK[idx].label;
    $("done-wpm").textContent = wpm(c.ok, c.ms);
    $("done-acc").textContent = acc(c.ok, c.bad) + "%";
    $("done-time").textContent = fmtTime(c.ms);
    $("done-next").hidden = idx >= BOOK.length - 1;
    $("done-card").hidden = false;
  }

  function nextChapter() {
    if (idx < BOOK.length - 1) openChapter(idx + 1);
  }

  // ---------- input ----------

  let composing = false;
  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => { composing = false; flush(); });
  input.addEventListener("input", (e) => {
    if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") { input.value = ""; return; }
    if (!composing) flush();
  });
  function flush() {
    const v = input.value;
    input.value = "";
    for (const ch of v) type(ch === "\r" ? "\n" : ch);
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace") { e.preventDefault(); back(e.altKey || e.ctrlKey || e.metaKey); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!$("done-card").hidden) nextChapter(); else type("\n");
    } else if (e.key === "Escape") input.blur();
    else if (e.key === "Tab") e.preventDefault();
  });
  function setPaused(p) {
    if (paused === p) return;
    paused = p;
    $("view-type").classList.toggle("paused", p);
    if (p) document.body.classList.remove("typing");
    if (view === "type" && idx !== undefined) render();
  }
  input.addEventListener("blur", () => setPaused(true));
  input.addEventListener("focus", () => setPaused(false));
  // Clicking resumes, unless you're selecting text to re-read it.
  scroller.addEventListener("click", () => { if (!getSelection().toString()) input.focus(); });
  $("focus-hint").addEventListener("click", () => input.focus());
  const SCROLL_KEYS = { ArrowUp: -0.15, ArrowDown: 0.15, PageUp: -0.8, PageDown: 0.8 };
  document.addEventListener("keydown", (e) => {
    if (view !== "type" || document.activeElement === input || e.metaKey || e.ctrlKey) return;
    if (SCROLL_KEYS[e.key]) {
      e.preventDefault();
      // Arrows repeat while held, and repeated smooth scrolls cancel each other out.
      const smooth = e.key.startsWith("Page") ? "smooth" : "instant";
      scroller.scrollBy({ top: SCROLL_KEYS[e.key] * scroller.clientHeight, behavior: smooth });
    } else if (e.key.length === 1 || e.key === "Enter") input.focus();
  });
  $("done-next").addEventListener("click", nextChapter);
  $("restart-chapter").addEventListener("click", () => {
    if (!confirm(`Restart ${BOOK[idx].label}? Your position goes back to the start (stats are kept).`)) return;
    const c = chap(idx);
    c.pos = 0; c.wrong = {}; c.done = false;
    openChapter(idx);
    input.focus();
  });
  addEventListener("resize", () => view === "type" && render(true));

  // ---------- views ----------

  let view = "type";
  function go(v) {
    view = v;
    for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== "view-" + v;
    for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.go === v);
    if (v === "type") { openChapter(state.current); stats(); input.focus(); }
    if (v === "chapters") renderChapters();
    if (v === "stats") renderStats();
    if (v === "settings") renderSettings();
    if (location.hash.slice(1) !== v) history.replaceState(null, "", "#" + v);
  }
  for (const b of document.querySelectorAll("[data-go]")) b.addEventListener("click", () => go(b.dataset.go));

  function fmtTime(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return Math.round(ms / 1000) + "s";
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  const fmt = (n) => n.toLocaleString("en-US");

  function totals() {
    let ok = 0, bad = 0, ms = 0;
    for (const c of Object.values(state.chapters)) { ok += c.ok; bad += c.bad; ms += c.ms; }
    return { ok, bad, ms, typed: typedTotal() };
  }

  function renderChapters() {
    const t = totals();
    const p = t.typed / TOTAL_CHARS;
    $("bp-pct").textContent = (p * 100).toFixed(1) + "%";
    $("bp-bar").style.width = p * 100 + "%";
    const avg = wpm(t.ok, t.ms);
    const left = avg ? fmtTime(((TOTAL_CHARS - t.typed) / 5 / avg) * 60000) : "—";
    const done = BOOK.filter((_, i) => chap(i).done).length;
    $("bp-sub").textContent =
      `${fmt(Math.round(t.typed / 5))} of ${fmt(Math.round(TOTAL_CHARS / 5))} words · ${done}/${BOOK.length} chapters · ` +
      `${fmtTime(t.ms)} at sea` + (avg ? ` · ~${left} to go at ${avg} wpm` : "");

    $("chapter-list").innerHTML = BOOK.map((b, i) => {
      const c = state.chapters[i];
      const cp = c ? c.pos / b.text.length : 0;
      const cls = [i === state.current ? "current" : "", c && c.done ? "complete" : ""].join(" ");
      const right = c && c.done ? `✓ ${acc(c.ok, c.bad)}%` : cp > 0 ? pct(cp) + "%" : `${fmt(Math.round(b.text.length / 5))} words`;
      return `<li class="${cls}"><button data-ch="${i}">
        <div class="cl-top"><span>${b.label}</span><span>${right}</span></div>
        <div class="cl-title">${esc(b.title || b.label)}</div>
        <div class="bar"><i style="width:${cp * 100}%"></i></div>
      </button></li>`;
    }).join("");
  }
  $("chapter-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ch]");
    if (!b) return;
    state.current = +b.dataset.ch;
    save();
    go("type");
  });

  function streak() {
    let n = 0;
    const d = new Date();
    const key = () => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!state.days[key()]?.chars) d.setDate(d.getDate() - 1); // today doesn't break it yet
    while (state.days[key()]?.chars) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function renderStats() {
    const t = totals();
    const tiles = [
      [fmt(Math.round(t.ok / 5)), "words typed"],
      [fmtTime(t.ms), "time typing"],
      [wpm(t.ok, t.ms), "average wpm"],
      [acc(t.ok, t.bad) + "%", "accuracy"],
      [fmt(t.bad), "mistakes"],
      [streak() + (streak() === 1 ? " day" : " days"), "streak"],
    ];
    $("tiles").innerHTML = tiles.map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join("");

    rank($("missed-words"), state.missedWords, (w) => esc(w), "No missed words yet. Suspicious.");
    rank($("missed-keys"), state.missedKeys, (k) => `<code>${esc(k)}</code>`, "No confused keys yet.");

    const worst = BOOK.map((b, i) => ({ i, c: state.chapters[i] }))
      .filter((x) => x.c && x.c.ok + x.c.bad >= 200)
      .map((x) => ({ ...x, a: x.c.ok / (x.c.ok + x.c.bad) }))
      .sort((a, b) => a.a - b.a)
      .slice(0, 8);
    $("worst-chapters").innerHTML = worst.length
      ? worst.map((x) => `<li><span class="w">${BOOK[x.i].label}${BOOK[x.i].title ? " · " + esc(BOOK[x.i].title) : ""}</span>
          <div class="bar"><i style="width:${(1 - x.a) * 100 * 5}%"></i></div><span class="n">${(x.a * 100).toFixed(1)}%</span></li>`).join("")
      : `<li class="empty">Type a bit more first.</li>`;

    chart();
  }

  function rank(el, counts, label, empty) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!top.length) { el.innerHTML = `<li class="empty">${empty}</li>`; return; }
    const max = top[0][1];
    el.innerHTML = top.map(([k, n]) =>
      `<li><span class="w">${label(k)}</span><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><span class="n">${n}</span></li>`
    ).join("");
  }

  function chart() {
    const el = $("chart");
    const days = [];
    const d = new Date();
    d.setDate(d.getDate() - 29);
    for (let k = 0; k < 30; k++) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const v = state.days[key] || { chars: 0, ms: 0 };
      days.push({ date: new Date(d), words: Math.round(v.chars / 5), ms: v.ms });
      d.setDate(d.getDate() + 1);
    }
    const W = el.clientWidth || 600, H = 180, L = 40, B = 22, T = 10;
    const max = Math.max(...days.map((x) => x.words));
    const step = niceStep(max / 3 || 1);
    const top = Math.max(step, Math.ceil(max / step) * step);
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const slot = (W - L) / days.length;
    const bw = Math.max(2, slot - 4);
    const short = (dt) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Words typed per day, last 30 days">`;
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
    }
    days.forEach((x, k) => {
      const bx = L + k * slot + (slot - bw) / 2;
      const by = y(x.words), bh = y(0) - by;
      svg += `<rect class="hit" data-k="${k}" x="${L + k * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>`;
      if (bh > 0) {
        const r = Math.min(4, bw / 2, bh);
        svg += `<path class="b" d="M${bx},${y(0)} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + bw - r} Q${bx + bw},${by} ${bx + bw},${by + r} V${y(0)} Z"/>`;
      }
    });
    [0, 14, 29].forEach((k) => {
      svg += `<text class="ax" x="${L + k * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${k === 29 ? "today" : short(days[k].date)}</text>`;
    });
    svg += "</svg><div class=\"tip\" hidden></div>";
    el.innerHTML = svg;

    const tip = el.querySelector(".tip");
    el.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("mouseenter", () => {
        const x = days[+r.dataset.k];
        tip.innerHTML = `<b>${fmt(x.words)} words</b><span>${short(x.date)} · ${fmtTime(x.ms)}</span>`;
        tip.style.left = (+r.getAttribute("x") + slot / 2) * (el.clientWidth / W) + "px";
        tip.style.top = Math.min(y(x.words), H - B - 4) - 8 + "px";
        tip.hidden = false;
      });
      r.addEventListener("mouseleave", () => (tip.hidden = true));
    });
  }

  function niceStep(raw) {
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }

  // ---------- settings ----------

  const media = matchMedia("(prefers-color-scheme: light)");
  function applySettings() {
    const s = state.settings;
    const theme = s.theme === "system" ? (media.matches ? "light" : "dark") : s.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--text-size", s.size + "px");
    document.body.classList.toggle("fade", s.fade);
  }
  media.addEventListener("change", applySettings);

  function renderSettings() {
    const s = state.settings;
    $("set-strict").checked = s.strict;
    $("set-fade").checked = s.fade;
    $("set-size").value = s.size;
    $("set-size-val").textContent = s.size + "px";
    $("set-theme").value = s.theme;
  }
  const bind = (id, key, get) => $(id).addEventListener("input", (e) => {
    state.settings[key] = get(e.target);
    applySettings(); renderSettings(); save();
  });
  bind("set-strict", "strict", (el) => el.checked);
  bind("set-fade", "fade", (el) => el.checked);
  bind("set-size", "size", (el) => +el.value);
  bind("set-theme", "theme", (el) => el.value);

  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `moby-type-progress-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (s.v !== 1 || typeof s.chapters !== "object") throw new Error("not a moby-type file");
      if (!confirm("Replace your current progress with this file?")) return;
      const d = defaults();
      state = { ...d, ...s, settings: { ...d.settings, ...s.settings } };
      save(true); applySettings(); renderSettings();
      toast("Progress imported.");
    } catch (err) {
      toast("That file didn't look like a moby-type backup.");
    } finally {
      e.target.value = "";
    }
  });
  $("reset").addEventListener("click", () => {
    if (!confirm("Really wipe all progress, stats and mistakes? This can't be undone.")) return;
    state = defaults();
    save(true); applySettings(); renderSettings();
    toast("Fresh start. Call me Ishmael.");
  });

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- boot ----------

  applySettings();
  const start = location.hash.slice(1);
  document.fonts.ready.then(() => view === "type" && render(true));
  go(["type", "chapters", "stats", "settings"].includes(start) ? start : "type");
})();

"use strict";
(() => {
  // ================================================================ basics
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage"), world = $("#world"), objsG = $("#objs"), overlay = $("#overlay");
  const cursorsEl = $("#cursors"), titleInput = $("#title"), statusEl = $("#status"), ctxEl = $("#ctx");
  const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };
  const coarse = matchMedia("(pointer: coarse)").matches;

  const NOTE_COLORS = ["#fff9b1", "#ffd59e", "#ffc6d9", "#d4f5b3", "#bfe6ff", "#e0d1ff", "#ffffff"];
  const INK_COLORS = ["#1f1f1f", "#e03131", "#f08c00", "#2f9e44", "#1971c2", "#9c36b5", "#868e96"];
  const USER_COLORS = ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#9c36b5", "#0c8599", "#d6336c", "#5f3dc4"];
  const ANIMALS = ["Otter", "Fox", "Panda", "Koala", "Lynx", "Heron", "Badger", "Gecko", "Moose", "Yak", "Puffin", "Walrus", "Ibex", "Marmot", "Owl", "Seal"];
  const TEXTABLE = new Set(["note", "shape", "text"]);
  const CONNECTABLE = new Set(["note", "shape", "text", "image"]);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : "#888888");

  // ================================================================ board id, me, view
  const newBoardId = () => Math.random().toString(36).slice(2, 7) + "-" + Math.random().toString(36).slice(2, 7);
  let boardId = new URLSearchParams(location.search).get("b");
  if (!boardId || !/^[\w-]{1,40}$/.test(boardId)) {
    boardId = newBoardId();
    history.replaceState(null, "", "?b=" + boardId);
  }

  let me = store.get("wb.me", null);
  if (!me || !me.id) {
    me = { id: uid(), name: "Anonymous " + pick(ANIMALS), color: pick(USER_COLORS) };
    store.set("wb.me", me);
  }
  let cursor = null; // my pointer in world coordinates (sent as presence)

  const savedView = store.get("wb.view." + boardId, null);
  let view = savedView || { x: innerWidth / 2, y: innerHeight / 2, s: 1 };

  // ================================================================ state
  const objects = new Map(); // id → object
  const els = new Map(); // id → <g>
  let selection = new Set();
  let editingId = null;
  let tool = "select";
  let noteColor = store.get("wb.noteColor", NOTE_COLORS[0]);
  let inkColor = store.get("wb.inkColor", INK_COLORS[0]);
  const active = new Set(); // ids I'm dragging right now → ignore remote updates for them

  // ================================================================ undo / redo
  let tx = null;
  const undoStack = [], redoStack = [];
  const begin = () => { if (!tx) tx = new Map(); };
  const record = (id) => { if (tx && !tx.has(id)) tx.set(id, objects.has(id) ? clone(objects.get(id)) : null); };
  function commit() {
    if (!tx) return;
    const before = tx;
    tx = null;
    const after = new Map();
    let changed = false;
    for (const [id, b] of before) {
      const a = objects.has(id) ? clone(objects.get(id)) : null;
      after.set(id, a);
      if (JSON.stringify(a) !== JSON.stringify(b)) changed = true;
    }
    if (!changed) return;
    undoStack.push({ before, after });
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function applyStates(states) {
    for (const [id, o] of states) o ? putObj(clone(o), false) : removeObj(id, false);
    drawSelection();
  }
  function undo() { finishEdit(); const e = undoStack.pop(); if (e) { applyStates(e.before); redoStack.push(e); } }
  function redo() { finishEdit(); const e = redoStack.pop(); if (e) { applyStates(e.after); undoStack.push(e); } }

  // ================================================================ mutations (every local change goes through here)
  function putObj(o, rec = true) {
    if (rec) record(o.id);
    objects.set(o.id, o);
    render(o);
    renderDependents(o.id);
    queue(o.id);
  }
  function updateObj(id, patch) {
    const o = objects.get(id);
    if (!o) return;
    record(id);
    Object.assign(o, patch);
    render(o);
    renderDependents(id);
    queue(id);
  }
  function removeObj(id, rec = true) {
    const o = objects.get(id);
    if (!o) return;
    if (rec) {
      // detach connectors that point at this object so they stay where they are
      for (const l of objects.values()) {
        if (l.type !== "line" || (l.from !== id && l.to !== id)) continue;
        const [a, b] = lineEnds(l);
        const patch = { x1: r1(a[0]), y1: r1(a[1]), x2: r1(b[0]), y2: r1(b[1]) };
        if (l.from === id) patch.from = null;
        if (l.to === id) patch.to = null;
        updateObj(l.id, patch);
      }
      record(id);
    }
    objects.delete(id);
    unrender(id);
    selection.delete(id);
    renderDependents(id);
    queue(id);
  }
  const topZ = () => { let m = 0; for (const o of objects.values()) if (o.z > m) m = o.z; return m; };
  const bottomZ = () => { let m = 0; for (const o of objects.values()) if (o.z < m) m = o.z; return m; };

  // ================================================================ geometry
  function bbox(o) {
    if (o.type === "line") {
      const [a, b] = lineEnds(o);
      return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
    }
    if (o.type === "pen") {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < o.pts.length; i += 2) {
        x0 = Math.min(x0, o.pts[i]); x1 = Math.max(x1, o.pts[i]);
        y0 = Math.min(y0, o.pts[i + 1]); y1 = Math.max(y1, o.pts[i + 1]);
      }
      const p = (o.width || 3) / 2;
      return { x: o.x + x0 - p, y: o.y + y0 - p, w: x1 - x0 + 2 * p, h: y1 - y0 + 2 * p };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of list) {
      const b = bbox(o);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function centerOf(o) { const b = bbox(o); return [b.x + b.w / 2, b.y + b.h / 2]; }
  // point on the border of `o` in the direction of `t` (for connectors)
  function anchor(o, t) {
    const b = bbox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = t[0] - cx, dy = t[1] - cy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return [cx, cy];
    let k;
    if (o.type === "shape" && o.shape === "ellipse") {
      const a = Math.max(b.w / 2, 1), c = Math.max(b.h / 2, 1);
      k = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (c * c));
    } else {
      k = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
    }
    k += 6 / len; // small gap
    return [cx + dx * k, cy + dy * k];
  }
  function lineEnds(o) {
    const A = o.from && objects.get(o.from), B = o.to && objects.get(o.to);
    let p1 = [o.x1, o.y1], p2 = [o.x2, o.y2];
    const t1 = A ? centerOf(A) : p1, t2 = B ? centerOf(B) : p2;
    if (A) p1 = anchor(A, t2);
    if (B) p2 = anchor(B, t1);
    return [p1, p2];
  }
  function translated(o, dx, dy) {
    if (o.type === "line") return { x1: r1(o.x1 + dx), y1: r1(o.y1 + dy), x2: r1(o.x2 + dx), y2: r1(o.y2 + dy) };
    return { x: r1(o.x + dx), y: r1(o.y + dy) };
  }

  // ================================================================ rendering
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function placeByZ(g, z) {
    let ref = null;
    for (const c of objsG.children) if (c !== g && c.__z > z) { ref = c; break; }
    objsG.insertBefore(g, ref);
  }
  function unrender(id) { const g = els.get(id); if (g) g.remove(); els.delete(id); }
  function renderDependents(id) {
    for (const o of objects.values()) if (o.type === "line" && (o.from === id || o.to === id)) render(o);
  }

  function render(o) {
    if (o.type === "meta") {
      if (document.activeElement !== titleInput) titleInput.value = o.title || "";
      document.title = (o.title ? o.title + " – " : "") + "Whiteboard";
      return;
    }
    let g = els.get(o.id);
    if (!g) {
      g = svgEl("g", { "data-id": o.id });
      g.__z = o.z;
      els.set(o.id, g);
      placeByZ(g, o.z);
    } else if (g.__z !== o.z) {
      g.__z = o.z;
      placeByZ(g, o.z);
    }
    if (o.id === editingId) return; // keep the live editor intact
    if (o.type === "image" && g.__src === o.src && g.children.length === 2) {
      // just move/resize – don't reload the picture
      for (const c of g.children) for (const [k, v] of [["x", o.x], ["y", o.y], ["width", o.w], ["height", o.h]]) c.setAttribute(k, v);
      return;
    }
    g.textContent = "";
    g.__src = null;
    g.setAttribute("class", "obj " + o.type);
    switch (o.type) {
      case "note":
        svgEl("rect", { x: o.x, y: o.y, width: o.w, height: o.h, fill: safeColor(o.color), class: "note-bg" }, g);
        textBox(g, o);
        break;
      case "shape": {
        const st = { fill: o.fill === "none" ? "none" : safeColor(o.fill), stroke: safeColor(o.stroke), "stroke-width": 2, "pointer-events": "all" };
        if (o.shape === "ellipse") svgEl("ellipse", { cx: o.x + o.w / 2, cy: o.y + o.h / 2, rx: o.w / 2, ry: o.h / 2, ...st }, g);
        else svgEl("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: 6, ...st }, g);
        textBox(g, o);
        break;
      }
      case "text":
        textBox(g, o);
        break;
      case "line": {
        const [a, b] = lineEnds(o);
        const w = o.width || 2, color = safeColor(o.color);
        svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: "hit" }, g);
        let ex = b[0], ey = b[1];
        if (o.arrow) {
          const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, back = Math.min(arrowLen(w) * 0.7, d);
          ex = b[0] - ((b[0] - a[0]) / d) * back;
          ey = b[1] - ((b[1] - a[1]) / d) * back;
        }
        svgEl("line", {
          x1: a[0], y1: a[1], x2: ex, y2: ey, stroke: color, "stroke-width": w, "stroke-linecap": "round",
          "stroke-dasharray": o.dash ? `${w * 3} ${w * 2.5}` : null,
        }, g);
        if (o.arrow) svgEl("path", { d: arrowHead(a, b, w), fill: color }, g);
        break;
      }
      case "image": {
        svgEl("rect", { x: o.x, y: o.y, width: o.w, height: o.h, class: "img-bg" }, g);
        const im = svgEl("image", { x: o.x, y: o.y, width: o.w, height: o.h, preserveAspectRatio: "none" }, g);
        let tries = 0;
        im.addEventListener("error", () => {
          // the picture may still be uploading on the other side → retry a few times
          if (++tries <= 6) setTimeout(() => im.setAttribute("href", imageSrc(o.src) + (imageSrc(o.src).startsWith("data:") ? "" : "&r=" + tries)), 1500 * tries);
        });
        im.setAttribute("href", imageSrc(o.src));
        g.__src = o.src;
        break;
      }
      case "pen": {
        const d = penPath(o);
        svgEl("path", { d, class: "hit" }, g);
        svgEl("path", { d, fill: "none", stroke: safeColor(o.color), "stroke-width": o.width || 3, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
        break;
      }
    }
  }
  const arrowLen = (w) => 9 + w * 3;
  function arrowHead(a, b, w) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = arrowLen(w), W = 4.5 + w * 1.8;
    const bx = b[0] - Math.cos(ang) * L, by = b[1] - Math.sin(ang) * L;
    const px = -Math.sin(ang) * W, py = Math.cos(ang) * W;
    return `M${b[0]} ${b[1]}L${bx + px} ${by + py}L${bx - px} ${by - py}Z`;
  }
  function penPath(o) {
    const p = o.pts, X = o.x, Y = o.y;
    if (p.length <= 2) return `M${X + p[0]} ${Y + p[1]}l0.01 0`;
    let d = `M${X + p[0]} ${Y + p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      d += `Q${X + p[i]} ${Y + p[i + 1]} ${X + mx} ${Y + my}`;
    }
    return d + `L${X + p[p.length - 2]} ${Y + p[p.length - 1]}`;
  }

  function textBox(g, o) {
    const isText = o.type === "text";
    const fo = svgEl("foreignObject", { x: o.x, y: o.y, width: Math.max(o.w, 1), height: Math.max(o.h, 1) }, g);
    const box = document.createElement("div");
    box.className = "tb " + (isText ? "left" : "center");
    box.style.padding = o.type === "note" ? "14px" : o.type === "shape" ? "10px" : "0";
    const tx = document.createElement("div");
    tx.className = "tx";
    tx.textContent = o.text || "";
    tx.style.color = isText ? safeColor(o.color) : "#1f1f1f";
    box.appendChild(tx);
    fo.appendChild(box);
    if (o.type === "note") fitNote(tx, o);
    else tx.style.fontSize = (o.size || (isText ? 24 : 18)) + "px";
    if (isText) fitTextHeight(o, fo, tx);
  }
  const fitCache = new Map();
  function fitNote(tx, o) {
    const key = o.w + "|" + o.h + "|" + (o.text || "");
    let fs = fitCache.get(key);
    if (fs) { tx.style.fontSize = fs + "px"; return; }
    const availH = o.h - 28, availW = o.w - 28;
    fs = clamp(Math.round(o.w / 7), 10, 44);
    tx.style.fontSize = fs + "px";
    while (fs > 6 && (tx.scrollHeight > availH || tx.scrollWidth > availW + 1)) {
      fs -= fs > 20 ? 2 : 1;
      tx.style.fontSize = fs + "px";
    }
    if (fitCache.size > 2000) fitCache.clear();
    fitCache.set(key, fs);
  }
  function fitTextHeight(o, fo, tx) {
    const h = Math.ceil(tx.scrollHeight) || Math.round((o.size || 24) * 1.25);
    if (Math.abs(h - o.h) > 1) { o.h = h; fo.setAttribute("height", h); }
  }

  // ================================================================ selection overlay + context toolbar
  function drawSelection() {
    overlay.textContent = "";
    for (const id of [...selection]) if (!objects.has(id)) selection.delete(id);
    const moving = drag && (drag.kind === "move" || drag.kind === "resize") && drag.moved;
    if (!selection.size) { hideCtx(); return; }
    const s = view.s, sw = 1.5 / s;
    const items = [...selection].map((id) => objects.get(id));
    for (const o of items) {
      if (o.type === "line") continue;
      const b = bbox(o);
      svgEl("rect", { x: b.x - 2 / s, y: b.y - 2 / s, width: b.w + 4 / s, height: b.h + 4 / s, class: "sel", "stroke-width": sw }, overlay);
    }
    if (items.length === 1) {
      const o = items[0];
      if (o.type === "line") {
        const [a, b] = lineEnds(o);
        handle(a, "p1");
        handle(b, "p2");
      } else if (o.type !== "pen" && o.id !== editingId) {
        const b = bbox(o);
        handle([b.x, b.y], "nw"); handle([b.x + b.w, b.y], "ne");
        handle([b.x, b.y + b.h], "sw"); handle([b.x + b.w, b.y + b.h], "se");
      }
    } else {
      const u = unionBox(items);
      if (u) svgEl("rect", { x: u.x - 6 / s, y: u.y - 6 / s, width: u.w + 12 / s, height: u.h + 12 / s, class: "group", "stroke-width": sw }, overlay);
    }
    if (moving) hideCtx(); else showCtx(items);
  }
  function handle([x, y], name) {
    const k = coarse ? 1.8 : 1, s = view.s;
    if (name[0] === "p") svgEl("circle", { cx: x, cy: y, r: (6 * k) / s, class: "handle", "stroke-width": 1.5 / s, "data-handle": name }, overlay);
    else svgEl("rect", { x: x - (5 * k) / s, y: y - (5 * k) / s, width: (10 * k) / s, height: (10 * k) / s, class: "handle", "stroke-width": 1.5 / s, "data-handle": name }, overlay);
  }

  const ICON = {
    select: '<path d="M5 3l14 8-6.5 1.6L9.5 19z"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v6.5c0 4.5-2.7 7.5-6.5 7.5-2.6 0-4.3-1.1-5.8-3.4L3.4 13.4a1.5 1.5 0 0 1 2.4-1.8L8 14"/>',
    note: '<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/>',
    text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>',
    rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
    pen: '<path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19z"/><path d="M14 7l3 3"/>',
    eraser: '<path d="M8 20h12M4.5 15.5l9.5-9.5 5 5-8.5 8.5H8.5z"/><path d="M10 10l5 5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    front: '<path d="M12 17V4M7 9l5-5 5 5M5 20h14"/>',
    back: '<path d="M12 4v13M7 12l5 5 5-5M5 20h14"/>',
    dash: '<path d="M3 12h4M10 12h4M17 12h4"/>',
    image: '<path d="M20.5 11.5l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

  function showCtx(items) {
    ctxEl.textContent = "";
    const has = (t) => items.some((o) => o.type === t);
    const btn = (html, title, fn, on) => {
      const b = document.createElement("button");
      b.className = "cbtn" + (on ? " on" : "");
      b.innerHTML = html;
      b.title = title;
      b.onclick = fn;
      ctxEl.appendChild(b);
    };
    const sep = () => { const d = document.createElement("span"); d.className = "csep"; ctxEl.appendChild(d); };
    const swatch = (c, current, title, fn) => {
      const b = document.createElement("button");
      b.className = "sw" + (c === "none" ? " none" : "") + (c === current ? " on" : "");
      b.style.background = c === "none" ? "" : c;
      b.title = title;
      b.onclick = fn;
      ctxEl.appendChild(b);
    };
    const first = (t) => items.find((o) => o.type === t);

    if (has("note") || has("shape")) {
      const cur = (first("note") || {}).color || (first("shape") || {}).fill;
      for (const c of NOTE_COLORS) swatch(c, cur, "Fill", () => applyAll((o) => {
        if (o.type === "note") { noteColor = c; store.set("wb.noteColor", c); return { color: c }; }
        if (o.type === "shape") return { fill: c };
      }));
      if (has("shape")) swatch("none", cur, "No fill", () => applyAll((o) => (o.type === "shape" ? { fill: "none" } : null)));
    }
    if (has("line") || has("pen") || has("text") || has("shape")) {
      if (ctxEl.children.length) sep();
      const f = items.find((o) => o.type !== "note");
      const cur = f && (f.type === "shape" ? f.stroke : f.color);
      for (const c of INK_COLORS) swatch(c, cur, "Color", () => applyAll((o) => {
        if (o.type === "note") return null;
        inkColor = c; store.set("wb.inkColor", c);
        return o.type === "shape" ? { stroke: c } : { color: c };
      }));
    }
    const line = first("line");
    if (line) {
      sep();
      btn(icon("arrow"), "Arrow head", () => applyAll((o) => (o.type === "line" ? { arrow: !line.arrow } : null)), line.arrow);
      btn(icon("dash"), "Dashed", () => applyAll((o) => (o.type === "line" ? { dash: !line.dash } : null)), line.dash);
    }
    if (line || has("pen")) {
      const cw = (line || first("pen")).width || 2;
      btn(cw + "px", "Line width", () => {
        const next = cw >= 8 ? 1 : cw >= 4 ? 8 : cw >= 2 ? 4 : 2;
        applyAll((o) => (o.type === "line" || o.type === "pen" ? { width: next } : null));
      });
    }
    if (has("text") || has("shape")) {
      sep();
      const step = (d) => applyAll((o) => {
        if (o.type !== "text" && o.type !== "shape") return null;
        const s = o.size || (o.type === "text" ? 24 : 18);
        return { size: clamp(Math.round(s * (d > 0 ? 1.25 : 0.8)), 8, 300) };
      });
      btn("A−", "Smaller text", () => step(-1));
      btn("A+", "Bigger text", () => step(1));
    }
    sep();
    btn(icon("front"), "Bring to front", () => reorder(true));
    btn(icon("back"), "Send to back", () => reorder(false));
    btn(icon("copy"), "Duplicate (Ctrl+D)", duplicate);
    btn(icon("trash"), "Delete (Del)", deleteSelection);

    ctxEl.hidden = false;
    const u = unionBox(items);
    const s = view.s, w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
    let x = (u.x + u.w / 2) * s + view.x;
    let y = u.y * s + view.y - h - 16;
    if (y < 64) y = (u.y + u.h) * s + view.y + 16;
    y = clamp(y, 64, innerHeight - h - 70);
    x = clamp(x, w / 2 + 8, innerWidth - w / 2 - 8);
    ctxEl.style.left = x + "px";
    ctxEl.style.top = y + "px";
  }
  function hideCtx() { ctxEl.hidden = true; }
  ctxEl.addEventListener("pointerdown", (e) => e.preventDefault());

  function applyAll(fn) {
    finishEdit();
    begin();
    for (const id of selection) {
      const o = objects.get(id);
      const patch = o && fn(o);
      if (patch) updateObj(id, patch);
    }
    commit();
    drawSelection();
  }
  function reorder(front) {
    finishEdit();
    begin();
    const list = [...selection].map((id) => objects.get(id)).sort((a, b) => a.z - b.z);
    if (front) { let z = topZ(); for (const o of list) updateObj(o.id, { z: ++z }); }
    else { let z = bottomZ(); for (const o of list.reverse()) updateObj(o.id, { z: --z }); }
    commit();
    drawSelection();
  }
  function deleteSelection() {
    finishEdit();
    begin();
    for (const id of [...selection]) removeObj(id);
    commit();
    selection.clear();
    drawSelection();
  }
  function duplicate() {
    const items = [...selection].map((id) => objects.get(id)).filter(Boolean);
    if (items.length) pasteObjs(items.map(clone), 24, 24);
  }
  function pasteObjs(items, dx, dy) {
    finishEdit();
    begin();
    const ids = new Map();
    for (const o of items) if (o && o.id) ids.set(o.id, uid());
    let z = topZ();
    const out = [];
    for (const o0 of items.filter((o) => o && typeof o.type === "string" && o.type !== "meta").sort((a, b) => a.z - b.z)) {
      const o = clone(o0);
      o.id = ids.get(o0.id);
      o.z = ++z;
      if (o.type === "line") {
        const [a, b] = lineEnds(o0);
        Object.assign(o, { x1: r1(a[0]), y1: r1(a[1]), x2: r1(b[0]), y2: r1(b[1]) });
        o.from = o0.from && ids.has(o0.from) ? ids.get(o0.from) : null;
        o.to = o0.to && ids.has(o0.to) ? ids.get(o0.to) : null;
      }
      Object.assign(o, translated(o, dx, dy));
      putObj(o);
      out.push(o.id);
    }
    commit();
    selection = new Set(out);
    drawSelection();
  }

  // ================================================================ text editing
  const readText = (tx) => tx.innerText.replace(/\n$/, "");
  function startEdit(id) {
    const o = objects.get(id);
    if (!o || !TEXTABLE.has(o.type) || editingId === id) return;
    finishEdit();
    selection = new Set([id]);
    render(o);
    const tx = els.get(id) && els.get(id).querySelector(".tx");
    if (!tx) return;
    editingId = id;
    begin();
    record(id);
    tx.contentEditable = "plaintext-only";
    if (tx.contentEditable !== "plaintext-only") tx.contentEditable = "true";
    tx.focus();
    const range = document.createRange();
    range.selectNodeContents(tx);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    tx.addEventListener("input", () => {
      const cur = objects.get(id);
      if (!cur || editingId !== id) return;
      cur.text = readText(tx);
      if (cur.type === "note") fitNote(tx, cur);
      if (cur.type === "text") fitTextHeight(cur, tx.closest("foreignObject"), tx);
      queue(id);
      drawSelection();
    });
    tx.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishEdit(); }
    });
    tx.addEventListener("paste", (e) => {
      e.stopPropagation();
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });
    for (const ev of ["copy", "cut"]) tx.addEventListener(ev, (e) => e.stopPropagation());
    drawSelection();
  }
  function finishEdit() {
    if (!editingId) return;
    const id = editingId;
    editingId = null;
    const o = objects.get(id);
    const tx = els.get(id) && els.get(id).querySelector(".tx");
    if (tx && document.activeElement === tx) tx.blur();
    if (o && tx) o.text = readText(tx).slice(0, 10000);
    if (o && o.type === "text" && !o.text.trim()) removeObj(id);
    else if (o) { render(o); queue(id); }
    commit();
    drawSelection();
  }

  // ================================================================ creating things
  function createNote(wx, wy, text = "") {
    finishEdit();
    begin();
    const o = { id: uid(), type: "note", x: r1(wx - 100), y: r1(wy - 100), w: 200, h: 200, color: noteColor, text, z: topZ() + 1 };
    putObj(o);
    commit();
    selection = new Set([o.id]);
    drawSelection();
    return o.id;
  }
  function createText(wx, wy) {
    finishEdit();
    begin();
    const o = { id: uid(), type: "text", x: r1(wx), y: r1(wy - 16), w: 260, h: 30, size: 24, color: inkColor, text: "", z: topZ() + 1 };
    putObj(o);
    commit();
    selection = new Set([o.id]);
    return o.id;
  }
  // Ramer–Douglas–Peucker: fewer points for pen strokes
  function simplify(pts, eps) {
    const n = pts.length / 2;
    if (n < 3) return pts;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[2 * i + 1]) - (ax - pts[2 * i]) * (by - ay)) / len;
        if (d > best) { best = d; bi = i; }
      }
      if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
    return out;
  }

  // ================================================================ view
  let viewSaveT = null;
  function applyView() {
    world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.s})`);
    const g = 24 * view.s;
    stage.style.backgroundSize = `${g}px ${g}px`;
    stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
    stage.classList.toggle("nogrid", view.s < 0.35);
    $("#zpct").textContent = Math.round(view.s * 100) + "%";
    drawSelection();
    renderCursors(false);
    clearTimeout(viewSaveT);
    viewSaveT = setTimeout(() => store.set("wb.view." + boardId, view), 300);
  }
  function zoomAt(cx, cy, factor) {
    const ns = clamp(view.s * factor, 0.1, 4);
    const wx = (cx - view.x) / view.s, wy = (cy - view.y) / view.s;
    view = { x: cx - wx * ns, y: cy - wy * ns, s: ns };
    applyView();
  }
  function fit() {
    const u = unionBox([...objects.values()].filter((o) => o.type !== "meta"));
    if (!u) { view = { x: innerWidth / 2, y: innerHeight / 2, s: 1 }; applyView(); return; }
    const pad = 80;
    const s = clamp(Math.min((innerWidth - 2 * pad) / Math.max(u.w, 1), (innerHeight - 2 * pad) / Math.max(u.h, 1)), 0.1, 1.5);
    view = { s, x: innerWidth / 2 - (u.x + u.w / 2) * s, y: innerHeight / 2 - (u.y + u.h / 2) * s };
    applyView();
  }
  const toWorld = (cx, cy) => [(cx - view.x) / view.s, (cy - view.y) / view.s];

  // ================================================================ pointer input
  let drag = null, spaceDown = false, lastDown = { t: 0, x: 0, y: 0 };
  const touches = new Map();
  let pinch = null;

  const objIdAt = (t) => {
    const g = t && t.closest && t.closest("#objs [data-id]");
    return g ? g.dataset.id : null;
  };
  function connectableAt(cx, cy, exclude) {
    for (const e of document.elementsFromPoint(cx, cy)) {
      const id = objIdAt(e);
      if (id && id !== exclude && CONNECTABLE.has((objects.get(id) || {}).type)) return id;
    }
    return null;
  }
  function eraseAt(cx, cy) {
    for (const e of document.elementsFromPoint(cx, cy)) {
      const id = objIdAt(e);
      const o = id && objects.get(id);
      if (o && (o.type === "pen" || o.type === "line")) { removeObj(id); return; }
    }
  }
  function endDragForPinch() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === "pen" || d.kind === "box" || d.kind === "line") removeObj(d.id);
    active.clear();
    commit();
    drawSelection();
  }

  stage.addEventListener("pointerdown", (e) => {
    if (editingId && e.target.closest && e.target.closest(".tx[contenteditable]")) return; // let the editor work
    e.preventDefault();
    if (document.activeElement === titleInput) titleInput.blur();
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        endDragForPinch();
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, view: { ...view } };
        return;
      }
      if (touches.size > 2) return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    finishEdit();
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const now = performance.now();
    const dbl = now - lastDown.t < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 10;
    lastDown = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY };
    const hitId = objIdAt(e.target);
    const handleEl = e.target.closest && e.target.closest("[data-handle]");

    if (e.button === 1 || tool === "hand" || spaceDown ||
        (e.pointerType === "touch" && tool === "select" && !hitId && !handleEl && !dbl)) {
      drag = { kind: "pan", lx: e.clientX, ly: e.clientY };
      stage.classList.add("panning");
      return;
    }

    switch (tool) {
      case "select": {
        if (dbl && !handleEl) {
          if (hitId && TEXTABLE.has(objects.get(hitId).type)) { drag = { kind: "none", editOnUp: hitId }; return; }
          if (!hitId) { drag = { kind: "none", editOnUp: createNote(wx, wy) }; return; }
        }
        if (handleEl && selection.size === 1) {
          const id = [...selection][0];
          begin();
          active.add(id);
          drag = { kind: "resize", id, handle: handleEl.dataset.handle, orig: clone(objects.get(id)), moved: false };
          return;
        }
        if (hitId) {
          if (e.shiftKey) {
            if (selection.has(hitId)) { selection.delete(hitId); drawSelection(); return; }
            selection.add(hitId);
          } else if (!selection.has(hitId)) selection = new Set([hitId]);
          begin();
          const orig = new Map();
          for (const id of selection) orig.set(id, clone(objects.get(id)));
          drag = { kind: "move", orig, wx, wy, sx: e.clientX, sy: e.clientY, moved: false, hitId };
          drawSelection();
        } else {
          if (!e.shiftKey) selection.clear();
          drag = { kind: "marquee", wx, wy, base: new Set(selection) };
          drawSelection();
        }
        return;
      }
      case "note":
        setTool("select");
        drag = { kind: "none", editOnUp: createNote(wx, wy) };
        return;
      case "text":
        setTool("select");
        drag = { kind: "none", editOnUp: createText(wx, wy) };
        return;
      case "rect":
      case "ellipse": {
        begin();
        const o = { id: uid(), type: "shape", shape: tool, x: r1(wx), y: r1(wy), w: 1, h: 1, fill: "#ffffff", stroke: inkColor, text: "", size: 18, z: topZ() + 1 };
        putObj(o);
        active.add(o.id);
        drag = { kind: "box", id: o.id, wx, wy, moved: false };
        return;
      }
      case "line":
      case "arrow": {
        begin();
        const from = connectableAt(e.clientX, e.clientY, null);
        const o = { id: uid(), type: "line", x1: r1(wx), y1: r1(wy), x2: r1(wx), y2: r1(wy), from, to: null, color: inkColor, width: 2, arrow: tool === "arrow", dash: false, z: topZ() + 1 };
        putObj(o);
        active.add(o.id);
        drag = { kind: "line", id: o.id };
        return;
      }
      case "pen": {
        begin();
        const o = { id: uid(), type: "pen", x: r1(wx), y: r1(wy), pts: [0, 0], color: inkColor, width: 3, z: topZ() + 1 };
        putObj(o);
        active.add(o.id);
        drag = { kind: "pen", id: o.id };
        return;
      }
      case "eraser":
        begin();
        drag = { kind: "erase" };
        eraseAt(e.clientX, e.clientY);
        return;
    }
  });

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const p = pinch.view, s = clamp(p.s * (d / pinch.d), 0.1, 4);
        const wx = (pinch.mx - p.x) / p.s, wy = (pinch.my - p.y) / p.s;
        view = { s, x: mx - wx * s, y: my - wy * s };
        applyView();
        return;
      }
    }
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    cursor = [wx, wy];
    if (!drag) return;
    switch (drag.kind) {
      case "pan":
        view.x += e.clientX - drag.lx;
        view.y += e.clientY - drag.ly;
        drag.lx = e.clientX;
        drag.ly = e.clientY;
        applyView();
        break;
      case "move": {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        if (!drag.moved) { drag.moved = true; for (const id of drag.orig.keys()) active.add(id); }
        const dx = wx - drag.wx, dy = wy - drag.wy;
        for (const [id, o0] of drag.orig) updateObj(id, translated(o0, dx, dy));
        drawSelection();
        break;
      }
      case "resize": {
        drag.moved = true;
        const o0 = drag.orig, h = drag.handle;
        if (h === "p1" || h === "p2") {
          const n = h === "p1" ? "1" : "2";
          const target = connectableAt(e.clientX, e.clientY, drag.id);
          updateObj(drag.id, { ["x" + n]: r1(wx), ["y" + n]: r1(wy), [n === "1" ? "from" : "to"]: target });
          drawSelection();
          if (target) highlight(target);
          break;
        }
        const left = h.includes("w"), top = h.includes("n");
        const ax = left ? o0.x + o0.w : o0.x, ay = top ? o0.y + o0.h : o0.y; // fixed corner
        let w = Math.abs(wx - ax), hh = Math.abs(wy - ay);
        const keepRatio = o0.type === "note" || o0.type === "text" || o0.type === "image" || e.shiftKey;
        if (keepRatio) {
          const k = Math.max(w / o0.w, hh / o0.h, 20 / Math.min(o0.w, o0.h));
          w = o0.w * k;
          hh = o0.h * k;
        }
        w = Math.max(w, 20);
        hh = Math.max(hh, 20);
        let x = wx < ax ? ax - w : ax, y = wy < ay ? ay - hh : ay;
        if (keepRatio) { x = left ? ax - w : ax; y = top ? ay - hh : ay; }
        const patch = { x: r1(x), y: r1(y), w: r1(w), h: r1(hh) };
        if (o0.type === "text") {
          patch.size = clamp(Math.round((o0.size || 24) * (w / o0.w)), 8, 300);
          delete patch.h;
        }
        updateObj(drag.id, patch);
        drawSelection();
        break;
      }
      case "marquee": {
        const x = Math.min(wx, drag.wx), y = Math.min(wy, drag.wy), w = Math.abs(wx - drag.wx), h = Math.abs(wy - drag.wy);
        selection = new Set(drag.base);
        for (const o of objects.values()) {
          if (o.type === "meta") continue;
          const b = bbox(o);
          if (b.x >= x && b.y >= y && b.x + b.w <= x + w && b.y + b.h <= y + h) selection.add(o.id);
        }
        drawSelection();
        svgEl("rect", { x, y, width: w, height: h, class: "marquee", "stroke-width": 1 / view.s }, overlay);
        break;
      }
      case "box": {
        drag.moved = true;
        let w = Math.abs(wx - drag.wx), h = Math.abs(wy - drag.wy);
        if (e.shiftKey) w = h = Math.max(w, h);
        const x = wx < drag.wx ? drag.wx - w : drag.wx, y = wy < drag.wy ? drag.wy - h : drag.wy;
        updateObj(drag.id, { x: r1(x), y: r1(y), w: r1(Math.max(w, 1)), h: r1(Math.max(h, 1)) });
        break;
      }
      case "line": {
        const o = objects.get(drag.id);
        if (!o) return;
        let to = connectableAt(e.clientX, e.clientY, drag.id);
        if (to === o.from) to = null;
        updateObj(drag.id, { x2: r1(wx), y2: r1(wy), to });
        overlay.textContent = "";
        if (to) highlight(to);
        break;
      }
      case "pen": {
        const o = objects.get(drag.id);
        if (!o) return;
        const px = r1(wx - o.x), py = r1(wy - o.y), n = o.pts.length;
        if (Math.hypot(px - o.pts[n - 2], py - o.pts[n - 1]) * view.s < 2) return;
        o.pts.push(px, py);
        render(o);
        queue(o.id);
        break;
      }
      case "erase":
        eraseAt(e.clientX, e.clientY);
        break;
    }
  });

  function highlight(id) {
    const o = objects.get(id);
    if (!o) return;
    const b = bbox(o), s = view.s;
    svgEl("rect", { x: b.x - 4 / s, y: b.y - 4 / s, width: b.w + 8 / s, height: b.h + 8 / s, rx: 4 / s, class: "target", "stroke-width": 2 / s }, overlay);
  }

  function onUp(e) {
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) pinch = null; return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    stage.classList.remove("panning");
    switch (d.kind) {
      case "move":
        if (!d.moved && !e.shiftKey && selection.size > 1 && d.hitId) selection = new Set([d.hitId]);
        break;
      case "box": {
        const o = objects.get(d.id);
        if (o && (o.w < 10 || o.h < 10)) {
          const w = o.shape === "ellipse" ? 140 : 160, h = o.shape === "ellipse" ? 140 : 100;
          updateObj(d.id, { x: r1(d.wx - w / 2), y: r1(d.wy - h / 2), w, h });
        }
        selection = new Set([d.id]);
        setTool("select");
        break;
      }
      case "line": {
        const o = objects.get(d.id);
        if (o) {
          const [a, b] = lineEnds(o);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) * view.s < 8 && !(o.from && o.to)) removeObj(d.id);
          else selection = new Set([d.id]);
        }
        break;
      }
      case "pen": {
        const o = objects.get(d.id);
        if (o) { o.pts = simplify(o.pts, 0.6 / view.s).map(r1); render(o); queue(o.id); }
        break;
      }
    }
    active.clear();
    commit();
    if (d.editOnUp) setTimeout(() => startEdit(d.editOnUp), 0);
    drawSelection();
  }
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const k = e.deltaMode === 1 ? 33 : 1;
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * (e.ctrlKey && !mouseWheel ? 0.01 : 0.0015)));
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    }
  }, { passive: false });

  // Safari trackpad pinch
  let gestureStart = null;
  document.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureStart = touches.size ? null : view.s; });
  document.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (gestureStart != null) zoomAt(e.clientX, e.clientY, (gestureStart * e.scale) / view.s);
  });

  // ================================================================ keyboard + clipboard
  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  window.addEventListener("keydown", (e) => {
    if (editingId || typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (k === " ") { spaceDown = true; stage.classList.add("space"); e.preventDefault(); return; }
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && k === "a") {
      e.preventDefault();
      selection = new Set([...objects.values()].filter((o) => o.type !== "meta").map((o) => o.id));
      drawSelection();
      return;
    }
    if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
    if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSelection(); return; }
    if (k === "escape") { selection.clear(); setTool("select"); drawSelection(); return; }
    if (k === "enter" && selection.size === 1) { e.preventDefault(); startEdit([...selection][0]); return; }
    if (k.startsWith("arrow") && selection.size) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : 1;
      const dx = k === "arrowleft" ? -st : k === "arrowright" ? st : 0, dy = k === "arrowup" ? -st : k === "arrowdown" ? st : 0;
      begin();
      for (const id of selection) { const o = objects.get(id); if (o) updateObj(id, translated(o, dx, dy)); }
      commit();
      drawSelection();
      return;
    }
    if (mod || e.altKey) return;
    if (k === "+" || k === "=") return zoomAt(innerWidth / 2, innerHeight / 2, 1.2);
    if (k === "-") return zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2);
    if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) return fit();
    if (k === "i") return fileInput.click();
    const map = { v: "select", h: "hand", n: "note", s: "note", t: "text", r: "rect", o: "ellipse", l: "line", a: "arrow", p: "pen", e: "eraser" };
    if (map[k]) setTool(map[k]);
  });
  window.addEventListener("keyup", (e) => { if (e.key === " ") { spaceDown = false; stage.classList.remove("space"); } });
  window.addEventListener("blur", () => { spaceDown = false; stage.classList.remove("space"); });

  const CLIP = "whiteboard-objects:";
  const selectedObjs = () => [...selection].map((id) => objects.get(id)).filter(Boolean);
  document.addEventListener("copy", (e) => {
    if (editingId || typing(e.target)) return;
    const items = selectedObjs();
    if (!items.length) return;
    e.preventDefault();
    const withEnds = items.map((o) => {
      if (o.type !== "line") return o;
      const [a, b] = lineEnds(o);
      return { ...o, x1: r1(a[0]), y1: r1(a[1]), x2: r1(b[0]), y2: r1(b[1]) };
    });
    e.clipboardData.setData("text/plain", CLIP + JSON.stringify(withEnds));
    toast(items.length === 1 ? "Copied" : `Copied ${items.length} items`);
  });
  document.addEventListener("cut", (e) => {
    if (editingId || typing(e.target) || !selection.size) return;
    e.preventDefault();
    const items = selectedObjs();
    e.clipboardData.setData("text/plain", CLIP + JSON.stringify(items));
    deleteSelection();
  });
  document.addEventListener("paste", (e) => {
    if (editingId || typing(e.target)) return;
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      insertImages(files, cursor);
      return;
    }
    const t = e.clipboardData.getData("text/plain");
    if (!t) return;
    e.preventDefault();
    if (t.startsWith(CLIP)) {
      try {
        const items = JSON.parse(t.slice(CLIP.length));
        if (!Array.isArray(items) || !items.length) return;
        // paste at the mouse (or screen centre), keeping relative positions
        const u = unionBox(items.filter((o) => o.type !== "line" || (o.x1 != null)).map((o) => (o.type === "line" ? { ...o, from: null, to: null } : o)));
        const [cx, cy] = cursor || toWorld(innerWidth / 2, innerHeight / 2);
        pasteObjs(items, u ? cx - (u.x + u.w / 2) : 24, u ? cy - (u.y + u.h / 2) : 24);
      } catch { /* not ours */ }
    } else {
      const [cx, cy] = cursor || toWorld(innerWidth / 2, innerHeight / 2);
      createNote(cx, cy, t.slice(0, 5000));
    }
  });

  // ================================================================ pictures (paperclip button, paste, drag & drop)
  const imgCache = new Map(); // picture id → data URL I have locally
  function imageSrc(id) {
    let s = imgCache.get(id);
    if (!s) { s = store.get("wb.img." + id, null); if (s) imgCache.set(id, s); }
    return s || "/api/image?id=" + encodeURIComponent(id);
  }
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", () => { insertImages(fileInput.files, null); fileInput.value = ""; });
  stage.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) insertImages(e.dataTransfer.files, toWorld(e.clientX, e.clientY));
  });

  // shrink to ≤1600 px and ≤1 MB before upload
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => bad(new Error("not a readable picture"));
        i.src = url;
      });
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("empty picture");
      let max = 1600;
      for (let attempt = 0; attempt < 6; attempt++) {
        const k = Math.min(1, max / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, cw, ch);
        let data = c.toDataURL("image/webp", 0.85);
        if (!data.startsWith("data:image/webp")) {
          // no WebP encoder (Safari): PNG if small, otherwise JPEG on white
          data = c.toDataURL("image/png");
          if (data.length > 700000) {
            g.globalCompositeOperation = "destination-over";
            g.fillStyle = "#fff";
            g.fillRect(0, 0, cw, ch);
            data = c.toDataURL("image/jpeg", 0.85);
          }
        }
        if (data.length <= 1000000) return { data, w: cw, h: ch };
        max = Math.round(max * 0.7);
      }
      throw new Error("picture too large");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function uploadImage(id, data) {
    let res;
    try {
      res = await fetch("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, data }) });
    } catch {
      throw new Error("no connection");
    }
    if (res.status === 503 || res.status === 404) return "local";
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "upload failed (" + res.status + ")");
    return "server";
  }
  async function insertImages(fileList, at) {
    const files = [...(fileList || [])].filter((f) => f.type.startsWith("image/")).slice(0, 10);
    if (!files.length) { toast("That's not a picture"); return; }
    let [cx, cy] = at || toWorld(innerWidth / 2, innerHeight / 2);
    toast(files.length > 1 ? `Adding ${files.length} pictures…` : "Adding picture…");
    const added = [];
    for (const f of files) {
      try {
        const { data, w, h } = await prepareImage(f);
        const imgId = uid();
        imgCache.set(imgId, data);
        if ((await uploadImage(imgId, data)) === "local") store.set("wb.img." + imgId, data);
        const k = Math.min(1, 480 / view.s / Math.max(w, h));
        const ow = r1(w * k), oh = r1(h * k);
        finishEdit();
        begin();
        const o = { id: uid(), type: "image", src: imgId, x: r1(cx - ow / 2), y: r1(cy - oh / 2), w: ow, h: oh, z: topZ() + 1 };
        putObj(o);
        commit();
        added.push(o.id);
        cx += 30 / view.s;
        cy += 30 / view.s;
      } catch (err) {
        toast("Couldn't add picture: " + err.message);
      }
    }
    if (added.length) { selection = new Set(added); drawSelection(); }
  }

  // ================================================================ title, users, cursors, toolbar
  let titleT = null;
  titleInput.addEventListener("input", () => {
    clearTimeout(titleT);
    titleT = setTimeout(() => {
      const m = objects.get("_meta") || { id: "_meta", type: "meta" };
      m.title = titleInput.value.slice(0, 80);
      objects.set("_meta", m);
      render(m);
      queue("_meta");
    }, 300);
  });
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") titleInput.blur(); });

  const initials = (n) => String(n || "?").replace(/^Anonymous\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  function renderUsers() {
    const box = $("#users");
    box.textContent = "";
    const list = [me, ...others];
    for (const u of list.slice(0, 7)) {
      const a = document.createElement(u === me ? "button" : "span");
      a.className = "avatar" + (u === me ? " me" : "");
      a.style.background = safeColor(u.color);
      a.textContent = initials(u.name);
      a.title = u === me ? `${u.name} (you) – click to change your name` : u.name;
      if (u === me) a.onclick = rename;
      box.appendChild(a);
    }
    if (list.length > 7) {
      const m = document.createElement("span");
      m.className = "more";
      m.textContent = "+" + (list.length - 7);
      box.appendChild(m);
    }
  }
  function rename() {
    const n = prompt("Your name (shown to others on this board)", me.name);
    if (n && n.trim()) {
      me.name = n.trim().slice(0, 40);
      store.set("wb.me", me);
      renderUsers();
      wake();
    }
  }

  const cursorEls = new Map();
  function renderCursors(animate) {
    cursorsEl.classList.toggle("anim", !!animate);
    const seen = new Set();
    for (const u of others) {
      if (u.x == null || u.y == null) continue;
      seen.add(u.id);
      let c = cursorEls.get(u.id);
      if (!c) {
        c = document.createElement("div");
        c.className = "cursor";
        c.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18"><path d="M1 1l5.5 14 2-6.2L15 6.6z" stroke="#fff" stroke-width="1"/></svg><span></span>';
        cursorsEl.appendChild(c);
        cursorEls.set(u.id, c);
      }
      const col = safeColor(u.color);
      c.querySelector("path").setAttribute("fill", col);
      const lab = c.querySelector("span");
      lab.textContent = u.name;
      lab.style.background = col;
      c.style.transform = `translate(${u.x * view.s + view.x}px, ${u.y * view.s + view.y}px)`;
    }
    for (const [id, c] of cursorEls) if (!seen.has(id)) { c.remove(); cursorEls.delete(id); }
  }

  const TOOLS = [
    ["select", "Select (V)"], ["hand", "Hand / pan (H, or hold Space)"], null,
    ["note", "Sticky note (N)"], ["text", "Text (T)"], ["rect", "Rectangle (R)"], ["ellipse", "Ellipse (O)"],
    ["line", "Line / connector (L)"], ["arrow", "Arrow (A)"], ["pen", "Pen (P)"], ["eraser", "Eraser – pen & lines (E)"],
    ["image", "Insert picture (I) – or paste / drop it"], null,
    ["undo", "Undo (Ctrl+Z)"], ["redo", "Redo (Ctrl+Y)"],
  ];
  const toolsEl = $("#tools");
  for (const t of TOOLS) {
    if (!t) { const s = document.createElement("span"); s.className = "tsep"; toolsEl.appendChild(s); continue; }
    const b = document.createElement("button");
    b.className = "tbtn";
    b.dataset.tool = t[0];
    b.title = t[1];
    b.setAttribute("aria-label", t[1]);
    b.innerHTML = icon(t[0]);
    b.onclick = () => (t[0] === "undo" ? undo() : t[0] === "redo" ? redo() : t[0] === "image" ? fileInput.click() : setTool(t[0]));
    toolsEl.appendChild(b);
  }
  function setTool(t) {
    tool = t;
    stage.dataset.tool = t;
    for (const b of toolsEl.querySelectorAll(".tbtn")) b.classList.toggle("on", b.dataset.tool === t);
  }

  let toastT = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 1800);
  }
  $("#share").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied – anyone with it can edit"); }
    catch { prompt("Copy this link:", location.href); }
  };
  $("#newboard").onclick = () => { window.open("?b=" + newBoardId(), "_blank"); };
  $("#zin").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  $("#zout").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  $("#zpct").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / view.s);
  $("#fit").onclick = fit;
  window.addEventListener("resize", () => drawSelection());

  function updateHint() { $("#hint").classList.toggle("gone", objects.size > (objects.has("_meta") ? 1 : 0)); }

  // ================================================================ sync with the server
  const API = "/api/board";
  const LKEY = "wb.board." + boardId;
  const pending = new Set();
  let since = 0, others = [], mode = "connecting", lastSent = 0, wakeFn = null, wakeT = null, loaded = false;

  function queue(id) {
    pending.add(id);
    saveLocalSoon();
    updateHint();
    if (!wakeT && mode !== "local" && mode !== "offline") wakeT = setTimeout(() => { wakeT = null; wake(); }, 80);
  }
  function wake() { if (wakeFn) wakeFn(); }
  function sleep(ms) {
    return new Promise((r) => {
      const done = () => { clearTimeout(t); wakeFn = null; r(); };
      const t = setTimeout(done, ms);
      wakeFn = done;
    });
  }
  function nextDelay() {
    if (document.hidden) return 30000;
    if (mode === "local" || mode === "offline") return 8000;
    return others.length ? 1000 : 2500;
  }
  function setMode(m) {
    mode = m;
    statusEl.className = m;
    statusEl.textContent = { live: "Live", local: "Local only", offline: "Offline", connecting: "Connecting…" }[m];
    statusEl.title = {
      live: "Changes are saved and shared",
      local: "No database connected – changes stay in this browser",
      offline: "Can't reach the server – changes are kept and sent when you're back online",
      connecting: "",
    }[m];
  }

  function applyRemote(id, o) {
    if (pending.has(id) || active.has(id) || id === editingId) return;
    if (!o) {
      if (objects.has(id)) { objects.delete(id); unrender(id); selection.delete(id); renderDependents(id); }
      return;
    }
    if (o.id !== id || typeof o.type !== "string") return;
    const cur = objects.get(id);
    if (cur && JSON.stringify(cur) === JSON.stringify(o)) return;
    objects.set(id, o);
    render(o);
    renderDependents(id);
  }

  async function syncOnce() {
    lastSent = Date.now();
    const ids = [...pending].slice(0, 300);
    const ops = ids.map((id) => { const o = objects.get(id); return [id, o ? JSON.stringify(o) : null]; });
    ids.forEach((id) => pending.delete(id));
    const body = { b: boardId, since, ops, me: { id: me.id, name: me.name, color: me.color, x: cursor && cursor[0], y: cursor && cursor[1] } };
    let data;
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(res.status === 503 || res.status === 404 ? "nodb" : "http " + res.status);
      data = await res.json();
    } catch (err) {
      ids.forEach((id) => pending.add(id));
      setMode(err.message === "nodb" ? "local" : "offline");
      saveLocalSoon();
      return;
    }
    if (data.seq < since) {
      // the server lost this board (e.g. new database) → upload what we have
      since = 0;
      for (const id of objects.keys()) pending.add(id);
      return;
    }
    for (const [id, o] of data.changes || []) applyRemote(id, o);
    since = data.seq;
    others = (data.users || []).filter((u) => u && u.id !== me.id);
    setMode("live");
    renderUsers();
    renderCursors(true);
    if (data.changes && data.changes.length) { saveLocalSoon(); drawSelection(); updateHint(); }
    if (!loaded) { loaded = true; if (!savedView) fit(); }
  }

  async function syncLoop() {
    for (;;) {
      const wait = 250 - (Date.now() - lastSent);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await syncOnce();
      if (!pending.size || mode !== "live") await sleep(nextDelay());
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);

  let saveT = null;
  function saveLocalSoon() {
    clearTimeout(saveT);
    saveT = setTimeout(() => store.set(LKEY, { objs: [...objects.values()], pending: [...pending], since }), 500);
  }
  window.addEventListener("pagehide", () => {
    clearTimeout(saveT);
    store.set(LKEY, { objs: [...objects.values()], pending: [...pending], since });
  });

  // ================================================================ start
  const snap = store.get(LKEY, null);
  if (snap && Array.isArray(snap.objs)) {
    for (const o of snap.objs) if (o && o.id) objects.set(o.id, o);
    for (const o of objects.values()) render(o);
    for (const id of snap.pending || []) pending.add(id);
    since = Number(snap.since) || 0;
  }
  setTool("select");
  setMode("connecting");
  applyView();
  renderUsers();
  updateHint();
  syncLoop();
})();

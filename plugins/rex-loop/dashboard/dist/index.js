/**
 * Rex Loop Dashboard Plugin — War Room v4 (Mission Control)
 *
 * Single hand-written IIFE, no build step. Module sections in order:
 *   1. constants          (palette, polling, endpoints)
 *   2. utilities          (fmtTokens, fmtDuration, tzFormat)
 *   3. polling driver     (shared setInterval fan-out)
 *   4. data hooks         (useMissions, useTokens, useTickFile, useCronStream, ...)
 *   5. primitives         (Panel, StatusPill, StatBlock, Sparkline)
 *   6. components         (Header, LeftRail, AgentPanel, TickFileViewer, TokensCol, CronStrip)
 *   7. pages              (OverviewPage, KanbanPage stub, SettingsPage stub)
 *   8. root               (RexLoopPage with internal tab switcher)
 *   9. register
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const PLUGINS = window.__HERMES_PLUGINS__;
  if (!SDK || !PLUGINS) {
    console.warn("[rex-loop] SDK or PLUGINS not present on window; skipping registration");
    return;
  }

  const { React } = SDK;
  const { useState, useEffect, useCallback, useRef, useMemo } = SDK.hooks;
  const BASE = "/api/plugins/rex-loop";
  function api(path, opts) { return SDK.fetchJSON(BASE + path, opts || {}); }

  // ============================================================================
  // 1. CONSTANTS
  // ============================================================================
  const C = {
    bg:        "#000814",
    surface:   "rgba(0,29,61,0.45)",
    surfaceLo: "rgba(0,29,61,0.20)",
    border:    "#082545",
    borderHi:  "#103a6b",

    accent:    "#ffd60a",  // primary — yellow, mission control
    success:   "#06d6a0",
    error:     "#e63946",
    info:      "#79c2ff",
    muted:     "#5a7a9a",
    pmAccent:  "#b76dff",  // PM purple — only for PM-related UI

    text:      "#e6f0ff",
    textDim:   "#7a90ad",
  };

  const FONT = {
    chrome: "Inter, system-ui, -apple-system, sans-serif",
    mono:   "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace",
  };

  const POLL = {
    missions:      10000,  // 10s
    ticks:         10000,  // 10s when a mission is selected
    tokensTodayBy:  30000, // 30s for /tokens/today + /tokens/by-role
    tokensByHour: 300000,  // 5min for /tokens/by-hour
    cronStream:     3000,  // 3s incremental tail
    tickfile:       3000,  // 3s when a tick is live
    pmStatus:       3000,  // 3s during scoping
    streams:       4000,   // 4s agent stream list
  };

  const TZ = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; }
    catch (_e) { return "America/New_York"; }
  })();

  // Inject keyframes + utility classes once
  if (typeof document !== "undefined" && !document.getElementById("rex-warroom-css")) {
    const s = document.createElement("style");
    s.id = "rex-warroom-css";
    s.textContent = `
      @keyframes rex-pulse  { 0%,100%{opacity:1}50%{opacity:.4} }
      @keyframes rex-blink  { 0%,49%{opacity:1}50%,100%{opacity:0} }
      @keyframes rex-glow   { 0%,100%{box-shadow:0 0 0 0 ${C.accent}66} 50%{box-shadow:0 0 0 4px ${C.accent}11} }
      @keyframes rex-slide  { from{transform:translateY(4px);opacity:0} to{transform:translateY(0);opacity:1} }
      .rex-mono { font-family: ${FONT.mono}; }
      .rex-chrome { font-family: ${FONT.chrome}; letter-spacing:.18em; text-transform:uppercase; }
      .rex-pulse-yellow { animation: rex-glow 1.6s ease-in-out infinite; }
      .rex-row-enter { animation: rex-slide .25s ease-out; }
      .rex-scroll::-webkit-scrollbar { width:6px; height:6px; }
      .rex-scroll::-webkit-scrollbar-thumb { background:${C.border}; border-radius:3px; }
      .rex-scroll::-webkit-scrollbar-thumb:hover { background:${C.borderHi}; }
      .rex-scroll::-webkit-scrollbar-track { background:transparent; }
    `;
    document.head.appendChild(s);
  }

  // Mission Control theme override — applies to the whole Hermes dashboard.
  // Hermes sets theme tokens via inline style="" on <html> at boot, so we must
  // (a) use !important in CSS to beat inline styles, and (b) re-apply via a
  // MutationObserver if Hermes ever re-writes the inline style. The three
  // base tokens (--background-base / --foreground-base / --midground-base)
  // cascade through every Hermes color via color-mix().
  if (typeof document !== "undefined" && !document.getElementById("rex-mission-control-theme")) {
    const t = document.createElement("style");
    t.id = "rex-mission-control-theme";
    // Mission Control = deep navy bg + cool-light text + reserved yellow.
    // Keeping midground close to foreground means body text stays readable;
    // our plugin uses C.accent (#ffd60a) directly for highlights instead of
    // routing yellow through Hermes' midground token (which would make
    // ALL body text yellow — too saturated for reading).
    const MC_TEXT = C.text;          // #e6f0ff — cool light, primary text
    const MC_ACCENT_SOFT = "#ffe66a"; // softer yellow tint for Hermes highlights
    t.textContent = `
      :root, html {
        --background:        ${C.bg}         !important;
        --background-base:   ${C.bg}         !important;
        --background-alpha:  1               !important;
        --foreground:        ${MC_TEXT}      !important;
        --foreground-base:   ${MC_TEXT}      !important;
        --foreground-alpha:  1               !important;
        --midground:         ${MC_TEXT}      !important;
        --midground-base:    ${MC_TEXT}      !important;
        --midground-alpha:   1               !important;
        --color-success:     ${C.success}    !important;
        --color-warning:     ${MC_ACCENT_SOFT} !important;
        --color-destructive: ${C.error}      !important;
        --warm-glow:         rgba(255, 214, 10, 0.20) !important;
      }
    `;
    document.head.appendChild(t);

    // Also set inline on documentElement (with !important) so values win even
    // if Hermes runtime-rewrites the inline style attr at boot.
    function applyMissionTheme() {
      const root = document.documentElement;
      root.style.setProperty("--background",      C.bg,    "important");
      root.style.setProperty("--background-base", C.bg,    "important");
      root.style.setProperty("--foreground",      MC_TEXT, "important");
      root.style.setProperty("--foreground-base", MC_TEXT, "important");
      root.style.setProperty("--foreground-alpha", "1",    "important");
      root.style.setProperty("--midground",       MC_TEXT, "important");
      root.style.setProperty("--midground-base",  MC_TEXT, "important");
      root.style.setProperty("--midground-alpha", "1",     "important");
    }
    applyMissionTheme();

    // Re-apply on any html-style mutation in case Hermes resets the theme.
    if (typeof MutationObserver !== "undefined") {
      const mo = new MutationObserver(function (muts) {
        for (const m of muts) {
          if (m.attributeName === "style") {
            // Schedule micro-task so our re-apply runs after Hermes' write.
            Promise.resolve().then(applyMissionTheme);
            break;
          }
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    }
  }

  // ============================================================================
  // 2. UTILITIES
  // ============================================================================
  function fmtTokens(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
    if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
    return (n / 1_000_000_000).toFixed(2) + "B";
  }

  function fmtDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return "—";
    seconds = Math.max(0, Math.floor(seconds));
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
    if (seconds < 86400) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h + "h " + m + "m";
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return d + "d " + h + "h";
  }

  function tzFormat(dt, opts) {
    // dt: Date or ISO string. Returns clock string with TZ abbrev appended.
    const d = (dt instanceof Date) ? dt : new Date(dt);
    if (isNaN(d.getTime())) return "—";
    const o = Object.assign({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ, timeZoneName: "short" }, opts || {});
    try { return new Intl.DateTimeFormat(undefined, o).format(d); }
    catch (_e) { return d.toISOString(); }
  }

  function tzNow() { return tzFormat(new Date()); }

  function relTime(iso) {
    if (!iso) return "—";
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "—";
    const delta = Math.floor((Date.now() - then) / 1000);
    if (delta < 0)   return "in " + fmtDuration(-delta);
    if (delta < 60)  return "just now";
    if (delta < 3600) return fmtDuration(delta) + " ago";
    if (delta < 86400) return fmtDuration(delta) + " ago";
    return fmtDuration(delta) + " ago";
  }

  function classNames(/* ...args */) {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function safeNum(n, fallback) {
    return (typeof n === "number" && !isNaN(n)) ? n : (fallback == null ? 0 : fallback);
  }

  // ============================================================================
  // 3. POLLING DRIVER  — one timer per cadence, fan-out to subscribers
  // ============================================================================
  const _drivers = new Map(); // ms -> { id, subs:Set<fn> }

  function _ensureDriver(ms) {
    let d = _drivers.get(ms);
    if (d) return d;
    d = { subs: new Set(), id: null };
    _drivers.set(ms, d);
    d.id = setInterval(function () {
      if (typeof document !== "undefined" && document.hidden) return;
      d.subs.forEach(function (fn) { try { fn(); } catch (e) { console.error("[rex-loop] poll fn threw", e); } });
    }, ms);
    return d;
  }

  function subscribePoll(ms, fn, runImmediately) {
    const d = _ensureDriver(ms);
    d.subs.add(fn);
    if (runImmediately !== false) {
      try { fn(); } catch (e) { console.error("[rex-loop] poll fn threw", e); }
    }
    return function unsubscribe() {
      d.subs.delete(fn);
      if (d.subs.size === 0) {
        clearInterval(d.id);
        _drivers.delete(ms);
      }
    };
  }

  // Re-fire all drivers when tab becomes visible after being hidden
  if (typeof document !== "undefined") {
    let wasHidden = document.hidden;
    document.addEventListener("visibilitychange", function () {
      if (wasHidden && !document.hidden) {
        _drivers.forEach(function (d) { d.subs.forEach(function (fn) { try { fn(); } catch (_e) {} }); });
      }
      wasHidden = document.hidden;
    });
  }

  // ============================================================================
  // 4. DATA HOOKS
  // ============================================================================
  function useApi(path, intervalMs, deps) {
    const [state, setState] = useState({ data: null, error: null, loading: true });
    const pathRef = useRef(path);
    pathRef.current = path;

    useEffect(function () {
      let cancelled = false;
      function tick() {
        const p = pathRef.current;
        if (!p) { setState(function (s) { return Object.assign({}, s, { loading: false }); }); return; }
        api(p).then(function (data) {
          if (cancelled) return;
          setState({ data: data, error: null, loading: false });
        }).catch(function (err) {
          if (cancelled) return;
          setState(function (s) { return { data: s.data, error: err, loading: false }; });
        });
      }
      const unsub = subscribePoll(intervalMs, tick, true);
      return function () { cancelled = true; unsub(); };
    // eslint-disable-next-line
    }, (deps || []).concat([intervalMs]));
    return state;
  }

  function useMissions() {
    return useApi("/missions", POLL.missions);
  }

  function useTicks(missionName) {
    const path = missionName ? "/missions/" + encodeURIComponent(missionName) + "/ticks" : null;
    return useApi(path, POLL.ticks, [missionName]);
  }

  function useTickFile(missionName, tickId) {
    const path = (missionName && tickId != null)
      ? "/missions/" + encodeURIComponent(missionName) + "/tickfile/" + encodeURIComponent(tickId)
      : null;
    return useApi(path, POLL.tickfile, [missionName, tickId]);
  }

  function useTokensToday() { return useApi("/tokens/today", POLL.tokensTodayBy); }
  function useTokensTotal() { return useApi("/tokens/total", POLL.tokensTodayBy); }
  function useTokensByRole() { return useApi("/tokens/by-role", POLL.tokensTodayBy); }
  function useTokensByHour(window) {
    return useApi("/tokens/by-hour?window=" + (window || 24), POLL.tokensByHour, [window]);
  }

  function useCronStream() {
    const [lines, setLines] = useState([]);
    const sinceRef = useRef(null);
    useEffect(function () {
      let cancelled = false;
      function tick() {
        const q = sinceRef.current ? "?since=" + encodeURIComponent(sinceRef.current) : "";
        api("/cron-stream" + q).then(function (data) {
          if (cancelled) return;
          const fresh = (data && data.lines) || [];
          if (fresh.length === 0) return;
          sinceRef.current = fresh[fresh.length - 1].ts || sinceRef.current;
          setLines(function (prev) {
            const merged = prev.concat(fresh);
            // Keep last 500 events to bound memory
            return merged.length > 500 ? merged.slice(merged.length - 500) : merged;
          });
        }).catch(function () { /* ignore transient errors */ });
      }
      const unsub = subscribePoll(POLL.cronStream, tick, true);
      return function () { cancelled = true; unsub(); };
    }, []);
    return lines;
  }

  function useGlobalPause() {
    const [paused, setPaused] = useState(false);
    const refresh = useCallback(function () {
      api("/global-pause").then(function (d) { setPaused(!!(d && d.paused)); }).catch(function () {});
    }, []);
    useEffect(function () { refresh(); }, [refresh]);
    const toggle = useCallback(function () {
      const target = !paused;
      api("/global-pause", { method: "POST", body: JSON.stringify({ paused: target }), headers: { "content-type": "application/json" } })
        .then(function () { setPaused(target); }).catch(function () { refresh(); });
    }, [paused, refresh]);
    return { paused: paused, toggle: toggle };
  }

  // Currently-active mission (server-side: any mission whose latest tick is "running")
  function useActiveMission(missions) {
    return useMemo(function () {
      if (!missions) return null;
      const running = missions.find(function (m) { return m.status === "active" && m.current_tick && m.current_tick.state === "running"; });
      return running || null;
    }, [missions]);
  }

  function useKanban() {
    const [data, setData] = useState({ cards: [], loading: true, error: null });
    const refresh = useCallback(function () {
      api("/kanban/cards").then(function (cards) {
        setData({ cards: cards || [], loading: false, error: null });
      }).catch(function (err) {
        setData(function (d) { return { cards: d.cards, loading: false, error: err }; });
      });
    }, []);
    useEffect(function () {
      const unsub = subscribePoll(POLL.tickfile, refresh, true); // 3s — kanban needs to feel live
      return unsub;
    }, [refresh]);

    const create = useCallback(function (title, tag) {
      return api("/kanban/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title, tag: tag || null }),
      }).then(function (r) { refresh(); return r; });
    }, [refresh]);

    const update = useCallback(function (id, patch) {
      return api("/kanban/cards/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).then(function (r) { refresh(); return r; });
    }, [refresh]);

    const promote = useCallback(function (id) {
      return api("/kanban/cards/" + encodeURIComponent(id) + "/promote", { method: "POST" })
        .then(function (r) { refresh(); return r; });
    }, [refresh]);

    const discard = useCallback(function (id) {
      return api("/kanban/cards/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function (r) { refresh(); return r; });
    }, [refresh]);

    return { cards: data.cards, loading: data.loading, error: data.error, create: create, update: update, promote: promote, discard: discard, refresh: refresh };
  }

  function usePmStatus() {
    const [state, setState] = useState({ data: null, loading: true });
    const refresh = useCallback(function () {
      api("/pm/status").then(function (data) {
        setState({ data: data, loading: false });
      }).catch(function () {});
    }, []);
    useEffect(function () {
      let cancelled = false;
      function tick() {
        api("/pm/status").then(function (data) {
          if (cancelled) return;
          setState({ data: data, loading: false });
        }).catch(function () { if (!cancelled) setState(function (s) { return { data: s.data, loading: false }; }); });
      }
      const unsub = subscribePoll(POLL.pmStatus, tick, true);
      return function () { cancelled = true; unsub(); };
    }, []);

    const setPaused = useCallback(function (paused) {
      return api(paused ? "/pm/pause" : "/pm/resume", { method: "POST" }).then(function (r) { refresh(); return r; });
    }, [refresh]);

    const setAutoFlow = useCallback(function (on) {
      return api("/pm/auto-flow", { method: on ? "POST" : "DELETE" }).then(function (r) { refresh(); return r; });
    }, [refresh]);

    return { data: state.data, loading: state.loading, setPaused: setPaused, setAutoFlow: setAutoFlow, refresh: refresh };
  }

  function useStreams(filter) {
    const filterStr = (filter && filter.kind) ? "?kind=" + encodeURIComponent(filter.kind)
                  : (filter && filter.status) ? "?status=" + encodeURIComponent(filter.status)
                  : "";
    return useApi("/streams" + filterStr, POLL.streams || 4000, [filterStr]);
  }

  function useStreamSSE(streamId) {
    const [state, setState] = useState({ lines: [], status: "running",
                                          exitCode: null, err: null });
    const linesRef = useRef([]);

    useEffect(function () {
      if (!streamId) return;
      const url = "/api/plugins/rex-loop/streams/" +
                  encodeURIComponent(streamId) + "/events";
      const es = new EventSource(url);

      es.addEventListener("snapshot", function (e) {
        try {
          const o = JSON.parse(e.data);
          const lines = o.lines || [];
          linesRef.current = lines.slice(-1000);
          setState(function (s) { return Object.assign({}, s,
            { lines: linesRef.current.slice(), err: null }); });
        } catch (_e) {}
      });
      es.addEventListener("line", function (e) {
        try {
          const o = JSON.parse(e.data);
          linesRef.current = linesRef.current.concat([o]).slice(-1000);
          setState(function (s) { return Object.assign({}, s,
            { lines: linesRef.current.slice(), err: null }); });
        } catch (_e) {}
      });
      es.addEventListener("status", function (e) {
        try {
          const o = JSON.parse(e.data);
          setState(function (s) { return Object.assign({}, s,
            { status: o.status, exitCode: o.exit_code }); });
        } catch (_e) {}
        es.close();
      });
      es.onerror = function () {
        // EventSource auto-reconnects with Last-Event-Id natively.
        setState(function (s) { return Object.assign({}, s, { err: "reconnecting" }); });
      };

      return function () { es.close(); };
    }, [streamId]);

    return state;
  }

  // ============================================================================
  // 5. PRIMITIVES
  // ============================================================================
  function Panel(props) {
    const accent = props.accent || C.border;
    return React.createElement("div", {
      className: classNames("rex-row-enter", props.className),
      style: Object.assign({
        background: C.surface,
        border: "1px solid " + accent,
        borderRadius: 4,
        padding: props.padding != null ? props.padding : "12px 14px",
        color: C.text,
        position: "relative",
      }, props.style || {}),
      onClick: props.onClick,
    }, props.children);
  }

  function StatusPill(props) {
    const map = {
      active:    { bg: C.accent + "22", fg: C.accent,   label: "ACTIVE"   },
      running:   { bg: C.accent + "22", fg: C.accent,   label: "RUNNING"  },
      idle:      { bg: C.muted + "22",  fg: C.muted,    label: "IDLE"     },
      paused:    { bg: C.error + "22",  fg: C.error,    label: "PAUSED"   },
      done:      { bg: C.success + "22", fg: C.success, label: "DONE"     },
      expired:   { bg: C.muted + "22",  fg: C.textDim,  label: "EXPIRED"  },
      failed:    { bg: C.error + "22",  fg: C.error,    label: "FAILED"   },
      pending:   { bg: C.info + "22",   fg: C.info,     label: "PENDING"  },
    };
    const m = map[props.status] || { bg: C.border, fg: C.textDim, label: String(props.status || "—").toUpperCase() };
    return React.createElement("span", {
      className: "rex-chrome",
      style: {
        display: "inline-flex", alignItems: "center", gap: 6,
        background: m.bg, color: m.fg,
        fontSize: 10, fontWeight: 700,
        padding: "2px 8px", borderRadius: 2,
        border: "1px solid " + m.fg + "44",
      },
    }, props.children || m.label);
  }

  function Stat(props) {
    // {label, value, sub?, color?}
    const color = props.color || C.text;
    return React.createElement("div", {
      style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
    },
      React.createElement("span", {
        className: "rex-chrome",
        style: { fontSize: 9, color: C.textDim, letterSpacing: "0.22em" },
      }, props.label),
      React.createElement("span", {
        className: "rex-mono",
        style: { fontSize: 18, color: color, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 },
      }, props.value),
      props.sub != null ? React.createElement("span", {
        className: "rex-mono",
        style: { fontSize: 10, color: C.textDim, fontVariantNumeric: "tabular-nums" },
      }, props.sub) : null,
    );
  }

  function Sparkline(props) {
    // {values: number[], width, height, color}
    const w = props.width || 80, h = props.height || 18;
    const values = props.values || [];
    if (values.length < 2) {
      return React.createElement("div", { style: { width: w, height: h, opacity: 0.3 } }, "—");
    }
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = max - min || 1;
    const step = w / (values.length - 1);
    const points = values.map(function (v, i) {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return React.createElement("svg", {
      width: w, height: h, viewBox: "0 0 " + w + " " + h, style: { display: "block" },
    }, React.createElement("polyline", {
      points: points, fill: "none", stroke: props.color || C.info, strokeWidth: 1.2, strokeLinejoin: "round", strokeLinecap: "round",
    }));
  }

  function IconButton(props) {
    return React.createElement("button", {
      onClick: props.onClick, disabled: props.disabled, title: props.title,
      style: Object.assign({
        background: "transparent",
        border: "1px solid " + (props.danger ? C.error : C.border),
        color: props.danger ? C.error : C.text,
        padding: "6px 10px", fontSize: 10, fontFamily: FONT.chrome, letterSpacing: "0.18em", textTransform: "uppercase",
        cursor: props.disabled ? "not-allowed" : "pointer", borderRadius: 2,
        opacity: props.disabled ? 0.4 : 1,
      }, props.style || {}),
    }, props.children);
  }

  // ============================================================================
  // 6. COMPONENTS
  // ============================================================================

  // ---------- Header ----------
  function Header(props) {
    const { missions, tokensToday, tokensTotal, pause } = props;

    const ticksToday = useMemo(function () {
      if (!missions) return 0;
      const today = new Date().toISOString().slice(0, 10);
      let n = 0;
      missions.forEach(function (m) {
        (m.ticks_summary || []).forEach(function (t) {
          if ((t.started_at || "").slice(0, 10) === today) n++;
        });
      });
      return n;
    }, [missions]);

    const fails24h = useMemo(function () {
      if (!missions) return 0;
      const cutoff = Date.now() - 86400 * 1000;
      let n = 0;
      missions.forEach(function (m) {
        (m.ticks_summary || []).forEach(function (t) {
          if (t.state === "failed" && new Date(t.started_at).getTime() >= cutoff) n++;
        });
      });
      return n;
    }, [missions]);

    const agentTimeToday = useMemo(function () {
      if (!tokensToday || !tokensToday.by_role) return 0;
      let s = 0;
      Object.keys(tokensToday.by_role).forEach(function (k) { s += safeNum(tokensToday.by_role[k].wall, 0); });
      return s;
    }, [tokensToday]);

    const loopUptime = useMemo(function () {
      if (!missions || missions.length === 0) return null;
      const earliest = missions
        .map(function (m) { return m.started_at; })
        .filter(Boolean)
        .map(function (s) { return new Date(s).getTime(); })
        .sort()[0];
      return earliest ? Math.floor((Date.now() - earliest) / 1000) : null;
    }, [missions]);

    const tokensTodaySum = safeNum(tokensToday && (tokensToday["in"] + tokensToday.out));
    const tokensTotalSum = safeNum(tokensTotal && (tokensTotal["in"] + tokensTotal.out));

    return React.createElement("header", {
      style: {
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        padding: "0",
        borderBottom: "1px solid " + C.border,
        background: "linear-gradient(180deg, rgba(0,8,20,0.95) 0%, rgba(0,12,28,0.92) 100%)",
      },
    },
      // Stats row — fills available width, each stat in its own bordered cell
      React.createElement("div", {
        style: {
          flex: 1,
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
        },
      },
        React.createElement(HeaderStat, { label: "Loop Uptime",      value: loopUptime != null ? fmtDuration(loopUptime) : "—" }),
        React.createElement(HeaderStat, { label: "Ticks Today",      value: ticksToday, color: ticksToday > 0 ? C.accent : C.textDim }),
        React.createElement(HeaderStat, { label: "Agent Time",       value: agentTimeToday > 0 ? fmtDuration(agentTimeToday) : "—" }),
        React.createElement(HeaderStat, { label: "Tokens Today",     value: tokensTodaySum > 0 ? fmtTokens(tokensTodaySum) : "—", color: tokensTodaySum > 0 ? C.success : C.textDim }),
        React.createElement(HeaderStat, { label: "Total Tokens",     value: tokensTotalSum > 0 ? fmtTokens(tokensTotalSum) : "—" }),
        React.createElement(HeaderStat, { label: "Fails 24h",        value: fails24h, color: fails24h > 0 ? C.error : C.success }),
      ),
      // Status + Pause cluster
      React.createElement("div", {
        style: {
          display: "flex", alignItems: "center", gap: 12,
          padding: "0 18px", borderLeft: "1px solid " + C.border,
          minWidth: 280,
          background: pause.paused ? "rgba(230,57,70,0.06)" : "transparent",
        },
      },
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2, flex: 1 } },
          React.createElement("span", {
            className: "rex-chrome",
            style: { fontSize: 9, color: C.textDim, letterSpacing: "0.22em" },
          }, "STATUS"),
          React.createElement("span", {
            className: "rex-chrome",
            style: { fontSize: 12, color: pause.paused ? C.error : C.success, letterSpacing: "0.22em", fontWeight: 700 },
          }, pause.paused ? "ALL PAUSED" : "RUNNING"),
          React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } }, tzNow()),
        ),
        React.createElement(IconButton, {
          onClick: pause.toggle, danger: !pause.paused,
        }, pause.paused ? "RESUME" : "PAUSE"),
      ),
    );
  }

  // Header-cell variant of Stat — bordered, taller, more legible than the
  // generic Stat primitive used inside panels.
  function HeaderStat(props) {
    const color = props.color || C.text;
    return React.createElement("div", {
      style: {
        display: "flex", flexDirection: "column", gap: 4,
        padding: "12px 16px",
        borderRight: "1px solid " + C.border,
        minWidth: 0,
      },
    },
      React.createElement("span", {
        className: "rex-chrome",
        style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em", fontWeight: 600 },
      }, props.label),
      React.createElement("span", {
        className: "rex-mono",
        style: {
          fontSize: 22, color: color, fontVariantNumeric: "tabular-nums",
          lineHeight: 1, fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        },
      }, props.value),
    );
  }

  // ---------- LeftRail ----------
  function MissionCard(props) {
    const m = props.mission;
    const isSelected = props.selected;
    const isLive = m.current_tick && m.current_tick.state === "running";

    const sparkValues = useMemo(function () {
      const ticks = (m.ticks_summary || []).slice(-20);
      // Map state to numeric: done=1, running=0.7, failed=0, pending=0.3
      return ticks.map(function (t) {
        if (t.state === "done") return 1;
        if (t.state === "running") return 0.7;
        if (t.state === "failed") return 0;
        return 0.3;
      });
    }, [m.ticks_summary]);

    const daysLeft = useMemo(function () {
      if (!m.started_at || !m.max_days) return null;
      const elapsedSec = (Date.now() - new Date(m.started_at).getTime()) / 1000;
      const remaining = m.max_days * 86400 - elapsedSec;
      return Math.max(0, Math.floor(remaining / 86400));
    }, [m.started_at, m.max_days]);

    const tickCount = m.tick_count || 0;
    const stateColor = isLive ? C.accent : (m.status === "active" ? C.success : (m.status === "expired" ? C.muted : C.textDim));

    return React.createElement(Panel, {
      onClick: function () { props.onSelect(m.name); },
      accent: isSelected ? C.accent : (isLive ? C.accent : C.border),
      className: isLive ? "rex-pulse-yellow" : null,
      style: {
        cursor: "pointer", marginBottom: 6, padding: "10px 12px",
        transition: "border-color 0.2s, background 0.2s",
        background: isSelected ? "rgba(255,214,10,0.06)" : C.surface,
        borderLeft: "3px solid " + stateColor,
      },
    },
      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
        // Title row
        React.createElement("div", {
          style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
        },
          React.createElement("span", {
            className: "rex-mono",
            style: {
              fontSize: 12, fontWeight: 700, color: C.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
            },
          }, m.name),
          isLive
            ? React.createElement("span", {
                className: "rex-chrome",
                style: { fontSize: 9, color: C.accent, letterSpacing: "0.2em", fontWeight: 700, flexShrink: 0 },
              }, "▶ LIVE")
            : null,
        ),
        // Meta row — ticks · days left · sparkline (only if enough data)
        React.createElement("div", {
          style: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" },
        },
          React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 10, color: C.textDim },
          },
            tickCount + (tickCount === 1 ? " tick" : " ticks") +
            (daysLeft != null ? " · " + daysLeft + "d left" : "")),
          sparkValues.length >= 2
            ? React.createElement(Sparkline, {
                values: sparkValues, width: 80, height: 12, color: isLive ? C.accent : C.info,
              })
            : null,
        ),
      ),
    );
  }

  function LeftRail(props) {
    const { missions, selected, onSelect } = props;
    const groups = useMemo(function () {
      const g = { active: [], done: [], expired: [] };
      (missions || []).forEach(function (m) {
        if (m.status === "active") g.active.push(m);
        else if (m.status === "done") g.done.push(m);
        else g.expired.push(m);
      });
      return g;
    }, [missions]);

    function GroupHeader(props) {
      return React.createElement("div", {
        className: "rex-chrome",
        style: {
          fontSize: 10, color: C.textDim, padding: "12px 4px 6px",
          borderBottom: "1px solid " + C.border, marginBottom: 8, letterSpacing: "0.24em",
        },
      }, props.label + " · " + props.count);
    }

    return React.createElement("aside", {
      className: "rex-scroll",
      style: {
        width: 320, padding: "12px 12px 16px",
        borderRight: "1px solid " + C.border,
        overflowY: "auto", height: "100%",
      },
    },
      React.createElement(GroupHeader, { label: "ACTIVE", count: groups.active.length }),
      groups.active.length === 0
        ? React.createElement("div", { className: "rex-mono", style: { fontSize: 10, color: C.textDim, padding: "4px 4px 12px" } }, "no active missions")
        : groups.active.map(function (m) {
            return React.createElement(MissionCard, { key: m.name, mission: m, selected: selected === m.name, onSelect: onSelect });
          }),
      React.createElement(GroupHeader, { label: "DONE", count: groups.done.length }),
      groups.done.map(function (m) {
        return React.createElement(MissionCard, { key: m.name, mission: m, selected: selected === m.name, onSelect: onSelect });
      }),
      React.createElement(GroupHeader, { label: "EXPIRED", count: groups.expired.length }),
      groups.expired.map(function (m) {
        return React.createElement(MissionCard, { key: m.name, mission: m, selected: selected === m.name, onSelect: onSelect });
      }),
    );
  }

  // ---------- AgentPanel ----------
  const PIPELINE_STAGES = ["researcher", "planner", "coder", "tester"];

  function StageBadge(props) {
    // {stage, state, elapsed}
    const ICONS = { done: "✓", running: "▶", pending: "—", failed: "✗" };
    const COLORS = { done: C.success, running: C.accent, pending: C.muted, failed: C.error };
    const c = COLORS[props.state] || C.muted;
    const isActive = props.state === "running";
    return React.createElement("div", {
      className: isActive ? "rex-pulse-yellow" : null,
      style: {
        flex: 1,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        padding: "10px 8px",
        background: isActive ? C.accent + "11" : "transparent",
        border: "1px solid " + c + "44",
        borderRadius: 2,
      },
    },
      React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: c, fontWeight: 700, letterSpacing: "0.22em" } }, props.stage.toUpperCase()),
      React.createElement("span", { className: "rex-mono", style: { fontSize: 16, color: c } }, ICONS[props.state] || "—"),
      React.createElement("span", { className: "rex-mono", style: { fontSize: 9, color: C.textDim } }, props.elapsed != null ? fmtDuration(props.elapsed) : "—"),
    );
  }

  function PipelineStrip(props) {
    const stages = props.stages || {}; // { researcher: {state, elapsed}, ... }
    return React.createElement("div", {
      style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, padding: "8px 0" },
    },
      PIPELINE_STAGES.map(function (s) {
        const info = stages[s] || { state: "pending" };
        return React.createElement(StageBadge, {
          key: s, stage: s, state: info.state, elapsed: info.elapsed,
        });
      }),
    );
  }

  function HandoffBadges(props) {
    // Renders summary cards between stages: researcher.sources -> planner.steps -> coder.progress -> tester.gates
    const handoffs = props.handoffs || {};
    function Pill(p) {
      return React.createElement("div", {
        style: {
          padding: "6px 8px", border: "1px dashed " + C.border, borderRadius: 2,
          color: C.textDim, fontFamily: FONT.mono, fontSize: 10, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        },
      }, p.label + ": " + (p.value == null ? "—" : p.value));
    }
    return React.createElement("div", {
      style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
    },
      React.createElement(Pill, { label: "src", value: handoffs.sources_count }),
      React.createElement(Pill, { label: "steps", value: handoffs.planner_steps }),
      React.createElement(Pill, { label: "progress", value: handoffs.coder_progress }),
      React.createElement(Pill, { label: "gates", value: handoffs.tester_gates }),
    );
  }

  // Parse a tick file into per-stage info {state, elapsed} from sections
  function parseTickStages(tickfile) {
    const stages = { researcher: { state: "pending" }, planner: { state: "pending" }, coder: { state: "pending" }, tester: { state: "pending" } };
    if (!tickfile || !tickfile.sections) return stages;
    const sections = tickfile.sections;
    const startedAt = (s) => s && s.started_at ? new Date(s.started_at).getTime() : null;
    const endedAt   = (s) => s && s.ended_at ? new Date(s.ended_at).getTime() : null;
    sections.forEach(function (sect, i) {
      const role = (sect.role || "").toLowerCase();
      if (!stages[role]) return;
      const isLast = i === sections.length - 1;
      const ended = endedAt(sect);
      stages[role].state = ended ? "done" : (isLast ? "running" : "done");
      const start = startedAt(sect);
      const stop = ended || Date.now();
      if (start) stages[role].elapsed = Math.floor((stop - start) / 1000);
    });
    return stages;
  }

  function summarizeHandoffs(tickfile) {
    if (!tickfile || !tickfile.sections) return {};
    const out = {};
    tickfile.sections.forEach(function (s) {
      const r = (s.role || "").toLowerCase();
      const body = s.body || "";
      if (r === "researcher") {
        const links = (body.match(/^https?:\/\//gm) || []).length;
        out.sources_count = links;
      } else if (r === "planner") {
        out.planner_steps = (body.match(/^- \[ \]/gm) || []).length + (body.match(/^- \[x\]/gmi) || []).length;
      } else if (r === "coder") {
        const done = (body.match(/^- \[x\]/gmi) || []).length;
        const total = done + (body.match(/^- \[ \]/gm) || []).length;
        out.coder_progress = total ? done + "/" + total : null;
      } else if (r === "tester") {
        out.tester_gates = (body.match(/GATE/g) || []).length;
      }
    });
    return out;
  }

  function AgentPanel(props) {
    const { mission, tickfile, loadingTick } = props;
    const stages = useMemo(function () { return parseTickStages(tickfile); }, [tickfile]);
    const handoffs = useMemo(function () { return summarizeHandoffs(tickfile); }, [tickfile]);

    if (!mission || !mission.current_tick || mission.current_tick.state !== "running") {
      // Idle banner is rendered by the parent OverviewPage; AgentPanel only renders during a live tick.
      return null;
    }

    const t = mission.current_tick;
    return React.createElement(Panel, { accent: C.accent, style: { marginBottom: 12 } },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" } },
        React.createElement("span", { className: "rex-mono", style: { fontSize: 12, color: C.text, fontWeight: 700 } },
          mission.name + " // TICK #" + t.id +
          (t.picked_line ? " · line " + t.picked_line : "") +
          (t.task ? " · " + t.task : "")),
        React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } },
          t.started_at ? "started " + tzFormat(t.started_at, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : ""),
      ),
      React.createElement(PipelineStrip, { stages: stages }),
      React.createElement("div", { style: { marginTop: 8 } },
        React.createElement(HandoffBadges, { handoffs: handoffs }),
      ),
      loadingTick && !tickfile ? React.createElement("div", {
        className: "rex-mono", style: { marginTop: 8, fontSize: 10, color: C.textDim },
      }, "loading tick file...") : null,
    );
  }

  // ---------- TickFileViewer ----------
  function SectionHeader(props) {
    const { role, expanded, onToggle, isActive } = props;
    return React.createElement("button", {
      onClick: onToggle,
      style: {
        width: "100%", textAlign: "left",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "8px 10px",
        background: isActive ? C.accent + "11" : "transparent",
        border: "1px solid " + (isActive ? C.accent + "55" : C.border),
        borderRadius: 2, cursor: "pointer",
        color: isActive ? C.accent : C.text, fontFamily: FONT.chrome, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700,
      },
    },
      React.createElement("span", null, (expanded ? "▾ " : "▸ ") + role),
      isActive ? React.createElement("span", { className: "rex-mono", style: { fontSize: 9, letterSpacing: "0.2em" } }, "ACTIVE") : null,
    );
  }

  function TickFileViewer(props) {
    const tickfile = props.tickfile;
    const [collapsed, setCollapsed] = useState({}); // {role: bool}

    const sections = (tickfile && tickfile.sections) || [];
    const activeIdx = sections.length - 1; // last section is the most recent / running

    function isExpanded(i) {
      const role = sections[i].role;
      // Default: active section expanded, others collapsed unless explicitly toggled
      const explicit = collapsed[role];
      if (explicit != null) return !explicit;
      return i === activeIdx;
    }

    function toggle(i) {
      const role = sections[i].role;
      setCollapsed(function (c) {
        const cur = c[role];
        const wasExpanded = cur != null ? !cur : (i === activeIdx);
        return Object.assign({}, c, { [role]: wasExpanded ? true : false });
      });
    }

    if (!tickfile) {
      return React.createElement(Panel, null,
        React.createElement("span", { className: "rex-mono", style: { color: C.textDim, fontSize: 11 } }, "no tick file loaded"),
      );
    }

    if (sections.length === 0) {
      return React.createElement(Panel, null,
        React.createElement("span", { className: "rex-mono", style: { color: C.textDim, fontSize: 11 } }, "tick file is empty"),
      );
    }

    return React.createElement(Panel, { padding: 8, style: { display: "flex", flexDirection: "column", gap: 6 } },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "0 4px 4px" } },
        React.createElement("span", { className: "rex-chrome", style: { fontSize: 9, color: C.textDim, letterSpacing: "0.22em" } },
          "TICK FILE · " + (tickfile.path || "").split("/").slice(-3).join("/")),
        React.createElement("span", { className: "rex-mono", style: { fontSize: 9, color: C.textDim } },
          tickfile.size != null ? (tickfile.size + " bytes") : ""),
      ),
      sections.map(function (s, i) {
        const expanded = isExpanded(i);
        return React.createElement("div", { key: s.role + ":" + i, style: { display: "flex", flexDirection: "column", gap: 4 } },
          React.createElement(SectionHeader, {
            role: s.role, expanded: expanded, isActive: i === activeIdx,
            onToggle: function () { toggle(i); },
          }),
          expanded ? React.createElement("pre", {
            className: "rex-mono rex-scroll",
            style: {
              margin: 0, padding: "8px 10px",
              background: C.surfaceLo, border: "1px solid " + C.border, borderRadius: 2,
              fontSize: 11, lineHeight: 1.5, color: C.text,
              maxHeight: 320, overflow: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            },
          }, s.body || "(empty)") : null,
        );
      }),
    );
  }


  // ---------- TokensColumn ----------
  function BigTokens(props) {
    const inN = safeNum(props.in);
    const outN = safeNum(props.out);
    const total = inN + outN;
    const empty = total === 0;
    return React.createElement(Panel, { padding: "10px 12px" },
      React.createElement("span", {
        className: "rex-chrome",
        style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em", fontWeight: 600 },
      }, props.label),
      empty
        ? React.createElement("div", {
            className: "rex-mono",
            style: { marginTop: 8, fontSize: 11, color: C.textDim, fontStyle: "italic" },
          }, "no data yet")
        : React.createElement("div", { style: { display: "flex", gap: 14, marginTop: 6, alignItems: "baseline" } },
            React.createElement("span", {
              className: "rex-mono",
              style: { fontSize: 28, color: C.text, fontVariantNumeric: "tabular-nums", lineHeight: 1, fontWeight: 600 },
            }, fmtTokens(total)),
            React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } },
              "in " + fmtTokens(inN) + " · out " + fmtTokens(outN)),
          ),
      props.sub && !empty
        ? React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 10, color: C.textDim, marginTop: 4, display: "block" },
          }, props.sub)
        : null,
    );
  }

  function ByRoleTable(props) {
    const data = props.data || {};
    const roles = Object.keys(data).sort();
    return React.createElement(Panel, null,
      React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em", display: "block", marginBottom: 8 } }, "BY ROLE"),
      roles.length === 0
        ? React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } }, "no per-role data yet")
        : React.createElement("table", {
            style: { width: "100%", borderCollapse: "collapse", fontFamily: FONT.mono, fontSize: 10 },
          },
            React.createElement("thead", null,
              React.createElement("tr", { style: { color: C.textDim } },
                React.createElement("th", { style: { textAlign: "left", padding: "2px 4px", letterSpacing: "0.18em" } }, "ROLE"),
                React.createElement("th", { style: { textAlign: "right", padding: "2px 4px", letterSpacing: "0.18em" } }, "TODAY"),
                React.createElement("th", { style: { textAlign: "right", padding: "2px 4px", letterSpacing: "0.18em" } }, "LIFETIME"),
                React.createElement("th", { style: { textAlign: "right", padding: "2px 4px", letterSpacing: "0.18em" } }, "WALL"),
              ),
            ),
            React.createElement("tbody", null,
              roles.map(function (r) {
                const row = data[r] || {};
                const tIn = safeNum(row.today && row.today["in"]) + safeNum(row.today && row.today.out);
                const lIn = safeNum(row.lifetime && row.lifetime["in"]) + safeNum(row.lifetime && row.lifetime.out);
                const wall = safeNum(row.lifetime && row.lifetime.wall);
                return React.createElement("tr", { key: r, style: { borderTop: "1px solid " + C.border } },
                  React.createElement("td", { style: { padding: "4px", color: C.text, textTransform: "capitalize" } }, r),
                  React.createElement("td", { style: { padding: "4px", textAlign: "right", color: C.accent } }, fmtTokens(tIn)),
                  React.createElement("td", { style: { padding: "4px", textAlign: "right", color: C.text } }, fmtTokens(lIn)),
                  React.createElement("td", { style: { padding: "4px", textAlign: "right", color: C.textDim } }, fmtDuration(wall)),
                );
              }),
            ),
          ),
    );
  }

  function HourlyChart(props) {
    const points = props.data || [];
    const W = 360, H = 80, PAD = 4;
    if (points.length === 0) {
      return React.createElement(Panel, null,
        React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em" } }, "TOKENS / HR · 24H"),
        React.createElement("div", { className: "rex-mono", style: { fontSize: 10, color: C.textDim, marginTop: 8 } }, "no hourly data"),
      );
    }
    const totals = points.map(function (p) { return safeNum(p["in"]) + safeNum(p.out); });
    const max = Math.max.apply(null, totals) || 1;
    const barW = (W - 2 * PAD) / Math.max(points.length, 1);
    return React.createElement(Panel, null,
      React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em" } }, "TOKENS / HR · " + points.length + "H"),
      React.createElement("svg", {
        width: "100%", height: H, viewBox: "0 0 " + W + " " + H,
        style: { display: "block", marginTop: 6 },
      },
        points.map(function (p, i) {
          const total = totals[i];
          const h = (total / max) * (H - 2 * PAD);
          return React.createElement("rect", {
            key: i,
            x: (PAD + i * barW).toFixed(1), y: (H - PAD - h).toFixed(1),
            width: Math.max(1, barW - 1).toFixed(1), height: h.toFixed(1),
            fill: i === points.length - 1 ? C.accent : C.info,
            opacity: 0.85,
          });
        }),
      ),
    );
  }

  function TokensColumn(props) {
    const { today, total, byRole, byHour } = props;
    return React.createElement("aside", {
      className: "rex-scroll",
      style: {
        width: 380, padding: "12px 12px 16px",
        borderLeft: "1px solid " + C.border,
        overflowY: "auto", height: "100%",
        display: "flex", flexDirection: "column", gap: 12,
      },
    },
      React.createElement(BigTokens, {
        label: "TOKENS TODAY",
        in: today && today["in"], out: today && today.out,
      }),
      React.createElement(BigTokens, {
        label: "TOTAL TOKENS",
        in: total && total["in"], out: total && total.out,
        sub: total && total.days_running ? (total.days_running + " days · avg " + fmtTokens(safeNum(total.avg_per_day && (total.avg_per_day["in"] + total.avg_per_day.out))) + "/day") : null,
      }),
      React.createElement(ByRoleTable, { data: byRole || {} }),
      React.createElement(HourlyChart, { data: byHour || [] }),
    );
  }

  // ---------- CronStrip ----------
  // The /cron-stream endpoint returns plain strings (not {ts, mission, level} objects);
  // we parse the leading "[ISO_TS]" and color-code by content keywords.
  const _TS_RE = /^\[([0-9T:+\-Z. ]+)\]\s+(.*)$/;

  function classifyCronLine(s) {
    const t = s.toLowerCase();
    if (t.indexOf("fail") >= 0 || t.indexOf("error") >= 0 || t.indexOf("rc=1") >= 0) return { color: C.error, icon: "✗" };
    if (t.indexOf("skip") >= 0 || t.indexOf("preflight refused") >= 0)               return { color: C.muted, icon: "·" };
    if (t.indexOf("tick start") >= 0 || t.indexOf("scope-start") >= 0)               return { color: C.accent, icon: "▶" };
    if (t.indexOf(" ok ") >= 0 || t.indexOf("rc=0") >= 0 || t.indexOf("scope-end") >= 0) return { color: C.success, icon: "✓" };
    if (t.indexOf("pause") >= 0)                                                     return { color: C.error, icon: "⏸" };
    return { color: C.textDim, icon: " " };
  }

  function parseCronLine(s) {
    const m = _TS_RE.exec(s);
    return m ? { ts: m[1], body: m[2] } : { ts: null, body: s };
  }

  function CronStrip(props) {
    const { lines } = props;
    const scrollRef = useRef(null);
    useEffect(function () {
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }, [lines.length]);

    return React.createElement("section", {
      style: {
        borderTop: "1px solid " + C.border,
        background: "rgba(0,8,20,0.55)",
        display: "flex", flexDirection: "column",
        height: 160, minHeight: 160,
      },
    },
      // Header bar
      React.createElement("div", {
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 12px", borderBottom: "1px solid " + C.border, flexShrink: 0,
        },
      },
        React.createElement("span", {
          className: "rex-chrome",
          style: { fontSize: 10, color: C.textDim, letterSpacing: "0.24em", fontWeight: 600 },
        }, "CRON STREAM"),
        React.createElement("span", {
          className: "rex-mono",
          style: { fontSize: 10, color: C.textDim },
        }, lines.length + (lines.length === 1 ? " event" : " events")),
      ),
      // Stream
      React.createElement("div", {
        ref: scrollRef, className: "rex-scroll",
        style: {
          flex: 1, overflowY: "auto", padding: "4px 12px 8px",
          fontFamily: FONT.mono, fontSize: 11, lineHeight: 1.5,
        },
      },
        lines.length === 0
          ? React.createElement("span", { style: { color: C.textDim, fontSize: 10 } }, "// no cron events yet")
          : lines.map(function (raw, i) {
              const s = String(raw);
              const cls = classifyCronLine(s);
              const parsed = parseCronLine(s);
              return React.createElement("div", {
                key: i,
                style: {
                  display: "grid", gridTemplateColumns: "16px 90px 1fr",
                  gap: 8, color: cls.color, alignItems: "baseline",
                },
              },
                React.createElement("span", { style: { color: cls.color, opacity: 0.85, textAlign: "center" } }, cls.icon),
                React.createElement("span", {
                  style: { color: C.textDim, fontSize: 10, fontVariantNumeric: "tabular-nums" },
                }, parsed.ts ? tzFormat(parsed.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"),
                React.createElement("span", {
                  style: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
                }, parsed.body),
              );
            }),
      ),
    );
  }

  // ---------- PmStrip (purple, top of Kanban view) ----------
  function PmStrip(props) {
    const { pm } = props;
    const data = (pm && pm.data) || { state: "idle", queue: [], today: { scoped: 0, avg_seconds: 0, fails: 0 }, current: null, trace: [] };
    const isWorking = data.state === "working";
    const isPaused = data.state === "paused";
    const purple = C.pmAccent;

    const stateLabel = (function () {
      if (isPaused) return "PM PAUSED";
      if (isWorking) {
        const elapsed = data.current && data.current.started_at
          ? Math.floor((Date.now() - new Date(data.current.started_at).getTime()) / 1000)
          : null;
        return "scoping '" + (data.current && data.current.title || "?") + "'" +
          (elapsed != null ? " · " + fmtDuration(elapsed) + " in" : "");
      }
      return "idle, queue " + ((data.queue && data.queue.length) || 0);
    })();

    return React.createElement(Panel, {
      accent: purple,
      style: {
        marginBottom: 12,
        background: purple + "0c",
        borderColor: purple + "55",
        boxShadow: isWorking ? "0 0 0 1px " + purple + "33" : "none",
      },
      className: isWorking ? "rex-pulse-yellow" : null,
    },
      React.createElement("div", { style: { display: "flex", gap: 18, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" } },
        React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center", minWidth: 0 } },
          React.createElement("span", {
            className: "rex-chrome",
            style: { fontSize: 10, color: purple, letterSpacing: "0.24em", fontWeight: 700 },
          }, "PM AGENT"),
          React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 12, color: isPaused ? C.error : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, stateLabel),
        ),
        React.createElement("div", { style: { display: "flex", gap: 24, alignItems: "center" } },
          React.createElement(Stat, { label: "scoped today",  value: data.today && data.today.scoped, color: purple }),
          React.createElement(Stat, { label: "avg scope time", value: fmtDuration(data.today && data.today.avg_seconds) }),
          React.createElement(Stat, { label: "fails",          value: data.today && data.today.fails, color: (data.today && data.today.fails > 0) ? C.error : C.success }),
          React.createElement(IconButton, {
            onClick: function () { pm.setPaused(!isPaused); },
            danger: !isPaused,
            style: { borderColor: purple, color: isPaused ? C.success : purple },
          }, isPaused ? "RESUME PM" : "PAUSE PM"),
        ),
      ),
      // Live PM trace (only while scoping)
      isWorking && data.trace && data.trace.length > 0
        ? React.createElement("pre", {
            className: "rex-mono rex-scroll",
            style: {
              marginTop: 8, padding: "8px 10px",
              background: C.surfaceLo, border: "1px dashed " + purple + "55", borderRadius: 2,
              fontSize: 10, lineHeight: 1.4, color: C.textDim,
              maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
            },
          }, data.trace.join("\n"))
        : null,
    );
  }

  // ---------- KanbanCard ----------
  function CardInbox(props) {
    const c = props.card;
    return React.createElement("div", null,
      React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.text, fontWeight: 600 } }, c.title),
      c.tag ? React.createElement("span", {
        className: "rex-chrome",
        style: { marginLeft: 8, padding: "1px 6px", borderRadius: 2, background: C.info + "22", color: C.info, fontSize: 9, letterSpacing: "0.15em" },
      }, c.tag) : null,
      React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4 } },
        relTime(c.created_at)),
    );
  }

  function CardScoping(props) {
    const c = props.card;
    const queuePos = props.queuePos;  // null if currently active in PM, else 1+
    const purple = C.pmAccent;
    return React.createElement("div", { className: queuePos == null ? "rex-pulse-yellow" : null },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 } },
        React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.text, fontWeight: 600 } }, c.title),
        queuePos == null
          ? React.createElement("span", { className: "rex-chrome", style: { color: purple, fontSize: 9, letterSpacing: "0.2em" } }, "ACTIVE")
          : React.createElement("span", { className: "rex-chrome", style: { color: C.textDim, fontSize: 9, letterSpacing: "0.2em" } }, "QUEUE #" + queuePos),
      ),
      React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4 } },
        "attempt " + (c.scope_attempts || 0) + " · " + relTime(c.updated_at)),
    );
  }

  function CardBacklog(props) {
    const c = props.card;
    const onStart = props.onStart, onEdit = props.onEdit, onDiscard = props.onDiscard;
    const sp = c.spec_summary || {}; // optional rollup the backend may attach (DB1 frontmatter parse)
    return React.createElement("div", null,
      React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.text, fontWeight: 600 } }, c.title),
      c.needs_review ? React.createElement("span", {
        className: "rex-chrome",
        style: { marginLeft: 8, padding: "1px 6px", borderRadius: 2, background: C.error + "22", color: C.error, fontSize: 9, letterSpacing: "0.15em" },
      }, "NEEDS REVIEW") : null,
      React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" } },
        sp.tasks_count != null ? React.createElement("span", null, sp.tasks_count + " tasks") : null,
        sp.phases_count != null ? React.createElement("span", null, sp.phases_count + " phases") : null,
        sp.max_days != null ? React.createElement("span", null, sp.max_days + "d max") : null,
        sp.workspace ? React.createElement("span", null, "ws: " + sp.workspace.replace(/^\/home\/ubuntu\//, "~/")) : null,
      ),
      React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
        React.createElement(IconButton, { onClick: function () { onStart(c.id); }, style: { borderColor: C.success, color: C.success } }, "START"),
        React.createElement(IconButton, { onClick: function () { onEdit(c); } }, "EDIT"),
        React.createElement(IconButton, { onClick: function () { onDiscard(c.id); }, danger: true }, "DISCARD"),
      ),
    );
  }

  function CardActive(props) {
    const c = props.card;
    const m = props.mission;
    const onJump = props.onJump;
    const isLive = m && m.current_tick && m.current_tick.state === "running";
    return React.createElement("div", { onClick: function () { if (m) onJump(m.name); }, style: { cursor: m ? "pointer" : "default" } },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
        React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.text, fontWeight: 600 } }, c.title),
        m ? React.createElement(StatusPill, { status: isLive ? "running" : m.status }) : React.createElement(StatusPill, { status: "pending" }),
      ),
      m
        ? React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4 } },
            (m.tick_count || 0) + " ticks" +
            (m.current_tick ? " · " + (m.current_tick.role || "?") + " " + (m.current_tick.elapsed != null ? fmtDuration(m.current_tick.elapsed) : "") : "") +
            (m.tokens_today != null ? " · " + fmtTokens(m.tokens_today) + " tok today" : ""))
        : React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4 } }, "promoting..."),
    );
  }

  function CardDone(props) {
    const c = props.card;
    const m = props.mission;
    return React.createElement("div", null,
      React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.text, fontWeight: 600 } }, c.title),
      React.createElement("div", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" } },
        React.createElement("span", null, m && m.completed_at ? tzFormat(m.completed_at, { month: "short", day: "numeric", timeZoneName: "short" }) : "—"),
        m && m.tick_count != null ? React.createElement("span", null, m.tick_count + " ticks") : null,
        m && m.run_seconds != null ? React.createElement("span", null, fmtDuration(m.run_seconds)) : null,
        m && m.report_path ? React.createElement("a", {
          href: m.report_path, target: "_blank", style: { color: C.info, textDecoration: "none" },
        }, "report.md ↗") : null,
      ),
    );
  }

  function KanbanCard(props) {
    const c = props.card;
    const accent = (
      c.status === "scoping" ? C.pmAccent :
      c.status === "active"  ? C.accent :
      c.status === "done"    ? C.success :
      c.status === "backlog" ? C.info :
      C.border
    );
    let body;
    if (c.status === "inbox")      body = React.createElement(CardInbox,   { card: c });
    else if (c.status === "scoping") body = React.createElement(CardScoping, { card: c, queuePos: props.queuePos });
    else if (c.status === "backlog") body = React.createElement(CardBacklog, { card: c, onStart: props.onStart, onEdit: props.onEdit, onDiscard: props.onDiscard });
    else if (c.status === "active")  body = React.createElement(CardActive,  { card: c, mission: props.mission, onJump: props.onJump });
    else if (c.status === "done")    body = React.createElement(CardDone,    { card: c, mission: props.mission });
    else body = React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } }, c.title);

    return React.createElement(Panel, {
      accent: accent,
      style: { marginBottom: 8, padding: "10px 12px" },
    }, body);
  }

  // ---------- KanbanColumn ----------
  function KanbanColumn(props) {
    const { id, label, accent, cards, children } = props;
    return React.createElement("div", {
      className: "rex-scroll",
      style: {
        display: "flex", flexDirection: "column", minWidth: 0,
        background: C.surfaceLo, border: "1px solid " + C.border, borderTop: "2px solid " + accent,
        borderRadius: 2, padding: 10, height: "100%", overflowY: "auto",
      },
    },
      React.createElement("div", {
        className: "rex-chrome",
        style: {
          fontSize: 10, color: accent, letterSpacing: "0.24em", fontWeight: 700,
          paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid " + C.border,
          display: "flex", justifyContent: "space-between",
        },
      },
        React.createElement("span", null, label),
        React.createElement("span", { style: { color: C.textDim } }, "(" + cards.length + ")"),
      ),
      children,
      cards.length === 0
        ? React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim, padding: "8px 4px" } }, "empty")
        : null,
    );
  }

  function NewIdeaInput(props) {
    const [title, setTitle] = useState("");
    const [tag, setTag] = useState("");
    const [busy, setBusy] = useState(false);

    function submit() {
      const t = title.trim();
      if (!t || busy) return;
      setBusy(true);
      props.onCreate(t, tag.trim() || null)
        .then(function () { setTitle(""); setTag(""); })
        .catch(function (err) { console.warn("[rex-loop] create card failed", err); })
        .finally(function () { setBusy(false); });
    }

    return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 } },
      React.createElement("input", {
        type: "text", value: title, placeholder: "+ new idea",
        onChange: function (e) { setTitle(e.target.value); },
        onKeyDown: function (e) { if (e.key === "Enter") submit(); },
        style: {
          background: C.bg, color: C.text, border: "1px solid " + C.border, borderRadius: 2,
          padding: "6px 8px", fontFamily: FONT.mono, fontSize: 11,
        },
      }),
      React.createElement("div", { style: { display: "flex", gap: 6 } },
        React.createElement("input", {
          type: "text", value: tag, placeholder: "tag (optional)",
          onChange: function (e) { setTag(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter") submit(); },
          style: {
            flex: 1, background: C.bg, color: C.textDim, border: "1px solid " + C.border, borderRadius: 2,
            padding: "4px 8px", fontFamily: FONT.mono, fontSize: 10,
          },
        }),
        React.createElement(IconButton, { onClick: submit, disabled: busy || !title.trim() }, busy ? "…" : "ADD"),
      ),
    );
  }

  // ============================================================================
  // 7. PAGES
  // ============================================================================

  function IdleBanner(props) {
    const m = props.mission;
    const next = m.next_tick_at ? new Date(m.next_tick_at).getTime() : null;
    const remaining = next ? Math.max(0, Math.floor((next - Date.now()) / 1000)) : null;
    const lastTick = (m.ticks_summary && m.ticks_summary.length)
      ? m.ticks_summary[m.ticks_summary.length - 1]
      : null;
    const lastResult = lastTick
      ? (lastTick.state === "done" ? { color: C.success, label: "✓ done" }
        : lastTick.state === "failed" ? { color: C.error, label: "✗ failed" }
        : { color: C.muted, label: lastTick.state || "—" })
      : null;
    const lastTickRel = lastTick && lastTick.started_at ? relTime(lastTick.started_at) : null;

    return React.createElement(Panel, {
      style: { padding: "10px 12px", borderLeft: "3px solid " + C.muted },
    },
      // Title row
      React.createElement("div", {
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
      },
        React.createElement("span", {
          className: "rex-mono",
          style: { fontSize: 12, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        }, m.name),
        React.createElement("span", {
          className: "rex-chrome",
          style: { fontSize: 9, color: C.textDim, letterSpacing: "0.22em" },
        }, "IDLE"),
      ),
      // Stats grid: ticks · last result · next tick
      React.createElement("div", {
        style: {
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
          gap: 12, marginTop: 8, fontSize: 10,
        },
      },
        // Ticks
        React.createElement("div", { className: "rex-mono", style: { display: "flex", flexDirection: "column", gap: 2 } },
          React.createElement("span", { style: { color: C.textDim, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase" } }, "ticks"),
          React.createElement("span", { style: { color: C.text, fontSize: 12, fontVariantNumeric: "tabular-nums" } }, m.tick_count || 0),
        ),
        // Last result
        React.createElement("div", { className: "rex-mono", style: { display: "flex", flexDirection: "column", gap: 2 } },
          React.createElement("span", { style: { color: C.textDim, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase" } }, "last"),
          lastResult
            ? React.createElement("span", { style: { color: lastResult.color, fontSize: 11 } },
                lastResult.label + (lastTickRel ? " · " + lastTickRel : ""))
            : React.createElement("span", { style: { color: C.textDim, fontSize: 11 } }, "no ticks yet"),
        ),
        // Next tick
        React.createElement("div", { className: "rex-mono", style: { display: "flex", flexDirection: "column", gap: 2 } },
          React.createElement("span", { style: { color: C.textDim, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase" } }, "next"),
          React.createElement("span", { style: { color: remaining != null ? C.info : C.textDim, fontSize: 11 } },
            remaining != null ? "in " + fmtDuration(remaining) : "—"),
        ),
      ),
    );
  }

  function OverviewPage(props) {
    const missionsState = useMissions();
    const missions = missionsState.data || [];
    const [selectedName, setSelectedName] = useState(function () {
      try {
        const j = localStorage.getItem("rex-loop:jump-mission");
        if (j) { localStorage.removeItem("rex-loop:jump-mission"); return j; }
      } catch (_e) {}
      return null;
    });
    const active = useActiveMission(missions);
    const selected = useMemo(function () {
      if (selectedName) return missions.find(function (m) { return m.name === selectedName; }) || null;
      return active;
    }, [missions, selectedName, active]);

    const liveTickId = (active && active.current_tick) ? active.current_tick.id : null;
    const tickfileState = useTickFile(active && active.name, liveTickId);

    const tokensTodayState = useTokensToday();
    const tokensTotalState = useTokensTotal();
    const byRoleState      = useTokensByRole();
    const byHourState      = useTokensByHour(24);

    const cronLines = useCronStream();

    const pause = useGlobalPause();

    return React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        height: "calc(100vh - 56px)",  // adjust if Hermes nav height differs
        background: C.bg, color: C.text, fontFamily: FONT.chrome,
      },
    },
      React.createElement(Header, {
        missions: missions, tokensToday: tokensTodayState.data, tokensTotal: tokensTotalState.data, pause: pause,
      }),
      React.createElement("div", {
        style: { display: "grid", gridTemplateColumns: "320px 1fr 380px", minHeight: 0 },
      },
        React.createElement(LeftRail, {
          missions: missions, selected: selected ? selected.name : null, onSelect: setSelectedName,
        }),
        React.createElement("main", {
          className: "rex-scroll",
          style: { padding: "14px 16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 },
        },
          // Live agent panel (only if there's an actively running tick)
          active
            ? React.createElement(AgentPanel, {
                mission: active, tickfile: tickfileState.data, loadingTick: tickfileState.loading,
              })
            : null,
          // Live tick file viewer
          active
            ? React.createElement(TickFileViewer, { tickfile: tickfileState.data })
            : null,
          // No-live-tick state banner (only when nothing is running)
          !active && missions.length > 0
            ? React.createElement("div", {
                style: {
                  padding: "10px 14px", border: "1px dashed " + C.border, borderRadius: 4,
                  background: "rgba(255,255,255,0.01)",
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                },
              },
                React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.textDim, letterSpacing: "0.22em" } },
                  "▌ NO TICK CURRENTLY RUNNING"),
                React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim } },
                  missions.filter(function (m) { return m.status === "active"; }).length + " active missions waiting on cron"),
              )
            : null,
          // Idle banners for non-running missions — grid layout when no live tick
          !active
            ? React.createElement("div", {
                style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 },
              },
                missions.filter(function (m) { return m.status === "active" && (!m.current_tick || m.current_tick.state !== "running"); })
                  .map(function (m) { return React.createElement(IdleBanner, { key: m.name, mission: m }); }),
              )
            : missions.filter(function (m) { return m.status === "active" && (!m.current_tick || m.current_tick.state !== "running"); })
                .map(function (m) { return React.createElement(IdleBanner, { key: m.name, mission: m }); }),
          // Empty state
          missions.length === 0 && !missionsState.loading
            ? React.createElement(Panel, null,
                React.createElement("span", { className: "rex-mono", style: { fontSize: 11, color: C.textDim } }, "no missions in ~/.hermes/missions/"),
              )
            : null,
        ),
        React.createElement(TokensColumn, {
          today: tokensTodayState.data, total: tokensTotalState.data, byRole: byRoleState.data, byHour: byHourState.data,
        }),
      ),
      React.createElement(CronStrip, { lines: cronLines }),
    );
  }

  function KanbanPage() {
    const kanban = useKanban();
    const pm = usePmStatus();
    const missionsState = useMissions();
    const missions = missionsState.data || [];
    const [editingCard, setEditingCard] = useState(null);

    function missionByName(n) {
      if (!n) return null;
      return missions.find(function (m) { return m.name === n; }) || null;
    }

    // Group cards by status
    const byStatus = useMemo(function () {
      const out = { inbox: [], scoping: [], backlog: [], active: [], done: [] };
      (kanban.cards || []).forEach(function (c) {
        if (c.status && out[c.status]) out[c.status].push(c);
      });
      // Newest-first within each column (created_at desc)
      Object.keys(out).forEach(function (k) {
        out[k].sort(function (a, b) { return (b.created_at || "").localeCompare(a.created_at || ""); });
      });
      return out;
    }, [kanban.cards]);

    // Determine PM queue position: scoping cards in queue order (oldest first === position 1)
    const scopingByQueue = useMemo(function () {
      const arr = (byStatus.scoping || []).slice().sort(function (a, b) { return (a.updated_at || "").localeCompare(b.updated_at || ""); });
      const activeId = pm.data && pm.data.current && pm.data.current.card_id;
      return arr.map(function (c, i) {
        return { card: c, queuePos: c.id === activeId ? null : (i + 1) };
      });
    }, [byStatus.scoping, pm.data]);

    function handleStart(id)   { kanban.promote(id).catch(function (e) { alert("promote failed: " + (e.message || e)); }); }
    function handleDiscard(id) { if (confirm("Discard this card?")) kanban.discard(id); }
    function handleEdit(c)     { setEditingCard(c); }
    function handleJump(missionName) {
      try {
        localStorage.setItem("rex-loop:active-tab", "overview");
        if (missionName) localStorage.setItem("rex-loop:jump-mission", missionName);
      } catch (_e) {}
      window.dispatchEvent(new CustomEvent("rex-loop:jump-to-overview", { detail: { mission: missionName } }));
    }

    function ColumnCards(props) {
      return props.cards.map(function (c) {
        return React.createElement(KanbanCard, {
          key: c.id, card: c,
          mission: c.mission_name ? missionByName(c.mission_name) : null,
          onStart: handleStart, onEdit: handleEdit, onDiscard: handleDiscard, onJump: handleJump,
        });
      });
    }

    return React.createElement("div", {
      style: { padding: "12px 16px", background: C.bg, color: C.text, height: "100%", display: "flex", flexDirection: "column" },
    },
      React.createElement(PmStrip, { pm: pm }),
      kanban.error
        ? React.createElement(Panel, { accent: C.error, style: { marginBottom: 12 } },
            React.createElement("span", { className: "rex-mono", style: { color: C.error, fontSize: 11 } },
              "kanban error: " + (kanban.error.message || String(kanban.error))))
        : null,
      React.createElement("div", {
        style: { display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, flex: 1, minHeight: 0 },
      },
        // Inbox — has new-idea input
        React.createElement(KanbanColumn, { id: "inbox", label: "INBOX", accent: C.muted, cards: byStatus.inbox },
          React.createElement(NewIdeaInput, { onCreate: kanban.create }),
          ColumnCards({ cards: byStatus.inbox }),
        ),
        // Scoping — uses queue position
        React.createElement(KanbanColumn, { id: "scoping", label: "SCOPING", accent: C.pmAccent, cards: byStatus.scoping },
          scopingByQueue.map(function (entry) {
            return React.createElement(KanbanCard, {
              key: entry.card.id, card: entry.card, queuePos: entry.queuePos,
              onStart: handleStart, onEdit: handleEdit, onDiscard: handleDiscard,
            });
          }),
        ),
        // Backlog
        React.createElement(KanbanColumn, { id: "backlog", label: "BACKLOG", accent: C.info, cards: byStatus.backlog },
          ColumnCards({ cards: byStatus.backlog }),
        ),
        // Active
        React.createElement(KanbanColumn, { id: "active", label: "ACTIVE", accent: C.accent, cards: byStatus.active },
          ColumnCards({ cards: byStatus.active }),
        ),
        // Done
        React.createElement(KanbanColumn, { id: "done", label: "DONE", accent: C.success, cards: byStatus.done },
          ColumnCards({ cards: byStatus.done }),
        ),
      ),
      // Edit modal
      editingCard
        ? React.createElement(EditCardModal, {
            card: editingCard,
            onClose: function () { setEditingCard(null); },
            onSave: function (patch) {
              kanban.update(editingCard.id, patch).then(function () { setEditingCard(null); });
            },
          })
        : null,
    );
  }

  function EditCardModal(props) {
    const [title, setTitle] = useState(props.card.title || "");
    const [tag, setTag] = useState(props.card.tag || "");
    return React.createElement("div", {
      onClick: props.onClose,
      style: {
        position: "fixed", inset: 0, background: "rgba(0,8,20,0.78)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      },
    },
      React.createElement("div", {
        onClick: function (e) { e.stopPropagation(); },
        style: {
          background: C.bg, border: "1px solid " + C.borderHi, borderRadius: 4,
          padding: 18, width: 420, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 10,
        },
      },
        React.createElement("span", { className: "rex-chrome", style: { fontSize: 11, color: C.accent, letterSpacing: "0.24em" } }, "EDIT CARD"),
        React.createElement("input", {
          type: "text", value: title, onChange: function (e) { setTitle(e.target.value); },
          style: { background: C.surfaceLo, color: C.text, border: "1px solid " + C.border, padding: "6px 8px", fontFamily: FONT.mono, fontSize: 12 },
        }),
        React.createElement("input", {
          type: "text", value: tag, placeholder: "tag", onChange: function (e) { setTag(e.target.value); },
          style: { background: C.surfaceLo, color: C.textDim, border: "1px solid " + C.border, padding: "4px 8px", fontFamily: FONT.mono, fontSize: 11 },
        }),
        React.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 } },
          React.createElement(IconButton, { onClick: props.onClose }, "CANCEL"),
          React.createElement(IconButton, {
            onClick: function () { props.onSave({ title: title.trim(), tag: tag.trim() || null }); },
            style: { borderColor: C.success, color: C.success },
          }, "SAVE"),
        ),
      ),
    );
  }
  // ---------- Settings page ----------
  function ToggleRow(props) {
    const { label, description, on, onToggle, onColor, onLabel, offLabel, busy } = props;
    const accent = onColor || C.success;
    return React.createElement("div", {
      style: {
        display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center",
        padding: "14px 16px",
        borderTop: "1px solid " + C.border,
      },
    },
      React.createElement("div", { style: { minWidth: 0 } },
        React.createElement("div", {
          style: { display: "flex", alignItems: "center", gap: 10 },
        },
          React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 13, color: C.text, fontWeight: 700 },
          }, label),
          React.createElement("span", {
            className: "rex-chrome",
            style: {
              fontSize: 9, padding: "2px 8px", borderRadius: 2, letterSpacing: "0.2em", fontWeight: 700,
              background: (on ? accent : C.muted) + "22",
              color: on ? accent : C.muted,
              border: "1px solid " + (on ? accent : C.muted) + "55",
            },
          }, on ? (onLabel || "ON") : (offLabel || "OFF")),
        ),
        description ? React.createElement("p", {
          className: "rex-mono",
          style: { fontSize: 11, color: C.textDim, margin: "4px 0 0", lineHeight: 1.5 },
        }, description) : null,
      ),
      React.createElement(IconButton, {
        onClick: function () { onToggle(!on); },
        disabled: busy,
        style: {
          minWidth: 100, justifyContent: "center", textAlign: "center",
          borderColor: on ? accent : C.border,
          color: on ? accent : C.textDim,
        },
      }, busy ? "…" : (on ? "DISABLE" : "ENABLE")),
    );
  }

  function SettingsCard(props) {
    return React.createElement("div", {
      style: {
        background: C.surface, border: "1px solid " + C.border, borderRadius: 4,
        marginBottom: 14, overflow: "hidden",
      },
    },
      React.createElement("div", {
        style: {
          padding: "10px 16px",
          borderBottom: "1px solid " + C.border,
          background: "rgba(0,8,20,0.55)",
        },
      },
        React.createElement("span", {
          className: "rex-chrome",
          style: { fontSize: 10, color: props.accent || C.accent, letterSpacing: "0.24em", fontWeight: 700 },
        }, props.title),
        props.subtitle ? React.createElement("span", {
          className: "rex-mono",
          style: { fontSize: 10, color: C.textDim, marginLeft: 12 },
        }, props.subtitle) : null,
      ),
      props.children,
    );
  }

  function DiagnosticsRow(props) {
    return React.createElement("div", {
      style: {
        display: "grid", gridTemplateColumns: "200px 1fr",
        padding: "10px 16px", borderTop: "1px solid " + C.border, gap: 12, alignItems: "baseline",
      },
    },
      React.createElement("span", {
        className: "rex-chrome",
        style: { fontSize: 10, color: C.textDim, letterSpacing: "0.18em" },
      }, props.label),
      React.createElement("span", {
        className: "rex-mono",
        style: { fontSize: 11, color: props.color || C.text, fontVariantNumeric: "tabular-nums", wordBreak: "break-all" },
      }, props.value),
    );
  }

  function SettingsPage() {
    const pm = usePmStatus();
    const pause = useGlobalPause();
    const tokensTotal = useTokensTotal();
    const missionsState = useMissions();
    const [busy, setBusy] = useState({});

    function withBusy(key, fn) {
      setBusy(function (b) { return Object.assign({}, b, { [key]: true }); });
      Promise.resolve(fn()).finally(function () {
        setBusy(function (b) { const n = Object.assign({}, b); delete n[key]; return n; });
      });
    }

    const pmData    = pm.data || {};
    const autoFlow  = !!pmData.auto_flow;
    const pmPaused  = !!pmData.paused;
    const totalIn   = safeNum(tokensTotal.data && tokensTotal.data["in"]);
    const totalOut  = safeNum(tokensTotal.data && tokensTotal.data.out);
    const daysRun   = safeNum(tokensTotal.data && tokensTotal.data.days_running);
    const missions  = missionsState.data || [];

    return React.createElement("div", {
      style: {
        padding: "16px 20px",
        background: C.bg, color: C.text,
        height: "100%", overflowY: "auto",
        maxWidth: 880, margin: "0 auto",
      },
      className: "rex-scroll",
    },
      // Heading
      React.createElement("div", { style: { marginBottom: 18 } },
        React.createElement("h1", {
          className: "rex-chrome",
          style: { fontSize: 16, color: C.text, letterSpacing: "0.24em", fontWeight: 700, margin: 0 },
        }, "REX LOOP // SETTINGS"),
        React.createElement("p", {
          className: "rex-mono",
          style: { fontSize: 11, color: C.textDim, margin: "6px 0 0", lineHeight: 1.5 },
        }, "Toggles + diagnostics for the war-room. Changes apply immediately — no save button."),
      ),

      // Card 1: Loop control
      React.createElement(SettingsCard, { title: "LOOP CONTROL" },
        React.createElement(ToggleRow, {
          label: "Global Pause",
          description: "Halts ALL loops — Rex multi-profile ticks AND PM scoping. Sentinel file: ~/.hermes/loop/PAUSE",
          on: pause.paused,
          onColor: C.error,
          onLabel: "PAUSED",
          offLabel: "RUNNING",
          busy: busy.pause,
          onToggle: function () { withBusy("pause", function () { return pause.toggle(); }); },
        }),
      ),

      // Card 2: PM Agent
      React.createElement(SettingsCard, { title: "PM AGENT", accent: C.pmAccent },
        React.createElement(ToggleRow, {
          label: "Auto-Flow",
          description: "When ON, PM-scoped specs auto-promote from Backlog → Active. When OFF, you must click START on each Backlog card. Sentinel file: ~/.hermes/kanban/AUTO_FLOW",
          on: autoFlow,
          busy: busy.autoFlow,
          onToggle: function (next) { withBusy("autoFlow", function () { return pm.setAutoFlow(next); }); },
        }),
        React.createElement(ToggleRow, {
          label: "PM Pause",
          description: "Stops the PM scoping cron without affecting other loops. Sentinel file: ~/.hermes/kanban/PM_PAUSE",
          on: pmPaused,
          onColor: C.error,
          onLabel: "PAUSED",
          offLabel: "RUNNING",
          busy: busy.pmPause,
          onToggle: function (next) { withBusy("pmPause", function () { return pm.setPaused(next); }); },
        }),
      ),

      // Card 3: Diagnostics
      React.createElement(SettingsCard, {
        title: "DIAGNOSTICS",
        subtitle: "live state of the rex-loop plugin",
      },
        React.createElement(DiagnosticsRow, {
          label: "Plugin",
          value: "rex-loop / war-room v4 (manifest v2.0.0)",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Plugin dir",
          value: "~/.hermes/hermes-agent/plugins/rex-loop/dashboard/",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Missions",
          value: missions.length + " total · " +
            missions.filter(function (m) { return m.status === "active"; }).length + " active · " +
            missions.filter(function (m) { return m.status === "done"; }).length + " done",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Tokens (lifetime)",
          color: (totalIn + totalOut) > 0 ? C.text : C.error,
          value: (totalIn + totalOut) > 0
            ? (fmtTokens(totalIn) + " in · " + fmtTokens(totalOut) + " out · " + daysRun + " days")
            : "no data — Hermes session JSON does not preserve usage; scraper finds 0",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Local LLM",
          value: "llama-proxy: http://192.168.1.169:8081/v1 (PM profile target)",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Cron",
          value: "*/5 pm_runner.sh · */15 refresh-tokens.sh",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Sentinel files",
          value: "PAUSE=" + (pause.paused ? "yes" : "no") +
                 " · PM_PAUSE=" + (pmPaused ? "yes" : "no") +
                 " · AUTO_FLOW=" + (autoFlow ? "yes" : "no"),
        }),
      ),

      // Card 4: References
      React.createElement(SettingsCard, { title: "REFERENCES" },
        React.createElement(DiagnosticsRow, {
          label: "Spec",
          value: "docs/superpowers/specs/2026-05-05-rex-loop-warroom-and-pm-agent-design.md",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Plan",
          value: "docs/superpowers/plans/2026-05-05-rex-loop-warroom-and-pm-agent.md",
        }),
        React.createElement(DiagnosticsRow, {
          label: "Tag",
          value: "rex-loop-warroom-v2.0.1 (post-review fixes)",
        }),
      ),
    );
  }

  // ============================================================================
  // 7.X STREAM TILE
  // ============================================================================
  const KIND_COLOR = {
    "mission":   C.accent,        // yellow
    "synth":     "#79c2ff",       // blue
    "pm":        "#b76dff",       // purple
    "ai-brief":  "#06d6a0",       // green
    "telegram":  C.text,          // cool light
  };
  const KIND_ICON = {
    "mission":   "⚙",
    "synth":     "Σ",
    "pm":        "▤",
    "ai-brief":  "✎",
    "telegram":  "✉",
  };

  function fmtElapsed(startedAt) {
    if (!startedAt) return "";
    const sec = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime())/1000));
    const m = Math.floor(sec/60), s = sec%60;
    return (m < 10 ? "0"+m : m) + ":" + (s < 10 ? "0"+s : s);
  }

  function StreamTile(props) {
    const stream = props.stream;
    const sse = useStreamSSE(stream.status === "running" ? stream.id : null);
    const [now, setNow] = useState(Date.now());
    useEffect(function () {
      const id = setInterval(function () { setNow(Date.now()); }, 1000);
      return function () { clearInterval(id); };
    }, []);
    // For ended streams: do a one-shot fetch of the snapshot via SSE-with-follow=false
    const [snapshot, setSnapshot] = useState(null);
    useEffect(function () {
      if (stream.status === "running") return;
      fetch("/api/plugins/rex-loop/streams/" + encodeURIComponent(stream.id) +
            "/events?follow=false&snapshot=200")
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          // Parse SSE stream: lines starting with "data: " in snapshot event
          const m = txt.match(/event: snapshot\nid: \d+\ndata: (.+)\n\n/);
          if (m) {
            try { setSnapshot(JSON.parse(m[1]).lines || []); }
            catch (_e) {}
          }
        }).catch(function () {});
    }, [stream.id, stream.status]);

    const lines = stream.status === "running" ? sse.lines : (snapshot || []);
    const color = KIND_COLOR[stream.kind] || C.text;
    const icon = KIND_ICON[stream.kind] || "▶";
    const statusPill = stream.status === "running" ? "● LIVE"
                     : stream.status === "done" ? "✓ DONE"
                     : stream.status === "error" ? "✕ ERROR"
                     : "□ KILLED";

    return React.createElement("div", {
      style: {
        display: "flex", flexDirection: "column",
        background: C.surface, border: "1px solid " + C.border,
        borderTop: "2px solid " + color,
        borderRadius: 4, minHeight: 240,
      },
    },
      React.createElement("div", {
        style: { padding: "8px 12px", borderBottom: "1px solid " + C.border,
                 display: "flex", alignItems: "baseline", gap: 10,
                 fontFamily: FONT.chrome, fontSize: 11, letterSpacing: "0.18em" },
      },
        React.createElement("span", { style: { color, fontSize: 13 } }, icon),
        React.createElement("span", { style: { color, fontWeight: 600 } },
          stream.kind.toUpperCase()),
        React.createElement("span", { style: { color: C.text, opacity: 0.8 } },
          stream.instance),
        React.createElement("span", { style: { marginLeft: "auto", color: C.textDim } },
          (stream.model_hint || "?") + " · " + fmtElapsed(stream.started_at)),
        React.createElement("span", { style: { color, fontSize: 10 } }, statusPill),
      ),
      React.createElement("pre", {
        className: "rex-mono",
        style: { flex: 1, margin: 0, padding: "8px 12px", fontSize: 11,
                 lineHeight: "1.4", color: C.text, background: C.bg,
                 overflowY: "auto", maxHeight: 360, whiteSpace: "pre-wrap" },
      },
        lines.map(function (l) { return l.text; }).join("\n") || "(no output yet)",
      ),
    );
  }

  // ============================================================================
  // 7.Y TELEGRAM TILE
  // ============================================================================
  function useTelegramSession() {
    const recent = useApi("/telegram/recent?limit=1", 5000, []);
    const sessionId = (recent.data && recent.data[0] && recent.data[0].id) || null;
    const turns = useApi(sessionId ? "/telegram/" + encodeURIComponent(sessionId) + "/turns" : null,
                         3000, [sessionId]);
    return { sessionId: sessionId, turns: turns.data || [] };
  }

  function TelegramTile() {
    const t = useTelegramSession();
    const recent = (t.turns || []).slice(-20);
    return React.createElement("div", {
      style: {
        display: "flex", flexDirection: "column",
        background: C.surface, border: "1px solid " + C.border,
        borderTop: "2px solid " + KIND_COLOR.telegram, borderRadius: 4,
        minHeight: 240,
      },
    },
      React.createElement("div", {
        style: { padding: "8px 12px", borderBottom: "1px solid " + C.border,
                 display: "flex", alignItems: "baseline", gap: 10,
                 fontFamily: FONT.chrome, fontSize: 11, letterSpacing: "0.18em" },
      },
        React.createElement("span", { style: { color: KIND_COLOR.telegram, fontSize: 13 } }, KIND_ICON.telegram),
        React.createElement("span", { style: { color: KIND_COLOR.telegram, fontWeight: 600 } }, "TELEGRAM"),
        React.createElement("span", { style: { color: C.textDim, marginLeft: "auto" } },
          recent.length + " turns"),
      ),
      React.createElement("div", {
        style: { flex: 1, padding: "8px 12px", overflowY: "auto",
                 maxHeight: 360, display: "flex", flexDirection: "column", gap: 6,
                 background: C.bg, fontSize: 11, lineHeight: "1.45" },
      },
        recent.length === 0
          ? React.createElement("span", { style: { color: C.textDim } }, "(no turns yet)")
          : recent.map(function (turn, i) {
              const isUser = turn.role === "user";
              return React.createElement("div", {
                key: i,
                style: {
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: isUser ? "rgba(255,214,10,0.10)" : "rgba(255,255,255,0.04)",
                  border: "1px solid " + (isUser ? "rgba(255,214,10,0.3)" : C.border),
                  color: C.text, fontFamily: FONT.chrome, whiteSpace: "pre-wrap",
                },
              },
                React.createElement("span", {
                  style: { fontSize: 9, color: C.textDim, letterSpacing: "0.18em",
                           display: "block", marginBottom: 2,
                           fontFamily: FONT.chrome },
                }, isUser ? "USER" : "REX"),
                turn.content || ""
              );
            })
      )
    );
  }

  function CronRibbonTile() {
    const lines = useCronStream();
    return React.createElement("div", {
      style: {
        background: C.surface, border: "1px solid " + C.border,
        borderTop: "2px solid " + C.border, borderRadius: 4,
        gridColumn: "1 / -1",
      },
    },
      React.createElement("div", {
        style: { padding: "8px 12px", borderBottom: "1px solid " + C.border,
                 fontFamily: FONT.chrome, fontSize: 11, letterSpacing: "0.18em",
                 color: C.textDim },
      }, "\u258c CRON RIBBON \u00b7 cron.out tail"),
      React.createElement("pre", {
        className: "rex-mono",
        style: { margin: 0, padding: "8px 12px", fontSize: 10,
                 lineHeight: "1.45", color: C.text, background: C.bg,
                 maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap" },
      }, (lines || []).slice(-100).join("\n") || "(no cron output)")
    );
  }


  // ============================================================================
  // 7b. FIRE MENU
  // ============================================================================
  function FireMenu(props) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const missions = (props.missions || []).filter(function (m) { return m.status === "active"; });

    function fire(url, label) {
      setBusy(true);
      fetch("/api/plugins/rex-loop" + url, { method: "POST" })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
          return r.json();
        })
        .then(function (j) {
          setBusy(false); setOpen(false);
          if (props.onFired) props.onFired(j);
        })
        .catch(function (e) {
          setBusy(false);
          alert(label + " failed: " + e.message);
        });
    }

    return React.createElement("div", { style: { position: "relative" } },
      React.createElement("button", {
        onClick: function () { setOpen(!open); },
        disabled: busy,
        style: {
          padding: "6px 12px", background: C.accent, color: "#000",
          border: "none", borderRadius: 3, cursor: "pointer",
          fontFamily: FONT.chrome, fontSize: 11, letterSpacing: "0.18em",
          fontWeight: 600,
        },
      }, busy ? "FIRING…" : "FIRE ▾"),
      open ? React.createElement("div", {
        style: {
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          background: C.surface, border: "1px solid " + C.borderHi,
          borderRadius: 4, minWidth: 240, zIndex: 100,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        },
      },
        React.createElement("div", {
          style: { padding: "6px 12px", color: C.textDim,
                   fontFamily: FONT.chrome, fontSize: 10,
                   borderBottom: "1px solid " + C.border, letterSpacing: "0.18em" },
        }, "MISSION TICKS"),
        missions.length === 0
          ? React.createElement("div", { style: { padding: 12, color: C.textDim, fontSize: 11 } }, "(no active missions)")
          : missions.map(function (m) {
              return React.createElement("div", {
                key: m.name,
                onClick: function () { fire("/missions/" + encodeURIComponent(m.name) + "/fire",
                                            "fire " + m.name); },
                style: { padding: "8px 12px", cursor: "pointer", color: C.text,
                         fontFamily: FONT.chrome, fontSize: 11,
                         borderBottom: "1px solid " + C.border },
              }, "▶ " + m.name);
            }),
        React.createElement("div", {
          style: { padding: "6px 12px", color: C.textDim,
                   fontFamily: FONT.chrome, fontSize: 10,
                   borderBottom: "1px solid " + C.border, letterSpacing: "0.18em",
                   marginTop: 4 },
        }, "OTHER AGENTS"),
        React.createElement("div", {
          onClick: function () { fire("/pm/fire", "PM"); },
          style: { padding: "8px 12px", cursor: "pointer", color: C.text,
                   fontFamily: FONT.chrome, fontSize: 11,
                   borderBottom: "1px solid " + C.border },
        }, "▶ PM SCOPING"),
        React.createElement("div", {
          onClick: function () { fire("/ai-brief/fire", "AI Brief"); },
          style: { padding: "8px 12px", cursor: "pointer", color: C.text,
                   fontFamily: FONT.chrome, fontSize: 11 },
        }, "▶ AI BRIEF"),
      ) : null
    );
  }

  // ============================================================================
  // 8. ROOT
  // ============================================================================
  function AgentsPage() {
    const streamsState = useStreams();
    const missionsState = useMissions();
    const streams = (streamsState.data || []);
    const active = streams.filter(function (s) { return s.status === "running"; });
    const recentlyEnded = streams.filter(function (s) { return s.status !== "running"; })
                                  .slice(0, 3);

    function handleFired(j) {
      // Next normal poll will pick up the new stream within 4s.
    }

    return React.createElement("div", {
      style: {
        display: "grid", gridTemplateRows: "auto 1fr auto",
        height: "calc(100vh - 56px)", background: C.bg, color: C.text,
        fontFamily: FONT.chrome,
      },
    },
      // Header
      React.createElement("div", {
        style: { padding: "12px 20px", borderBottom: "1px solid " + C.border,
                 display: "flex", alignItems: "center", gap: 16 },
      },
        React.createElement("span", {
          style: { color: C.accent, letterSpacing: "0.22em", fontSize: 12 },
        }, "▌ AGENTS"),
        React.createElement("span", { style: { color: C.textDim, fontSize: 11 } },
          active.length + " active · " + recentlyEnded.length + " recently ended"),
        React.createElement("span", { style: { marginLeft: "auto" } },
          React.createElement(FireMenu, {
            missions: missionsState.data, onFired: handleFired })),
      ),
      // Tile grid + cron ribbon
      React.createElement("div", {
        style: { padding: 16, overflowY: "auto",
                 display: "grid",
                 gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                 gap: 12, alignContent: "start" },
      },
        active.map(function (s) {
          return React.createElement(StreamTile, { key: s.id, stream: s });
        }),
        recentlyEnded.map(function (s) {
          return React.createElement(StreamTile, { key: s.id, stream: s });
        }),
        React.createElement(TelegramTile, { key: "telegram-pinned" }),
        React.createElement(CronRibbonTile, { key: "cron-pinned" }),
      ),
      // Empty-state placard
      active.length === 0 ? React.createElement("div", {
        style: { padding: "8px 20px", borderTop: "1px solid " + C.border,
                 color: C.textDim, fontSize: 10, letterSpacing: "0.22em" },
      }, "▌ ALL AGENTS IDLE — fire one above or wait for next cron tick") : null,
    );
  }

  const TABS = [
    { id: "overview", label: "OVERVIEW", Page: OverviewPage },
    { id: "kanban",   label: "KANBAN",   Page: KanbanPage },
    { id: "agents",   label: "AGENTS",   Page: AgentsPage },
    { id: "settings", label: "SETTINGS", Page: SettingsPage },
  ];

  function RexLoopPage() {
    const [tab, setTab] = useState(function () {
      try {
        // URL hash override: /rex-loop#kanban → kanban tab on first mount.
        // Lets you deep-link or share a tab-specific URL.
        const h = (typeof location !== "undefined" && location.hash) ? location.hash.replace(/^#/, "") : "";
        if (h && TABS.some(function (t) { return t.id === h; })) return h;
        return localStorage.getItem("rex-loop:active-tab") || "overview";
      } catch (_e) { return "overview"; }
    });
    useEffect(function () {
      try { localStorage.setItem("rex-loop:active-tab", tab); } catch (_e) {}
      try {
        if (typeof history !== "undefined" && history.replaceState) {
          history.replaceState(null, "", "#" + tab);
        }
      } catch (_e) {}
    }, [tab]);

    useEffect(function () {
      function onJump() {
        setTab("overview");
        // The OverviewPage will pick up the requested mission from localStorage on the next mount
      }
      window.addEventListener("rex-loop:jump-to-overview", onJump);
      return function () { window.removeEventListener("rex-loop:jump-to-overview", onJump); };
    }, []);

    useEffect(function () {
      function onHashChange() {
        const h = (location.hash || "").replace(/^#/, "");
        if (h && TABS.some(function (t) { return t.id === h; })) {
          setTab(h);
        }
      }
      window.addEventListener("hashchange", onHashChange);
      return function () { window.removeEventListener("hashchange", onHashChange); };
    }, []);

    const ActivePage = (TABS.find(function (t) { return t.id === tab; }) || TABS[0]).Page;

    return React.createElement("div", {
      style: { background: C.bg, color: C.text, minHeight: "100%", display: "flex", flexDirection: "column" },
    },
      React.createElement("nav", {
        style: { display: "flex", gap: 0, borderBottom: "1px solid " + C.border, background: C.bg, padding: "0 16px" },
      },
        TABS.map(function (t) {
          const isActive = t.id === tab;
          return React.createElement("button", {
            key: t.id, onClick: function () { setTab(t.id); },
            className: "rex-chrome",
            style: {
              padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer",
              color: isActive ? C.accent : C.textDim, fontSize: 11, letterSpacing: "0.24em", fontWeight: 700,
              borderBottom: "2px solid " + (isActive ? C.accent : "transparent"),
            },
          }, t.label);
        }),
      ),
      React.createElement("div", { style: { flex: 1, minHeight: 0 } },
        React.createElement(ActivePage),
      ),
    );
  }

  // ============================================================================
  // 9. REGISTER
  // ============================================================================
  PLUGINS.register("rex-loop", RexLoopPage);
  console.log("[rex-loop] registered (war-room v4)");
})();

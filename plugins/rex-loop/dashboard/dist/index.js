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
  // 6. COMPONENTS  (filled in by Tasks B6–B11)
  // ============================================================================

  // ============================================================================
  // 7. PAGES  (filled in by Tasks B12, B13)
  // ============================================================================

  function RexLoopPage() {
    return React.createElement("div", {
      style: { padding: 24, color: "#79c2ff", fontFamily: "ui-monospace, monospace" },
    }, "rex-loop war-room: skeleton (Task B0). Phase B in progress.");
  }

  // ============================================================================
  // 9. REGISTER
  // ============================================================================
  PLUGINS.register("rex-loop", RexLoopPage);
  console.log("[rex-loop] registered (war-room v4 skeleton)");
})();

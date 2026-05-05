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

    return React.createElement("header", {
      style: {
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 24,
        padding: "12px 20px",
        borderBottom: "1px solid " + C.border,
        background: "linear-gradient(180deg, " + C.bg + " 0%, rgba(0,8,20,0.92) 100%)",
      },
    },
      // Brand
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        React.createElement("div", {
          style: {
            width: 28, height: 28, borderRadius: 2,
            background: C.accent, color: C.bg,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: FONT.mono, fontWeight: 800, fontSize: 14,
          },
        }, "R"),
        React.createElement("div", { style: { display: "flex", flexDirection: "column" } },
          React.createElement("span", { className: "rex-chrome", style: { fontSize: 13, color: C.text, letterSpacing: "0.3em", fontWeight: 700 } }, "REX // LOOP"),
          React.createElement("span", { className: "rex-mono", style: { fontSize: 9, color: C.textDim, letterSpacing: "0.2em" } }, "WAR ROOM · v4"),
        ),
      ),
      // Stats row
      React.createElement("div", {
        style: { display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 18, justifyItems: "start" },
      },
        React.createElement(Stat, { label: "Loop Uptime",      value: loopUptime != null ? fmtDuration(loopUptime) : "—" }),
        React.createElement(Stat, { label: "Ticks Today",      value: ticksToday, color: C.accent }),
        React.createElement(Stat, { label: "Agent Time Today", value: fmtDuration(agentTimeToday) }),
        React.createElement(Stat, { label: "Tokens Today",     value: fmtTokens(safeNum(tokensToday && (tokensToday["in"] + tokensToday.out))), color: C.success }),
        React.createElement(Stat, { label: "Total Tokens",     value: fmtTokens(safeNum(tokensTotal && (tokensTotal["in"] + tokensTotal.out))) }),
        React.createElement(Stat, { label: "Fails 24h",        value: fails24h, color: fails24h > 0 ? C.error : C.success }),
      ),
      // Pause
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        pause.paused
          ? React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.error, letterSpacing: "0.22em" } }, "ALL LOOPS PAUSED")
          : React.createElement("span", { className: "rex-chrome", style: { fontSize: 10, color: C.success, letterSpacing: "0.22em" } }, "RUNNING"),
        React.createElement(IconButton, {
          onClick: pause.toggle, danger: !pause.paused,
        }, pause.paused ? "RESUME ALL" : "PAUSE ALL"),
        React.createElement("span", { className: "rex-mono", style: { fontSize: 10, color: C.textDim, marginLeft: 8 } }, tzNow()),
      ),
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

    return React.createElement(Panel, {
      onClick: function () { props.onSelect(m.name); },
      accent: isSelected ? C.accent : (isLive ? C.accent + "88" : C.border),
      className: isLive ? "rex-pulse-yellow" : null,
      style: {
        cursor: "pointer", marginBottom: 8,
        transition: "border-color 0.2s",
        background: isSelected ? "rgba(255,214,10,0.08)" : C.surface,
      },
    },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 } },
        React.createElement("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 } },
          React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, m.name),
          React.createElement("span", {
            className: "rex-mono",
            style: { fontSize: 10, color: C.textDim, marginTop: 2 },
          }, (m.tick_count || 0) + " ticks · " + (daysLeft != null ? daysLeft + "d left" : "no cap")),
        ),
        React.createElement(StatusPill, { status: isLive ? "running" : m.status }),
      ),
      React.createElement("div", { style: { marginTop: 8 } },
        React.createElement(Sparkline, {
          values: sparkValues, width: 200, height: 14, color: isLive ? C.accent : C.info,
        }),
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

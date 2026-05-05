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
  // 2. UTILITIES  (filled in by Task B2)
  // ============================================================================

  // ============================================================================
  // 3. POLLING DRIVER  (filled in by Task B3)
  // ============================================================================

  // ============================================================================
  // 4. DATA HOOKS  (filled in by Task B4)
  // ============================================================================

  // ============================================================================
  // 5. PRIMITIVES  (filled in by Task B5)
  // ============================================================================

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

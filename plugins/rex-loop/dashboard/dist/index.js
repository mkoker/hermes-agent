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
  // 1. CONSTANTS  (filled in by Task B1)
  // ============================================================================

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

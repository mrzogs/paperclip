import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  chartbookPath,
  dataDir,
  executablePath,
  logsDir,
  readSierraInstances,
  tradeActivityLogDir,
} from "./instance-registry.mjs";

const DEFAULT_SOURCE_FILE = path.resolve("D:\\paperclip-codex\\ocean-trading-strategies\\strategies\\OceanTrading.cpp");
const DEFAULT_REPLAY_STUDY_PRESETS_FILE = path.resolve("D:\\paperclip-codex\\connectors\\sierra-chart\\config\\replay-study-presets.json");
const REPLAY_CHARTBOOK_UI_SCRIPT = path.resolve("D:\\paperclip-codex\\connectors\\sierra-chart\\scripts\\open-replay-chartbook.ps1");
const INSTANCE_ALIASES = new Map([
  ["paper", "paper"],
  ["sim", "paper"],
  ["simulation", "paper"],
  ["replay", "replay"],
  ["replay-safe", "replay"],
  ["live", "live"],
]);

const MESSAGE_LOG_LINE_RE = /^(?<timestamp>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\|\s+Chart:\s+(?<chart>.*?)\s+\|\s+Study:\s+(?<study>.*?)\s+\|\s+(?<message>.+)$/;
const TRADE_ACTIVITY_ENTRY_RE =
  /Auto-trade:\s+Replay\s+(?<replayTag>[^:]+):\s+(?<chart>.+?)\s+\|\s+(?<study>.+?)\s+\|\s+(?<profile>.+?)\s+\|\s+(?<side>BuyEntry|SellEntry)\s+\|\s+Bar start date-time:\s+(?<barTime>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\|\s+Last:\s+(?<last>[0-9.]+)/g;
const TRADE_ACTIVITY_EXIT_RE =
  /Trade simulation fill\.\s+Bid:\s+(?<bid>[0-9.]+)\s+Ask:\s+(?<ask>[0-9.]+)\s+Last:\s+(?<last>[0-9.]+).*?(?<orderType>Stop|Limit)l/g;
const TRADE_ACTIVITY_CANCEL_RE = /Simulated order canceled.*?(?<orderType>Stop|Limit)l/g;

const ARTIFACT_TYPE = "ocean_trading.replay_backtest_validation";
const ARTIFACT_VERSION = "2026-05-25.v3";
const ALLOWED_REPLAY_SPEEDS = ["1X", "2X", "10X", "60X", "120X", "240X", "480X", "960X"];
const REPLAY_CONTROLLER_DIR_NAME = "connector-control";
const REPLAY_CONTROLLER_COMMAND_FILE = "replay-command.json";
const REPLAY_CONTROLLER_STATUS_FILE = "replay-status.json";
const DEFAULT_REPLAY_CONTROLLER_STATUS_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_TOLERANCES = {
  entryPricePoints: 0.5,
  initialStopPoints: 0.5,
  targetPricePoints: 0.5,
  pnlDollars: 10,
};

const CONTRACT_SPECS = [
  { prefix: "MNQ", tickSize: 0.25, tickValue: 0.5 },
  { prefix: "NQ", tickSize: 0.25, tickValue: 5 },
  { prefix: "MES", tickSize: 0.25, tickValue: 1.25 },
  { prefix: "ES", tickSize: 0.25, tickValue: 12.5 },
  { prefix: "MGC", tickSize: 0.1, tickValue: 1 },
  { prefix: "GC", tickSize: 0.1, tickValue: 10 },
  { prefix: "MCL", tickSize: 0.01, tickValue: 1 },
  { prefix: "CL", tickSize: 0.01, tickValue: 10 },
];

function normalizeMode(mode) {
  return INSTANCE_ALIASES.get(String(mode || "paper").trim().toLowerCase()) || "paper";
}

function readFileShared(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const descriptor = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(descriptor, buffer, 0, stat.size, 0);
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readText(filePath) {
  const buffer = readFileShared(filePath);
  return buffer ? buffer.toString("utf8").replace(/^\uFEFF/, "") : null;
}

function readJson(filePath) {
  const text = readText(filePath);
  return text ? JSON.parse(text) : null;
}

function loadReplayStudyPresets(options = {}) {
  const presetsFile = options.replayStudyPresetsFile || DEFAULT_REPLAY_STUDY_PRESETS_FILE;
  const presets = readJson(presetsFile);
  return presets && typeof presets === "object" ? presets : {};
}

export function resolveReplayStudyPreset(options = {}) {
  const presetKey = options.studyPreset || options.replayStudyPreset || null;
  if (!presetKey) return null;
  const normalizedKey = String(presetKey).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const presets = loadReplayStudyPresets(options);
  const preset = presets[normalizedKey];
  if (!preset) {
    throw new Error(`Unknown replay study preset: ${presetKey}`);
  }
  return {
    key: normalizedKey,
    ...preset,
  };
}

function listFiles(dir, predicate = () => true, limit = 50) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry))
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mtimeUtc: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function parseKeyValueMessage(message) {
  const parsed = {};
  for (const match of message.matchAll(/([a-zA-Z0-9_]+)=([^=]+?)(?=\s+[a-zA-Z0-9_]+=|$)/g)) {
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
}

function classifyMessageEvent(message) {
  if (/Hermes profile display switched:/i.test(message)) return "hermes_profile_switch";
  if (/\b(long|short) bracket plan:/i.test(message)) return "bracket_plan";
  if (/Sierra order state:/i.test(message)) return "sierra_order_state";
  if (/Sierra fill observed:/i.test(message)) return "sierra_fill_observed";
  if (/position closed:/i.test(message)) return "position_closed";
  if (/order submission was not accepted:/i.test(message)) return "order_submission_rejected";
  if (/input schema applied:/i.test(message)) return "input_schema_applied";
  if (/startup audit:/i.test(message)) return "startup_audit";
  if (/Lucid close-out guard active:/i.test(message)) return "lucid_guard";
  if (/CME .*guard active:/i.test(message)) return "market_hours_guard";
  return "study_log";
}

function enrichMessagePayload(eventType, message) {
  if (eventType === "hermes_profile_switch") {
    const match = message.match(/profile=(?<profile>.+?)\s+state=(?<state>-?\d+)\s+bar_index=(?<barIndex>-?\d+)\s+version=(?<version>.+)$/i);
    if (!match?.groups) return {};
    return {
      profile: match.groups.profile,
      state: Number(match.groups.state),
      barIndex: Number(match.groups.barIndex),
      version: match.groups.version,
    };
  }
  if (eventType === "bracket_plan") {
    const plan = parseKeyValueMessage(message);
    return {
      direction: /\blong bracket plan:/i.test(message) ? "long" : "short",
      ...plan,
      barIndex: plan.bar_index ? Number(plan.bar_index) : null,
      qty: plan.qty ? Number(plan.qty) : null,
      plannedRisk: plan.planned_risk ? Number(plan.planned_risk) : null,
    };
  }
  if (eventType === "order_submission_rejected") {
    const match = message.match(/result=(?<result>-?\d+)\s+version=(?<version>.+)$/i);
    return match?.groups
      ? { result: Number(match.groups.result), version: match.groups.version }
      : {};
  }
  if (eventType === "position_closed") {
    const close = parseKeyValueMessage(message);
    return {
      ...close,
      priorQty: close.prior_qty ? Number(close.prior_qty) : null,
      pnl: close.last_trade_pnl ? Number(close.last_trade_pnl) : null,
      barIndex: close.bar_index ? Number(close.bar_index) : null,
    };
  }
  if (eventType === "sierra_order_state" || eventType === "sierra_fill_observed") {
    const payload = parseKeyValueMessage(message);
    return {
      ...payload,
      internalOrderId: payload.internal_order_id ? Number(payload.internal_order_id) : null,
      parentId: payload.parent_id ? Number(payload.parent_id) : null,
      targetChildId: payload.target_child_id ? Number(payload.target_child_id) : null,
      stopChildId: payload.stop_child_id ? Number(payload.stop_child_id) : null,
      qty: payload.qty ? Number(payload.qty) : null,
      filledQty: payload.filled_qty ? Number(payload.filled_qty) : null,
      price: payload.price ? Number(payload.price) : null,
      price1: payload.price1 ? Number(payload.price1) : null,
      avgFill: payload.avg_fill ? Number(payload.avg_fill) : null,
      lastFill: payload.last_fill ? Number(payload.last_fill) : null,
      barIndex: payload.bar_index ? Number(payload.bar_index) : null,
      positionQtyAfter: payload.position_qty_after ? Number(payload.position_qty_after) : null,
      buySell: payload.buy_sell ? Number(payload.buy_sell) : null,
    };
  }
  return parseKeyValueMessage(message);
}

function printableBufferText(buffer) {
  return Buffer.from(buffer)
    .toString("utf8")
    .replace(/[^\x20-\x7E\r\n]+/g, " ")
    .replace(/\s+/g, " ");
}

function roundNumber(value) {
  if (value == null || value === "") return null;
  return Math.round(Number(value) * 1e6) / 1e6;
}

function normalizeSymbolToken(symbol) {
  const token = String(symbol || "").trim().toUpperCase();
  const matchedKnownRoot = CONTRACT_SPECS.find((item) => new RegExp(`\\b${item.prefix}[A-Z0-9_]*`).test(token));
  if (matchedKnownRoot) return matchedKnownRoot.prefix;
  const matched = token.match(/[A-Z]{1,4}/);
  return matched ? matched[0] : null;
}

function resolveContractSpec(symbol) {
  const token = normalizeSymbolToken(symbol);
  if (!token) return null;
  const spec = CONTRACT_SPECS.find((item) => token.startsWith(item.prefix));
  if (!spec) return null;
  return {
    symbolRoot: spec.prefix,
    tickSize: spec.tickSize,
    tickValue: spec.tickValue,
    pointValue: roundNumber(spec.tickValue / spec.tickSize),
  };
}

function londonEntryKey(barTime) {
  const match = String(barTime || "").match(/^(?<date>\d{4}-\d{2}-\d{2})\s+(?<time>\d{2}:\d{2})/);
  return match?.groups ? `${match.groups.date}T${match.groups.time}` : null;
}

function safeBasename(filePath) {
  return filePath ? path.basename(filePath) : null;
}

function parseIsoLikeDateTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(?<date>\d{4}[-/]\d{2}[-/]\d{2})[T\s](?<time>\d{2}:\d{2}(?::\d{2})?)$/);
  if (!match?.groups) {
    throw new Error(`Expected date-time in YYYY-MM-DD HH:MM[:SS] or YYYY/MM/DD HH:MM[:SS] format, received: ${value}`);
  }
  const normalizedDate = match.groups.date.replace(/\//g, "-");
  if (normalizedDate === "1899-12-30") {
    throw new Error("Refusing Sierra blank replay start 1899-12-30. Set an explicit valid replay start date.");
  }
  const time = match.groups.time.length === 5 ? `${match.groups.time}:00` : match.groups.time;
  return {
    date: normalizedDate,
    time,
    text: `${match.groups.date} ${time}`,
    normalizedText: `${normalizedDate} ${time}`,
  };
}

function parseDateOnly(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must be YYYY-MM-DD, received: ${value}`);
  }
  return text;
}

function nowStampCompact() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "_");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function atomicWriteJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw lastError;
}

function hashFileSha256(filePath) {
  const buffer = readFileShared(filePath);
  if (!buffer) return null;
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function compareScalar(left, right, tolerance = null) {
  if (left == null || right == null) return { status: "not_compared", left, right };
  if (tolerance != null) {
    const delta = roundNumber(Math.abs(Number(left) - Number(right)));
    return {
      status: delta <= tolerance ? "exact" : "mismatch",
      left,
      right,
      delta,
      tolerance,
    };
  }
  return { status: left === right ? "exact" : "mismatch", left, right };
}

function compareList(left, right, tolerance = null) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
    return { status: "not_compared", left, right };
  }
  if (left.length !== right.length) return { status: "mismatch", left, right };
  const items = left.map((item, index) => compareScalar(item, right[index], tolerance));
  const status = items.some((item) => item.status === "mismatch")
    ? "mismatch"
    : items.some((item) => item.status === "not_compared")
      ? "not_compared"
      : "exact";
  return { status, left, right, items };
}

function compareExpectedSetting(actual, expected) {
  if (expected == null) return { status: "not_compared", actual, expected };
  if (actual == null) return { status: "mismatch", actual, expected };
  if (typeof expected === "number") {
    const actualNumber = Number(actual);
    return Number.isFinite(actualNumber) && actualNumber === expected
      ? { status: "exact", actual: actualNumber, expected }
      : { status: "mismatch", actual, expected };
  }
  const normalizedActual = String(actual).trim().toLowerCase();
  const normalizedExpected = String(expected).trim().toLowerCase();
  return normalizedActual === normalizedExpected
    ? { status: "exact", actual, expected }
    : { status: "mismatch", actual, expected };
}

function compareExitOutcome(replay, backtest, pnlComparison) {
  const left = replay.outcome.exitReason;
  const right = backtest.outcome.exitReason;
  if (left == null || right == null) return { status: "not_compared", left, right };
  if (left === right) return { status: "exact", left, right };
  const replayFills = Array.isArray(replay.context?.exitFills) ? replay.context.exitFills : [];
  const replayHasLimitAndStop =
    replayFills.some((fill) => fill.orderType === "limit") &&
    replayFills.some((fill) => fill.orderType === "stop");
  const finalStopCompatible =
    left === "mixed" &&
    right === "stop" &&
    replayHasLimitAndStop &&
    pnlComparison?.status === "exact";
  if (finalStopCompatible) {
    return {
      status: "exact",
      left,
      right,
      note: "Replay labels partial-target plus final stop as mixed; backtest labels by final stop.",
    };
  }
  return { status: "mismatch", left, right };
}

function summarizeComparisonOutcome(summary) {
  if (!summary) return "No comparison summary available.";
  if (summary.mismatchCount || summary.unmatchedReplayCount || summary.unmatchedBacktestCount) {
    return "Replay validation failed. Investigate mismatches or unmatched trades before accepting the run.";
  }
  if (summary.partialCount) {
    return "Replay validation is partially aligned. Review missing non-optional fields before accepting the run.";
  }
  return "Replay validation aligned exactly for the compared window.";
}

function evaluateComparisonStatus(fieldComparisons, optionalFields = []) {
  const optionalSet = new Set(optionalFields);
  let sawPartial = false;
  for (const [field, comparison] of Object.entries(fieldComparisons)) {
    if (comparison.status === "mismatch") {
      if (optionalSet.has(field)) {
        sawPartial = true;
        continue;
      }
      return "mismatch";
    }
    if (comparison.status === "not_compared" && !optionalSet.has(field)) sawPartial = true;
  }
  return sawPartial ? "partial" : "exact";
}

function normalizeTargetPlan(targets) {
  return (targets || [])
    .map((target) => ({
      contracts: Number(target.contracts),
      r: roundNumber(target.r),
      price: roundNumber(target.price),
    }))
    .filter((target) => target.contracts > 0);
}

function targetSplit(targetPlan) {
  return targetPlan?.length ? targetPlan.map((item) => item.contracts).join("/") : null;
}

function targetRs(targetPlan) {
  return (targetPlan || []).map((item) => item.r).filter((value) => value != null);
}

function entryKeyFromDateTimeText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(?<date>\d{4}[-/]\d{2}[-/]\d{2})[T\s](?<time>\d{2}:\d{2})/);
  return match?.groups ? `${match.groups.date.replaceAll("/", "-")}T${match.groups.time}` : null;
}

function entryKeyFromDateAndTime(date, time) {
  if (!date || !time) return null;
  return entryKeyFromDateTimeText(`${date} ${time}`);
}

function entryKeyForTrade(trade) {
  return trade.entryKey ||
    entryKeyFromDateTimeText(trade.entryTime || trade.entryDateTime || trade.barTime) ||
    entryKeyFromDateAndTime(trade.entry_date_london, trade.entry_time_london);
}

function exitKeyForTrade(trade) {
  return trade.exitKey ||
    entryKeyFromDateTimeText(trade.exitTime || trade.exitDateTime) ||
    entryKeyFromDateAndTime(trade.exit_date_london, trade.exit_time_london);
}

function normalizeDirection(direction) {
  const normalized = String(direction || "").trim().toLowerCase();
  if (normalized.startsWith("long") || normalized === "buy") return "long";
  if (normalized.startsWith("short") || normalized === "sell") return "short";
  return normalized || null;
}

function normalizeExitReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (normalized === "target") return "targets";
  if (normalized === "stopped") return "stop";
  return normalized || null;
}

function singleTargetFromBacktestTrade(trade) {
  const price = trade.target ?? trade.target_price;
  if (price == null) return null;
  const contracts = Number(trade.contracts || trade.quantity || 1);
  const entry = Number(trade.entry ?? trade.entry_price);
  const stop = Number(trade.initialStop ?? trade.stop);
  const risk = Math.abs(entry - stop);
  const r = risk > 0 ? Math.abs(Number(price) - entry) / risk : null;
  return {
    contracts,
    price: Number(price),
    r: r == null ? null : roundNumber(r),
  };
}

function filterTradesByEntryRange(trades, startDateTime, endDateTime) {
  const startKey = entryKeyFromDateTimeText(startDateTime);
  const endKey = entryKeyFromDateTimeText(endDateTime);
  if (!startKey && !endKey) return trades;
  return trades.filter((trade) => {
    const entryKey = entryKeyForTrade(trade);
    if (!entryKey) return true;
    if (startKey && entryKey < startKey) return false;
    if (endKey && entryKey > endKey) return false;
    return true;
  });
}

function findReplayWindowViolations(trades, startDateTime, endDateTime) {
  const startKey = entryKeyFromDateTimeText(startDateTime);
  const endKey = entryKeyFromDateTimeText(endDateTime);
  if (!startKey && !endKey) return [];
  return trades.flatMap((trade) => {
    const entryKey = entryKeyForTrade(trade);
    const exitKey = trade.outcome?.exitKey || exitKeyForTrade(trade) || null;
    const direction = normalizeDirection(trade.direction);
    const violations = [];
    if (startKey && entryKey && entryKey < startKey) {
      violations.push({ type: "entry_before_window", entryKey, exitKey, direction });
    }
    if (endKey && entryKey && entryKey > endKey) {
      violations.push({ type: "entry_after_window", entryKey, exitKey, direction });
    }
    if (endKey && exitKey && exitKey > endKey) {
      violations.push({ type: "exit_after_window", entryKey, exitKey, direction });
    }
    if (endKey && entryKey && entryKey <= endKey && !exitKey && trade.outcome?.exitReason == null) {
      violations.push({ type: "open_trade_at_window_end", entryKey, exitKey: null, direction });
    }
    return violations;
  });
}

function summarizeReplayBacktestPnl({ replayRows, backtestRows }) {
  const replayNetPnl = roundNumber(replayRows.reduce((total, trade) => (
    Number.isFinite(Number(trade.outcome?.pnl)) ? total + Number(trade.outcome.pnl) : total
  ), 0));
  const replayCompletedCount = replayRows.filter((trade) => Number.isFinite(Number(trade.outcome?.pnl))).length;
  const backtestNetPnl = roundNumber(backtestRows.reduce((total, trade) => (
    Number.isFinite(Number(trade.outcome?.pnl)) ? total + Number(trade.outcome.pnl) : total
  ), 0));
  const pnlDelta = roundNumber(replayNetPnl - backtestNetPnl);
  const pnlVariationPct = backtestNetPnl === 0
    ? null
    : roundNumber((pnlDelta / Math.abs(backtestNetPnl)) * 100);
  return {
    replayNetPnl,
    backtestNetPnl,
    pnlDelta,
    pnlVariationPct,
    replayCompletedCount,
    backtestCompletedCount: backtestRows.filter((trade) => Number.isFinite(Number(trade.outcome?.pnl))).length,
  };
}

function normalizeControllerEffectiveStartDateTime(status) {
  const actual = status?.status || status;
  if (!actual || typeof actual !== "object") return null;
  if (String(actual.action || "").toLowerCase() !== "start") return null;
  if (actual.isReplayRunning === false) return null;
  const requestedStart = String(actual.requestedStartDateTime || "").trim();
  const effectiveStart = String(actual.effectiveStartDateTime || "").trim();
  if (effectiveStart) {
    if (!requestedStart) return effectiveStart;
    return requestedStart.slice(0, 10) === effectiveStart.slice(0, 10) ? effectiveStart : null;
  }
  const currentChartDateTime = String(actual.currentChartDateTime || "").trim();
  if (currentChartDateTime.startsWith("1899-12-30")) return null;
  if (!requestedStart || !currentChartDateTime) return null;
  const requestedDate = requestedStart.slice(0, 10);
  const currentDate = currentChartDateTime.slice(0, 10);
  return requestedDate === currentDate ? currentChartDateTime : null;
}

function normalizeReplayEvent(event) {
  const plan = normalizeTargetPlan(event.targetPlan || event.targets);
  return {
    source: event.source || "replay",
    entryKey: event.entryKey,
    direction: normalizeDirection(event.direction),
    entry: roundNumber(event.entry),
    initialStop: roundNumber(event.initialStop),
    stopAtExit: roundNumber(event.stopAtExit),
    targetPlan: plan,
    targetSplit: event.targetSplit || targetSplit(plan),
    targetRs: event.targetRs || targetRs(plan),
    hermesProfile: event.hermesProfile || null,
    hermesAction: event.hermesAction || null,
    outcome: {
      exitKey: event.outcome?.exitKey || null,
      exitReason: normalizeExitReason(event.outcome?.exitReason),
      pnl: roundNumber(event.outcome?.pnl),
    },
    context: event.context || {},
    rawSource: event.rawSource || null,
  };
}

function normalizeBacktestTrade(trade) {
  const singleTarget = singleTargetFromBacktestTrade(trade);
  const plan = normalizeTargetPlan(trade.targets || trade.targetPlan || (singleTarget ? [singleTarget] : []));
  return {
    source: "backtest",
    entryKey: entryKeyForTrade(trade),
    direction: normalizeDirection(trade.direction),
    entry: roundNumber(trade.entry ?? trade.entry_price),
    initialStop: roundNumber(trade.initialStop ?? trade.stop),
    stopAtExit: roundNumber(trade.stopAtExit ?? trade.stop),
    targetPlan: plan,
    targetSplit: targetSplit(plan),
    targetRs: targetRs(plan),
    hermesProfile: trade.hermesProfile || null,
    hermesAction: trade.hermesAction || null,
    outcome: {
      exitKey: exitKeyForTrade(trade),
      exitReason: normalizeExitReason(trade.exitReason ?? trade.exit_reason),
      pnl: roundNumber(trade.pnl),
    },
    context: {
      regime5m: trade.regime5m || null,
      regime15m: trade.regime15m || null,
      regime50m: trade.regime50m || null,
      regime60m: trade.regime60m || null,
      regimeDaily: trade.regimeDaily || null,
      weeklyRangeRegime: trade.weeklyRangeRegime || null,
      markovBias: roundNumber(trade.markovBias),
    },
  };
}

export function compareReplayToBacktest({
  strategy,
  assumptions,
  replayEvents,
  backtestTrades,
  tolerances = DEFAULT_TOLERANCES,
}) {
  const replayRows = [...new Map(replayEvents.map((item) => {
    const normalized = normalizeReplayEvent(item);
    return [`${normalized.entryKey}|${normalized.direction}`, normalized];
  })).values()];
  const backtestRows = [...new Map(backtestTrades.map((item) => {
    const normalized = normalizeBacktestTrade(item);
    return [`${normalized.entryKey}|${normalized.direction}`, normalized];
  })).values()];
  const replayIndex = new Map(replayRows.map((item) => [`${item.entryKey}|${item.direction}`, item]));
  const backtestIndex = new Map(backtestRows.map((item) => [`${item.entryKey}|${item.direction}`, item]));
  const keys = [...new Set([...replayIndex.keys(), ...backtestIndex.keys()])].sort();
  const comparisons = [];
  const unmatchedReplay = [];
  const unmatchedBacktest = [];
  const optionalComparisonFields = ["entry", "initialStop", "hermesProfile"];

  for (const key of keys) {
    const replay = replayIndex.get(key);
    const backtest = backtestIndex.get(key);
    if (!replay) {
      unmatchedBacktest.push(backtest);
      continue;
    }
    if (!backtest) {
      unmatchedReplay.push(replay);
      continue;
    }
    const outcomePnl = compareScalar(replay.outcome.pnl, backtest.outcome.pnl, tolerances.pnlDollars);
    const fieldComparisons = {
      entry: compareScalar(replay.entry, backtest.entry, tolerances.entryPricePoints),
      initialStop: compareScalar(replay.initialStop, backtest.initialStop, tolerances.initialStopPoints),
      targetSplit: compareScalar(replay.targetSplit, backtest.targetSplit),
      targetRs: compareList(replay.targetRs, backtest.targetRs, tolerances.targetPricePoints),
      hermesProfile: compareScalar(replay.hermesProfile, backtest.hermesProfile),
      hermesAction: compareScalar(replay.hermesAction, backtest.hermesAction),
      outcome: compareExitOutcome(replay, backtest, outcomePnl),
      outcomePnl,
    };
    const status = evaluateComparisonStatus(fieldComparisons, optionalComparisonFields);
    const [entryKey, direction] = key.split("|");
    comparisons.push({ entryKey, direction, status, fieldComparisons, replay, backtest });
  }

  return {
    artifactType: ARTIFACT_TYPE,
    artifactVersion: ARTIFACT_VERSION,
    generatedAtUtc: new Date().toISOString(),
    strategy,
    assumptions,
    comparisonContract: {
      matchKey: ["entryKey", "direction"],
      tolerances,
      requiredReplayFields: [
        "entryKey",
        "direction",
        "entry",
        "initialStop",
        "targetPlan",
        "hermesAction",
        "outcome.exitReason",
        "outcome.pnl",
      ],
      requiredBacktestFields: [
        "entryKey",
        "direction",
        "entry",
        "initialStop",
        "targets",
        "hermesAction",
        "exitReason",
        "pnl",
      ],
      optionalComparisonFields,
    },
    summary: {
      replayCount: replayRows.length,
      backtestCount: backtestRows.length,
      matchedCount: comparisons.length,
      exactCount: comparisons.filter((item) => item.status === "exact").length,
      partialCount: comparisons.filter((item) => item.status === "partial").length,
      mismatchCount: comparisons.filter((item) => item.status === "mismatch").length,
      unmatchedReplayCount: unmatchedReplay.length,
      unmatchedBacktestCount: unmatchedBacktest.length,
      pnl: summarizeReplayBacktestPnl({ replayRows, backtestRows }),
    },
    replayEvents: replayRows,
    backtestTrades: backtestRows,
    comparisons,
    unmatchedReplay,
    unmatchedBacktest,
  };
}

function renderValidationMarkdown(artifact, metadata) {
  const summary = artifact.summary;
  const lines = [
    "# Sierra Replay Validation",
    "",
    `- Strategy: \`${artifact.strategy}\``,
    `- Generated UTC: \`${artifact.generatedAtUtc}\``,
    `- Replay root: \`${metadata.instanceRoot || "unknown"}\``,
    `- Chartbook: \`${metadata.chartbook || "unknown"}\``,
    `- Study version: \`${metadata.strategyVersion || "unknown"}\``,
    `- DLL SHA-256: \`${metadata.dllSha256 || "unknown"}\``,
    `- Replay speed: \`${metadata.replaySpeed || "unknown"}\``,
    `- Requested start: \`${metadata.requestedStartDateTime || "unknown"}\``,
    `- Effective start: \`${metadata.effectiveStartDateTime || "unknown"}\``,
    `- Message log: \`${safeBasename(metadata.messageLogPath) || "n/a"}\``,
    `- Trade logs: \`${(metadata.tradeLogPaths || []).map((item) => safeBasename(item)).join(", ") || "n/a"}\``,
    `- Parsed replay fills: **${metadata.parsedTradeActivitySummary?.replayFillCount ?? 0}** total, **${metadata.parsedTradeActivitySummary?.replayExitFillCount ?? 0}** exit fills, **${metadata.parsedTradeActivitySummary?.unknownFillCount ?? 0}** unknown`,
    "",
    "## Summary",
    "",
    `- Replay rows: **${summary.replayCount}**`,
    `- Backtest rows: **${summary.backtestCount}**`,
    `- Replay completed rows: **${summary.pnl?.replayCompletedCount ?? 0}**`,
    `- Replay net P&L: **${summary.pnl?.replayNetPnl ?? "n/a"}**`,
    `- Backtest net P&L: **${summary.pnl?.backtestNetPnl ?? "n/a"}**`,
    `- Replay vs backtest delta: **${summary.pnl?.pnlDelta ?? "n/a"}** (${summary.pnl?.pnlVariationPct == null ? "n/a" : `${summary.pnl.pnlVariationPct}%`})`,
    `- Exact matches: **${summary.exactCount}**`,
    `- Partial matches: **${summary.partialCount}**`,
    `- Mismatches: **${summary.mismatchCount}**`,
    `- Replay-only rows: **${summary.unmatchedReplayCount}**`,
    `- Backtest-only rows: **${summary.unmatchedBacktestCount}**`,
    `- Recommendation: ${metadata.recommendation || summarizeComparisonOutcome(summary)}`,
    "",
    "## Matched Rows",
    "",
    "| Entry London | Side | Status | Entry | Initial Stop | Target Split | Hermes Action | Outcome |",
    "| --- | --- | --- | ---: | ---: | --- | --- | --- |",
  ];

  if (artifact.validation?.status === "invalid") {
    lines.splice(
      lines.indexOf("## Matched Rows"),
      0,
      "## Validation Warnings",
      "",
      `- Status: **${artifact.validation.status}**`,
      `- Replay window violations: **${artifact.validation.replayWindowViolations?.length || 0}**`,
      ...((artifact.validation.replayWindowViolations || []).slice(0, 10).map((violation) =>
        `- ${violation.type}: ${violation.entryKey || "unknown"} ${violation.direction || ""} exit=${violation.exitKey || "open"}`
      )),
      "",
    );
  }

  for (const item of artifact.comparisons) {
    lines.push(
      `| ${item.entryKey} | ${item.direction} | ${item.status} | ${item.replay.entry ?? ""} | ${item.replay.initialStop ?? ""} | ${item.replay.targetSplit ?? ""} | ${item.replay.hermesAction ?? ""} | ${item.replay.outcome.exitReason ?? ""} |`,
    );
  }

  const mismatches = artifact.comparisons.filter((item) => item.status === "mismatch");
  if (mismatches.length) {
    lines.push("", "## Mismatch Details", "");
    for (const item of mismatches) {
      lines.push(`- ${item.entryKey} ${item.direction}`);
      for (const [field, comparison] of Object.entries(item.fieldComparisons)) {
        if (comparison.status === "exact") continue;
        const left = Object.hasOwn(comparison, "left") ? JSON.stringify(comparison.left) : JSON.stringify(comparison.actual);
        const right = Object.hasOwn(comparison, "right") ? JSON.stringify(comparison.right) : JSON.stringify(comparison.expected);
        const delta = Object.hasOwn(comparison, "delta") ? ` delta=${comparison.delta}` : "";
        const tolerance = Object.hasOwn(comparison, "tolerance") ? ` tolerance=${comparison.tolerance}` : "";
        const note = comparison.note ? ` note=${comparison.note}` : "";
        lines.push(`  - ${field}: ${comparison.status} replay=${left} backtest=${right}${delta}${tolerance}${note}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeValidationArtifacts({ artifact, outputJsonPath, outputMarkdownPath, metadata }) {
  if (outputJsonPath) {
    fs.writeFileSync(outputJsonPath, JSON.stringify({ ...artifact, metadata }, null, 2));
  }
  if (outputMarkdownPath) {
    fs.writeFileSync(outputMarkdownPath, renderValidationMarkdown(artifact, metadata));
  }
}

export function readReplayCapableInstances(options = {}) {
  const config = readSierraInstances(options);
  const instances = {};
  for (const mode of ["paper", "replay", "live"]) {
    const instance = { ...(config[mode] || {}) };
    instance.mode = mode;
    instance.environmentLabel = instance.environmentLabel || mode;
    instance.root = instance.root || null;
    instance.executablePath = executablePath(instance);
    instance.dataFolder = dataDir(instance);
    instance.tradeActivityLogDir = tradeActivityLogDir(instance);
    instance.logsDir = logsDir(instance);
    instance.chartbook = chartbookPath(instance);
    instance.isLive = mode === "live";
    instance.exists = Boolean(instance.root && fs.existsSync(instance.root));
    instances[mode] = instance;
  }
  if (config.warning) instances.warning = config.warning;
  return instances;
}

export function resolveSierraEnvironment(target, options = {}) {
  const mode = normalizeMode(target);
  const instances = readReplayCapableInstances(options);
  if (mode === "live" && !options.allowLive) {
    const error = new Error("Live Sierra access is blocked by default. Pass allowLive: true only after explicit operator approval.");
    error.code = "LIVE_ACCESS_BLOCKED";
    throw error;
  }
  const instance = instances[mode];
  return {
    mode,
    instance,
    safety: {
      allowLive: Boolean(options.allowLive),
      liveAccessBlockedByDefault: true,
      paperPreferred: mode !== "live",
    },
  };
}

function readWindowsProcessSnapshot() {
  const command = [
    "$ErrorActionPreference='Stop';",
    "Get-Process | Where-Object { $_.ProcessName -like 'SierraChart*' -or $_.Path -like '*SierraChart_64.exe' } |",
    "Select-Object Id,ProcessName,Path,StartTime,MainWindowTitle | ConvertTo-Json -Depth 4",
  ].join(" ");
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function detectRunningSierraInstances(options = {}) {
  const instances = readReplayCapableInstances(options);
  const processList = options.processList || readWindowsProcessSnapshot();
  return processList.map((processInfo) => {
    const executable = String(processInfo.Path || "");
    const title = String(processInfo.MainWindowTitle || "");
    const matchingMode = ["replay", "paper", "live"].find((mode) => {
      const root = String(instances[mode]?.root || "").toLowerCase();
      return root && executable.toLowerCase().startsWith(root);
    });
    const titleMode = /replay/i.test(title) ? "replay" : null;
    return {
      pid: Number(processInfo.Id),
      processName: processInfo.ProcessName || null,
      path: executable || null,
      mainWindowTitle: title || null,
      startedAt: processInfo.StartTime || null,
      mode: matchingMode || titleMode || "unknown",
      rootMatched: Boolean(matchingMode),
    };
  });
}

export function listInstanceMessageLogs(instance, options = {}) {
  const limit = options.limit || 20;
  return listFiles(instance.logsDir, (entry) => /^Message Log .*\.log$/i.test(entry.name), limit);
}

export function listInstanceTradeLogs(instance, options = {}) {
  const limit = options.limit || 20;
  return listFiles(instance.tradeActivityLogDir, (entry) => /^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(entry.name), limit);
}

function parseTradeLogDate(entry) {
  const match = String(entry?.name || entry || "").match(/^TradeActivityLog_(\d{4}-\d{2}-\d{2})_UTC\./i);
  return match?.[1] || null;
}

export function extractStudyCatalogFromSource(sourceText, options = {}) {
  const sourceFile = options.sourceFile || DEFAULT_SOURCE_FILE;
  const studies = [];
  let currentExport = null;
  for (const line of String(sourceText || "").split(/\r?\n/)) {
    const exportMatch = line.match(/SCSFExport\s+([A-Za-z0-9_]+)\s*\(/);
    if (exportMatch) currentExport = exportMatch[1];
    const graphMatch = line.match(/sc\.GraphName\s*=\s*"([^"]+)"/);
    if (graphMatch) {
      const graphName = graphMatch[1];
      const version = graphName.match(/\bv(\d+\.\d+\.\d+)\b/i)?.[1] || null;
      studies.push({
        exportName: currentExport,
        graphName,
        version,
        sourceFile,
      });
    }
  }
  return studies;
}

export function parseReplayMessageLogText(text, options = {}) {
  const sourceFile = options.sourceFile || null;
  const startLine = Math.max(1, Number(options.startLine || options.messageLogStartLine || 1));
  const events = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(MESSAGE_LOG_LINE_RE);
    if (!match?.groups) continue;
    const eventType = classifyMessageEvent(match.groups.message);
    events.push({
      type: eventType,
      lineNumber: index + 1,
      timestamp: match.groups.timestamp,
      chart: match.groups.chart,
      study: match.groups.study,
      message: match.groups.message,
      payload: enrichMessagePayload(eventType, match.groups.message),
      sourceFile,
    });
  }
  return events;
}

export function extractReplayStudySettings(messageEvents = []) {
  const startupAudit = messageEvents.filter((event) => event.type === "startup_audit").at(-1) || null;
  const inputSchema = messageEvents.filter((event) => event.type === "input_schema_applied").at(-1) || null;
  const bracketPlan = messageEvents.filter((event) => event.type === "bracket_plan").at(-1) || null;
  if (!startupAudit && !inputSchema && !bracketPlan) return null;
  const bracketPayload = bracketPlan?.payload || {};
  const bracketQuantities = [1, 2, 3, 4, 5].map((slot) =>
    bracketPayload[`qty${slot}`] != null ? Number(bracketPayload[`qty${slot}`]) : null
  );
  const bracketTargetRs = [1, 2, 3, 4, 5].map((slot) =>
    bracketPayload[`target${slot}_r`] != null ? Number(bracketPayload[`target${slot}_r`]) : null
  );
  const completeFiveTargetSplit = bracketQuantities.every((value) => value != null);
  const completeFiveTargetRs = bracketTargetRs.every((value) => value != null);
  const bracketQty1 = bracketQuantities[0];
  const bracketQty2 = bracketQuantities[1];
  const bracketQty3 = bracketQuantities[2];
  const bracketQty4 = bracketQuantities[3];
  const bracketQty5 = bracketQuantities[4];
  return {
    study: startupAudit?.study || inputSchema?.study || null,
    version: startupAudit?.payload?.version || inputSchema?.payload?.version || bracketPlan?.payload?.version || null,
    schema: startupAudit?.payload?.schema ? Number(startupAudit.payload.schema) : inputSchema?.payload?.schema ? Number(inputSchema.payload.schema) : null,
    quantity: bracketPlan?.payload?.qty ? Number(bracketPlan.payload.qty) : startupAudit?.payload?.qty ? Number(startupAudit.payload.qty) : inputSchema?.payload?.qty ? Number(inputSchema.payload.qty) : null,
    maxTradesPerDay: bracketPlan?.payload?.max_trades_per_day ? Number(bracketPlan.payload.max_trades_per_day) : startupAudit?.payload?.max_trades_per_day ? Number(startupAudit.payload.max_trades_per_day) : inputSchema?.payload?.max_trades_per_day ? Number(inputSchema.payload.max_trades_per_day) : null,
    tpSplit: completeFiveTargetSplit ? bracketQuantities.join("/") : bracketQty1 != null && bracketQty2 != null && bracketQty3 != null ? `${bracketQty1}/${bracketQty2}/${bracketQty3}` : startupAudit?.payload?.tp_split || null,
    targetRs: completeFiveTargetRs ? bracketTargetRs.join("/") : null,
    tp1: bracketQty1 ?? (inputSchema?.payload?.tp1 ? Number(inputSchema.payload.tp1) : null),
    tp2: bracketQty2 ?? (inputSchema?.payload?.tp2 ? Number(inputSchema.payload.tp2) : null),
    tp3: bracketQty3 ?? (inputSchema?.payload?.tp3 ? Number(inputSchema.payload.tp3) : null),
    tp4: bracketQty4,
    tp5: bracketQty5,
    maxRiskDollars: bracketPlan?.payload?.max_risk_dollars ? Number(bracketPlan.payload.max_risk_dollars) : startupAudit?.payload?.risk_cap ? Number(startupAudit.payload.risk_cap) : inputSchema?.payload?.risk_cap ? Number(inputSchema.payload.risk_cap) : null,
    breakevenMode: bracketPlan?.payload?.breakeven_mode || null,
    breakevenTriggerValue: bracketPlan?.payload?.breakeven_trigger_value ? Number(bracketPlan.payload.breakeven_trigger_value) : null,
    breakevenOffsetPoints: bracketPlan?.payload?.breakeven_offset_points ? Number(bracketPlan.payload.breakeven_offset_points) : null,
    targetStopRatchet: bracketPlan?.payload?.target_stop_ratchet || null,
    targetStopRatchetHoldBars: bracketPlan?.payload?.target_stop_ratchet_hold_bars ? Number(bracketPlan.payload.target_stop_ratchet_hold_bars) : null,
    targetStopRatchetVwapTrend: bracketPlan?.payload?.target_stop_ratchet_vwap_trend || null,
    confluenceMode: startupAudit?.payload?.confluence_mode ? Number(startupAudit.payload.confluence_mode) : inputSchema?.payload?.confluence_mode ? Number(inputSchema.payload.confluence_mode) : null,
    hermesTpAdaptation: startupAudit?.payload?.hermes_tp_adaptation || inputSchema?.payload?.hermes_tp_adaptation || null,
    tickSize: startupAudit?.payload?.tick_size ? Number(startupAudit.payload.tick_size) : null,
    symbol: startupAudit?.payload?.symbol || null,
    chart: startupAudit?.payload?.chart || bracketPlan?.chart || null,
  };
}

export function verifyReplayStudySettings(actualSettings, expectedSettings = {}) {
  const comparisons = {
    version: compareExpectedSetting(actualSettings?.version, expectedSettings.version),
    schema: compareExpectedSetting(actualSettings?.schema, expectedSettings.schema),
    quantity: compareExpectedSetting(actualSettings?.quantity, expectedSettings.quantity),
    maxTradesPerDay: compareExpectedSetting(actualSettings?.maxTradesPerDay, expectedSettings.maxTradesPerDay),
    tpSplit: compareExpectedSetting(actualSettings?.tpSplit, expectedSettings.tpSplit),
    tp1: compareExpectedSetting(actualSettings?.tp1, expectedSettings.tp1),
    tp2: compareExpectedSetting(actualSettings?.tp2, expectedSettings.tp2),
    tp3: compareExpectedSetting(actualSettings?.tp3, expectedSettings.tp3),
    tp4: compareExpectedSetting(actualSettings?.tp4, expectedSettings.tp4),
    tp5: compareExpectedSetting(actualSettings?.tp5, expectedSettings.tp5),
    maxRiskDollars: compareExpectedSetting(actualSettings?.maxRiskDollars, expectedSettings.maxRiskDollars),
    targetRs: compareExpectedSetting(actualSettings?.targetRs, expectedSettings.targetRs),
    breakevenMode: compareExpectedSetting(actualSettings?.breakevenMode, expectedSettings.breakevenMode),
    breakevenTriggerValue: compareExpectedSetting(actualSettings?.breakevenTriggerValue, expectedSettings.breakevenTriggerValue),
    breakevenOffsetPoints: compareExpectedSetting(actualSettings?.breakevenOffsetPoints, expectedSettings.breakevenOffsetPoints),
    targetStopRatchet: compareExpectedSetting(actualSettings?.targetStopRatchet, expectedSettings.targetStopRatchet),
    targetStopRatchetHoldBars: compareExpectedSetting(actualSettings?.targetStopRatchetHoldBars, expectedSettings.targetStopRatchetHoldBars),
    targetStopRatchetVwapTrend: compareExpectedSetting(actualSettings?.targetStopRatchetVwapTrend, expectedSettings.targetStopRatchetVwapTrend),
    confluenceMode: compareExpectedSetting(actualSettings?.confluenceMode, expectedSettings.confluenceMode),
    hermesTpAdaptation: compareExpectedSetting(actualSettings?.hermesTpAdaptation, expectedSettings.hermesTpAdaptation),
  };
  const mismatches = Object.entries(comparisons)
    .filter(([, comparison]) => comparison.status === "mismatch")
    .map(([field, comparison]) => ({ field, ...comparison }));
  return {
    status: mismatches.length ? "mismatch" : "exact",
    actual: actualSettings || null,
    expected: expectedSettings,
    comparisons,
    mismatches,
  };
}

export function parseReplayTradeActivityBuffer(buffer, options = {}) {
  const text = printableBufferText(buffer);
  const sourceFile = options.sourceFile || null;
  const indexedEvents = [];

  for (const match of text.matchAll(/Auto-trade:\s+Replay\s+(?<replayTag>[^:]+):\s+(?<chart>.+?)\s+\|\s+(?<study>.+?)\s+\|\s+(?<profile>.+?)\s+\|\s+(?<side>BuyEntry|SellEntry)\s+\|\s+Bar start date-time:\s+(?<barTime>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\|\s+Last:\s+(?<last>[0-9.]+)(?<tail>.*?)(?=Auto-trade:|Trade simulation fill\.|Simulated order accepted|Updating move|Auto-sent child|$)/g)) {
    if (/\bAttached Order\b/i.test(match.groups.tail || "")) continue;
    indexedEvents.push({
      offset: match.index,
      event: {
        type: "replay_order_intent",
        replayTag: match.groups.replayTag,
        chart: match.groups.chart,
        study: match.groups.study,
        hermesProfile: match.groups.profile || null,
        side: match.groups.side,
        barTime: match.groups.barTime,
        lastPrice: Number(match.groups.last),
        sourceFile,
      },
    });
  }

  for (const match of text.matchAll(/Trade simulation fill\.\s+Bid:\s+(?<bid>[0-9.]+)\s+Ask:\s+(?<ask>[0-9.]+)\s+Last:\s+(?<last>[0-9.]+)(?<tail>.*?)(?=Trade simulation fill\.|Auto-trade:|Updating move|Auto trail order modification|Simulated order|Canceling order|$)/gi)) {
    const orderTypeMatch = String(match.groups.tail || "").match(/\b(Market|Stop|Limit)l\b/i);
    indexedEvents.push({
      offset: match.index,
      event: {
        type: "replay_fill",
        bid: Number(match.groups.bid),
        ask: Number(match.groups.ask),
        last: Number(match.groups.last),
        orderType: orderTypeMatch ? orderTypeMatch[1].toLowerCase() : "unknown",
        sourceFile,
      },
    });
  }

  for (const match of text.matchAll(/Simulated order (accepted|canceled|modify complete)(?:.*?(?<orderType>Stop|Limit)l)?/gi)) {
    indexedEvents.push({
      offset: match.index,
      event: {
        type: `replay_order_${match[1].toLowerCase().replace(/\s+/g, "_")}`,
        orderType: match.groups?.orderType ? match.groups.orderType.toLowerCase() : null,
        sourceFile,
      },
    });
  }

  for (const match of text.matchAll(/Updating move to breakeven (stop reference price|stop trigger price) .*? to (?<price>\d+)/gi)) {
    indexedEvents.push({
      offset: match.index,
      event: {
        type: "replay_breakeven_update",
        field: match[1],
        rawPrice: Number(match.groups.price),
        sourceFile,
      },
    });
  }

  for (const match of text.matchAll(/Auto trail order modification\..*?Using LastModifyQuantity of (?<quantity>\d+).*?Requested Price:\s+(?<price>[0-9.]+).*?Requested Quantity:\s+(?<requestedQuantity>\d+)/gi)) {
    indexedEvents.push({
      offset: match.index,
      event: {
        type: "replay_stop_quantity_update",
        quantity: Number(match.groups.quantity),
        requestedPrice: Number(match.groups.price),
        requestedQuantity: Number(match.groups.requestedQuantity),
        sourceFile,
      },
    });
  }

  return indexedEvents
    .sort((left, right) => left.offset - right.offset)
    .map((item) => item.event)
    .filter((event, index, events) => {
      if (event.type !== "replay_fill") return true;
      const previous = events[index - 1];
      if (previous?.type !== "replay_fill") return true;
      return !(
        previous.sourceFile === event.sourceFile &&
        previous.orderType === event.orderType &&
        previous.bid === event.bid &&
        previous.ask === event.ask &&
        previous.last === event.last
      );
    });
}

function makeReplayTradeFromBracketEvent(event, profileByBarIndex, sourceFile, dedupe) {
  const risk = Math.abs(Number(event.payload.entry) - Number(event.payload.stop));
  const targets = [];
  const qty = Number(event.payload.qty || 0);
  const entry = roundNumber(event.payload.entry);
  const stop = roundNumber(event.payload.stop);
  const explicitQuantities = [1, 2, 3, 4, 5].map((slot) =>
    event.payload[`qty${slot}`] != null ? Number(event.payload[`qty${slot}`]) : null
  );
  if (explicitQuantities[0] == null) {
    const laterSlots = explicitQuantities.slice(1).reduce((total, value) => total + Number(value || 0), 0);
    explicitQuantities[0] = Math.max(0, qty - laterSlots);
  }
  const quantities = explicitQuantities.map((value) => Number(value || 0));
  for (const slot of [1, 2, 3, 4, 5]) {
    const contracts = quantities[slot - 1];
    const price = event.payload[`target${slot}`];
    if (contracts > 0 && price) {
      targets.push({
        contracts,
        price: roundNumber(price),
        r: event.payload[`target${slot}_r`] ? roundNumber(event.payload[`target${slot}_r`]) : risk ? roundNumber(Math.abs(Number(price) - entry) / risk) : null,
      });
    }
  }
  const totalContracts = quantities.reduce((total, value) => total + value, 0);
  const entryKey = londonEntryKey(event.payload.bar_time);
  const direction = event.payload.direction;
  const key = `${entryKey}|${direction}|${entry}`;
  if (dedupe?.has(key)) return null;
  dedupe?.add(key);
  return {
    source: "replay",
    entryKey,
    direction,
    entry,
    initialStop: stop,
    stopAtExit: null,
    targetPlan: targets,
    totalContracts,
    targetSplit: targetSplit(targets),
    targetRs: targetRs(targets),
    hermesProfile:
      event.payload.hermes_profile ||
      profileByBarIndex.get(Number(event.payload.barIndex)) ||
      null,
    hermesAction: event.payload.hermes_action || null,
    outcome: {
      exitKey: null,
      exitReason: null,
      pnl: null,
    },
    context: {
      barTime: event.payload.bar_time || null,
      sourceMessage: event.message,
      chart: event.chart || null,
      targetStopRatchet: event.payload.target_stop_ratchet || null,
      targetStopRatchetHoldBars: event.payload.target_stop_ratchet_hold_bars ? Number(event.payload.target_stop_ratchet_hold_bars) : null,
      targetStopRatchetVwapTrend: event.payload.target_stop_ratchet_vwap_trend || null,
    },
    execution: {
      entryIntentSeen: false,
      entryFilled: false,
      remainingContracts: totalContracts,
      targetSlots: targets.map((target, index) => ({ index, ...target, filled: false })),
      inferredTargetQuantities: [],
      exitFills: [],
      exitFillKeys: new Set(),
    },
    rawSource: sourceFile,
  };
}

function makeReplayTradeFromIntent(event, dedupe) {
  const entryKey = londonEntryKey(event.barTime);
  const direction = event.side === "BuyEntry" ? "long" : "short";
  const entry = roundNumber(event.lastPrice);
  const key = `${entryKey}|${direction}|${entry}|intent`;
  if (dedupe.has(key)) return null;
  dedupe.add(key);
  return {
    source: "replay",
    entryKey,
    direction,
    entry,
    initialStop: null,
    stopAtExit: null,
    targetPlan: [],
    totalContracts: null,
    targetSplit: null,
    targetRs: [],
    hermesProfile: event.hermesProfile || null,
    hermesAction: null,
    outcome: {
      exitKey: null,
      exitReason: null,
      pnl: null,
    },
    context: {
      barTime: event.barTime || null,
      sourceMessage: "Synthesized from Sierra Trade Activity log order intent; message log bracket plan was unavailable or stale.",
      chart: event.chart || null,
      study: event.study || null,
      replayTag: event.replayTag || null,
      tradeActivityOnly: true,
    },
    execution: {
      entryIntentSeen: false,
      entryFilled: false,
      remainingContracts: null,
      targetSlots: [],
      inferredTargetQuantities: [],
      exitFills: [],
      exitFillKeys: new Set(),
    },
    rawSource: event.sourceFile || null,
  };
}

export function buildReplayTradeLedger({ messageLogText, tradeLogBuffers = [], sourceFile = null }) {
  const messageEvents = parseReplayMessageLogText(messageLogText, { sourceFile });
  const profileByBarIndex = new Map();
  for (const event of messageEvents) {
    if (event.type === "hermes_profile_switch" && Number.isFinite(event.payload.barIndex)) {
      profileByBarIndex.set(event.payload.barIndex, event.payload.profile);
    }
  }

  const trades = [];
  const dedupe = new Set();
  for (const event of messageEvents) {
    if (event.type !== "bracket_plan") continue;
    const trade = makeReplayTradeFromBracketEvent(event, profileByBarIndex, sourceFile, dedupe);
    if (trade) trades.push(trade);
  }

  const messageOpenTrades = [];
  for (const event of messageEvents) {
    if (event.type === "bracket_plan") {
      const trade = trades.find((item) =>
        item.context?.barTime === event.payload?.bar_time &&
        item.direction === event.payload?.direction &&
        item.outcome.exitReason == null
      );
      if (trade && !messageOpenTrades.includes(trade)) {
        messageOpenTrades.push(trade);
      }
      continue;
    }
    if (event.type !== "position_closed") continue;
    const activeTrade = messageOpenTrades.shift();
    if (!activeTrade) continue;
    activeTrade.outcome.exitKey = londonEntryKey(event.payload?.bar_time);
    activeTrade.outcome.exitReason = "sierra_closed";
    activeTrade.outcome.pnl = Number.isFinite(event.payload?.pnl) ? roundNumber(event.payload.pnl) : activeTrade.outcome.pnl;
    activeTrade.context.closeMessage = event.message;
    activeTrade.context.closeTimestamp = event.timestamp;
    activeTrade.context.sierraPriorQty = event.payload?.priorQty ?? null;
  }

  const tradeEvents = tradeLogBuffers.flatMap((buffer, index) =>
    parseReplayTradeActivityBuffer(buffer, { sourceFile: `${sourceFile || "trade-log"}#${index}` }).map((event, eventIndex) => ({
      ...event,
      sequence: index * 100000 + eventIndex,
    })),
  );
  const orderTypeByInternalId = new Map();
  const diagnosticTradeEvents = [];
  for (const event of messageEvents) {
    if (event.type === "bracket_plan") {
      diagnosticTradeEvents.push({
        type: "replay_order_intent",
        side: event.payload.direction === "long" ? "BuyEntry" : "SellEntry",
        barTime: event.payload.bar_time,
        lastPrice: Number(event.payload.entry),
        hermesProfile: event.payload.hermes_profile || null,
        chart: event.chart,
        study: event.study,
        sourceFile: event.sourceFile,
        sequence: event.lineNumber * 10,
      });
      continue;
    }
    if (event.type === "sierra_order_state") {
      const id = event.payload.internalOrderId;
      const label = String(event.payload.label || "");
      if (Number.isFinite(id)) {
        if (/parent/i.test(label)) orderTypeByInternalId.set(id, "market");
        else if (/target/i.test(label)) orderTypeByInternalId.set(id, "limit");
        else if (/stop/i.test(label)) orderTypeByInternalId.set(id, "stop");
      }
      if (Number.isFinite(event.payload.targetChildId) && event.payload.targetChildId > 0) {
        orderTypeByInternalId.set(event.payload.targetChildId, "limit");
      }
      if (Number.isFinite(event.payload.stopChildId) && event.payload.stopChildId > 0) {
        orderTypeByInternalId.set(event.payload.stopChildId, "stop");
      }
      continue;
    }
    if (event.type === "sierra_fill_observed") {
      const id = event.payload.internalOrderId;
      diagnosticTradeEvents.push({
        type: "replay_fill",
        last: Number(event.payload.price),
        orderType: orderTypeByInternalId.get(id) || "unknown",
        internalOrderId: id,
        sourceFile: event.sourceFile,
        sequence: event.lineNumber * 10 + 1,
      });
    }
  }
  const hasDiagnosticFills = diagnosticTradeEvents.some((event) => event.type === "replay_fill");
  const orderedTradeEvents = hasDiagnosticFills ? diagnosticTradeEvents : tradeEvents;
  const openTrades = [];

  function findMatchingTrade(entryEvent) {
    const sameBarCandidates = trades.filter((trade) =>
      !trade.execution.entryFilled &&
      trade.entryKey === londonEntryKey(entryEvent.barTime) &&
      trade.direction === (entryEvent.side === "BuyEntry" ? "long" : "short"),
    );
    if (sameBarCandidates.length === 1) {
      return sameBarCandidates[0];
    }
    return sameBarCandidates.find((trade) => Math.abs(Number(trade.entry) - Number(entryEvent.lastPrice)) <= 0.5) || null;
  }

  function ensureTradeForIntent(entryEvent) {
    const activeSameEntry = openTrades.find((trade) =>
      trade.entryKey === londonEntryKey(entryEvent.barTime) &&
      trade.direction === (entryEvent.side === "BuyEntry" ? "long" : "short")
    );
    if (activeSameEntry) return activeSameEntry;
    const existing = findMatchingTrade(entryEvent);
    if (existing) return existing;
    const synthesized = makeReplayTradeFromIntent(entryEvent, dedupe);
    if (!synthesized) return null;
    trades.push(synthesized);
    return synthesized;
  }

  function contractPointValue(trade) {
    return resolveContractSpec(trade.context.chart || trade.context.symbol || trade.entrySymbol)?.pointValue || null;
  }

  function findTargetSlot(trade, fillPrice) {
    const remaining = trade.execution.targetSlots.filter((slot) => !slot.filled);
    if (!remaining.length) return null;
    const exact = remaining.find((slot) => Math.abs(Number(slot.price) - Number(fillPrice)) <= 0.5);
    return exact || remaining[0];
  }

  function ensureInferredRemainingContracts(trade) {
    if (trade.execution.remainingContracts != null) return;
    const total = trade.execution.inferredTargetQuantities.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    if (total > 0) {
      trade.execution.remainingContracts = total;
      trade.totalContracts = total;
    }
  }

  function applyExitFill(trade, orderType, fillPrice) {
    ensureInferredRemainingContracts(trade);
    const remainingBefore = trade.execution.remainingContracts;
    if (!remainingBefore) return;
    let contracts = remainingBefore;
    if (orderType === "limit") {
      const slot = findTargetSlot(trade, fillPrice);
      if (slot) {
        slot.filled = true;
        contracts = slot.contracts;
      } else if (trade.execution.inferredTargetQuantities.length) {
        const inferred = trade.execution.inferredTargetQuantities.shift();
        contracts = inferred.quantity;
        const inferredSlot = {
          index: trade.execution.targetSlots.length,
          contracts,
          price: fillPrice,
          r: null,
          filled: true,
          inferred: true,
        };
        trade.execution.targetSlots.push(inferredSlot);
        trade.targetPlan.push({
          contracts,
          price: fillPrice,
          r: null,
          inferred: true,
        });
      }
    }
    const fillKey = `${orderType}|${roundNumber(fillPrice)}|${contracts}`;
    if (trade.execution.exitFillKeys.has(fillKey)) return;
    trade.execution.exitFillKeys.add(fillKey);
    trade.execution.remainingContracts = Math.max(0, remainingBefore - contracts);
    trade.execution.exitFills.push({
      orderType,
      price: fillPrice,
      contracts,
    });
    if (orderType === "stop") trade.stopAtExit = fillPrice;
    if (trade.execution.remainingContracts === 0) {
      const pointValue = contractPointValue(trade);
      const directionMultiplier = trade.direction === "long" ? 1 : -1;
      const pnl = pointValue == null
        ? null
        : roundNumber(trade.execution.exitFills.reduce((total, fill) => total + ((Number(fill.price) - Number(trade.entry)) * directionMultiplier * fill.contracts * pointValue), 0));
      const hasLimitFill = trade.execution.exitFills.some((fill) => fill.orderType === "limit");
      const hasStopFill = trade.execution.exitFills.some((fill) => fill.orderType === "stop");
      trade.outcome.exitReason = hasLimitFill && hasStopFill ? "mixed" : hasStopFill ? "stop" : "targets";
      trade.outcome.pnl = pnl;
    }
  }

  for (const event of orderedTradeEvents.sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "replay_order_intent") {
      const trade = ensureTradeForIntent(event);
      if (!trade) continue;
      if (!trade.hermesProfile && event.hermesProfile) trade.hermesProfile = event.hermesProfile;
      if (trade.execution.entryIntentSeen || openTrades.includes(trade)) continue;
      trade.execution.entryIntentSeen = true;
      openTrades.push(trade);
      continue;
    }
    if (event.type === "replay_stop_quantity_update") {
      const activeTrade = openTrades[0];
      if (!activeTrade) continue;
      const alreadySeen = activeTrade.execution.inferredTargetQuantities.some((item) =>
        item.quantity === event.quantity && item.requestedPrice === event.requestedPrice
      );
      if (!alreadySeen) {
        activeTrade.execution.inferredTargetQuantities.push({
          quantity: event.quantity,
          requestedPrice: event.requestedPrice,
        });
      }
      continue;
    }
    if (event.type !== "replay_fill") continue;
    const activeTrade = openTrades[0];
    if (!activeTrade) continue;
    if (!activeTrade.execution.entryFilled) {
      activeTrade.execution.entryFilled = true;
      activeTrade.context.plannedEntryPrice = activeTrade.entry;
      activeTrade.entry = roundNumber(event.last);
      activeTrade.context.actualEntryPrice = activeTrade.entry;
      activeTrade.context.entrySlippagePoints = roundNumber(activeTrade.entry - activeTrade.context.plannedEntryPrice);
      continue;
    }
    if (event.orderType === "market") continue;
    if (event.orderType === "limit" || event.orderType === "stop") {
      applyExitFill(activeTrade, event.orderType, roundNumber(event.last));
      if (activeTrade.execution.remainingContracts === 0) {
        openTrades.shift();
      }
    }
  }

  return trades.map((trade) => {
    trade.context.contractSpec = resolveContractSpec(trade.context.chart || trade.entrySymbol);
    trade.context.exitFills = trade.execution.exitFills;
    trade.targetSplit = targetSplit(trade.targetPlan);
    trade.targetRs = targetRs(trade.targetPlan);
    delete trade.execution;
    return trade;
  });
}

export function validateReplaySpeedPreset(speed) {
  const normalized = String(speed || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("Replay speed is required.");
  }
  if (!ALLOWED_REPLAY_SPEEDS.includes(normalized)) {
    throw new Error(`Replay speed must be one of ${ALLOWED_REPLAY_SPEEDS.join(", ")}. Received: ${speed}`);
  }
  return normalized;
}

export function buildReplayRunRequest(options = {}) {
  const mode = normalizeMode(options.mode || "replay");
  if (mode !== "replay") {
    throw new Error("Replay orchestration requests must target the replay environment.");
  }
  const requestedStart = parseIsoLikeDateTime(options.requestedStartDateTime || options.startDateTime);
  const requestedEnd = options.requestedEndDateTime || options.endDateTime
    ? parseIsoLikeDateTime(options.requestedEndDateTime || options.endDateTime)
    : null;
  const effectiveStart = options.effectiveStartDateTime ? parseIsoLikeDateTime(options.effectiveStartDateTime) : null;
  const effectiveEnd = options.effectiveEndDateTime ? parseIsoLikeDateTime(options.effectiveEndDateTime) : null;
  const replaySpeed = validateReplaySpeedPreset(options.replaySpeed || options.speed);
  const request = {
    mode,
    useStartDateTime: true,
    requestedStartDateTime: requestedStart.text,
    requestedEndDateTime: requestedEnd?.text || null,
    effectiveStartDateTime: effectiveStart?.text || null,
    effectiveEndDateTime: effectiveEnd?.text || null,
    replaySpeed,
    replaySpeedApproved: true,
  };
  request.startDateTimeMatchesEffective = request.effectiveStartDateTime == null
    ? "pending_readback"
    : request.requestedStartDateTime === request.effectiveStartDateTime;
  request.endDateTimeMatchesEffective = request.effectiveEndDateTime == null || request.requestedEndDateTime == null
    ? "pending_readback"
    : request.requestedEndDateTime === request.effectiveEndDateTime;
  if (request.startDateTimeMatchesEffective === false) {
    throw new Error(`Effective replay start ${request.effectiveStartDateTime} does not match requested ${request.requestedStartDateTime}.`);
  }
  if (request.endDateTimeMatchesEffective === false) {
    throw new Error(`Effective replay end ${request.effectiveEndDateTime} does not match requested ${request.requestedEndDateTime}.`);
  }
  return request;
}

export function archiveReplayTradeLogs(options = {}) {
  const resolved = resolveSierraEnvironment("replay", options);
  const instance = resolved.instance;
  const startDate = parseDateOnly(options.startDate, "startDate");
  const endDate = parseDateOnly(options.endDate || options.startDate, "endDate");
  const archiveLabel = String(options.archiveLabel || "targeted").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const matchingLogs = listInstanceTradeLogs(instance, { limit: options.limit || 5000 })
    .filter((entry) => /\.Sim1\.simulated\.data$/i.test(entry.name))
    .filter((entry) => {
      const logDate = parseTradeLogDate(entry);
      return logDate && logDate >= startDate && logDate <= endDate;
    });
  const archiveRoot = path.join(instance.root, `ReplayAlignmentArchive_${archiveLabel}_${nowStampCompact()}`);
  const archiveTradeLogDir = path.join(archiveRoot, "TradeActivityLogs");
  const actions = matchingLogs.map((entry) => ({
    from: entry.fullPath,
    to: path.join(archiveTradeLogDir, entry.name),
    tradeDate: parseTradeLogDate(entry),
  }));
  if (!options.dryRun) {
    ensureDir(archiveTradeLogDir);
    for (const action of actions) {
      fs.renameSync(action.from, action.to);
    }
  }
  return {
    mode: "replay",
    archiveRoot,
    tradeLogCount: actions.length,
    archivedTradeLogs: actions,
    dryRun: Boolean(options.dryRun),
  };
}

export function replayControllerPaths(options = {}) {
  const resolved = resolveSierraEnvironment("replay", options);
  const controlDir = path.resolve(options.controlDir || path.join(resolved.instance.root, REPLAY_CONTROLLER_DIR_NAME));
  return {
    mode: "replay",
    instance: resolved.instance,
    controlDir,
    commandPath: path.join(controlDir, REPLAY_CONTROLLER_COMMAND_FILE),
    statusPath: path.join(controlDir, REPLAY_CONTROLLER_STATUS_FILE),
  };
}

export function normalizeReplayControllerCommand(options = {}) {
  const studyPreset = resolveReplayStudyPreset(options);
  const action = String(options.action || "status").trim().toLowerCase();
  const allowedActions = new Set(["apply_settings", "start", "stop", "pause", "resume", "status"]);
  if (!allowedActions.has(action)) {
    throw new Error(`Replay controller action must be one of ${Array.from(allowedActions).join(", ")}, received: ${options.action}`);
  }
  const replaySpeed = action === "start"
    ? validateReplaySpeedPreset(options.replaySpeed || options.speed || "480X")
    : options.replaySpeed || options.speed
      ? validateReplaySpeedPreset(options.replaySpeed || options.speed)
      : null;
  const start = action === "start"
    ? parseIsoLikeDateTime(options.startDateTime || options.requestedStartDateTime)
    : null;
  const end = options.endDateTime || options.requestedEndDateTime
    ? parseIsoLikeDateTime(options.endDateTime || options.requestedEndDateTime)
    : null;
  const commandId = String(options.commandId || `replay-${action}-${nowStampCompact()}`);
  return {
    schema: "ocean-trading.sierra-replay-controller.command.v1",
    commandId,
    createdAtUtc: new Date().toISOString(),
    mode: "replay",
    environment: "replay",
    action,
    chartNumber: Number(options.chartNumber || 1),
    startDateTime: start?.text || null,
    endDateTime: end?.text || null,
    replaySpeed,
    replaySpeedMultiplier: replaySpeed ? Number(String(replaySpeed).replace(/X$/i, "")) : null,
    replayMode: options.replayMode || "accurate_trading_system_back_test",
    clearTradeSimulationData: options.clearTradeSimulationData !== false,
    skipEmptyPeriods: options.skipEmptyPeriods !== false,
    expectedStudy: options.expectedStudy || studyPreset?.expectedStudy || "Ocean Trading VWAP Momentum Reclaim",
    studyPreset: studyPreset?.key || null,
    studyInputOverrides: options.studyInputOverrides || studyPreset?.controllerInputs || null,
    safety: {
      liveTradingAllowed: false,
      allowedRoot: replayControllerPaths(options).instance.root,
      forbiddenRoot: "D:\\Trading\\SierraChart-LiveTrading",
    },
  };
}

export function writeReplayControllerCommand(options = {}) {
  const paths = replayControllerPaths(options);
  const command = normalizeReplayControllerCommand(options);
  if (!path.resolve(paths.controlDir).toLowerCase().startsWith(path.resolve(paths.instance.root).toLowerCase())) {
    throw new Error(`Replay controller command path must stay under replay root ${paths.instance.root}`);
  }
  if (fs.existsSync(paths.statusPath)) {
    fs.unlinkSync(paths.statusPath);
  }
  atomicWriteJson(paths.commandPath, command);
  return {
    ok: true,
    mode: "replay",
    command,
    paths,
  };
}

export function readReplayControllerStatus(options = {}) {
  const paths = replayControllerPaths(options);
  const status = fs.existsSync(paths.statusPath) ? readJson(paths.statusPath) : null;
  const statusMtimeMs = fs.existsSync(paths.statusPath) ? fs.statSync(paths.statusPath).mtimeMs : null;
  const commandMtimeMs = fs.existsSync(paths.commandPath) ? fs.statSync(paths.commandPath).mtimeMs : null;
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_REPLAY_CONTROLLER_STATUS_MAX_AGE_MS;
  const statusAgeMs = statusMtimeMs != null ? nowMs - statusMtimeMs : null;
  return {
    ok: Boolean(status) && !(statusAgeMs != null && statusAgeMs > maxAgeMs),
    mode: "replay",
    paths,
    status,
    freshness: {
      statusMtimeMs,
      commandMtimeMs,
      nowMs,
      maxAgeMs,
      statusAgeMs,
      statusIsOlderThanCommand: statusMtimeMs != null && commandMtimeMs != null ? statusMtimeMs < commandMtimeMs : null,
      statusIsTooOld: statusAgeMs != null ? statusAgeMs > maxAgeMs : null,
    },
  };
}

export function validateReplayControllerStatus(status, expected = {}) {
  const actual = status && Object.hasOwn(status, "paths") && Object.hasOwn(status, "status")
    ? status.status
    : status;
  const freshness = status?.freshness || {};
  const mismatches = [];
  if (!actual) {
    return { status: "missing", mismatches: [{ field: "status", expected: "present", actual: null }] };
  }
  if (freshness.statusIsOlderThanCommand === true) {
    mismatches.push({ field: "statusFreshness", expected: "not older than command", actual: "older than command" });
  }
  if (freshness.statusIsTooOld === true) {
    mismatches.push({ field: "statusAge", expected: `<= ${freshness.maxAgeMs}ms`, actual: `${freshness.statusAgeMs}ms` });
  }
  if (expected.commandId && actual.commandId !== expected.commandId) {
    mismatches.push({ field: "commandId", expected: expected.commandId, actual: actual.commandId });
  }
  if (expected.action && actual.action !== expected.action) {
    mismatches.push({ field: "action", expected: expected.action, actual: actual.action });
  }
  if (expected.startDateTime && actual.requestedStartDateTime !== expected.startDateTime) {
    mismatches.push({ field: "requestedStartDateTime", expected: expected.startDateTime, actual: actual.requestedStartDateTime });
  }
  const effectiveStartDateTime = normalizeControllerEffectiveStartDateTime(actual);
  if (expected.startDateTime && String(actual.currentChartDateTime || "").startsWith("1899-12-30")) {
    mismatches.push({
      field: "currentChartDateTime",
      expected: `valid replay date matching ${expected.startDateTime.slice(0, 10)}`,
      actual: actual.currentChartDateTime,
    });
  }
  if (expected.startDateTime && effectiveStartDateTime && effectiveStartDateTime !== expected.startDateTime) {
    mismatches.push({ field: "effectiveStartDateTime", expected: expected.startDateTime, actual: effectiveStartDateTime });
  }
  if (expected.replaySpeed && actual.replaySpeed !== validateReplaySpeedPreset(expected.replaySpeed)) {
    mismatches.push({ field: "replaySpeed", expected: validateReplaySpeedPreset(expected.replaySpeed), actual: actual.replaySpeed });
  }
  if (expected.action === "start" && actual.isReplayRunning === false) {
    mismatches.push({ field: "isReplayRunning", expected: true, actual: false });
  }
  if (
    expected.action === "start" &&
    (Number(actual.chartReplayStatus) === 2 || Number(actual.replayStatus) === 2)
  ) {
    mismatches.push({ field: "replayStatus", expected: "running", actual: "paused" });
  }
  if (actual.error) {
    mismatches.push({ field: "error", expected: null, actual: actual.error });
  }
  return {
    status: mismatches.length ? "mismatch" : "exact",
    mismatches,
    effectiveStartDateTime,
    actual,
  };
}

export function diagnoseReplayControllerReadiness(options = {}) {
  const mode = normalizeMode(options.mode || "replay");
  const resolved = resolveSierraEnvironment(mode, options);
  const instance = resolved.instance;
  const runningProcesses = options.runningProcesses || detectRunningSierraInstances(options).filter((processInfo) => processInfo.mode === mode);
  const controllerStatus = options.controllerStatus || readReplayControllerStatus(options);
  const status = controllerStatus?.status || null;
  const freshness = controllerStatus?.freshness || {};

  if (mode !== "replay") {
    return {
      status: "blocked",
      reason: "replay_controller_is_replay_only",
      detail: "The ACSIL replay controller must not be used outside the replay Sierra instance.",
      runningProcessCount: runningProcesses.length,
      controllerStatus: status,
    };
  }

  if (!runningProcesses.length) {
    return {
      status: "blocked",
      reason: "sierra_replay_not_running",
      detail: `Start the replay Sierra instance at ${instance.executablePath || "SierraChart_64.exe"} before sending replay commands.`,
      runningProcessCount: 0,
      controllerStatus: status,
    };
  }

  if (!status) {
    return {
      status: "blocked",
      reason: "chartbook_or_controller_not_loaded",
      detail:
        `Sierra replay is running, but ${REPLAY_CONTROLLER_STATUS_FILE} is missing. Open ${path.basename(instance.chartbook || "the replay chartbook")} and confirm the Ocean Trading Replay Controller study is loaded/enabled.`,
      runningProcessCount: runningProcesses.length,
      controllerStatus: null,
      chartbookExists: Boolean(instance.chartbook && fs.existsSync(instance.chartbook)),
    };
  }

  if (freshness.statusIsOlderThanCommand === true || freshness.statusIsTooOld === true) {
    return {
      status: "blocked",
      reason: "stale_controller_status",
      detail: freshness.statusIsTooOld === true
        ? "The replay controller status is too old for unattended replay control; send a fresh status command before trusting it."
        : "The replay controller status is older than the latest command; do not trust this acknowledgement.",
      runningProcessCount: runningProcesses.length,
      controllerStatus: status,
      freshness,
    };
  }

  if (status.error) {
    return {
      status: "blocked",
      reason: "controller_error",
      detail: status.error,
      runningProcessCount: runningProcesses.length,
      controllerStatus: status,
      freshness,
    };
  }

  if (String(status.action || "").toLowerCase() === "start" && status.isReplayRunning === false) {
    return {
      status: "blocked",
      reason: "replay_not_running_after_start",
      detail: status.status && String(status.status).startsWith("start_pending")
        ? "The replay controller has accepted the start command but is still waiting for Sierra chart data to finish loading before it can launch replay."
        : "The replay controller has a start-related status, but Sierra is not currently in replay mode.",
      runningProcessCount: runningProcesses.length,
      controllerStatus: status,
      freshness,
    };
  }

  if (
    String(status.action || "").toLowerCase() === "start" &&
    (Number(status.chartReplayStatus) === 2 || Number(status.replayStatus) === 2)
  ) {
    return {
      status: "blocked",
      reason: "replay_paused_after_start",
      detail: "The replay controller has a start acknowledgement, but Sierra reports REPLAY_PAUSED; resume or restart before accepting replay results.",
      runningProcessCount: runningProcesses.length,
      controllerStatus: status,
      freshness,
    };
  }

  return {
    status: "ready",
    reason: "controller_status_current",
    detail: "Replay Sierra is running and the ACSIL replay controller has written a current status file.",
    runningProcessCount: runningProcesses.length,
    controllerStatus: status,
    freshness,
  };
}

export function openReplayChartbookViaUi(options = {}) {
  const mode = normalizeMode(options.mode || "replay");
  if (mode !== "replay") {
    throw new Error("Replay chartbook UI automation is replay-only.");
  }
  const resolved = resolveSierraEnvironment(mode, options);
  const instance = resolved.instance;
  if (!instance.root || /SierraChart-LiveTrading/i.test(instance.root)) {
    throw new Error(`Refusing to open chartbook against non-replay root: ${instance.root || "unknown"}`);
  }
  if (!fs.existsSync(REPLAY_CHARTBOOK_UI_SCRIPT)) {
    throw new Error(`Replay chartbook UI helper not found: ${REPLAY_CHARTBOOK_UI_SCRIPT}`);
  }
  const chartbookName = path.basename(instance.chartbook || "");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    REPLAY_CHARTBOOK_UI_SCRIPT,
    "-ReplayRoot",
    instance.root,
    "-ChartbookName",
    chartbookName,
    "-MoveWindow",
  ];
  const output = execFileSync("powershell", args, { encoding: "utf8", windowsHide: false, timeout: options.timeoutMs || 60000 });
  return {
    ok: true,
    mode,
    script: REPLAY_CHARTBOOK_UI_SCRIPT,
    chartbookName,
    chartbookPath: instance.chartbook,
    output: output.trim(),
  };
}

export function buildReplayControlPlan(options = {}) {
  const mode = normalizeMode(options.mode || "replay");
  const resolved = resolveSierraEnvironment(mode, { ...options, allowLive: options.allowLive });
  const instance = resolved.instance;
  const chartbookName = path.basename(instance.chartbook || "unknown");
  const launchCommand = instance.executablePath
    ? `"${instance.executablePath}"`
    : null;
  return {
    mode,
    supported: {
      resolve_instance: true,
      detect_process: true,
      verify_chartbook: true,
      inspect_message_log: true,
      inspect_trade_activity_log: true,
      launch_instance: true,
      open_replay_chart_window: true,
      start_replay: true,
      stop_replay: true,
      pause_replay: true,
      resume_replay: true,
      restart_replay: true,
      set_replay_parameters: true,
      verify_requested_start_datetime: true,
      verify_study_settings: true,
      archive_replay_trade_logs: true,
      detect_completion: true,
      detect_stall: true,
      detect_unexpected_pause: true,
      acsil_controller_bridge: true,
    },
    notes: [
      "Replay lifecycle control is replay-only and must never target the live root without an explicit allowLive gate.",
      "Sierra Chart does not document a command-line parameter for opening a chartbook; a raw absolute .cht argument can be interpreted relative to the Data folder and fail.",
      `The connector must verify a fresh ${REPLAY_CONTROLLER_STATUS_FILE} handshake after the chartbook is opened before starting or validating replay.`,
      "Replay speed must be selected from Sierra presets only; custom values like 5000 are rejected before the run starts.",
      "The connector validates requested/effective replay start times and loaded study settings before a run is accepted.",
      "Hermes profile changes are only valid in replay/simulation trials and should be logged as simulated actions.",
    ],
    launchCommand,
    chartbookOpen: {
      method: "Open Cbook UI button or File > Open Chartbook, then select the chartbook from Sierra's Data folder list.",
      chartbookName,
      chartbookPath: instance.chartbook,
      connectorHelper: REPLAY_CHARTBOOK_UI_SCRIPT,
      unsupportedCommandLineArgument: instance.chartbook,
    },
    allowedReplaySpeeds: ALLOWED_REPLAY_SPEEDS,
    controls: {
      toolbarButtons: {
        openReplayChartWindow: "Replay Chrt",
        stopReplay: "Replay Stop",
        pauseResumeReplay: "Replay Pause",
        resetReplayPosition: "Replay Bck",
      },
      replayWindow: {
        requiredFields: ["start_date", "start_time", "end_date", "end_time", "speed"],
        operatorActions: ["start", "pause", "resume", "stop", "restart_from_start"],
      },
      acsilBridge: {
        studySource: "connectors/sierra-chart/studies/OceanTradingReplayController.cpp",
        commandFile: path.join(instance.root, REPLAY_CONTROLLER_DIR_NAME, REPLAY_CONTROLLER_COMMAND_FILE),
        statusFile: path.join(instance.root, REPLAY_CONTROLLER_DIR_NAME, REPLAY_CONTROLLER_STATUS_FILE),
        actions: ["start", "stop", "pause", "resume", "status"],
      },
    },
    steps: [
      `Resolve the ${mode} Sierra root and verify the chartbook path ${instance.chartbook}.`,
      `Launch or attach to ${instance.executablePath || "SierraChart_64.exe"}; then open ${chartbookName} through Sierra's chartbook UI/startup mechanism and wait for a fresh replay controller status file.`,
      "Prefer the ACSIL Replay Controller bridge when it is loaded on the replay chart; the connector writes replay-command.json and waits for replay-status.json.",
      "Use the Replay Chrt toolbar button to open Sierra's replay window and set the requested date/time range and speed.",
      "Use Replay Pause as the pause/resume toggle, Replay Stop to terminate the run, and Replay Bck before restarting from the beginning of the replay window.",
      "Read the latest Message Log and TradeActivityLog files to confirm strategy version, replay order intents, fills, closed-trade outcomes, and Hermes profile transitions.",
      "Compare the requested replay start date/time against the effective readback before pressing Play and fail closed on any mismatch.",
      "Archive existing replay TradeActivityLogs for the target date range under the replay root before restarting a targeted run.",
      "Treat stale logs or a missing replay process as stalled/completed lifecycle states and stop before any live-path interaction.",
    ],
  };
}

export function buildReplayValidationReport(options = {}) {
  const mode = normalizeMode(options.mode || "replay");
  const resolved = resolveSierraEnvironment(mode, options);
  const instance = resolved.instance;
  const studyPreset = resolveReplayStudyPreset(options);
  const running = detectRunningSierraInstances(options).filter((processInfo) => processInfo.mode === mode);
  const controllerStatus = mode === "replay" ? readReplayControllerStatus(options) : null;
  const controllerReadiness = mode === "replay"
    ? diagnoseReplayControllerReadiness({ ...options, mode, runningProcesses: running, controllerStatus })
    : null;
  const messageLogs = listInstanceMessageLogs(instance, { limit: options.logLimit || 3 });
  const tradeLogs = listInstanceTradeLogs(instance, { limit: options.logLimit || 3 });
  const latestMessageLog = options.messageLogPath || messageLogs[0]?.fullPath || null;
  const latestTradeLog = tradeLogs[0]?.fullPath || null;
  const sourceFile = options.sourceFile || DEFAULT_SOURCE_FILE;
  const sourceText = readText(sourceFile);
  const studyCatalog = extractStudyCatalogFromSource(sourceText, { sourceFile });
  const messageLogStartLine = options.messageLogStartLine || options.messageLogStart;
  const messageEvents = latestMessageLog
    ? parseReplayMessageLogText(readText(latestMessageLog), { sourceFile: latestMessageLog, messageLogStartLine })
    : [];
  const latestTradeBuffer = latestTradeLog ? readFileShared(latestTradeLog) : null;
  const tradeEvents = latestTradeBuffer ? parseReplayTradeActivityBuffer(latestTradeBuffer, { sourceFile: latestTradeLog }) : [];
  const customStudyDllPath = path.join(instance.root, "Data", "OceanTrading_64.dll");
  const dllPath = fs.existsSync(customStudyDllPath)
    ? customStudyDllPath
    : path.join(instance.root, "SierraChartStudies_64.dll");
  const studySettings = extractReplayStudySettings(messageEvents);
  const replayRequest = options.requestedStartDateTime || options.startDateTime
    ? buildReplayRunRequest(options)
    : null;
  const expectedStudySettings = options.expectedStudySettings || studyPreset?.expectedStudySettings || null;
  const settingsVerification = expectedStudySettings
    ? verifyReplayStudySettings(studySettings, expectedStudySettings)
    : null;

  return {
    generatedAtUtc: new Date().toISOString(),
    mode,
    instance,
    runningProcesses: running,
    controllerStatus,
    controllerReadiness,
    chartbookExists: Boolean(instance.chartbook && fs.existsSync(instance.chartbook)),
    executableExists: Boolean(instance.executablePath && fs.existsSync(instance.executablePath)),
    messageLogs,
    tradeLogs,
    latestMessageLog,
    latestTradeLog,
    dllPath,
    dllSha256: hashFileSha256(dllPath),
    studyCatalog,
    studyPreset,
    studySettings,
    settingsVerification,
    messageEvents,
    messageLogStartLine: messageLogStartLine ? Number(messageLogStartLine) : null,
    tradeEvents,
    replayRequest,
    controlPlan: buildReplayControlPlan({ ...options, mode }),
  };
}

export function buildReplayValidationArtifact(options = {}) {
  const report = buildReplayValidationReport(options);
  const messageLogPath = options.messageLogPath || report.latestMessageLog;
  const tradeLogPaths = options.tradeLogPaths?.length
    ? options.tradeLogPaths
    : report.tradeLogs.map((item) => item.fullPath).slice(0, options.tradeLogLimit || 2);
  const missingTradeLogPaths = tradeLogPaths.filter((filePath) => !filePath || !fs.existsSync(filePath));
  if (missingTradeLogPaths.length && options.tradeLogPaths?.length) {
    throw new Error(`Replay validation was given missing Trade Activity Log path(s): ${missingTradeLogPaths.join(", ")}`);
  }
  const messageLogTextRaw = messageLogPath ? readText(messageLogPath) : "";
  const messageLogStartLine = options.messageLogStartLine || options.messageLogStart;
  const messageLogText = messageLogStartLine
    ? String(messageLogTextRaw).split(/\r?\n/).slice(Math.max(0, Number(messageLogStartLine) - 1)).join("\n")
    : messageLogTextRaw;
  const tradeLogBuffers = tradeLogPaths.map((filePath) => readFileShared(filePath)).filter(Boolean);
  const diagnosticMessageEvents = parseReplayMessageLogText(messageLogText, { sourceFile: messageLogPath });
  const diagnosticFillCount = diagnosticMessageEvents.filter((event) => event.type === "sierra_fill_observed").length;
  const diagnosticExitFillCount = diagnosticMessageEvents.filter((event) =>
    event.type === "sierra_fill_observed" && event.payload?.positionQtyAfter === 0
  ).length;
  const parsedTradeActivityEvents = tradeLogBuffers.flatMap((buffer, index) =>
    parseReplayTradeActivityBuffer(buffer, { sourceFile: tradeLogPaths[index] || `trade-log#${index}` }),
  );
  const parsedTradeActivitySummary = {
    sourceUsed: diagnosticFillCount ? "message_log_diagnostics" : "trade_activity_log",
    tradeLogCount: tradeLogPaths.length,
    readableTradeLogCount: tradeLogBuffers.length,
    diagnosticFillCount,
    diagnosticExitFillCount,
    replayOrderIntentCount: parsedTradeActivityEvents.filter((event) => event.type === "replay_order_intent").length,
    replayFillCount: diagnosticFillCount || parsedTradeActivityEvents.filter((event) => event.type === "replay_fill").length,
    replayExitFillCount: diagnosticExitFillCount || parsedTradeActivityEvents.filter((event) =>
      event.type === "replay_fill" && (event.orderType === "limit" || event.orderType === "stop")
    ).length,
    unknownFillCount: parsedTradeActivityEvents.filter((event) => event.type === "replay_fill" && event.orderType === "unknown").length,
  };
  const replayEvents = buildReplayTradeLedger({
    messageLogText,
    tradeLogBuffers,
    sourceFile: messageLogPath,
  });
  const backtestJson = options.backtestJsonPath ? readJson(options.backtestJsonPath) : null;
  const backtestTrades = Array.isArray(backtestJson?.scenarios)
    ? backtestJson.scenarios.flatMap((scenario) => scenario.trades || [])
    : Array.isArray(backtestJson?.result?.trades)
      ? backtestJson.result.trades
    : Array.isArray(backtestJson?.backtestReplayDates?.trades)
      ? backtestJson.backtestReplayDates.trades
      : Array.isArray(backtestJson?.trades)
        ? backtestJson.trades
        : [];
  const strictBacktestAlignment = options.strictBacktestAlignment !== false;
  const controllerEffectiveStart =
    options.controllerStatus
      ? normalizeControllerEffectiveStartDateTime(options.controllerStatus)
      : normalizeControllerEffectiveStartDateTime(report.controllerStatus);
  const effectiveStart = options.effectiveStartDateTime || controllerEffectiveStart || options.requestedStartDateTime || null;
  const effectiveEnd = options.effectiveEndDateTime || options.requestedEndDateTime || null;
  const rangedReplayEvents = filterTradesByEntryRange(replayEvents, effectiveStart, effectiveEnd);
  const rangedBacktestTrades = filterTradesByEntryRange(backtestTrades, effectiveStart, effectiveEnd);
  const replayWindowViolations = findReplayWindowViolations(rangedReplayEvents, effectiveStart, effectiveEnd);
  const comparedBacktestTrades = strictBacktestAlignment
    ? rangedBacktestTrades
    : rangedReplayEvents.length
      ? rangedBacktestTrades.filter((trade) => rangedReplayEvents.some((event) => event.entryKey === trade.entryKey && event.direction === trade.direction))
      : rangedBacktestTrades;

  const assumptions = {
    sierraInstanceRoot: report.instance.root,
    replaySourceType: "connector_message_log_plus_trade_activity_log",
    chartTimezone: "Europe/London",
    sessionTemplate: "MNQ 5m London chart with US Eastern session rules converted to London",
    messageLogPath,
    messageLogStartLine: messageLogStartLine ? Number(messageLogStartLine) : null,
    tradeLogPaths,
    backtestJsonPath: options.backtestJsonPath || null,
    comparisonStartDateTime: effectiveStart,
    comparisonEndDateTime: effectiveEnd,
    strategyVersion:
      report.tradeEvents.find((event) => event.study)?.study?.match(/\bv\d+\.\d+\.\d+(?:-[A-Za-z0-9_-]+)?\b/)?.[0] ||
      report.messageEvents.find((event) => event.type === "startup_audit")?.payload.version ||
      report.studyCatalog.find((item) => item.version)?.version ||
      null,
    dllSha256: report.dllSha256,
    strictBacktestAlignment,
  };
  const artifact = compareReplayToBacktest({
    strategy:
      report.tradeEvents.find((event) => event.study)?.study ||
      report.messageEvents.find((event) => event.study)?.study ||
      report.studyCatalog.find((item) => /VWAP Momentum Reclaim/i.test(item.graphName || ""))?.graphName ||
      report.studyCatalog.find((item) => item.graphName)?.graphName ||
      "Ocean Trading Sierra replay validation",
    assumptions,
    replayEvents: rangedReplayEvents,
    backtestTrades: comparedBacktestTrades,
  });
  artifact.validation = {
    status: replayWindowViolations.length ? "invalid" : "valid",
    replayWindowViolations,
  };
  const recommendation = replayWindowViolations.length
    ? "Replay validation invalid: replay trades exited outside the requested comparison window. Fix replay auto-stop/window control before accepting P&L."
    : summarizeComparisonOutcome(artifact.summary);

  return {
    artifact,
    metadata: {
      instanceRoot: report.instance.root,
      chartbook: report.instance.chartbook,
      dllPath: report.dllPath,
      dllSha256: report.dllSha256,
      strategyVersion: assumptions.strategyVersion,
      studyPreset: report.studyPreset,
      replaySpeed: report.replayRequest?.replaySpeed || null,
      requestedStartDateTime: report.replayRequest?.requestedStartDateTime || null,
      effectiveStartDateTime: effectiveStart,
      studySettings: report.studySettings,
      settingsVerification: report.settingsVerification,
      recommendation,
      messageLogPath,
      messageLogStartLine: Number(messageLogStartLine || report.messageLogStartLine || 0) || null,
      tradeLogPaths,
      parsedTradeActivitySummary,
      sourceFile: options.sourceFile || DEFAULT_SOURCE_FILE,
    },
    report,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") options.mode = argv[++index];
    else if (value === "--config") options.configFile = argv[++index];
    else if (value === "--source") options.sourceFile = argv[++index];
    else if (value === "--message-log") options.messageLogPath = argv[++index];
    else if (value === "--message-log-start-line") options.messageLogStartLine = Number(argv[++index]);
    else if (value === "--trade-log") {
      options.tradeLogPaths ||= [];
      options.tradeLogPaths.push(argv[++index]);
    } else if (value === "--backtest-json") options.backtestJsonPath = argv[++index];
    else if (value === "--requested-start") options.requestedStartDateTime = argv[++index];
    else if (value === "--effective-start") options.effectiveStartDateTime = argv[++index];
    else if (value === "--requested-end") options.requestedEndDateTime = argv[++index];
    else if (value === "--effective-end") options.effectiveEndDateTime = argv[++index];
    else if (value === "--speed") options.replaySpeed = argv[++index];
    else if (value === "--study-preset") options.studyPreset = argv[++index];
    else if (value === "--controller-action") options.controllerAction = argv[++index];
    else if (value === "--controller-command-id") options.commandId = argv[++index];
    else if (value === "--controller-chart") options.chartNumber = Number(argv[++index]);
    else if (value === "--controller-control-dir") options.controlDir = argv[++index];
    else if (value === "--controller-write-command") options.writeControllerCommand = true;
    else if (value === "--controller-read-status") options.readControllerStatus = true;
    else if (value === "--open-chartbook-ui") options.openChartbookUi = true;
    else if (value === "--output-json") options.outputJsonPath = argv[++index];
    else if (value === "--output-md") options.outputMarkdownPath = argv[++index];
    else if (value === "--allow-live") options.allowLive = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv);
  if (options.writeControllerCommand) {
    const result = writeReplayControllerCommand({
      ...options,
      action: options.controllerAction || options.action || "status",
      startDateTime: options.requestedStartDateTime || options.startDateTime,
      endDateTime: options.requestedEndDateTime || options.endDateTime,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (options.readControllerStatus) {
    const result = readReplayControllerStatus(options);
    console.log(JSON.stringify(result, null, 2));
  } else if (options.openChartbookUi) {
    const result = openReplayChartbookViaUi(options);
    console.log(JSON.stringify(result, null, 2));
  } else if (options.outputJsonPath || options.outputMarkdownPath || options.backtestJsonPath) {
    const { artifact, metadata } = buildReplayValidationArtifact(options);
    writeValidationArtifacts({ artifact, outputJsonPath: options.outputJsonPath, outputMarkdownPath: options.outputMarkdownPath, metadata });
    console.log(JSON.stringify({ artifact, metadata }, null, 2));
  } else {
    const report = buildReplayValidationReport(options);
    console.log(JSON.stringify(report, null, 2));
  }
}

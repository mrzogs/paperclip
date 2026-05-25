import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveReplayTradeLogs,
  buildReplayTradeLedger,
  buildReplayValidationArtifact,
  buildReplayControlPlan,
  buildReplayRunRequest,
  compareReplayToBacktest,
  detectRunningSierraInstances,
  extractReplayStudySettings,
  normalizeReplayControllerCommand,
  parseReplayMessageLogText,
  parseReplayTradeActivityBuffer,
  readReplayControllerStatus,
  readReplayCapableInstances,
  replayControllerPaths,
  resolveReplayStudyPreset,
  resolveSierraEnvironment,
  validateReplaySpeedPreset,
  validateReplayControllerStatus,
  verifyReplayStudySettings,
  writeReplayControllerCommand,
} from "./replay-orchestration.mjs";

test("adds a replay instance that inherits paper symbol defaults", () => {
  const instances = readReplayCapableInstances();
  assert.match(instances.replay.root, /SierraChart-Replay/i);
  assert.equal(instances.replay.symbol, instances.paper.symbol);
  assert.match(instances.replay.chartbook, /OceanTrading-PaperTrading\.cht/i);
});

test("blocks live resolution by default", () => {
  assert.throws(() => resolveSierraEnvironment("live"), /blocked by default/i);
  assert.equal(resolveSierraEnvironment("replay").mode, "replay");
});

test("classifies running Sierra processes by connector roots", () => {
  const running = detectRunningSierraInstances({
    processList: [
      {
        Id: 1,
        ProcessName: "SierraChart_64",
        Path: "D:\\Trading\\SierraChart-Replay\\SierraChart_64.exe",
        StartTime: "2026-05-24T12:54:33.000Z",
        MainWindowTitle: "Sierra Chart 2755 Replay [Sim]",
      },
    ],
  });
  assert.equal(running.length, 1);
  assert.equal(running[0].mode, "replay");
  assert.equal(running[0].rootMatched, true);
});

test("normalizes replay message-log events", () => {
  const events = parseReplayMessageLogText([
    "2026-05-24  11:53:47.889 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.4 | Hermes Profile: Warming Up | VWAP Momentum Reclaim Hermes profile display switched: profile=Trend + Markov: Bear Continuation state=33 bar_index=78 version=v2.1.4-profile-display-replay-fix",
    "2026-05-24  11:53:47.890 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.4 | Hermes Profile: Warming Up | VWAP Momentum Reclaim short bracket plan: hermes_profile=Trend + Markov: Bear Continuation qty=5 bar_index=81 bar_time=2026-05-24 16:30:00 trades_today=0 max_trades_per_day=8 entry=25076.50 stop=25088.75 risk=12.25 planned_risk=122.50 tick_size=0.2500 target2=25052.00 qty2=2 target3=25039.75 qty3=3 breakeven=yes schema=3 version=v2.1.4-profile-display-replay-fix",
  ].join("\n"));

  assert.deepEqual(events.map((event) => event.type), ["hermes_profile_switch", "bracket_plan"]);
  assert.match(events[0].payload.profile, /Bear Continuation/);
  assert.equal(events[1].payload.direction, "short");
  assert.equal(events[1].payload.plannedRisk, 122.5);
});

test("normalizes replay trade-activity strings", () => {
  const buffer = Buffer.from(
    "Auto-trade: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.4 | Hermes Profile: Trend + Markov: Bear Continuation | SellEntry | Bar start date-time: 2026-05-15  00:55:00.000 | Last: 29687.5 Simulated order accepted Trade simulation fill. Bid: 29687.50 Ask: 29687.75 Last: 29687.50 Updating move to breakeven stop trigger price on parent modification/fill to 2966050",
    "utf8",
  );
  const events = parseReplayTradeActivityBuffer(buffer);
  assert.equal(events.some((event) => event.type === "replay_order_intent"), true);
  assert.equal(events.some((event) => event.type === "replay_fill"), true);
  assert.equal(events.some((event) => event.type === "replay_breakeven_update"), true);
});

test("builds a replay-safe lifecycle control plan", () => {
  const plan = buildReplayControlPlan({ mode: "replay" });
  assert.equal(plan.supported.launch_instance, true);
  assert.equal(plan.supported.start_replay, true);
  assert.equal(plan.supported.verify_requested_start_datetime, true);
  assert.equal(plan.controls.toolbarButtons.stopReplay, "Replay Stop");
  assert.deepEqual(plan.allowedReplaySpeeds.includes("480X"), true);
  assert.match(plan.steps[0], /Resolve the replay Sierra root/i);
});

test("accepts only approved replay speed presets", () => {
  assert.equal(validateReplaySpeedPreset("480x"), "480X");
  assert.throws(() => validateReplaySpeedPreset("5000"), /must be one of/i);
});

test("normalizes replay controller commands for the ACSIL bridge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const command = normalizeReplayControllerCommand({
    action: "start",
    requestedStartDateTime: "2026-05-20 23:00:00",
    speed: "960x",
    commandId: "cmd-1",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live") },
    },
  });

  assert.equal(command.action, "start");
  assert.equal(command.startDateTime, "2026-05-20 23:00:00");
  assert.equal(command.replaySpeed, "960X");
  assert.equal(command.replaySpeedMultiplier, 960);
  assert.equal(command.safety.liveTradingAllowed, false);
});

test("includes candidate replay study input overrides in controller commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const command = normalizeReplayControllerCommand({
    action: "start",
    requestedStartDateTime: "2026-05-20 23:00:00",
    speed: "480X",
    studyPreset: "candidate_88",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live") },
    },
  });

  assert.equal(command.studyPreset, "candidate_88");
  assert.equal(command.studyInputOverrides.studyName, "Ocean Trading VWAP Momentum Reclaim");
  assert.equal(command.studyInputOverrides.intInputs["9"], 3);
  assert.equal(command.studyInputOverrides.intInputs["18"], 4);
  assert.equal(command.studyInputOverrides.floatInputs["2"], 350);
  assert.equal(command.studyInputOverrides.floatInputs["23"], 0.35);
});

test("writes replay controller commands only under the replay root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const config = {
    paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
    replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
    live: { root: path.join(root, "live") },
  };
  const written = writeReplayControllerCommand({
    config,
    action: "start",
    requestedStartDateTime: "2026-05-20 23:00:00",
    speed: "480X",
    commandId: "cmd-2",
  });

  assert.equal(fs.existsSync(written.paths.commandPath), true);
  assert.deepEqual(replayControllerPaths({ config }).commandPath, written.paths.commandPath);

  fs.writeFileSync(written.paths.statusPath, JSON.stringify({
    commandId: "cmd-2",
    action: "start",
    requestedStartDateTime: "2026-05-20 23:00:00",
    replaySpeed: "480X",
    isReplayRunning: true,
    error: null,
  }));
  const status = readReplayControllerStatus({ config });
  const verification = validateReplayControllerStatus(status, {
    commandId: "cmd-2",
    action: "start",
    startDateTime: "2026-05-20 23:00:00",
    replaySpeed: "480X",
  });

  assert.equal(status.ok, true);
  assert.equal(verification.status, "exact");
  assert.throws(() => writeReplayControllerCommand({
    config,
    controlDir: path.join(os.tmpdir(), "outside-replay-root"),
    action: "status",
  }), /must stay under replay root/i);
});

test("builds a replay run request that fails closed on effective start mismatch", () => {
  const request = buildReplayRunRequest({
    mode: "replay",
    requestedStartDateTime: "2026-05-20 23:00:00",
    effectiveStartDateTime: "2026-05-20 23:00:00",
    replaySpeed: "960X",
  });
  assert.equal(request.startDateTimeMatchesEffective, true);
  assert.equal(request.replaySpeedApproved, true);
  assert.throws(() => buildReplayRunRequest({
    mode: "replay",
    requestedStartDateTime: "2026-05-20 23:00:00",
    effectiveStartDateTime: "2026-05-14 23:00:00",
    replaySpeed: "480X",
  }), /does not match requested/i);
});

test("builds replay trade rows from bracket-plan logs", () => {
  const trades = buildReplayTradeLedger({
    messageLogText: [
      "2026-05-24  11:53:47.890 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.8 | Hermes Profile: Warming Up | VWAP Momentum Reclaim long bracket plan: hermes_profile=Dynamic Profile Map: Bull Continuation qty=5 bar_index=81 bar_time=2026-05-24 16:30:00 entry=25076.50 stop=25064.25 target2=25101.00 qty2=2 target3=25113.25 qty3=3 schema=5 version=v2.1.8-optimized-dynamic-profile",
    ].join("\n"),
    tradeLogBuffers: [],
    sourceFile: "fixture.log",
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryKey, "2026-05-24T16:30");
  assert.equal(trades[0].targetSplit, "2/3");
  assert.equal(trades[0].hermesProfile, "Dynamic Profile Map: Bull Continuation");
});

test("builds a replay validation artifact from connector-owned sources", () => {
  const fixtureDir = "D:\\paperclip-codex\\connectors\\sierra-chart\\tests";
  const backtestJsonPath = `${fixtureDir}\\replay-backtest-fixture.json`;
  const messageLogPath = `${fixtureDir}\\replay-message.log`;
  const tradeLogPath = `${fixtureDir}\\replay-trade.log`;
  const artifactBundle = buildReplayValidationArtifact({
    mode: "replay",
    messageLogPath,
    tradeLogPaths: [tradeLogPath],
    backtestJsonPath,
    sourceFile: "D:\\paperclip-codex\\ocean-trading-strategies\\strategies\\OceanTrading.cpp",
  });

  assert.equal(artifactBundle.artifact.summary.replayCount, 1);
  assert.equal(artifactBundle.artifact.summary.backtestCount, 1);
  assert.equal(artifactBundle.artifact.summary.matchedCount, 1);
  assert.equal(artifactBundle.artifact.summary.exactCount, 1);
  assert.equal(artifactBundle.artifact.comparisons[0].status, "exact");
  assert.equal(artifactBundle.artifact.comparisons[0].fieldComparisons.outcomePnl.status, "exact");
  assert.equal(artifactBundle.artifact.replayEvents[0].outcome.pnl, -125);
});

test("extracts and verifies Sierra-loaded study settings from replay logs", () => {
  const messageEvents = parseReplayMessageLogText([
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim input schema applied: schema=6 version=v2.1.9-high-quality-defensive-profile qty=5 max_trades_per_day=8 tp1=0 tp2=2 tp3=3 risk_cap=500.00 cooldown_bars=10 allow_longs=yes allow_shorts=yes allow_after_22_london=no confluence_enabled=yes confluence_mode=4 hermes_tp_adaptation=no holiday_force_flat=yes trading_enabled=yes",
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.9-high-quality-defensive-profile schema=6 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=8 risk_cap=500.00 tp_split=0/2/3 confluence_enabled=yes confluence_mode=4 hermes_tp_adaptation=no be_plus_one=yes cme_guard=yes holiday_force_flat=yes lucid_closeout=yes",
  ].join("\n"));
  const actual = extractReplayStudySettings(messageEvents);
  const verification = verifyReplayStudySettings(actual, {
    version: "v2.1.9-high-quality-defensive-profile",
    schema: 6,
    quantity: 5,
    maxTradesPerDay: 8,
    tpSplit: "0/2/3",
    tp1: 0,
    tp2: 2,
    tp3: 3,
    confluenceMode: 4,
    hermesTpAdaptation: "no",
  });
  assert.equal(actual.version, "v2.1.9-high-quality-defensive-profile");
  assert.equal(actual.tpSplit, "0/2/3");
  assert.equal(verification.status, "exact");
  assert.equal(verification.mismatches.length, 0);
});

test("loads replay study presets for baseline and candidate validation", () => {
  const baselinePreset = resolveReplayStudyPreset({ studyPreset: "v219_replay_alignment" });
  const candidatePreset = resolveReplayStudyPreset({ studyPreset: "candidate-88" });

  assert.equal(baselinePreset.expectedStudySettings.tpSplit, "0/2/3");
  assert.equal(candidatePreset.expectedStudySettings.tpSplit, "0/4/1");
  assert.equal(candidatePreset.strategyParameters.maxRiskDollars, 350);
});

test("applies replay study presets to settings verification", () => {
  const messageEvents = parseReplayMessageLogText([
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim input schema applied: schema=6 version=v2.1.9-high-quality-defensive-profile qty=5 max_trades_per_day=8 tp1=0 tp2=2 tp3=3 risk_cap=500.00 cooldown_bars=10 allow_longs=yes allow_shorts=yes allow_after_22_london=no confluence_enabled=yes confluence_mode=4 hermes_tp_adaptation=no holiday_force_flat=yes trading_enabled=yes",
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.9-high-quality-defensive-profile schema=6 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=8 risk_cap=500.00 tp_split=0/2/3 confluence_enabled=yes confluence_mode=4 hermes_tp_adaptation=no be_plus_one=yes cme_guard=yes holiday_force_flat=yes lucid_closeout=yes",
  ].join("\n"));
  const actual = extractReplayStudySettings(messageEvents);
  const baselinePreset = resolveReplayStudyPreset({ studyPreset: "v219_replay_alignment" });
  const candidatePreset = resolveReplayStudyPreset({ studyPreset: "candidate_88" });
  const baselineVerification = verifyReplayStudySettings(actual, baselinePreset.expectedStudySettings);
  const candidateVerification = verifyReplayStudySettings(actual, candidatePreset.expectedStudySettings);

  assert.equal(baselineVerification.status, "exact");
  assert.equal(candidateVerification.status, "mismatch");
  assert.equal(candidatePreset.key, "candidate_88");
});

test("archives only replay Sim1 trade logs for the targeted date range", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-archive-"));
  const tradeDir = path.join(root, "TradeActivityLogs");
  const dataDir = path.join(root, "Data");
  fs.mkdirSync(tradeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tradeDir, "TradeActivityLog_2026-05-20_UTC.Sim1.simulated.data"), "a");
  fs.writeFileSync(path.join(tradeDir, "TradeActivityLog_2026-05-21_UTC.Sim1.simulated.data"), "b");
  fs.writeFileSync(path.join(tradeDir, "TradeActivityLog_2026-05-22_UTC.Other.data"), "c");

  const result = archiveReplayTradeLogs({
    startDate: "2026-05-20",
    endDate: "2026-05-21",
    archiveLabel: "Targeted",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(dataDir, "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live"), symbol: "MNQM26_FUT_CME[M]" },
    },
  });

  assert.equal(result.tradeLogCount, 2);
  assert.equal(result.archivedTradeLogs.every((entry) => /ReplayAlignmentArchive_Targeted_/i.test(entry.to)), true);
});

test("strict replay artifact keeps missing expected backtest trades visible", () => {
  const artifact = buildReplayValidationArtifact({
    mode: "replay",
    messageLogPath: "D:\\paperclip-codex\\connectors\\sierra-chart\\tests\\replay-message.log",
    tradeLogPaths: ["D:\\paperclip-codex\\connectors\\sierra-chart\\tests\\replay-trade.log"],
    backtestJsonPath: "D:\\paperclip-codex\\connectors\\sierra-chart\\tests\\replay-backtest-fixture-extra.json",
    sourceFile: "D:\\paperclip-codex\\ocean-trading-strategies\\strategies\\OceanTrading.cpp",
  });
  assert.equal(artifact.artifact.summary.unmatchedBacktestCount, 1);
});

test("accepts replay mixed exits when backtest labels the final stop", () => {
  const artifact = compareReplayToBacktest({
    strategy: "fixture",
    assumptions: {},
    replayEvents: [
      {
        entryKey: "2026-05-20T00:10",
        direction: "long",
        entry: 28946,
        initialStop: 28899,
        targetPlan: [
          { contracts: 2, r: 1.5, price: 29016.5 },
          { contracts: 3, r: 2.25, price: 29051.75 },
        ],
        hermesAction: "manual_tp_inputs",
        outcome: { exitReason: "mixed", pnl: 290 },
        context: {
          exitFills: [
            { orderType: "limit", price: 29017, contracts: 2 },
            { orderType: "stop", price: 28947, contracts: 3 },
          ],
        },
      },
    ],
    backtestTrades: [
      {
        entryKey: "2026-05-20T00:10",
        direction: "long",
        entry: 28946,
        stop: 28898.5,
        targets: [
          { contracts: 2, r: 1.5, price: 29017.25 },
          { contracts: 3, r: 2.25, price: 29052.875 },
        ],
        hermesAction: "manual_tp_inputs",
        exitReason: "stop",
        pnl: 291,
      },
    ],
  });

  assert.equal(artifact.summary.exactCount, 1);
  assert.equal(artifact.summary.mismatchCount, 0);
  assert.match(artifact.comparisons[0].fieldComparisons.outcome.note, /partial-target/);
});

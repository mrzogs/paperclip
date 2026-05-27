import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  archiveReplayTradeLogs,
  buildReplayTradeLedger,
  buildReplayValidationArtifact,
  buildReplayControlPlan,
  buildReplayRunRequest,
  compareReplayToBacktest,
  diagnoseReplayControllerReadiness,
  detectRunningSierraInstances,
  extractReplayStudySettings,
  normalizeReplayControllerCommand,
  openReplayChartbookViaUi,
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

test("can ignore stale Sierra message-log lines before a replay command", () => {
  const events = parseReplayMessageLogText([
    "2026-05-24  11:53:47.889 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.4 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.4 schema=3 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=8 risk_cap=500.00 tp_split=5/0/0 confluence_enabled=yes confluence_mode=5 hermes_tp_adaptation=no",
    "2026-05-24  11:54:47.889 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.26 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.26 schema=7 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=3 risk_cap=350.00 tp_split=0/4/1 confluence_enabled=yes confluence_mode=2 hermes_tp_adaptation=no",
  ].join("\n"), { messageLogStartLine: 2 });

  const settings = extractReplayStudySettings(events);
  assert.equal(events.length, 1);
  assert.equal(events[0].lineNumber, 2);
  assert.equal(settings.version, "v2.1.26");
  assert.equal(settings.tpSplit, "0/4/1");
  assert.equal(settings.confluenceMode, 2);
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

test("ignores attached-order auto-trade rows when identifying replay entries", () => {
  const buffer = Buffer.from(
    [
      "Auto-trade: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17 | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | SellEntry | Bar start date-time: 2026-03-02  00:15:00.000 | Last: 24947.75 | AOE=true | AOU=true. Attached Order | Client side OCO order",
      "Auto-trade: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17 | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | SellEntry | Bar start date-time: 2026-03-02  00:15:00.000 | Last: 24947.75 | AOE=true | AOU=true",
    ].join(" "),
    "utf8",
  );
  const entryEvents = parseReplayTradeActivityBuffer(buffer).filter((event) => event.type === "replay_order_intent");
  assert.equal(entryEvents.length, 1);
  assert.equal(entryEvents[0].barTime, "2026-03-02 00:15:00.000");
});

test("dedupes repeated parent auto-trade rows while a replay trade is open", () => {
  const trades = buildReplayTradeLedger({
    messageLogText: [
      "2026-05-26  12:00:00.000 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17 | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | VWAP Momentum Reclaim short bracket plan: hermes_profile=Hermes TMV: Bear Continuation hermes_action=manual_tp_inputs qty=5 bar_index=14308 bar_time=2026-03-02 00:15:00 entry=24943.25 stop=24992.75 target1_r=1.50 target1=24869.00 qty1=2 target2_r=2.25 target2=24831.75 qty2=3 schema=7 version=v2.1.17-hermes-volume-profile",
    ].join("\n"),
    tradeLogBuffers: [
      Buffer.from(
        [
          "Auto-trade: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17 | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | SellEntry | Bar start date-time: 2026-03-02  00:15:00.000 | Last: 24947.75 | AOE=true | AOU=true",
          "Trade simulation fill. Bid: 24945.00 Ask: 24947.75 Last: 24947.75 j 1k Marketl",
          "Auto-trade: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17 | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | SellEntry | Bar start date-time: 2026-03-02  00:15:00.000 | Last: 24947.75 | AOE=true | AOU=true",
          "Trade simulation fill. Bid: 24993.75 Ask: 24997.00 Last: 24997.00 j 2k Stopl",
        ].join(" "),
        "utf8",
      ),
    ],
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryKey, "2026-03-02T00:15");
  assert.equal(trades[0].entry, 24947.75);
  assert.equal(trades[0].outcome.exitReason, "stop");
});

test("builds replay rows from trade activity when the message log is stale", () => {
  const trades = buildReplayTradeLedger({
    messageLogText: "",
    tradeLogBuffers: [
      Buffer.from(
        [
          "Auto-trade: Replay 480X: MNQM26_FUT_CME[M] 5 Min #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.17-hermes-volume-profile | Session Profile: Hermes Asia Profit Profile | Hermes Profile: Hermes TMV: Waiting | SellEntry | Bar start date-time: 2026-03-02 05:20:00.000 | Last: 24940.75 | AOE=true | AOU=true",
          "Simulated order accepted",
          "Trade simulation fill. Bid: 24938.00 Ask: 24940.75 Last: 24940.75",
          "Auto trail order modification. 1. Trigger price: 24891.00. Using LastModifyQuantity of 2. Using new provided price. Requested Price: 24936.75. Requested Quantity: 2",
          "Auto trail order modification. 1. Trigger price: 24891.00. Using LastModifyQuantity of 3. Using new provided price. Requested Price: 24936.75. Requested Quantity: 3",
          "Trade simulation fill. Bid: 24870.00 Ask: 24872.75 Last: 24870.00 j 1884k Limitl",
          "Trade simulation fill. Bid: 24840.25 Ask: 24840.50 Last: 24840.50 j 1887k Limitl",
        ].join(" "),
        "utf8",
      ),
    ],
    sourceFile: "stale-message.log",
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryKey, "2026-03-02T05:20");
  assert.equal(trades[0].direction, "short");
  assert.equal(trades[0].targetSplit, "2/3");
  assert.equal(trades[0].outcome.exitReason, "targets");
  assert.equal(trades[0].outcome.pnl, 884.5);
  assert.equal(trades[0].context.tradeActivityOnly, true);
});

test("builds a replay-safe lifecycle control plan", () => {
  const plan = buildReplayControlPlan({ mode: "replay" });
  assert.equal(plan.supported.launch_instance, true);
  assert.equal(plan.supported.start_replay, true);
  assert.equal(plan.supported.verify_requested_start_datetime, true);
  assert.equal(plan.controls.toolbarButtons.stopReplay, "Replay Stop");
  assert.deepEqual(plan.allowedReplaySpeeds.includes("480X"), true);
  assert.doesNotMatch(plan.launchCommand, /OceanTrading-PaperTrading\.cht/i);
  assert.equal(plan.chartbookOpen.chartbookName, "OceanTrading-PaperTrading.cht");
  assert.match(plan.chartbookOpen.connectorHelper, /open-replay-chartbook\.ps1$/i);
  assert.match(plan.steps[0], /Resolve the replay Sierra root/i);
});

test("blocks replay chartbook UI helper outside replay mode", () => {
  assert.throws(() => openReplayChartbookViaUi({ mode: "paper" }), /replay-only/i);
});

test("diagnoses a running replay instance with no controller status as chartbook not loaded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-readiness-"));
  const data = path.join(root, "Data");
  const control = path.join(root, "connector-control");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(data, "OceanTrading-PaperTrading.cht"), "");
  fs.writeFileSync(path.join(control, "replay-command.json"), JSON.stringify({ commandId: "cmd-1" }));

  const readiness = diagnoseReplayControllerReadiness({
    mode: "replay",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(data, "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live"), symbol: "MNQM26_FUT_CME[M]" },
    },
    runningProcesses: [{ mode: "replay", Path: path.join(root, "SierraChart_64.exe") }],
  });

  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.reason, "chartbook_or_controller_not_loaded");
});

test("accepts only approved replay speed presets", () => {
  assert.equal(validateReplaySpeedPreset("480x"), "480X");
  assert.throws(() => validateReplaySpeedPreset("5000"), /must be one of/i);
});

test("rejects Sierra blank replay start dates", () => {
  assert.throws(
    () => buildReplayRunRequest({ mode: "replay", requestedStartDateTime: "1899-12-30 00:00:00", speed: "480X" }),
    /Refusing Sierra blank replay start/i,
  );
});

test("does not infer controller effective start from Sierra blank date", () => {
  const status = validateReplayControllerStatus(
    {
      action: "start",
      commandId: "cmd-blank",
      requestedStartDateTime: "2026-04-10 00:00:00",
      currentChartDateTime: "1899-12-30 00:00:00",
      effectiveStartDateTime: null,
      isReplayRunning: true,
    },
    { action: "start", commandId: "cmd-blank", startDateTime: "2026-04-10 00:00:00" },
  );

  assert.equal(status.status, "mismatch");
  assert.equal(status.effectiveStartDateTime, null);
  assert.equal(status.mismatches[0].field, "currentChartDateTime");
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
  assert.equal(command.studyInputOverrides.studyName, "Ocean Trading VWAP Momentum Reclaim 2R Capped");
  assert.equal(command.studyInputOverrides.intInputs["9"], 3);
  assert.equal(command.studyInputOverrides.intInputs["18"], 4);
  assert.equal(command.studyInputOverrides.floatInputs["2"], 350);
  assert.equal(command.studyInputOverrides.floatInputs["23"], 0.35);
});

test("includes VWAP Wave Pullback replay study input overrides in controller commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const command = normalizeReplayControllerCommand({
    action: "start",
    requestedStartDateTime: "2026-04-06 00:00:00",
    requestedEndDateTime: "2026-04-07 03:00:00",
    speed: "480X",
    studyPreset: "vwap_wave_pullback_clean",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live") },
    },
  });

  assert.equal(command.expectedStudy, "VWAP Wave Pullback");
  assert.equal(command.studyPreset, "vwap_wave_pullback_clean");
  assert.equal(command.studyInputOverrides.studyName, "VWAP Wave Pullback Replay Parity");
  assert.equal(command.studyInputOverrides.intInputs["0"], 2);
  assert.equal(command.studyInputOverrides.intInputs["15"], 1);
  assert.equal(command.studyInputOverrides.intInputs["16"], 1);
  assert.equal(command.studyInputOverrides.intInputs["17"], 2);
  assert.equal(command.studyInputOverrides.intInputs["18"], 1);
  assert.equal(command.studyInputOverrides.floatInputs["13"], 250);
});

test("includes configurable VWAP Wave Pullback five-target replay overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const command = normalizeReplayControllerCommand({
    action: "start",
    requestedStartDateTime: "2026-04-06 00:00:00",
    requestedEndDateTime: "2026-04-07 03:00:00",
    speed: "480X",
    studyPreset: "vwap_wave_pullback_split_be",
    config: {
      paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
      replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
      live: { root: path.join(root, "live") },
    },
  });

  assert.equal(command.expectedStudy, "VWAP Wave Pullback");
  assert.equal(command.studyInputOverrides.intInputs["0"], 3);
  assert.equal(command.studyInputOverrides.intInputs["16"], 0);
  assert.equal(command.studyInputOverrides.intInputs["22"], 0);
  assert.equal(command.studyInputOverrides.intInputs["23"], 2);
  assert.equal(command.studyInputOverrides.intInputs["24"], 0);
  assert.equal(command.studyInputOverrides.intInputs["25"], 0);
  assert.equal(command.studyInputOverrides.intInputs["26"], 0);
  assert.equal(command.studyInputOverrides.intInputs["31"], 0);
  assert.equal(command.studyInputOverrides.intInputs["32"], 1);
  assert.equal(command.studyInputOverrides.intInputs["33"], 1);
  assert.equal(command.studyInputOverrides.intInputs["36"], 4);
  assert.equal(command.studyInputOverrides.intInputs["37"], 3);
  assert.equal(command.studyInputOverrides.floatInputs["13"], 400);
  assert.equal(command.studyInputOverrides.floatInputs["27"], 0);
  assert.equal(command.studyInputOverrides.floatInputs["29"], 3);
  assert.equal(command.studyInputOverrides.floatInputs["30"], 4);
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

  const writtenNext = writeReplayControllerCommand({
    config,
    action: "start",
    requestedStartDateTime: "2026-05-21 23:00:00",
    speed: "480X",
    commandId: "cmd-3",
  });
  assert.equal(fs.existsSync(writtenNext.paths.commandPath), true);
  assert.equal(fs.existsSync(writtenNext.paths.statusPath), false);
  const missingStatus = readReplayControllerStatus({ config });
  const missingVerification = validateReplayControllerStatus(missingStatus, { commandId: "cmd-3" });
  assert.equal(missingStatus.ok, false);
  assert.equal(missingVerification.status, "missing");

  assert.throws(() => writeReplayControllerCommand({
    config,
    controlDir: path.join(os.tmpdir(), "outside-replay-root"),
    action: "status",
  }), /must stay under replay root/i);
});

test("rejects stale replay controller status files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const config = {
    paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
    replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
    live: { root: path.join(root, "live") },
  };
  const paths = replayControllerPaths({ config });
  fs.mkdirSync(paths.controlDir, { recursive: true });
  fs.writeFileSync(paths.statusPath, JSON.stringify({ commandId: "old", action: "start", error: null }));
  fs.writeFileSync(paths.commandPath, JSON.stringify({ commandId: "new", action: "start" }));
  const now = Date.now() / 1000;
  fs.utimesSync(paths.statusPath, now - 20, now - 20);
  fs.utimesSync(paths.commandPath, now, now);

  const status = readReplayControllerStatus({ config });
  const verification = validateReplayControllerStatus(status, { commandId: "new" });
  assert.equal(status.freshness.statusIsOlderThanCommand, true);
  assert.equal(verification.status, "mismatch");
  assert.equal(verification.mismatches.some((item) => item.field === "statusFreshness"), true);
  assert.equal(verification.mismatches.some((item) => item.field === "commandId"), true);
});

test("rejects replay controller status files that age out even when no newer command exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-replay-controller-"));
  const config = {
    paper: { root: path.join(root, "paper"), symbol: "MNQM26_FUT_CME[M]" },
    replay: { root, symbol: "MNQM26_FUT_CME[M]", chartbook: path.join(root, "Data", "OceanTrading-PaperTrading.cht") },
    live: { root: path.join(root, "live") },
  };
  const paths = replayControllerPaths({ config });
  fs.mkdirSync(paths.controlDir, { recursive: true });
  fs.writeFileSync(paths.commandPath, JSON.stringify({ commandId: "old-status", action: "status" }));
  fs.writeFileSync(paths.statusPath, JSON.stringify({
    commandId: "old-status",
    action: "status",
    error: null,
  }));
  const oldTime = Date.now() / 1000 - 600;
  fs.utimesSync(paths.statusPath, oldTime, oldTime);
  fs.utimesSync(paths.commandPath, oldTime, oldTime);

  const status = readReplayControllerStatus({ config, maxAgeMs: 5 * 60 * 1000 });
  const verification = validateReplayControllerStatus(status, { commandId: "old-status" });
  assert.equal(status.ok, false);
  assert.equal(status.freshness.statusIsTooOld, true);
  assert.equal(verification.status, "mismatch");
  assert.equal(verification.mismatches.some((item) => item.field === "statusAge"), true);
});

test("accepts inferred effective replay start from controller chart time", () => {
  const verification = validateReplayControllerStatus({
    paths: {},
    status: {
      commandId: "cmd-4",
      action: "start",
      requestedStartDateTime: "2026-05-20 23:00:00",
      currentChartDateTime: "2026-05-20 23:00:00",
      replaySpeed: "480X",
      isReplayRunning: true,
      error: null,
    },
    freshness: {
      statusIsOlderThanCommand: false,
    },
  }, {
    commandId: "cmd-4",
    action: "start",
    startDateTime: "2026-05-20 23:00:00",
    replaySpeed: "480X",
  });

  assert.equal(verification.status, "exact");
});

test("rejects start acknowledgements when Sierra is not actually replaying", () => {
  const status = {
    paths: {},
    status: {
      commandId: "cmd-not-running",
      action: "start",
      status: "start_requested",
      requestedStartDateTime: "2026-05-20 23:00:00",
      currentChartDateTime: "2026-05-20 23:00:00",
      replaySpeed: "480X",
      isReplayRunning: false,
      error: null,
    },
    freshness: {
      statusIsOlderThanCommand: false,
      statusIsTooOld: false,
    },
  };
  const verification = validateReplayControllerStatus(status, {
    commandId: "cmd-not-running",
    action: "start",
    startDateTime: "2026-05-20 23:00:00",
    replaySpeed: "480X",
  });
  assert.equal(verification.status, "mismatch");
  assert.equal(verification.mismatches.some((item) => item.field === "isReplayRunning"), true);

  const readiness = diagnoseReplayControllerReadiness({
    mode: "replay",
    config: {
      paper: { root: path.join(os.tmpdir(), "paper") },
      replay: { root: path.join(os.tmpdir(), "replay") },
      live: { root: path.join(os.tmpdir(), "live") },
    },
    runningProcesses: [{ mode: "replay", Path: "D:\\Trading\\SierraChart-Replay\\SierraChart_64.exe" }],
    controllerStatus: status,
  });
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.reason, "replay_not_running_after_start");
});

test("rejects start acknowledgements when Sierra is paused after launch", () => {
  const status = {
    paths: {},
    status: {
      commandId: "cmd-paused",
      action: "start",
      status: "replay_running",
      requestedStartDateTime: "2026-04-06 00:00:00",
      currentChartDateTime: "1899-12-30 00:00:00",
      replaySpeed: "480X",
      isReplayRunning: true,
      replayStatus: 2,
      chartReplayStatus: 2,
      error: null,
    },
    freshness: {
      statusIsOlderThanCommand: false,
      statusIsTooOld: false,
    },
  };
  const verification = validateReplayControllerStatus(status, {
    commandId: "cmd-paused",
    action: "start",
    startDateTime: "2026-04-06 00:00:00",
    replaySpeed: "480X",
  });
  assert.equal(verification.status, "mismatch");
  assert.equal(verification.mismatches.some((item) => item.field === "replayStatus"), true);

  const readiness = diagnoseReplayControllerReadiness({
    mode: "replay",
    config: {
      paper: { root: path.join(os.tmpdir(), "paper") },
      replay: { root: path.join(os.tmpdir(), "replay") },
      live: { root: path.join(os.tmpdir(), "live") },
    },
    runningProcesses: [{ mode: "replay", Path: "D:\\Trading\\SierraChart-Replay\\SierraChart_64.exe" }],
    controllerStatus: status,
  });
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.reason, "replay_paused_after_start");
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

test("extracts replay study settings from bracket-plan diagnostics", () => {
  const events = parseReplayMessageLogText([
    "2026-05-27  19:01:56.997 | Chart: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Study: VWAP Wave Pullback Replay Parity v0.1.0 | VWAP Wave Pullback long bracket plan: session_profile=all_sessions hermes_profile=wave_pullback_clean hermes_action=single_target_2r qty=2 bar_index=21375 bar_time=2026-04-06 23:50:00 entry=24318.75 stop=24257.05 risk=61.70 planned_risk=246.82 tick_size=0.2500 atr=17.8440 vwap=24301.3730 target1_r=2.00 target1=24444.41 qty2=0 target2=0.00 qty3=0 target3=0.00 schema=1 version=v0.1.0-replay-parity",
  ].join("\n"));
  const settings = extractReplayStudySettings(events);

  assert.equal(settings.version, "v0.1.0-replay-parity");
  assert.equal(settings.quantity, 2);
  assert.equal(settings.chart.includes("Replay 480X"), true);
});

test("parses VWAP Wave configurable five-target bracket plans", () => {
  const messageLogText = [
    "2026-05-27  20:01:56.997 | Chart: Replay 480X: MNQM26_FUT_CME[M]  5 Min  #1 | Study: VWAP Wave Pullback Replay Parity v0.3.1 | VWAP Wave Pullback long bracket plan: session_profile=all_sessions hermes_profile=wave_pullback_configurable_targets hermes_action=configurable_tp_ladder_runner_slot_ratchet qty=3 bar_index=21375 bar_time=2026-04-06 23:50:00 entry=24318.75 stop=24257.00 risk=61.75 planned_risk=370.50 tick_size=0.2500 atr=17.8440 vwap=24301.3730 target1_r=1.00 target1=24380.50 qty1=0 target2_r=1.50 target2=24411.38 qty2=2 target3_r=2.00 target3=24442.25 qty3=0 target4_r=3.00 target4=24504.00 qty4=0 target5_r=4.00 target5=24565.75 qty5=1 target_stop_ratchet=yes target_stop_ratchet_trigger=slot4 target_stop_ratchet_stop=slot3 target_stop_ratchet_trigger_slot=4 target_stop_ratchet_stop_slot=3 target_stop_ratchet_hold_bars=2 target_stop_ratchet_vwap_trend=yes breakeven=no breakeven_mode=disabled breakeven_trigger_value=0.00 breakeven_offset_points=1.00 max_risk_dollars=400.00 schema=4 version=v0.3.1-runner-slot-ratchet",
  ].join("\n");
  const events = parseReplayMessageLogText(messageLogText);
  const settings = extractReplayStudySettings(events);
  const trades = buildReplayTradeLedger({ messageLogText, tradeLogBuffers: [], sourceFile: "fixture.log" });

  assert.equal(settings.version, "v0.3.1-runner-slot-ratchet");
  assert.equal(settings.tpSplit, "0/2/0/0/1");
  assert.equal(settings.targetRs, "1/1.5/2/3/4");
  assert.equal(settings.maxRiskDollars, 400);
  assert.equal(settings.targetStopRatchet, "yes");
  assert.equal(settings.targetStopRatchetTriggerSlot, 4);
  assert.equal(settings.targetStopRatchetStopSlot, 3);
  assert.equal(settings.targetStopRatchetHoldBars, 2);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].totalContracts, 3);
  assert.equal(trades[0].targetSplit, "2/1");
  assert.deepEqual(trades[0].targetRs, [1.5, 4]);
});

test("links Sierra market fills to the unique planned trade even when entry slips by more than a tick", () => {
  const trades = buildReplayTradeLedger({
    messageLogText: [
      "2026-05-24  11:53:47.890 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.10 | Hermes Profile: Warming Up | VWAP Momentum Reclaim short bracket plan: hermes_profile=Trend + Markov: Bear Continuation hermes_action=manual_tp_inputs qty=5 bar_index=81 bar_time=2026-05-24 16:30:00 entry=100.00 stop=105.00 target2=92.50 qty2=4 target3=86.25 qty3=1 schema=6 version=v2.1.10",
    ].join("\n"),
    tradeLogBuffers: [
      Buffer.from(
        "Auto-trade: Replay 960X: MNQM26_FUT_CME[M]  5 Min  #1 | Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.10 | Hermes Profile: Trend + Markov: Bear Continuation | SellEntry | Bar start date-time: 2026-05-24  16:30:00.000 | Last: 101.00 Simulated order accepted Trade simulation fill. Bid: 100.75 Ask: 101.00 Last: 101.00 j 10 k Marketl Trade simulation fill. Bid: 104.75 Ask: 105.00 Last: 105.00 j 11 k Stopl",
        "utf8",
      ),
    ],
    sourceFile: "fixture.log",
  });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entry, 101);
  assert.equal(trades[0].context.plannedEntryPrice, 100);
  assert.equal(trades[0].context.entrySlippagePoints, 1);
  assert.equal(trades[0].outcome.exitReason, "stop");
  assert.equal(trades[0].outcome.pnl, -40);
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
  assert.equal(artifactBundle.metadata.parsedTradeActivitySummary.replayFillCount, 2);
  assert.equal(artifactBundle.metadata.parsedTradeActivitySummary.replayExitFillCount, 1);
});

test("fails closed when an explicit replay Trade Activity Log path is missing", () => {
  const fixtureDir = "D:\\paperclip-codex\\connectors\\sierra-chart\\tests";
  assert.throws(() => buildReplayValidationArtifact({
    mode: "replay",
    messageLogPath: `${fixtureDir}\\replay-message.log`,
    tradeLogPaths: [`${fixtureDir}\\missing-replay-trade.log`],
    backtestJsonPath: `${fixtureDir}\\replay-backtest-fixture.json`,
  }), /missing Trade Activity Log path/i);
});

test("carries inferred effective replay start into validation metadata", () => {
  const fixtureDir = "D:\\paperclip-codex\\connectors\\sierra-chart\\tests";
  const artifactBundle = buildReplayValidationArtifact({
    mode: "replay",
    messageLogPath: `${fixtureDir}\\replay-message.log`,
    tradeLogPaths: [`${fixtureDir}\\replay-trade.log`],
    backtestJsonPath: `${fixtureDir}\\replay-backtest-fixture.json`,
    requestedStartDateTime: "2026-05-24 16:30:00",
    replaySpeed: "480X",
    controllerStatus: {
      status: {
        action: "start",
        requestedStartDateTime: "2026-05-24 16:30:00",
        currentChartDateTime: "2026-05-24 16:30:00",
      },
    },
    sourceFile: "D:\\paperclip-codex\\ocean-trading-strategies\\strategies\\OceanTrading.cpp",
  });

  assert.equal(artifactBundle.metadata.effectiveStartDateTime, "2026-05-24 16:30:00");
});

test("extracts and verifies Sierra-loaded study settings from replay logs", () => {
  const messageEvents = parseReplayMessageLogText([
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim input schema applied: schema=6 version=v2.1.9-high-quality-defensive-profile qty=5 max_trades_per_day=8 tp1=0 tp2=2 tp3=3 risk_cap=500.00 cooldown_bars=10 allow_longs=yes allow_shorts=yes allow_after_22_london=no confluence_enabled=yes confluence_mode=3 hermes_tp_adaptation=no holiday_force_flat=yes trading_enabled=yes",
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.9-high-quality-defensive-profile schema=6 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=8 risk_cap=500.00 tp_split=0/2/3 confluence_enabled=yes confluence_mode=3 hermes_tp_adaptation=no be_plus_one=yes cme_guard=yes holiday_force_flat=yes lucid_closeout=yes",
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
    confluenceMode: 3,
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
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim input schema applied: schema=6 version=v2.1.9-high-quality-defensive-profile qty=5 max_trades_per_day=8 tp1=0 tp2=2 tp3=3 risk_cap=500.00 cooldown_bars=10 allow_longs=yes allow_shorts=yes allow_after_22_london=no confluence_enabled=yes confluence_mode=3 hermes_tp_adaptation=no holiday_force_flat=yes trading_enabled=yes",
    "2026-05-25  14:30:34.065 | Chart: MNQM26_FUT_CME[M]  5 Min  #1 | Study: Ocean Trading VWAP Momentum Reclaim 2R Capped v2.1.9 | Hermes Profile: Warming Up | VWAP Momentum Reclaim startup audit: version=v2.1.9-high-quality-defensive-profile schema=6 chart=1 study_id=1 symbol=MNQM26_FUT_CME tick_size=0.2500 qty=5 max_trades_per_day=8 risk_cap=500.00 tp_split=0/2/3 confluence_enabled=yes confluence_mode=3 hermes_tp_adaptation=no be_plus_one=yes cme_guard=yes holiday_force_flat=yes lucid_closeout=yes",
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

test("reports replay/backtest PnL variation as a metric, not an acceptance gate", () => {
  const artifact = compareReplayToBacktest({
    strategy: "fixture",
    assumptions: {},
    replayEvents: [
      {
        entryKey: "2026-05-20T00:10",
        direction: "long",
        entry: 100,
        initialStop: 95,
        targetPlan: [],
        hermesAction: "manual_tp_inputs",
        outcome: { exitReason: "stop", pnl: -20 },
      },
    ],
    backtestTrades: [
      {
        entryKey: "2026-05-20T00:10",
        direction: "long",
        entry: 100,
        stop: 95,
        targets: [],
        hermesAction: "manual_tp_inputs",
        exitReason: "stop",
        pnl: -10,
      },
    ],
    tolerances: { entryPricePoints: 0, initialStopPoints: 0, targetPricePoints: 0, pnlDollars: 0 },
  });

  assert.equal(artifact.summary.pnl.replayNetPnl, -20);
  assert.equal(artifact.summary.pnl.backtestNetPnl, -10);
  assert.equal(artifact.summary.pnl.pnlVariationPct, -100);
  assert.equal(artifact.summary.mismatchCount, 1);
});

test("writes field-level mismatch details into the markdown artifact", () => {
  const fixtureDir = "D:\\paperclip-codex\\connectors\\sierra-chart\\tests";
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-validation-md-"));
  const outputMarkdownPath = path.join(outputDir, "validation.md");
  const backtestJsonPath = path.join(outputDir, "mismatched-backtest.json");
  fs.writeFileSync(backtestJsonPath, JSON.stringify({
    trades: [
      {
        entryKey: "2026-05-24T16:30",
        direction: "long",
        entry: 25077.5,
        initialStop: 25064.25,
        hermesProfile: "Dynamic Profile Map: Bull Continuation",
        targets: [
          { contracts: 2, r: 2.0, price: 25101.0 },
          { contracts: 3, r: 3.0, price: 25113.25 },
        ],
        hermesAction: "dynamic_profile_map",
        exitReason: "stop",
        pnl: -100.0,
      },
    ],
  }, null, 2));
  execFileSync(process.execPath, [
    "D:\\paperclip-codex\\connectors\\sierra-chart\\src\\replay-orchestration.mjs",
    "--mode",
    "replay",
    "--message-log",
    `${fixtureDir}\\replay-message.log`,
    "--trade-log",
    `${fixtureDir}\\replay-trade.log`,
    "--backtest-json",
    backtestJsonPath,
    "--output-md",
    outputMarkdownPath,
    "--requested-start",
    "2026-05-24 16:30:00",
    "--requested-end",
    "2026-05-24 16:35:00",
    "--speed",
    "960X",
  ], {
    cwd: "D:\\paperclip-codex",
    encoding: "utf8",
  });

  const rendered = fs.readFileSync(outputMarkdownPath, "utf8");
  assert.match(rendered, /## Mismatch Details/);
  assert.match(rendered, /entry: mismatch/);
  assert.match(rendered, /outcomePnl: mismatch/);
});

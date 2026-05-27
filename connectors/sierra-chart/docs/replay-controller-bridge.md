# Sierra Replay Controller Bridge

Status: feature branch scaffold, replay controller v0.1.11 compiled for replay instance on 2026-05-27.

## Purpose

The replay controller bridge removes brittle replay-window clicking from the
VWAP Momentum Reclaim validation loop. The Node connector writes an explicit
command file under the replay Sierra Chart root. A hidden ACSIL study loaded on
the replay chart reads that command and calls Sierra Chart replay functions from
inside Sierra Chart.

This bridge is for replay/simulation only. Do not load or enable it in live
Sierra Chart.

## Files

- Source: `D:\paperclip-codex\connectors\sierra-chart\studies\OceanTradingReplayController.cpp`
- Replay DLL: `D:\Trading\SierraChart-Replay\Data\OceanTradingReplayController_64.dll`
- Command file: `D:\Trading\SierraChart-Replay\connector-control\replay-command.json`
- Status file: `D:\Trading\SierraChart-Replay\connector-control\replay-status.json`

## One-Time Replay Setup

1. Start only the replay Sierra Chart instance:
   `D:\Trading\SierraChart-Replay\SierraChart_64.exe`
2. Open the replay chartbook:
   `D:\Trading\SierraChart-Replay\Data\OceanTrading-PaperTrading.cht`
3. Add custom study:
   `Ocean Trading Replay Controller v0.1.11`
4. Confirm the study input:
   `Enable Replay Controller = Yes`
5. Leave command/status path inputs blank unless a different replay-root child
   directory is needed. The default is `..\connector-control` relative to the
   replay Data folder.

## Connector Commands

Replay study presets live in:
`D:\paperclip-codex\connectors\sierra-chart\config\replay-study-presets.json`

Current keys:

- `v219_replay_alignment`
- `candidate_88`
- `candidate_98`

Write a status command:

```sh
node D:\paperclip-codex\connectors\sierra-chart\src\replay-orchestration.mjs ^
  --mode replay ^
  --controller-write-command ^
  --controller-action status ^
  --controller-command-id smoke-status-001 ^
  --speed 480X
```

Read status:

```sh
node D:\paperclip-codex\connectors\sierra-chart\src\replay-orchestration.mjs ^
  --mode replay ^
  --controller-read-status
```

Start a targeted replay:

```sh
node D:\paperclip-codex\connectors\sierra-chart\src\replay-orchestration.mjs ^
  --mode replay ^
  --study-preset candidate_88 ^
  --controller-write-command ^
  --controller-action start ^
  --controller-command-id may20-2300-001 ^
  --requested-start "2026-05-20 23:00:00" ^
  --speed 480X
```

Stop replay:

```sh
node D:\paperclip-codex\connectors\sierra-chart\src\replay-orchestration.mjs ^
  --mode replay ^
  --controller-write-command ^
  --controller-action stop ^
  --controller-command-id stop-001
```

## Verification Status

- Connector unit tests passed: `node --test connectors/sierra-chart/src/replay-orchestration.test.mjs`
- Boundary check passed with existing legacy warnings and no failures:
  `node connectors/validate-boundaries.mjs`
- ACSIL source compiled successfully to the replay Data folder.
- v0.1.10 waits for Sierra to report chart data loading complete before calling
  `StartChartReplayNew`, because Sierra can otherwise accept the call without
  actually entering replay mode.
- v0.1.11 treats Sierra `REPLAY_PAUSED = 2` as a blocked start state, resumes
  paused launches, and only acknowledges active `REPLAY_RUNNING = 1`.
- End-to-end replay control still requires the replay chartbook to be open and
  the controller study loaded/enabled. Until a fresh `replay-status.json`
  appears after a status command, the bridge has not completed its in-Sierra
  handshake.
- The connector must reject Sierra's blank `1899-12-30` replay date. If that
  appears in controller status or UI readback, stop the run and reset the Replay
  Chart start fields before comparing replay to backtest.
- When falling back to `scripts/start-replay-window.ps1`, the helper must handle
  Sierra's modal prompts before the replay is considered running:
  `Clear Trade Data` and `Enter Processing Step in Seconds`.

## VWAP Handoff

Hermes memory was updated before this bridge work started. VWAP Momentum
Reclaim replay can now be checked against a connector-owned preset instead of
manual note-taking:

- `v219_replay_alignment`: Sierra settings `qty=5`, `tp_split=0/2/3`,
  `max_trades_per_day=8`, `confluence_mode=4`, Hermes TP adaptation disabled,
  BE+1 enabled.
- `candidate_88`: replay target with `qty=5`, `tp_split=0/4/1`,
  `max_trades_per_day=3`.
- `candidate_98`: replay target with `qty=6`, `tp_split=1/2/3`,
  `max_trades_per_day=6`.

The remaining replay-alignment gap was missing expected May 21 and May 22
trades after otherwise close May 6/7/13/14/19/20 alignment.

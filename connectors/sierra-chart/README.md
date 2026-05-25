# Sierra Chart Connector Proposal

Status: active scaffold. Runtime use has started with shared Sierra instance/path resolution for the Ocean Trading website monitor.

This connector is intended to become the single Sierra Chart access point for Paperclip, Codex, Ocean Trading, and future agents.

The first implementation phase should be read-only. It should centralize Sierra instance paths, symbols, contract specs, trade-log discovery, DTC status snapshots, and historical-cache coverage before any execution, compile, or deployment behavior is moved.

## Design Goals

- Keep Sierra Chart paper and live integrations behind one boundary.
- Make paper trading the default for backtesting, paper monitoring, and strategy validation.
- Require explicit approval before any live trading path is used.
- Stop duplicating Sierra paths, DTC ports, symbol mappings, contract values, and TradeActivityLog parsing across scripts.
- Create the same connector shape that future TradingView or other platform connectors can follow.
- Keep the Ocean Trading website as a presentation and control layer, not the source of truth for Sierra state.

## Proposed Modules

```text
connectors/sierra-chart/
  CONNECTOR_CAPABILITIES.md
  README.md
  config/
    instances.json
    symbols.json
    instruments.json
  src/
    instance-registry/
    symbols/
    historical-data/
    trade-monitor/
    dtc/
    reconciliation/
    deployment/
  tests/
```

## Active Runtime Modules

- `src/instance-registry.mjs`: resolves paper/replay/live Sierra roots, symbols, chartbooks, and log folders. The Ocean Trading website monitor imports this module instead of owning its own Sierra path defaults.
- `src/replay-orchestration.mjs`: replay-safe validation helper that resolves replay environments, detects the correct Sierra process, documents the exact Sierra replay control surface, and normalizes replay logs into an exact closed-trade ledger.
- `src/replay-orchestration.mjs` also emits connector-owned replay validation artifacts when given explicit replay message/trade logs plus a matching backtest JSON.

## Migration Principle

Existing consumers should keep their current behavior while their Sierra access is replaced one capability at a time.

All new Sierra Chart behavior must be added here first. Existing dashboard Sierra access is legacy code and should only be touched to route through connector capabilities or to preserve current behavior during migration.

The safe order is:

1. Centralize config readers for paper/live roots, ports, symbols, and contract specs.
2. Centralize read-only status and cache coverage checks.
3. Centralize trade log discovery and parsing behind regression tests.
4. Centralize replay-safe orchestration and validation so Hermes/backtest parity work can target the replay instance without touching live.
5. Centralize DTC snapshot normalization.
6. Centralize historical SCID import and cached bar loading.
7. Centralize compile/deploy only after source-of-truth and Qwen review gates are working.
8. Add future platform connectors using the same shape.

## Replay Orchestration Notes

- Replay is a first-class environment label separate from paper and live.
- Live access remains blocked by default in connector helpers unless the caller passes an explicit approval gate.
- The replay module remains hard-blocked from live by default. It now emits the replay launch command plus the exact Sierra replay toolbar/window controls that must be used for start/stop/pause/resume, while still refusing blind live-path automation.
- Use the module directly when a follow-on agent needs a replay validation snapshot:

```sh
node connectors/sierra-chart/src/replay-orchestration.mjs --mode replay
```

- The JSON output includes the resolved instance, matching running processes, latest message/trade logs, normalized replay events, study catalog extracted from the strategy source, Sierra-loaded study settings, and a replay request/control plan with approved preset speeds only.
- The connector now includes an ACSIL bridge study at `connectors/sierra-chart/studies/OceanTradingReplayController.cpp`. Load it only in the replay Sierra Chart instance. Leave it disabled unless actively running replay-control tests.
- The ACSIL bridge watches `D:\Trading\SierraChart-Replay\connector-control\replay-command.json` and writes `D:\Trading\SierraChart-Replay\connector-control\replay-status.json`. The connector owns the command file; Sierra owns the status file.
- To write a replay start command for the bridge:

```sh
node connectors/sierra-chart/src/replay-orchestration.mjs ^
  --mode replay ^
  --controller-write-command ^
  --controller-action start ^
  --requested-start "2026-05-20 23:00:00" ^
  --speed 480X
```

- To read the bridge status:

```sh
node connectors/sierra-chart/src/replay-orchestration.mjs ^
  --mode replay ^
  --controller-read-status
```

- For targeted replay starts, pass the requested/effective start readback and the preset speed so the connector can fail closed on any mismatch:

```sh
node connectors/sierra-chart/src/replay-orchestration.mjs ^
  --mode replay ^
  --requested-start "2026-05-20 23:00:00" ^
  --effective-start "2026-05-20 23:00:00" ^
  --speed 480X
```

- To archive existing replay `Sim1.simulated` trade logs for a target window before a restart, call the exported `archiveReplayTradeLogs()` helper from `src/replay-orchestration.mjs`. It is hard-scoped to `D:\Trading\SierraChart-Replay`.
- To generate a replay-vs-backtest validation artifact instead of a raw snapshot:

```sh
node connectors/sierra-chart/src/replay-orchestration.mjs ^
  --mode replay ^
  --message-log "D:\Trading\SierraChart-Replay\Logs\Message Log 2026-05-24 133930.log" ^
  --trade-log "D:\Trading\SierraChart-Replay\TradeActivityLogs\TradeActivityLog_2026-05-04_UTC.Sim1.simulated.data" ^
  --trade-log "D:\Trading\SierraChart-Replay\TradeActivityLogs\TradeActivityLog_2026-05-05_UTC.Sim1.simulated.data" ^
  --backtest-json "D:\paperclip-codex\.paperclip-home\instances\default\projects\378244c6-8e72-41b2-a4ab-27e9cca17a04\b3e08754-f0f4-4860-bc06-2bf07c525baa\_default\strategies\backtest_outputs\vwap-momentum-reclaim-v2-cody-5m-results.json" ^
  --output-json "D:\paperclip-codex\reports\transient-builds\sierra-replay-validation.json" ^
  --output-md "D:\paperclip-codex\reports\transient-builds\sierra-replay-validation.md"
```

## Boundary Check

Run this before accepting Sierra-related changes:

```sh
node connectors/validate-boundaries.mjs
```

The check reports current legacy dashboard Sierra references as warnings. New Sierra-specific behavior should not be introduced outside `connectors/sierra-chart`.

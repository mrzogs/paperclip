# Sierra Chart Connector Capabilities

Status: active connector. Runtime capabilities now cover instance/path resolution, replay-safe control planning, replay UI helpers, ACSIL replay-controller bridge commands/status, replay log parsing, and replay-vs-backtest validation artifacts.

Every new Sierra Chart capability added to this connector must be documented here in the same change that adds it.

## Safety Defaults

- Paper trading path: `D:\Trading\SierraChart-PaperTrading`
- Replay path: `D:\Trading\SierraChart-Replay`
- Live trading path: `D:\Trading\SierraChart-LiveTrading`
- Backtesting and paper trading must use the paper path unless the user explicitly approves live data or live execution.
- Replay validation should use the replay path and explicit `replay` environment labels rather than overloading `paper`.
- Live trading actions must require explicit approval.
- Sierra Chart is the source of truth for fills, open positions, closed trades, account execution state, and chart-loaded strategy behavior.
- Ocean Trading SQLite is the website read model, not the primary execution truth.

## Proposed Capabilities

| Capability | Purpose | Current sources to consolidate | First phase |
|---|---|---|---|
| `get_instances` | Return configured paper/replay/live roots, symbols, chartbooks, executables, and log folders. | `connectors/sierra-chart/src/instance-registry.mjs`; used by `dashboard/monitor.mjs` | Active |
| `resolve_replay_environment` | Resolve explicit `paper`, `replay`, or `live` targets with live access blocked by default. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `detect_running_instances` | Detect local `SierraChart_64.exe` processes and map them to paper/replay/live roots. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `inspect_replay_logs` | Read Sierra replay Message Log and TradeActivityLog files and normalize Hermes profile, bracket-plan, and fill/order events. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `plan_replay_controls` | Emit replay-safe launch/control metadata for Sierra replay lifecycle actions, including exact toolbar/window controls, approved replay speeds, requested/effective start validation, and live blocked by default. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `start_replay_window_ui` | Replay-only PowerShell UI helper that opens Sierra's Replay Chart dialog, forces `Use Start Date-Time`, validates date/time/speed readback, rejects custom speeds, archives target-day trade logs when requested, clears persisted Start Paused, accepts Sierra's Clear Trade Data and Enter Processing Step prompts, resumes if paused, and refuses live roots. | `connectors/sierra-chart/scripts/start-replay-window.ps1` | Active |
| `write_replay_controller_command` | Write replay-only command JSON for the ACSIL Replay Controller bridge under the replay root. Supports start/stop/pause/resume/status and rejects non-preset speeds. | `connectors/sierra-chart/src/replay-orchestration.mjs`; `connectors/sierra-chart/studies/OceanTradingReplayController.cpp` | Active scaffold |
| `read_replay_controller_status` | Read and validate ACSIL Replay Controller status JSON so the connector can verify command id, action, requested start, speed, running state, and errors. | `connectors/sierra-chart/src/replay-orchestration.mjs`; `connectors/sierra-chart/studies/OceanTradingReplayController.cpp` | Active scaffold |
| `prepare_replay_state` | Archive target-range replay `Sim1.simulated` trade logs under the replay root before targeted reruns. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `verify_replay_study_settings` | Parse Sierra startup/input-schema audits and compare loaded study settings against the expected backtest harness configuration, including VWAP Wave target-stop ratchet trigger/stop slots. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `resolve_replay_study_preset` | Load connector-owned replay study presets so baseline/candidate replay runs verify against the intended study configuration. | `connectors/sierra-chart/src/replay-orchestration.mjs`; `connectors/sierra-chart/config/replay-study-presets.json` | Active |
| `build_replay_validation_artifact` | Emit connector-owned replay-vs-backtest JSON/markdown proof with DLL hash, replay safety metadata, exact Sierra-derived closed-trade rows, strict missing-expected-trade detection, and comparison status. | `connectors/sierra-chart/src/replay-orchestration.mjs` | Active |
| `resolve_symbol` | Resolve logical instrument and feed/provider mapping into Sierra data symbol, display symbol, and `.scid` path. | `update-sierra-symbol.mjs`, `sierra-symbols.json`, `confluence_strategy.yaml`, manual script args | Yes |
| `resolve_contract_specs` | Return tick size, tick value, point value, currency, and multiplier for a symbol. | `instrument-contracts.json`, `cache_platform.py`, `build-manifest.mjs`, `OceanTrading.cpp` helper | Yes |
| `list_trade_logs` | List Sierra TradeActivityLog files for paper/live, respecting clean-start and excluded-file rules. | `monitor.mjs`, `build-manifest.mjs` | Yes |
| `read_monitor_status` | Return whether local monitor, Sierra logs, and DTC snapshots are current. | `monitor-state.json`, `/api/monitor/status`, `dtc-position-snapshot.json` | Yes |
| `snapshot_dtc` | Connect to Sierra DTC and return normalized status, positions, balances, and errors. | `dtc-snapshot.mjs`, manifest DTC readers | Later |
| `parse_trade_logs` | Parse TradeActivityLogs into normalized fill/order events. | `build-manifest.mjs` paper/live parsing functions | Later |
| `reconcile_trades` | Reconcile DTC positions, log-derived fills, closed trades, account monitor values, and website read model rows. | `build-manifest.mjs` reconciliation functions | Later |
| `ensure_historical_range` | Check whether requested historical data is already cached; import only missing ranges. | `cache_platform.py ensure-range`, website cache endpoints | Later |
| `import_scid` | Import Sierra `.scid` records into the historical SQLite cache. | `cache_platform.py import-scid` | Later |
| `load_bars` | Load normalized bars for backtesting/confluence from cached data. | `cache_platform.py load_bars`, `paperclip/data/sqlite_loader.py` | Later |
| `repair_ohlc` | Repair known invalid OHLC values in cached bars. | `cache_platform.py repair-ohlc` | Later |
| `update_symbol_mapping` | Update Sierra symbol config after feed/provider/account changes and emit derived config updates. | `update-sierra-symbol.mjs` | Later |
| `read_study_catalog` | Identify Sierra/Ocean Trading loaded study names and strategy catalog entries where available. | `parseSierraStudyCatalog()` in `build-manifest.mjs` | Later |
| `compile_strategy` | Run strategy compile preflight and Sierra ACSIL compile. | `VisualCCompile.Bat`, `OceanTradingPreflight.ps1`, strategy template docs | Later |
| `deploy_strategy` | Deploy reviewed source/DLL to paper or live Sierra instance with approval gates. | strategy repo sync scripts, manual copy/deploy flow | Later |

## Required Tests Before Moving Behavior

- Symbol mapping preserves current `MNQM26_FUT_CME[M]` paper behavior.
- Paper/live roots cannot be accidentally swapped.
- Replay must resolve as its own environment label and must not be inferred as live.
- Live path access is blocked unless explicitly approved.
- Contract specs match current website/backtest values for MNQ, NQ, MES, ES, MCL, CL, MGC, and GC.
- Trade log discovery returns the same files currently watched by the monitor.
- Replay process detection must choose the instance whose executable path matches the replay root when that process exists.
- Replay controller commands must only be written under `D:\Trading\SierraChart-Replay\connector-control` or an explicitly configured replay-root child directory.
- Replay controller commands must reject custom speed values such as `5000`; only Sierra dropdown presets are allowed.
- Replay run requests and controller validation must reject or flag Sierra's blank `1899-12-30` replay date; unattended replay validation cannot proceed from blank/stale starts.
- The replay UI helper must automatically handle Sierra modal prompts that block start, including `Clear Trade Data` and `Enter Processing Step in Seconds`.
- The ACSIL Replay Controller study must be loaded only on the replay instance and must remain disabled by default until an operator enables it for replay testing.
- Replay message-log parsing must normalize Hermes profile switches and bracket plans into machine-readable events.
- Replay validation artifact generation must work from explicit message/trade log file paths and compare normalized replay rows against a provided backtest artifact.
- Replay trade ledger generation must derive closed-trade exit reason and PnL from Sierra TradeActivity fills instead of leaving replay outcomes reconstructed or null.
- DTC unavailable states are represented without inventing balances.
- Historical cache coverage reports match the current `cache_platform.py info` output.

## Qwen Review Requirement

Before behavior moves into this connector:

1. Ask Qwen to review the architecture and migration step.
2. Implement the smallest safe change.
3. Run tests.
4. Run Qwen diff review:

```sh
python paperclip_ai_review/review.py main
python paperclip_ai_review/recurring_issues.py
```

If Qwen returns `fail`, revise before accepting the change.

## Connector Boundary Rule

No new Sierra Chart path, DTC, TradeActivityLog, SCID, compile, deploy, symbol, account, or order behavior should be implemented outside `connectors/sierra-chart`.

Before accepting Sierra-related changes, run:

```sh
node connectors/validate-boundaries.mjs
```

The current dashboard Sierra code is known legacy and should be migrated into this connector capability-by-capability. The rule for new work is stricter: add the capability here, document it in this file, then update consumers to call the connector.

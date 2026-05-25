import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LIVE_ROOT = "D:\\Trading\\SierraChart-LiveTrading";
export const DEFAULT_PAPER_ROOT = "D:\\Trading\\SierraChart-PaperTrading";
export const DEFAULT_REPLAY_ROOT = "D:\\Trading\\SierraChart-Replay";
export const DEFAULT_PAPER_SYMBOL = "MNQM26_FUT_CME";
export const DEFAULT_PAPER_DISPLAY_SYMBOL = "MNQM26_FUT_CME[M]";

export function executablePath(instance) {
  return instance.executablePath || path.join(instance.root, "SierraChart_64.exe");
}

export function dataDir(instance) {
  return instance.dataFolder || path.join(instance.root, "Data");
}

export function tradeActivityLogDir(instance) {
  return instance.tradeActivityLogDir || path.join(instance.root, "TradeActivityLogs");
}

export function logsDir(instance) {
  return instance.logsDir || path.join(instance.root, "Logs");
}

export function chartbookPath(instance) {
  return instance.chartbook || path.join(dataDir(instance), "OceanTrading-PaperTrading.cht");
}

function buildFallback() {
  const paper = {
    root: DEFAULT_PAPER_ROOT,
    symbol: DEFAULT_PAPER_SYMBOL,
    displaySymbol: DEFAULT_PAPER_DISPLAY_SYMBOL,
  };
  return {
    live: { root: DEFAULT_LIVE_ROOT },
    paper,
    replay: {
      ...paper,
      root: DEFAULT_REPLAY_ROOT,
    },
  };
}

export function readSierraInstances(options = {}) {
  const fallback = buildFallback();
  const configuredDirect = options.config;
  if (configuredDirect && typeof configuredDirect === "object") {
    return {
      ...fallback,
      ...configuredDirect,
      live: { ...fallback.live, ...(configuredDirect.live || {}) },
      paper: { ...fallback.paper, ...(configuredDirect.paper || {}) },
      replay: { ...fallback.replay, ...(configuredDirect.replay || {}) },
    };
  }
  const configFile = options.configFile;
  if (!configFile || !fs.existsSync(configFile)) return fallback;
  try {
    const configured = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
    return {
      ...fallback,
      ...configured,
      live: { ...fallback.live, ...(configured.live || {}) },
      paper: { ...fallback.paper, ...(configured.paper || {}) },
      replay: { ...fallback.replay, ...(configured.replay || {}) },
    };
  } catch (error) {
    return {
      ...fallback,
      warning: `Could not read Sierra instance config ${configFile}: ${error?.message || error}`,
    };
  }
}

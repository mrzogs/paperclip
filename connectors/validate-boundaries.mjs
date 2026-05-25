import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const connectorRoot = path.join(repoRoot, "connectors");
const sierraConnector = path.join(connectorRoot, "sierra-chart");
const emailConnector = path.join(connectorRoot, "email");

const scanRoots = [
  connectorRoot,
  path.join(repoRoot, ".paperclip-home", "instances", "default", "projects", "378244c6-8e72-41b2-a4ab-27e9cca17a04", "b3e08754-f0f4-4860-bc06-2bf07c525baa", "_default", "dashboard"),
  path.join(repoRoot, ".paperclip-home", "instances", "default", "projects", "378244c6-8e72-41b2-a4ab-27e9cca17a04", "b3e08754-f0f4-4860-bc06-2bf07c525baa", "_default", "strategies", "Ocean Trading"),
];

const textExtensions = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".html",
  ".css",
]);

const codeExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const implementationExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml", ".yml"]);

const sierraLegacyAllowlist = [
  path.join(repoRoot, ".paperclip-home", "instances", "default", "projects", "378244c6-8e72-41b2-a4ab-27e9cca17a04", "b3e08754-f0f4-4860-bc06-2bf07c525baa", "_default", "dashboard"),
  path.join(repoRoot, ".paperclip-home", "instances", "default", "projects", "378244c6-8e72-41b2-a4ab-27e9cca17a04", "b3e08754-f0f4-4860-bc06-2bf07c525baa", "_default", "strategies", "Ocean Trading"),
];

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "data"].includes(entry.name)) continue;
      files.push(...walk(fullPath));
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

const files = [...new Set(scanRoots.flatMap(walk))];
const failures = [];
const warnings = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const extension = path.extname(file).toLowerCase();
  const isCode = codeExtensions.has(extension);
  const isImplementationSurface = implementationExtensions.has(extension);
  const inEmailConnector = isInside(file, emailConnector);
  const inSierraConnector = isInside(file, sierraConnector);
  const isBoundaryChecker = file === fileURLToPath(import.meta.url);

  if (!inEmailConnector && !isBoundaryChecker && isCode && /function\s+buildClosedTradeEmail\s*\(|export\s+function\s+buildClosedTradeEmail\s*\(/.test(text)) {
    failures.push(`${rel(file)} implements closed-trade email templating outside connectors/email.`);
  }

  if (!inEmailConnector && !isBoundaryChecker && isCode && /\b(nodemailer|createTransport|gmail\.users\.messages\.send)\b/i.test(text)) {
    failures.push(`${rel(file)} appears to introduce direct email delivery outside connectors/email.`);
  }

  if (!inSierraConnector && !isBoundaryChecker && isImplementationSurface && /(D:\\Trading\\SierraChart|TradeActivityLog_|DTC_MESSAGE_TYPES|SierraChart_64|\.scid\b)/i.test(text)) {
    const allowedLegacy = sierraLegacyAllowlist.some((allowed) => isInside(file, allowed));
    if (allowedLegacy) {
      warnings.push(`${rel(file)} still contains legacy Sierra access that should migrate into connectors/sierra-chart.`);
    } else if (!inEmailConnector) {
      failures.push(`${rel(file)} contains Sierra access outside connectors/sierra-chart.`);
    }
  }
}

console.log(JSON.stringify({
  checkedAtUtc: new Date().toISOString(),
  status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
  failures,
  warnings,
}, null, 2));

process.exit(failures.length ? 1 : 0);

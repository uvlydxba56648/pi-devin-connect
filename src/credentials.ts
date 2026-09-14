import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const CREDENTIALS_PATH = join(homedir(), ".local/share/devin/credentials.toml");
export const BASE_URL = "https://server.codeium.com";

export interface DevinCreds {
  token: string;
  apiServerUrl: string;
}

function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** The Connect API key is `devin-session-token$` + web-session JWT — the CLI
 * itself rewrites credentials.toml into this form (observed: it migrated a
 * bare JWT on first run). Bare JWTs are rejected as "invalid api key". */
export function normalizeToken(token: string): string {
  const t = token.trim();
  if (t.startsWith("devin-session-token$")) return t;
  if (t.startsWith("eyJ")) return `devin-session-token$${t}`;
  return t;
}

let tokenOverride: string | null = null;

/** Pi OAuth credentials (auth.json) resolved by the provider layer arrive as
 * options.apiKey; stash them here so requireToken() sees them process-wide. */
export function setTokenOverride(token: string | null): void {
  tokenOverride = token?.trim() ? normalizeToken(token.trim()) : null;
}

export function readCredentials(): DevinCreds | null {
  const fromEnv = process.env.DEVIN_TOKEN || process.env.WINDSURF_API_KEY;
  if (fromEnv?.trim()) {
    return { token: normalizeToken(fromEnv.trim()), apiServerUrl: BASE_URL };
  }
  if (tokenOverride) {
    return { token: tokenOverride, apiServerUrl: BASE_URL };
  }
  if (!existsSync(CREDENTIALS_PATH)) return null;
  const raw = parseTomlStrings(readFileSync(CREDENTIALS_PATH, "utf8"));
  const token = raw.windsurf_api_key || raw.api_key;
  if (!token) return null;
  return {
    token: normalizeToken(token),
    apiServerUrl: (raw.api_server_url || BASE_URL).replace(/\/$/, ""),
  };
}

/** Persist a token into the Devin CLI credentials file so `devin` CLI and pi
 * share one credential. Preserves existing fields, updates windsurf_api_key
 * (or api_key) in place. */
function upsertToml(text: string, key: string, value: string): string {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)".*"$`, "m");
  if (re.test(text)) return text.replace(re, `$1"${value}"`);
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed ? "\n" : ""}${key} = "${value}"\n`;
}

export function writeCredentialsToml(
  token: string,
  extra?: { apiServerUrl?: string; webappHost?: string; apiUrl?: string },
): void {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  let next = "";
  try {
    next = readFileSync(CREDENTIALS_PATH, "utf8");
  } catch {
    // missing file is fine
  }
  const stored = normalizeToken(token);
  if (/^\s*api_key\s*=/m.test(next) && !/^\s*windsurf_api_key\s*=/m.test(next)) {
    next = upsertToml(next, "api_key", stored);
  } else {
    next = upsertToml(next, "windsurf_api_key", stored);
  }
  next = upsertToml(next, "api_server_url", extra?.apiServerUrl || BASE_URL);
  if (extra?.webappHost) next = upsertToml(next, "devin_webapp_host", extra.webappHost.replace(/^https?:\/\//, ""));
  if (extra?.apiUrl) next = upsertToml(next, "devin_api_url", extra.apiUrl);
  writeFileSync(CREDENTIALS_PATH, next, { mode: 0o600 });
}

/** Captured from devin 3000.10.21: ide_name/extension_name/ide_type =
 * "chisel"; os = the real platform ("linux" on this box, "mac" on darwin). */
export const CLIENT_NAME = process.env.DEVIN_CLIENT_NAME || "chisel";

function detectClientOs(): string {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
export const CLIENT_OS = process.env.DEVIN_CLIENT_OS || detectClientOs();
export const DEFAULT_CLIENT_VERSION = "3000.2.17";

let detectedClientVersion: string | null = null;

export function clientVersion(): string {
  if (process.env.DEVIN_CLIENT_VERSION) return process.env.DEVIN_CLIENT_VERSION;
  if (detectedClientVersion) return detectedClientVersion;
  // Report the actually-installed CLI version — ~/.local/share/devin/cli/
  // _versions/current is a symlink to e.g. 3000.10.21. A stale hardcoded
  // version looks more like a spoof than an up-to-date chisel.
  try {
    const current = realpathSync(join(homedir(), ".local/share/devin/cli/_versions/current"));
    const v = basename(current);
    if (/^\d+\.\d+\.\d+$/.test(v)) detectedClientVersion = v;
  } catch {
    // CLI not installed — fall through to the captured default.
  }
  return detectedClientVersion || DEFAULT_CLIENT_VERSION;
}

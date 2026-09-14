// Devin CLI auth flow, reconstructed from the chisel binary (3000.10.21):
//
//   URL  https://app.devin.ai/auth/cli/continue
//          ?state=<uuid>&prompt=select_account
//          &code_challenge=<b64url(sha256(verifier))>&code_challenge_method=S256
//          &cli_pkce_marker=1
//   (no redirect_uri -> page displays a code for manual paste)
//
//   POST https://api.devin.ai/auth/cli/token   {"code","code_verifier"}
//   ->  {"token"|"api_key"|"access_token": "devin-session-token$..."}
//
// Verified live: empty JSON body -> 422 listing required fields
// [code, code_verifier]; bogus code -> "Invalid or expired code".

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  EXCHANGE_DEVIN_CLI_PKCE,
  EXCHANGE_PKCE_AUTH_CODE,
  GET_USER_STATUS,
  buildMetadata,
  connectUnary,
} from "./connect.js";
import { BASE_URL, clientVersion } from "./credentials.js";
import { log } from "./log.js";
import { encodeMessage, encodeString, fieldBuf, fieldInt, fieldString, iterFields } from "./proto.js";

export const DEVIN_WEBAPP_URL = "https://app.devin.ai";
export const DEVIN_API_URL = "https://api.devin.ai";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, state: randomUUID() };
}

/** Manual-paste variant of the CLI browser flow: no redirect_uri, so the
 * sign-in page renders the authorization code for the user to copy. */
export function buildAuthUrl(challenge: string, state: string): string {
  return (
    `${DEVIN_WEBAPP_URL}/auth/cli/continue` +
    `?state=${state}` +
    `&prompt=select_account` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&cli_pkce_marker=1`
  );
}

function looksLikeApiKey(value: string): boolean {
  // Connect API key = "devin-session-token$" + JWT (normalizeToken adds the
  // prefix downstream), or a bare non-JWT key. A short pasted auth code is
  // NOT a key — it must go through the Exchange* RPCs.
  if (value.startsWith("devin-session-token$")) return true;
  if (value.startsWith("eyJ") && value.length > 100) return true; // session JWT
  return /^[0-9a-f]{40,}$/i.test(value);
}

function protoStrings(buf: Buffer): Record<number, string> {
  const out: Record<number, string> = {};
  for (const f of iterFields(buf)) {
    const s = fieldString(f);
    if (s) out[f.num] = s;
  }
  return out;
}

export interface ExchangedCreds {
  token: string;
  apiServerUrl?: string;
  webappHost?: string;
  apiUrl?: string;
  name?: string;
}

/** Exchange the browser-pasted authorization code for a Connect API key.
 *
 * Do NOT use POST api.devin.ai/auth/cli/token — that returns a web-session
 * JWT which server.codeium.com rejects as "invalid api key". The CLI talks
 * to SeatManagementService:
 *   ExchangePKCEAuthorizationCode → api_key (+ api_server_url, hosts)
 *   ExchangeDevinCLIPKCECode     → session_token (fallback)
 */
export async function resolvePastedToToken(pasted: string, verifier: string, signal?: AbortSignal): Promise<string> {
  return (await exchangeAuthCode(pasted, verifier, signal)).token;
}

export async function exchangeAuthCode(pasted: string, verifier: string, signal?: AbortSignal): Promise<ExchangedCreds> {
  const trimmed = pasted.trim();
  if (!trimmed) throw new Error("empty code");
  if (looksLikeApiKey(trimmed) && !trimmed.includes(" ") && !trimmed.includes(".")) {
    return { token: trimmed };
  }

  const noAuth = { scheme: "none" as const, baseUrl: BASE_URL };
  const pkceBody = Buffer.concat([encodeString(1, trimmed), encodeString(2, verifier)]);

  // 1) Windsurf/Codeium PKCE → api_key (this is what credentials.toml stores)
  try {
    const t0 = Date.now();
    const raw = await connectUnary(EXCHANGE_PKCE_AUTH_CODE, pkceBody, signal, noAuth);
    const fields = protoStrings(raw);
    log("auth", "exchange-pkce", { ms: Date.now() - t0, fields: Object.keys(fields), apiKeyLen: fields[1]?.length });
    if (fields[1] && looksLikeApiKey(fields[1])) {
      return {
        token: fields[1],
        name: fields[2],
        apiServerUrl: fields[3],
        webappHost: fields[4],
        apiUrl: fields[5],
      };
    }
    if (fields[1]) {
      log("auth", "exchange-pkce-unexpected", { prefix: fields[1].slice(0, 20) });
    }
  } catch (error) {
    log("auth", "exchange-pkce-fail", { err: String(error).slice(0, 300) });
  }

  // 2) Devin CLI PKCE → session_token. Only accept if it looks like an API key,
  // not a web JWT.
  try {
    const t0 = Date.now();
    const raw = await connectUnary(EXCHANGE_DEVIN_CLI_PKCE, pkceBody, signal, noAuth);
    const fields = protoStrings(raw);
    log("auth", "exchange-cli-pkce", { ms: Date.now() - t0, fields: Object.keys(fields), tokenLen: fields[1]?.length });
    if (fields[1] && looksLikeApiKey(fields[1])) {
      // JWT session_token is fine — normalizeToken() prefixes it into the
      // devin-session-token$<jwt> form server.codeium.com accepts.
      return { token: fields[1], webappHost: fields[2], apiUrl: fields[3] };
    }
  } catch (error) {
    log("auth", "exchange-cli-pkce-fail", { err: String(error).slice(0, 300) });
    throw error;
  }

  throw new Error("token exchange returned no api_key");
}

// ---------- GetUserStatus → account/plan summary ----------

export interface DevinAccountInfo {
  name?: string;
  email?: string;
  pro?: boolean;
  teamId?: string;
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  isEnterprise?: boolean;
  orgId?: string;
  accountDisplayName?: string;
  canUseCli?: boolean;
  // plan_status
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  availableFlexCredits?: number;
  usedPromptCredits?: number;
  usedFlowCredits?: number;
  usedFlexCredits?: number;
  dailyQuotaRemainingPercent?: number;
  weeklyQuotaRemainingPercent?: number;
  dailyQuotaResetAtUnix?: number;
  weeklyQuotaResetAtUnix?: number;
  acuConsumed?: number;
  acuLimit?: number;
}

function fieldDouble(value: unknown): number | undefined {
  return Buffer.isBuffer(value) && value.length === 8 ? value.readDoubleLE(0) : undefined;
}

/** int32/int64 fields arrive as unsigned varints; -1 (unlimited sentinel)
 * shows up as 2^64-1. Decode two's-complement signed. */
function fieldSignedInt(f: { value: unknown }): number | undefined {
  if (typeof f.value !== "bigint") return undefined;
  const v = f.value >= 1n << 63n ? f.value - (1n << 64n) : f.value;
  return Number(v);
}

function fmtCredits(n: number | undefined): string {
  if (n == null) return "?";
  return n < 0 ? "unlimited" : String(n);
}

export function parseUserStatus(buf: Buffer): DevinAccountInfo {
  const info: DevinAccountInfo = {};
  let userStatus: Buffer | undefined;
  let planInfo: Buffer | undefined;
  for (const f of iterFields(buf)) {
    if (f.num === 1) userStatus = fieldBuf(f);
    if (f.num === 2) planInfo = fieldBuf(f);
  }
  if (userStatus) {
    let planStatus: Buffer | undefined;
    for (const f of iterFields(userStatus)) {
      if (f.num === 1) info.pro = f.value === 1n || f.value === true;
      if (f.num === 3) info.name = fieldString(f);
      if (f.num === 5) info.teamId = fieldString(f);
      if (f.num === 7) info.email = fieldString(f);
      if (f.num === 13) planStatus = fieldBuf(f);
      if (f.num === 28) info.usedPromptCredits = fieldSignedInt(f);
      if (f.num === 29) info.usedFlowCredits = fieldSignedInt(f);
    }
    if (planStatus) {
      for (const f of iterFields(planStatus)) {
        if (f.num === 4) info.availableFlexCredits = fieldSignedInt(f);
        if (f.num === 5) info.usedFlowCredits = fieldSignedInt(f);
        if (f.num === 6) info.usedPromptCredits = fieldSignedInt(f);
        if (f.num === 7) info.usedFlexCredits = fieldSignedInt(f);
        if (f.num === 8) info.availablePromptCredits = fieldSignedInt(f);
        if (f.num === 9) info.availableFlowCredits = fieldSignedInt(f);
        if (f.num === 14) info.dailyQuotaRemainingPercent = fieldInt(f);
        if (f.num === 15) info.weeklyQuotaRemainingPercent = fieldInt(f);
        if (f.num === 17) info.dailyQuotaResetAtUnix = fieldInt(f);
        if (f.num === 18) info.weeklyQuotaResetAtUnix = fieldInt(f);
        if (f.num === 19) info.acuConsumed = fieldDouble(f.value);
        if (f.num === 20) info.acuLimit = fieldDouble(f.value);
      }
    }
  }
  if (planInfo) {
    let devinInfo: Buffer | undefined;
    for (const f of iterFields(planInfo)) {
      if (f.num === 2) info.planName = fieldString(f);
      if (f.num === 12) info.monthlyPromptCredits = fieldSignedInt(f);
      if (f.num === 13) info.monthlyFlowCredits = fieldSignedInt(f);
      if (f.num === 16) info.isEnterprise = f.value === 1n || f.value === true;
      if (f.num === 33) devinInfo = fieldBuf(f);
    }
    if (devinInfo) {
      for (const f of iterFields(devinInfo)) {
        if (f.num === 2) info.canUseCli = f.value === 1n || f.value === true;
        if (f.num === 4) info.orgId = fieldString(f);
        if (f.num === 8) info.accountDisplayName = fieldString(f);
      }
    }
  }
  return info;
}

export async function fetchAccountInfo(token: string, signal?: AbortSignal): Promise<DevinAccountInfo> {
  const body = encodeMessage(1, buildMetadata(token));
  const raw = await connectUnary(GET_USER_STATUS, body, signal, { token, scheme: "basic" });
  return parseUserStatus(raw);
}

export function formatAccountInfo(info: DevinAccountInfo): string[] {
  const lines: string[] = [];
  const who = info.accountDisplayName || info.name || info.email;
  if (who) lines.push(`Account: ${who}${info.email && info.email !== who ? ` <${info.email}>` : ""}`);
  const planBits: string[] = [];
  if (info.planName) planBits.push(info.planName);
  if (info.pro) planBits.push("pro");
  if (info.isEnterprise) planBits.push("enterprise");
  if (planBits.length) lines.push(`Plan: ${planBits.join(" · ")}`);
  if (info.orgId) lines.push(`Org: ${info.orgId}`);
  if (info.acuLimit || info.acuConsumed) {
    const pct = info.acuLimit ? Math.round((info.acuConsumed! / info.acuLimit) * 100) : 0;
    lines.push(`ACU: ${info.acuConsumed?.toFixed(1) ?? "0"} / ${info.acuLimit ?? "?"} (${pct}% used)`);
  }
  if (info.dailyQuotaRemainingPercent != null || info.weeklyQuotaRemainingPercent != null) {
    const parts = [];
    if (info.dailyQuotaRemainingPercent != null) parts.push(`daily ${info.dailyQuotaRemainingPercent}% left`);
    if (info.weeklyQuotaRemainingPercent != null) parts.push(`weekly ${info.weeklyQuotaRemainingPercent}% left`);
    lines.push(`Quota: ${parts.join(", ")}`);
  }
  const credits: string[] = [];
  if (info.availablePromptCredits != null) credits.push(`prompt ${fmtCredits(info.availablePromptCredits)}`);
  if (info.availableFlowCredits != null) credits.push(`flow ${fmtCredits(info.availableFlowCredits)}`);
  if (info.availableFlexCredits != null) credits.push(`flex ${fmtCredits(info.availableFlexCredits)}`);
  if (credits.length) lines.push(`Credits: ${credits.join(" / ")}`);
  if (info.monthlyPromptCredits != null || info.monthlyFlowCredits != null) {
    lines.push(
      `Monthly: prompt ${fmtCredits(info.monthlyPromptCredits)} / flow ${fmtCredits(info.monthlyFlowCredits)}`,
    );
  }
  const resets: string[] = [];
  if (info.dailyQuotaResetAtUnix) resets.push(`daily resets ${new Date(info.dailyQuotaResetAtUnix * 1000).toLocaleString()}`);
  if (info.weeklyQuotaResetAtUnix) resets.push(`weekly resets ${new Date(info.weeklyQuotaResetAtUnix * 1000).toLocaleString()}`);
  if (resets.length) lines.push(resets.join(" · "));
  return lines;
}

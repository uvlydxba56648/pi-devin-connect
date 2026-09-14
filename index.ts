import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CLIENT_NAME, CLIENT_OS, CREDENTIALS_PATH, readCredentials, setTokenOverride, writeCredentialsToml } from "./src/credentials.js";
import { clientVersion } from "./src/credentials.js";
import { FALLBACK_MODELS, listCliModels, toProviderModels } from "./src/catalog.js";
import { streamDevin } from "./src/stream.js";
import { buildAuthUrl, exchangeAuthCode, fetchAccountInfo, formatAccountInfo, generatePkce } from "./src/auth.js";
import { log, logPath } from "./src/log.js";

const PROVIDER_ID = "devin";

const devinOAuth = {
  name: "Devin",
  isSubscription: true,
  /** Paste-code flow: show the CLI continue URL, user signs in, page shows a
   * code, we exchange it via SeatManagementService ExchangePKCEAuthorizationCode
   * /ExchangeDevinCLIPKCECode on server.codeium.com for a Connect API key. */
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { verifier, challenge, state } = generatePkce();
    callbacks.onAuth({
      url: buildAuthUrl(challenge, state),
      instructions:
        "Open the URL in your browser, sign in to Devin, then copy the code shown on the page and paste it below.",
    });
    const pasted = await callbacks.onPrompt({
      message: "Paste the authorization code shown on the Devin sign-in page:",
      placeholder: "code",
    });
    callbacks.onProgress?.("Exchanging authorization code…");
    const exchanged = await exchangeAuthCode(pasted, verifier, callbacks.signal);
    setTokenOverride(exchanged.token);
    callbacks.onProgress?.("Verifying account…");
    try {
      const info = await fetchAccountInfo(exchanged.token, callbacks.signal);
      const who = info.accountDisplayName || info.name || info.email || "";
      if (who) callbacks.onProgress?.(`Verified: ${who}`);
    } catch {
      // verification is best-effort; token itself is the credential
    }
    try {
      writeCredentialsToml(exchanged.token, {
        apiServerUrl: exchanged.apiServerUrl,
        webappHost: exchanged.webappHost,
        apiUrl: exchanged.apiUrl,
      });
    } catch (error) {
      log("auth", "credentials-write-fail", { err: String(error).slice(0, 200) });
    }
    return {
      // Devin session tokens are long-lived; no refresh endpoint exists.
      access: exchanged.token,
      refresh: exchanged.token,
      expires: Number.MAX_SAFE_INTEGER,
    };
  },
  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return credentials;
  },
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};

function register(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin",
    api: "devin-connect",
    baseUrl: "https://server.codeium.com",
    apiKey: "devin-cli",
    models,
    streamSimple: streamDevin,
    oauth: devinOAuth,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const t0 = Date.now();
  register(pi, FALLBACK_MODELS);
  log("ext", "loaded", { log: logPath() });

  try {
    if (readCredentials()) {
      const catalog = await listCliModels();
      const models = toProviderModels(catalog);
      if (models.length > 0) register(pi, models);
      log("ext", "catalog-ready", { models: models.length, ms: Date.now() - t0 });
    } else {
      log("ext", "no-credentials", {});
    }
  } catch (error) {
    log("ext", "catalog-fail", { err: String(error).slice(0, 300) });
    // keep fallback
  }

  pi.registerCommand("devin-status", {
    description: "Show Devin auth, plan/quota, and catalog status",
    handler: async (_args, ctx) => {
      const creds = readCredentials();
      const version = clientVersion();
      const lines: string[] = [
        creds ? "Auth: Devin CLI credentials.toml / OAuth" : `Auth: missing ${CREDENTIALS_PATH}`,
        `Client: ${CLIENT_NAME} ${version} / ${CLIENT_OS}`,
        "Upstream: Connect RPC GetChatMessage (no local proxy)",
      ];
      try {
        if (creds) {
          const info = await fetchAccountInfo(creds.token);
          lines.push(...formatAccountInfo(info));
          const models = await listCliModels();
          lines.push(`Catalog: ${models.length} upstream variants -> ${toProviderModels(models).length} pi models`);
        }
      } catch (error) {
        lines.push(`status error: ${error instanceof Error ? error.message : String(error)}`);
      }
      ctx.ui.notify(lines.join("\n"), creds ? "info" : "warning");
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin model catalog from GetCliModelConfigs",
    handler: async (_args, ctx) => {
      try {
        const catalog = await listCliModels();
        const models = toProviderModels(catalog);
        register(pi, models);
        ctx.ui.notify(
          `Devin: ${catalog.length} upstream variants -> ${models.length} pi models (thinking levels grouped).`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

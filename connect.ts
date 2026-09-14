import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { encodeBool, encodeMessage, encodeString, encodeVarintField } from "./proto.js";
import { BASE_URL, CLIENT_NAME, CLIENT_OS, clientVersion, readCredentials } from "./credentials.js";
import { log } from "./log.js";

export const GET_CHAT = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const GET_CLI_MODELS = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const ASSIGN_MODEL = "/exa.api_server_pb.ApiServerService/AssignModel";
export const GET_USER_STATUS = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const EXCHANGE_DEVIN_CLI_PKCE = "/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
export const EXCHANGE_PKCE_AUTH_CODE = "/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
export const GET_PRIMARY_API_KEY = "/exa.seat_management_pb.SeatManagementService/GetPrimaryApiKeyForDevsOnly";

// ---------------------------------------------------------------------------
// Proxy support. node:https ignores HTTP(S)_PROXY env; Devin CLI (reqwest)
// honors it and is materially faster here (direct path is lossy/high-RTT).
// We tunnel via HTTP CONNECT (or SOCKS5 for socks5:// proxies) inside the
// Agent's createConnection, so keep-alive pooling still applies on top.
// ---------------------------------------------------------------------------

function noProxyMatch(host: string): boolean {
  const raw = process.env.DEVIN_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (!raw) return false;
  const h = host.toLowerCase();
  for (const entry of raw.split(",")) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    const name = e.replace(/:\d+$/, "").replace(/^\./, "");
    if (h === name || h.endsWith("." + name)) return true;
  }
  return false;
}

export function proxyUrlFor(host: string): URL | null {
  if (noProxyMatch(host)) {
    log("proxy", "bypass", { host });
    return null;
  }
  const raw =
    process.env.DEVIN_PROXY ??
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy ??
    process.env.ALL_PROXY ?? process.env.all_proxy;
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

/** Read until the first predicate-satisfied length; returns consumed bytes and leaves the rest in place via unshift. */
function readUpTo(socket: net.Socket, until: (buf: Buffer) => number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = until(buf);
      if (end >= 0) {
        socket.off("data", onData);
        socket.off("error", onErr);
        if (end < buf.length) socket.unshift(buf.subarray(end));
        resolve(buf.subarray(0, end));
      }
    };
    const onErr = (e: Error) => {
      socket.off("data", onData);
      reject(e);
    };
    socket.on("data", onData);
    socket.once("error", onErr);
  });
}

function readExact(socket: net.Socket, n: number): Promise<Buffer> {
  return readUpTo(socket, (buf) => (buf.length >= n ? n : -1));
}

async function openHttpConnect(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 8080 });
  await onceConnect(socket);
  const auth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await readUpTo(socket, (buf) => {
    const idx = buf.indexOf("\r\n\r\n");
    return idx >= 0 ? idx + 4 : -1;
  });
  const statusLine = head.toString("latin1").split("\r\n", 1)[0];
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine);
  const status = m ? Number(m[1]) : 0;
  if (status !== 200) {
    socket.destroy();
    throw new Error(`proxy CONNECT to ${host}:${port} failed: ${statusLine}`);
  }
  return socket;
}

async function openSocks5(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 1080 });
  await onceConnect(socket);
  // greeting: VER=5, NMETHODS=1, no-auth
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greet = await readExact(socket, 2);
  if (greet[0] !== 0x05 || greet[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 proxy rejected no-auth (method=${greet[1]})`);
  }
  const hostBuf = Buffer.from(host, "ascii");
  if (hostBuf.length > 255) {
    socket.destroy();
    throw new Error("SOCKS5: hostname too long");
  }
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05; // VER
  req[1] = 0x01; // CONNECT
  req[2] = 0x00; // RSV
  req[3] = 0x03; // ATYP domain
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(port, 5 + hostBuf.length);
  socket.write(req);
  const rep = await readExact(socket, 4);
  if (rep[0] !== 0x05 || rep[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 connect failed (rep=${rep[1]})`);
  }
  const atyp = rep[3];
  if (atyp === 0x01) await readExact(socket, 4 + 2);
  else if (atyp === 0x03) {
    const len = await readExact(socket, 1);
    await readExact(socket, len[0] + 2);
  } else if (atyp === 0x04) await readExact(socket, 16 + 2);
  return socket;
}

async function openProxySocket(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const proto = proxy.protocol.replace(":", "").toLowerCase();
  const t0 = Date.now();
  log("proxy", "connect", { via: proto, proxy: `${proxy.hostname}:${proxy.port || (proto.startsWith("socks") ? 1080 : 8080)}`, to: `${host}:${port}` });
  let socket: net.Socket;
  if (proto === "socks5" || proto === "socks5h" || proto === "socks") socket = await openSocks5(proxy, host, port);
  else if (proto === "http" || proto === "https" || proto === "") socket = await openHttpConnect(proxy, host, port);
  else throw new Error(`unsupported proxy scheme: ${proxy.protocol}`);
  log("proxy", "tunnel-ok", { to: `${host}:${port}`, ms: Date.now() - t0 });
  return socket;
}

function tlsOver(socket: net.Socket, options: https.RequestOptions & { host?: string; servername?: string }): tls.TLSSocket {
  const host = options.servername ?? options.host ?? "";
  return tls.connect({
    socket,
    servername: host,
    ALPNProtocols: ["http/1.1"],
    ca: options.ca,
    rejectUnauthorized: options.rejectUnauthorized !== false,
  });
}

/** HTTP/1.1 keep-alive. HTTP/2 multiplexing is serialized by upstream and spikes TTFT. */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  keepAliveMsecs: 30_000,
  timeout: 0,
  ALPNProtocols: ["http/1.1"],
});

// NOTE: `createConnection` must be assigned as a method — https.Agent ignores
// it inside the constructor options object (verified empirically: it is never
// invoked there).
httpsAgent.createConnection = (options: https.RequestOptions, cb: (err: Error | null, socket?: unknown) => void) => {
  const host = String(options.servername ?? options.host ?? options.hostname ?? "");
  const port = Number(options.port) || 443;
  const proxy = proxyUrlFor(host);
  if (!proxy) {
    log("conn", "direct", { host, port });
    return tls.connect({ ...options, servername: host, ALPNProtocols: ["http/1.1"] });
  }
  openProxySocket(proxy, host, port).then(
    (raw) => cb(null, tlsOver(raw, { ...options, servername: host })),
    (err) => {
      log("proxy", "tunnel-fail", { to: `${host}:${port}`, err: String(err) });
      cb(err as Error);
    },
  );
  return undefined as unknown as tls.TLSSocket;
};

export function authHeader(token: string): string {
  return `Basic ${token}-${token}`;
}

export function requireToken(): { token: string; baseUrl: string } {
  const creds = readCredentials();
  if (!creds) {
    throw new Error("Devin CLI credentials missing. Run `devin auth login`, or set DEVIN_TOKEN.");
  }
  return { token: creds.token, baseUrl: creds.apiServerUrl };
}

// ---------------------------------------------------------------------------
// Metadata — field set captured byte-for-byte from devin 3000.10.21 through a
// transparent local proxy (api_server_url override). Verified wire shapes:
//   GetUserStatus:      1,2,3,4,5,7,12,28,31
//   GetCliModelConfigs: 1,2,3,4,5,7,12,28,30=[3,4,6,7,8],31
//   GetChatMessage:     1,2,3,4,5,7,12,28,31
// f(31) is a FRESH 366-byte hex blob per request — every captured call in the
// same process carried a different value, so a stable fingerprint would be the
// anomaly. Fields absent on the wire (9 request_id, 10 session_id, 13
// user_agent, 15 auth_source, 24 device_fingerprint, 32 team_id) are NOT sent.
// ---------------------------------------------------------------------------

function randomFingerprint(): string {
  return randomBytes(366).toString("hex");
}

export function buildMetadata(token: string, opts?: { displays?: boolean }): Buffer {
  const version = clientVersion();
  const parts: Buffer[] = [
    encodeString(1, CLIENT_NAME),
    encodeString(2, version),
    encodeString(3, token),
    encodeString(4, "en"),
    encodeString(5, CLIENT_OS),
    encodeString(7, version),
    encodeString(12, CLIENT_NAME),
    // ide_type = 28: "chisel" on every captured request
    encodeString(28, CLIENT_NAME),
  ];
  if (opts?.displays) {
    // supported_model_displays — captured set on GetCliModelConfigs only.
    parts.push(encodeMessage(30, Buffer.from([3, 4, 6, 7, 8])));
  }
  parts.push(encodeString(31, randomFingerprint()));
  return Buffer.concat(parts);
}

export type UnaryAuth = {
  token?: string;
  scheme?: "basic" | "bearer" | "none";
  baseUrl?: string;
};

function sentryTrace(): string {
  // Captured on every CLI request: <32-hex trace>-<16-hex span>-<sampled=1>
  return `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-1`;
}

export function connectHeaders(token: string, streaming: boolean, contentLength: number, scheme: UnaryAuth["scheme"] = "basic"): Record<string, string> {
  // Captured header set (3000.10.21): authorization, sentry-trace,
  // content-type, connect-protocol-version, accept:* /*, content-length.
  // No User-Agent, no Connection, no *-Encoding headers — and no request
  // compression (envelope flag is 0x00 even on 48KB bodies).
  const headers: Record<string, string> = {
    "Connect-Protocol-Version": "1",
    "Content-Type": streaming ? "application/connect+proto" : "application/proto",
    Accept: "*/*",
    "sentry-trace": sentryTrace(),
    "Content-Length": String(contentLength),
  };
  if (scheme === "bearer" && token) headers.Authorization = `Bearer ${token}`;
  else if (scheme !== "none" && token) headers.Authorization = authHeader(token);
  return headers;
}

export function encodeConnectEnvelope(payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function postHttps(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  signal?: AbortSignal,
): Promise<{ status: number; stream: Readable; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const parsed = new URL(url);
    log("http", "request", { path: parsed.pathname, bytes: body.length });
    const req = https.request(
      {
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
        agent: httpsAgent,
        ALPNProtocols: ["http/1.1"],
        signal,
      },
      (res) => {
        log("http", "headers", { path: parsed.pathname, status: res.statusCode, ms: Date.now() - t0, encoding: res.headers["content-encoding"] ?? res.headers["connect-content-encoding"] });
        resolve({ status: res.statusCode ?? 0, stream: res, headers: res.headers });
      },
    );
    req.on("error", (err) => {
      log("http", "error", { path: parsed.pathname, ms: Date.now() - t0, err: String(err) });
      reject(err);
    });
    req.on("socket", (socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
    });
    req.write(body);
    req.end();
  });
}

/** Plain HTTPS JSON POST through the same proxy-aware agent — used by the
 * OAuth-style auth endpoints on api.devin.ai (not Connect-RPC). */
export async function postJson(
  url: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown; text: string }> {
  const body = Buffer.from(JSON.stringify(payload));
  const { status, stream } = await postHttps(
    url,
    { "Content-Type": "application/json", Accept: "application/json", "Content-Length": String(body.length) },
    body,
    signal,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON response
  }
  return { status, json, text };
}

export async function connectUnary(path: string, body: Buffer, signal?: AbortSignal, auth?: UnaryAuth): Promise<Buffer> {
  const resolved = auth?.scheme === "none"
    ? { token: "", baseUrl: auth.baseUrl || BASE_URL }
    : auth?.token
      ? { token: auth.token, baseUrl: auth.baseUrl || requireToken().baseUrl }
      : requireToken();
  const baseUrl = auth?.baseUrl || resolved.baseUrl;
  const { status, stream, headers } = await postHttps(
    `${baseUrl}${path}`,
    connectHeaders(resolved.token, false, body.length, auth?.scheme ?? "basic"),
    body,
    signal,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  let buf = Buffer.concat(chunks);
  if (headers["content-encoding"] === "gzip") {
    try {
      buf = gunzipSync(buf);
    } catch {
      // keep raw
    }
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Devin ${path} HTTP ${status}: ${buf.subarray(0, 400).toString("utf8")}`);
  }
  return buf;
}

export async function connectStream(path: string, body: Buffer, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const { token, baseUrl } = requireToken();
  // Captured CLI sends the raw envelope (flags=0x00, uncompressed) — a 48KB
  // body went out plain. Match that; compression headers are absent upstream.
  const framed = encodeConnectEnvelope(body, 0x00);
  const { status, stream } = await postHttps(
    `${baseUrl}${path}`,
    connectHeaders(token, true, framed.length),
    framed,
    signal,
  );
  if (status < 200 || status >= 300) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    throw new Error(`Devin ${path} HTTP ${status}: ${Buffer.concat(chunks).subarray(0, 400).toString("utf8")}`);
  }
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export async function* readConnectFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ end: boolean; payload: Buffer }> {
  const reader = stream.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (true) {
      while (buf.length < 5) {
        const { done, value } = await reader.read();
        if (done) {
          if (buf.length > 0) throw new Error("truncated Connect stream");
          return;
        }
        buf = Buffer.concat([buf, Buffer.from(value)]);
      }
      const flags = buf[0];
      const length = buf.readUInt32BE(1);
      while (buf.length < 5 + length) {
        const { done, value } = await reader.read();
        if (done) throw new Error("truncated Connect frame");
        buf = Buffer.concat([buf, Buffer.from(value)]);
      }
      let payload = buf.subarray(5, 5 + length);
      buf = buf.subarray(5 + length);
      // Connect envelope bit 0x01 = compressed message (connect-content-encoding).
      if (flags & 0x01) {
        try {
          payload = gunzipSync(payload);
        } catch {
          // not actually compressed — pass through
        }
      }
      yield { end: (flags & 0x02) !== 0, payload };
      if (flags & 0x02) return;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Keep-alive warm-up. The CLI keeps a hot connection via ambient RPCs; idle
// LBs drop ours. A cheap unary ping on a timer after first use keeps the
// socket (and TCP cwnd) warm. Stops after ~10 min idle.
// ---------------------------------------------------------------------------

const KEEPALIVE_INTERVAL_MS = 45_000;
const KEEPALIVE_MAX_IDLE_MS = 10 * 60_000;
let lastStreamAt = 0;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

export function noteStreamActivity(): void {
  lastStreamAt = Date.now();
  if (!keepaliveTimer) {
    keepaliveTimer = setInterval(() => {
      if (Date.now() - lastStreamAt > KEEPALIVE_MAX_IDLE_MS) {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        return;
      }
      // GetUserStatus requires metadata.api_key in the body — an empty body
      // gets HTTP 400. It still warms the socket either way, but a 200 also
      // confirms the token is live.
      let body: Buffer;
      try {
        body = encodeMessage(1, buildMetadata(requireToken().token));
      } catch {
        return;
      }
      connectUnary(GET_USER_STATUS, body).then(
        () => log("keepalive", "ping-ok", {}),
        (err) => log("keepalive", "ping-fail", { err: String(err).slice(0, 200) }),
      );
      // team_id learning happens inside connectUnary (path === GET_USER_STATUS).
    }, KEEPALIVE_INTERVAL_MS);
    keepaliveTimer.unref?.();
  }
}

export { encodeBool, encodeMessage, encodeString, encodeVarintField };

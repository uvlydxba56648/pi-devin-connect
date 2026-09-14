import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
} from "@earendil-works/pi-ai";
import { assignRouter, peekCatalog, resolveModelUid } from "./catalog.js";
import { setTokenOverride } from "./credentials.js";
import {
  GET_CHAT,
  buildMetadata,
  connectStream,
  noteStreamActivity,
  encodeBool,
  encodeMessage,
  encodeString,
  encodeVarintField,
  readConnectFrames,
  requireToken,
} from "./connect.js";
import { encodeDouble, fieldBuf, fieldInt, fieldString, iterFields } from "./proto.js";
import { log } from "./log.js";

const SOURCE_USER = 1;
const SOURCE_ASSISTANT = 2;
const SOURCE_TOOL = 4;
const REQUEST_CASCADE = 5;
const PLANNER_DEFAULT = 1;
const TRAJECTORY_CASCADE = 4;
const STEP_USER_INPUT = 14;
const CACHE_EPHEMERAL = 1;
const PROVIDER_SOURCE_CASCADE = 12;
const XML_PARAM = /<(?:antml:)?parameter\s+name="([A-Za-z_][\w-]*)"[^>]*>([\s\S]*?)<\/(?:antml:)?parameter>/g;

interface ChatPrompt {
  source: number;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown; custom?: boolean }>;
  toolCallId?: string;
  toolError?: boolean;
  thinking?: string;
  signature?: string;
  signatureType?: string;
  thinkingRedacted?: boolean;
  outputId?: string;
  images?: Array<{ data: string; mime?: string }>;
  cache?: boolean;
}

interface OpenTool {
  index: number;
  id: string;
  name: string;
  partialJson: string;
  custom: boolean;
  started: boolean;
}


function uuidFromBytes(bytes: Buffer): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Captured (3000.10.21, two turns in one ACP session): trajectory_id and
// cascade_id are RANDOM UUIDs minted at session/new — identical across
// requests of the same session, different across sessions. We key them by
// Pi's sessionId (or a content seed) and generate v4 uuids on first sight.
const idsBySession = new Map<string, { trajectory: string; cascade: string }>();
// step_index (trajectory_reference.2) is a per-trajectory request counter:
// omitted on the first call, then 1, 2, 3… (title-gen call between two user
// turns carried 1, the second user turn carried 2).
const stepCountByTrajectory = new Map<string, number>();

function sessionIds(context: Context, sessionId?: string): { trajectory: string; cascade: string } {
  let seed = sessionId || "";
  if (!seed) {
    const head = (context.systemPrompt ?? "").slice(0, 4096);
    seed = head;
    const first = context.messages?.[0];
    if (first) {
      const text = textOf((first as { content?: unknown }).content).slice(0, 1024);
      if (text) seed += `\0${text}`;
    }
  }
  let ids = idsBySession.get(seed);
  if (!ids) {
    ids = { trajectory: randomUUID(), cascade: randomUUID() };
    if (idsBySession.size >= 4096) idsBySession.clear();
    idsBySession.set(seed, ids);
  }
  return ids;
}

function nextStepIndex(trajectory: string): number {
  const next = stepCountByTrajectory.get(trajectory) ?? 0;
  if (stepCountByTrajectory.size >= 65536) stepCountByTrajectory.clear();
  stepCountByTrajectory.set(trajectory, next + 1);
  return next; // first call → 0 → field omitted (matches wire)
}

function encodeImage(data: string, mime = "image/png"): Buffer {
  let raw = data;
  if (raw.startsWith("data:")) {
    const idx = raw.indexOf(",");
    if (idx >= 0) raw = raw.slice(idx + 1);
  }
  return Buffer.concat([encodeString(1, raw), encodeString(2, mime)]);
}

function toolArgumentsJson(args: unknown): { json?: string; invalid?: string; custom?: boolean } {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return { json: "{}" };
    try {
      JSON.parse(trimmed);
      return { json: trimmed };
    } catch {
      return { invalid: args, custom: true };
    }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (typeof rec.raw === "string" && Object.keys(rec).length === 1) {
      return toolArgumentsJson(rec.raw);
    }
    return { json: JSON.stringify(args) };
  }
  return { json: JSON.stringify(args ?? {}) };
}

function encodeToolCall(call: { id: string; name: string; arguments: unknown; custom?: boolean }): Buffer {
  const parts: Buffer[] = [encodeString(1, call.id), encodeString(2, call.name)];
  const encoded = toolArgumentsJson(call.arguments);
  if (call.custom || encoded.custom) {
    parts.push(encodeString(4, encoded.invalid ?? encoded.json ?? ""));
    parts.push(encodeBool(6, true));
  } else if (encoded.json) {
    parts.push(encodeString(3, encoded.json));
  }
  return Buffer.concat(parts);
}

function encodePrompt(prompt: ChatPrompt): Buffer {
  const parts: Buffer[] = [encodeString(1, randomUUID()), encodeVarintField(2, prompt.source)];
  if (prompt.text) parts.push(encodeString(3, prompt.text));
  for (const call of prompt.toolCalls ?? []) parts.push(encodeMessage(6, encodeToolCall(call)));
  if (prompt.toolCallId) parts.push(encodeString(7, prompt.toolCallId));
  if (prompt.cache) parts.push(encodeMessage(8, encodeVarintField(1, CACHE_EPHEMERAL)));
  if (prompt.toolError) parts.push(encodeBool(9, true));
  for (const img of prompt.images ?? []) parts.push(encodeMessage(10, encodeImage(img.data, img.mime)));
  if (prompt.thinking) parts.push(encodeString(11, prompt.thinking));
  if (prompt.signature) parts.push(encodeString(12, prompt.signature));
  if (prompt.thinkingRedacted) parts.push(encodeBool(13, true));
  if (prompt.outputId) parts.push(encodeString(15, prompt.outputId));
  if (prompt.signatureType) parts.push(encodeString(18, prompt.signatureType));
  return Buffer.concat(parts);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join("\n");
}

function convertMessages(context: Context): ChatPrompt[] {
  const messages = context.messages ?? [];
  let lastAssistant = -1;
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as { role?: string }).role === "assistant") lastAssistant = i;
  }
  const prompts: ChatPrompt[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    const attachImages = i > lastAssistant;
    if (msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
      const images = attachImages
        ? content
            .filter((p: { type?: string }) => p.type === "image")
            .map((p: { data?: string; mimeType?: string }) => ({
              data: p.data || "",
              mime: p.mimeType,
            }))
            .filter((p) => p.data)
        : [];
      const omitted = !attachImages && content.some((p: { type?: string }) => p.type === "image");
      let text = textOf(content);
      if (omitted) text = text ? `${text}\n[Image omitted from history]` : "[Image omitted from history]";
      prompts.push({ source: SOURCE_USER, text, images });
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      let text = "";
      let thinking = "";
      let signature = "";
      let signatureType = "";
      let thinkingRedacted = false;
      const calls: NonNullable<ChatPrompt["toolCalls"]> = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text") text += String(block.text ?? "");
        if (block.type === "thinking") {
          const chunk = String(block.thinking ?? block.text ?? "");
          if (thinking && chunk) thinking += "\n";
          thinking += chunk;
          signature = String(block.thinkingSignature ?? block.signature ?? signature);
          signatureType = String(block.signatureType ?? signatureType);
          thinkingRedacted = thinkingRedacted || Boolean(block.redacted);
        }
        if (block.type === "toolCall" || block.type === "tool_call") {
          calls.push({
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            arguments: block.arguments ?? {},
          });
        }
      }
      if (!text && calls.length === 0) continue;
      prompts.push({
        source: SOURCE_ASSISTANT,
        text: text || undefined,
        thinking: thinking || undefined,
        signature: signature || undefined,
        signatureType: signatureType || undefined,
        thinkingRedacted: thinkingRedacted || undefined,
        outputId: typeof msg.responseId === "string" ? msg.responseId : undefined,
        toolCalls: calls,
      });
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const content = msg.content;
      const images = attachImages && Array.isArray(content)
        ? content
            .filter((p: { type?: string }) => p.type === "image")
            .map((p: { data?: string; mimeType?: string }) => ({ data: p.data || "", mime: p.mimeType }))
            .filter((p) => p.data)
        : [];
      prompts.push({
        source: SOURCE_TOOL,
        text: textOf(content) || "[tool result]",
        toolCallId: String(msg.toolCallId ?? msg.tool_call_id ?? ""),
        toolError: Boolean(msg.isError),
        images,
      });
    }
  }
  return demoteOrphanToolResults(pairToolCallsWithResults(prompts));
}

function pairToolCallsWithResults(prompts: ChatPrompt[]): ChatPrompt[] {
  const isCall = (p: ChatPrompt) => p.source === SOURCE_ASSISTANT && (p.toolCalls?.length ?? 0) > 0;
  const isResult = (p: ChatPrompt) => p.source === SOURCE_TOOL;
  const out: ChatPrompt[] = [];
  for (let i = 0; i < prompts.length; ) {
    if (!isCall(prompts[i])) {
      out.push(prompts[i++]);
      continue;
    }
    const calls: ChatPrompt[] = [];
    while (i < prompts.length && isCall(prompts[i])) calls.push(prompts[i++]);
    const byId = new Map<string, ChatPrompt>();
    const jStart = i;
    while (i < prompts.length && isResult(prompts[i])) {
      byId.set(prompts[i].toolCallId ?? "", prompts[i]);
      i++;
    }
    const consumed = new Set<string>();
    for (const callPrompt of calls) {
      out.push(callPrompt);
      for (const call of callPrompt.toolCalls ?? []) {
        const result = byId.get(call.id);
        if (result) {
          out.push(result);
          consumed.add(call.id);
          byId.delete(call.id);
        }
      }
    }
    for (let k = jStart; k < i; k++) {
      const id = prompts[k].toolCallId ?? "";
      if (!consumed.has(id)) out.push(prompts[k]);
    }
  }
  return out;
}

function demoteOrphanToolResults(prompts: ChatPrompt[]): ChatPrompt[] {
  const callIds = new Set<string>();
  for (const prompt of prompts) {
    for (const call of prompt.toolCalls ?? []) if (call.id) callIds.add(call.id);
  }
  return prompts.map((prompt) => {
    if (prompt.source !== SOURCE_TOOL) return prompt;
    if (prompt.toolCallId && callIds.has(prompt.toolCallId)) return prompt;
    return {
      source: SOURCE_USER,
      text: `[tool result, original call lost]\n${prompt.text ?? ""}`,
      images: prompt.images,
      cache: prompt.cache,
    };
  });
}

function encodeTools(context: Context): Buffer[] {
  const tools = (context as { tools?: Array<{ name: string; description?: string; parameters?: unknown }> }).tools ?? [];
  return tools.map((tool) =>
    Buffer.concat([
      encodeString(1, tool.name),
      encodeString(2, (tool.description ?? "").slice(0, 6995)),
      encodeString(3, JSON.stringify(tool.parameters ?? { type: "object" })),
    ]),
  );
}

function withToolDescriptions(system: string, context: Context): string {
  const tools = (context as { tools?: Array<{ name: string; description?: string }> }).tools ?? [];
  if (tools.length === 0) return system;
  const blocks = tools.map((t) => `<tool name="${t.name}">${t.description ?? ""}</tool>`).join("\n");
  return `${system}\n\n${blocks}`;
}

function encodeCompletion(options?: SimpleStreamOptions): Buffer {
  // Restore the values that worked for long CASCADE turns (swe-2-max).
  // The ACP capture of a 1-prompt swe-1-6-fast turn used temp=0/top_p=0 and
  // was rejected as invalid_argument when applied to 262-message tool chats.
  const parts: Buffer[] = [
    encodeVarintField(1, 1),
    encodeVarintField(2, options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 128000),
    encodeVarintField(3, 400),
    encodeDouble(5, options?.temperature ?? 1),
    encodeVarintField(7, 40),
    encodeDouble(8, 0.95),
  ];
  return Buffer.concat(parts);
}

function encodeTrajectory(id: string, stepIndex: number): Buffer {
  // Captured shape: {1: trajectory_id, [2: step_index when >0], 3: CASCADE(4),
  // 4: STEP_USER_INPUT(14)} — first request omits step_index entirely.
  const parts = [encodeString(1, id)];
  if (stepIndex > 0) parts.push(encodeVarintField(2, stepIndex));
  parts.push(encodeVarintField(3, TRAJECTORY_CASCADE), encodeVarintField(4, STEP_USER_INPUT));
  return Buffer.concat(parts);
}

export async function buildChatRequest(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<{ body: Buffer; cascadeId: string; modelUid: string; assignmentJwt?: string }> {
  const buildT0 = Date.now();
  const { token } = requireToken();
  const { trajectory, cascade } = sessionIds(context, options?.sessionId);
  let uid = resolveModelUid(model, options?.reasoning);
  let assignmentJwt: string | undefined;
  const entry = peekCatalog()?.find((m) => m.id === uid);
  if (entry?.isRouter) {
    try {
      const assigned = await assignRouter(uid, cascade);
      if (assigned) {
        uid = assigned.uid;
        assignmentJwt = assigned.jwt;
      }
    } catch {
      // router optional
    }
  }
  const prompts = convertMessages(context);
  if (prompts.length > 0) prompts[prompts.length - 1].cache = true;
  log("build", "chat-request", {
    model: model.id,
    uid,
    isRouter: Boolean(entry?.isRouter),
    prompts: prompts.length,
    systemChars: (context.systemPrompt ?? "").length,
    messages: context.messages.length,
    tools: context.tools?.length ?? 0,
    ms: Date.now() - buildT0,
  });
  const tools = encodeTools(context);
  const parts: Buffer[] = [
    encodeMessage(1, buildMetadata(token)),
    encodeString(2, withToolDescriptions(context.systemPrompt ?? "", context)),
  ];
  for (const prompt of prompts) parts.push(encodeMessage(3, encodePrompt(prompt)));
  parts.push(encodeVarintField(7, REQUEST_CASCADE));
  parts.push(encodeMessage(8, encodeCompletion(options)));
  for (const tool of tools) parts.push(encodeMessage(10, tool));
  if (options?.toolChoice === "none") {
    parts.push(encodeMessage(12, encodeString(1, "none")));
  }
  parts.push(encodeMessage(13, encodeVarintField(1, CACHE_EPHEMERAL)));
  parts.push(encodeMessage(15, encodeTrajectory(trajectory, nextStepIndex(trajectory))));
  parts.push(encodeString(16, cascade));
  // CASCADE turns with tools require provider_source=12; omitting it (as the
  // tiny ACP capture did) produces invalid_argument on long Pi conversations.
  parts.push(encodeVarintField(18, PROVIDER_SOURCE_CASCADE));
  parts.push(encodeVarintField(20, PLANNER_DEFAULT));
  parts.push(encodeString(21, uid));
  parts.push(encodeString(22, randomUUID()));
  if (assignmentJwt) parts.push(encodeString(26, assignmentJwt));
  return { body: Buffer.concat(parts), cascadeId: cascade, modelUid: uid, assignmentJwt };
}

function mapStop(reason: number): AssistantMessage["stopReason"] {
  if (reason === 10) return "toolUse";
  if (reason === 3 || reason === 5 || reason === 1 || reason === 9) return "length";
  if (reason === 13 || reason === 7) return "error";
  return "stop";
}

function repairXmlArguments(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  XML_PARAM.lastIndex = 0;
  while ((match = XML_PARAM.exec(raw))) {
    out[match[1]] = match[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

function finalizeArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  const xml = repairXmlArguments(trimmed);
  if (xml) return xml;
  const streamed = parseStreamingJson(trimmed);
  if (streamed && typeof streamed === "object" && !Array.isArray(streamed) && Object.keys(streamed).length > 0) {
    return streamed as Record<string, unknown>;
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function streamDevin(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  // Pi resolves credentials (auth.json OAuth → getApiKey) into options.apiKey.
  // Our provider apiKey placeholder is the literal "devin-cli"; anything else
  // is a real session token — override the file/env source for this process.
  if (options?.apiKey && options.apiKey !== "devin-cli") {
    setTokenOverride(options.apiKey);
  }
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  void (async () => {
    let textOpen = false;
    let thinkingOpen = false;
    const tools: OpenTool[] = [];

    // Delta smoother. Upstream frames arrive in TCP bursts; Pi coalesces
    // renders per batch, so output looks chunked. Queue visible events in
    // order and drip text/thinking deltas at a fixed cadence. Non-delta
    // events emit when they reach the head of the queue. flush() drains
    // everything synchronously (stream end / abort).
    type QDelta = { kind: "delta"; event: Record<string, unknown>; delta: string };
    type QOther = { kind: "other"; event: Record<string, unknown> };
    const queue: Array<QDelta | QOther> = [];
    let timer: ReturnType<typeof setInterval> | null = null;
    // ~25 updates/sec is below Pi's 60fps render cap and cheap enough that the
    // O(content) markdown re-render per update doesn't starve the event loop.
    const TICK_MS = 40;
    // Constant-rate drip: any backlog drains in ~MAX_DRAIN_TICKS ticks
    // (~1.6s), so a big sealed thinking segment types out continuously instead
    // of landing as one jump; small token bursts still feel instant.
    const MAX_DRAIN_TICKS = 40;
    const MIN_CHARS = 12; // ~300 chars/s floor ≈ normal reading pace
    const enqueue = (event: Record<string, unknown>) => {
      queue.push({ kind: "other", event });
      ensureTimer();
    };
    const enqueueDelta = (event: Record<string, unknown>, delta: string) => {
      queue.push({ kind: "delta", event, delta });
      ensureTimer();
    };
    const emitHead = (budget: number): number => {
      const item = queue[0];
      if (!item) return 0;
      if (item.kind === "other") {
        queue.shift();
        stream.push(item.event as never);
        const t = (item.event as { type?: string }).type;
        if (t === "done" || t === "error") stream.end();
        return 0;
      }
      const take = Math.min(budget, item.delta.length);
      const part = item.delta.slice(0, take);
      item.delta = item.delta.slice(take);
      stream.push({ ...item.event, delta: part } as never);
      if (item.delta.length === 0) queue.shift();
      return take;
    };
    const tick = () => {
      const queuedChars = queue.reduce((n, q) => n + (q.kind === "delta" ? q.delta.length : 0), 0);
      let budget = Math.max(MIN_CHARS, Math.ceil(queuedChars / MAX_DRAIN_TICKS));
      // Emit delta chars across as many queued items as the budget allows,
      // then any non-delta events that surface behind them.
      while (queue.length) {
        if (queue[0].kind === "other") {
          emitHead(0);
          continue;
        }
        if (budget <= 0) break;
        budget -= emitHead(budget);
      }
      if (queue.length === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const ensureTimer = () => {
      if (!timer) {
        // Ref'd on purpose: after the HTTP stream ends, draining the remaining
        // queue is the only pending work; an unref'd timer could let the
        // process idle-exit before queued events (incl. done) are emitted.
        timer = setInterval(tick, TICK_MS);
      }
    };
    const flush = () => {
      while (queue.length) emitHead(Number.MAX_SAFE_INTEGER);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const closeText = () => {
      if (!textOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "text") {
        enqueue({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
      }
      textOpen = false;
    };
    const closeThinking = () => {
      if (!thinkingOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "thinking") {
        enqueue({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
      }
      thinkingOpen = false;
    };
    const findTool = (id: string): OpenTool | undefined => {
      if (id) return tools.find((tool) => tool.id === id);
      return tools.at(-1);
    };
    const applyToolDelta = (delta: { id: string; name: string; args: string; hasArgs: boolean; custom: boolean }) => {
      closeThinking();
      closeText();
      let tool = findTool(delta.id);
      if (!tool) {
        const id = delta.id || `call_${tools.length}`;
        output.content.push({ type: "toolCall", id, name: delta.name || "unknown", arguments: {} });
        const idx = output.content.length - 1;
        tool = { index: idx, id, name: delta.name || "unknown", partialJson: "", custom: delta.custom, started: false };
        tools.push(tool);
      }
      if (delta.id) {
        tool.id = delta.id;
        const block = output.content[tool.index];
        if (block.type === "toolCall") block.id = delta.id;
      }
      if (delta.name) {
        tool.name = delta.name;
        const block = output.content[tool.index];
        if (block.type === "toolCall") block.name = delta.name;
      }
      if (delta.custom) tool.custom = true;
      if (!tool.started) {
        tool.started = true;
        enqueue({ type: "toolcall_start", contentIndex: tool.index, partial: output });
      }
      if (delta.hasArgs) {
        tool.partialJson += delta.args;
        const block = output.content[tool.index];
        if (block.type === "toolCall") {
          block.arguments = asRecord(parseStreamingJson(tool.partialJson));
        }
        if (delta.args) {
          enqueueDelta({ type: "toolcall_delta", contentIndex: tool.index, partial: output }, delta.args);
        }
      }
    };
    const finishTools = () => {
      for (const tool of tools) {
        if (!tool.started) continue;
        const block = output.content[tool.index];
        if (block.type !== "toolCall") continue;
        block.id = tool.id;
        block.name = tool.name;
        block.arguments = finalizeArguments(tool.partialJson);
        const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
        enqueue({ type: "toolcall_end", contentIndex: tool.index, toolCall, partial: output });
      }
    };

    try {
      const built = await buildChatRequest(model, context, options);
      output.providerThinkingLevel = built.modelUid;
      enqueue({ type: "start", partial: output });
      const reqT0 = Date.now();
      // CLI retries backend stream creation once; do the same for transient
      // connect failures (lossy direct path, proxy flap, LB idle kill).
      let remote: ReadableStream<Uint8Array>;
      try {
        remote = await connectStream(GET_CHAT, built.body, options?.signal);
      } catch (firstErr) {
        log("stream", "connect-retry", { model: model.id, err: String(firstErr).slice(0, 200) });
        await new Promise((r) => setTimeout(r, 800));
        remote = await connectStream(GET_CHAT, built.body, options?.signal);
      }
      noteStreamActivity();
      log("stream", "request-sent", { model: model.id, uid: built.modelUid, bodyBytes: built.body.length, headersMs: Date.now() - reqT0 });
      let sawStop = false;
      let frames = 0;
      let lastPhase = "";
      let totalDeltaTokens = 0;
      let firstFrameMs: number | null = null;
      let firstTextMs: number | null = null;
      let firstThinkMs: number | null = null;
      for await (const frame of readConnectFrames(remote)) {
        if (firstFrameMs === null) {
          firstFrameMs = Date.now() - reqT0;
          log("stream", "first-frame", { model: model.id, ms: firstFrameMs });
        }
        frames++;
        if (options?.signal?.aborted) throw new Error("aborted");
        if (frame.end) {
          if (frame.payload.length) {
            const trailer = frame.payload.toString("utf8");
            if (trailer.includes('"error"') || trailer.includes("error")) {
              throw new Error(trailer.slice(0, 500));
            }
          }
          break;
        }
        let deltaText = "";
        let deltaThinking = "";
        let deltaSignature = "";
        let deltaSignatureType = "";
        let thinkingRedacted = false;
        let stopReason = 0;
        let outputId = "";
        let deltaTokens = 0;
        let phase = "";
        const toolDeltas: Array<{ id: string; name: string; args: string; hasArgs: boolean; custom: boolean }> = [];
        for (const f of iterFields(frame.payload)) {
          if (f.num === 1 && !output.responseId) output.responseId = fieldString(f);
          if (f.num === 3) deltaText = fieldString(f);
          if (f.num === 4) deltaTokens = fieldInt(f);
          if (f.num === 5) stopReason = fieldInt(f);
          if (f.num === 6) {
            let id = "";
            let name = "";
            let args = "";
            let hasArgs = false;
            let custom = false;
            for (const inner of iterFields(fieldBuf(f))) {
              if (inner.num === 1) id = fieldString(inner);
              if (inner.num === 2) name = fieldString(inner);
              if (inner.num === 3) {
                args = fieldString(inner);
                hasArgs = true;
              }
              if (inner.num === 4) {
                args = fieldString(inner);
                hasArgs = true;
                custom = true;
              }
              if (inner.num === 6) custom = custom || fieldInt(inner) !== 0;
            }
            toolDeltas.push({ id, name, args, hasArgs, custom });
          }
          if (f.num === 7) {
            for (const inner of iterFields(fieldBuf(f))) {
              if (inner.num === 2) output.usage.input = fieldInt(inner);
              if (inner.num === 3) output.usage.output = fieldInt(inner);
              if (inner.num === 4) output.usage.cacheWrite = fieldInt(inner);
              if (inner.num === 5) output.usage.cacheRead = fieldInt(inner);
              if (inner.num === 9 && !output.responseModel) output.responseModel = fieldString(inner);
            }
            output.usage.totalTokens =
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
          if (f.num === 9) deltaThinking = fieldString(f);
          if (f.num === 10) deltaSignature = fieldString(f);
          if (f.num === 11) thinkingRedacted = fieldInt(f) !== 0;
          if (f.num === 15) outputId = fieldString(f);
          if (f.num === 21) deltaSignatureType = fieldString(f);
          if (f.num === 23) output.responseModel = fieldString(f);
          if (f.num === 25) phase = fieldString(f);
        }
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          log("stream", "phase", { model: model.id, phase });
        }
        totalDeltaTokens += deltaTokens;
        if (deltaText && firstTextMs === null) {
          firstTextMs = Date.now() - reqT0;
          log("stream", "first-text", { model: model.id, ms: firstTextMs });
        }
        if (deltaThinking && firstThinkMs === null) {
          firstThinkMs = Date.now() - reqT0;
          log("stream", "first-thinking", { model: model.id, ms: firstThinkMs });
        }
        if (outputId) output.responseId = outputId;
        if (deltaSignature && !deltaThinking && !thinkingOpen) {
          for (let i = output.content.length - 1; i >= 0; i--) {
            const block = output.content[i];
            if (block.type !== "thinking") continue;
            block.thinkingSignature = `${block.thinkingSignature ?? ""}${deltaSignature}`;
            if (deltaSignatureType) (block as { signatureType?: string }).signatureType = deltaSignatureType;
            deltaSignature = "";
            break;
          }
        }
        if (deltaThinking || deltaSignature || thinkingRedacted) {
          closeText();
          if (!thinkingOpen) {
            output.content.push({ type: "thinking", thinking: "", redacted: thinkingRedacted || undefined });
            const idx = output.content.length - 1;
            enqueue({ type: "thinking_start", contentIndex: idx, partial: output });
            thinkingOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "thinking") {
            if (deltaThinking) {
              block.thinking += deltaThinking;
              enqueueDelta({ type: "thinking_delta", contentIndex: idx, partial: output }, deltaThinking);
            }
            if (deltaSignature) block.thinkingSignature = `${block.thinkingSignature ?? ""}${deltaSignature}`;
            if (deltaSignatureType) (block as { signatureType?: string }).signatureType = deltaSignatureType;
            if (thinkingRedacted) block.redacted = true;
          }
        }
        if (deltaText) {
          closeThinking();
          if (!textOpen) {
            output.content.push({ type: "text", text: "" });
            const idx = output.content.length - 1;
            enqueue({ type: "text_start", contentIndex: idx, partial: output });
            textOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "text") {
            block.text += deltaText;
            enqueueDelta({ type: "text_delta", contentIndex: idx, partial: output }, deltaText);
          }
        }
        for (const tool of toolDeltas) applyToolDelta(tool);
        if (stopReason) {
          sawStop = true;
          output.stopReason = mapStop(stopReason);
        }
      }
      closeThinking();
      closeText();
      if (!sawStop && output.content.length === 0 && tools.length === 0) {
        throw new Error("Devin stream ended without generated content");
      }
      if (!sawStop) {
        throw new Error("Devin stream ended without stop reason");
      }
      finishTools();
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Devin stopped with an error");
      }
      log("stream", "done", {
        model: model.id,
        totalMs: Date.now() - reqT0,
        frames,
        firstFrameMs,
        firstTextMs,
        firstThinkMs,
        stopReason: output.stopReason,
        deltaTokens: totalDeltaTokens,
        usage: output.usage,
        responseModel: output.responseModel,
      });
      // Let the queue drain at tick cadence so the tail also looks smooth;
      // emitHead ends the stream when the done event surfaces.
      enqueue({ type: "done", reason: output.stopReason === "error" || output.stopReason === "aborted" || output.stopReason === "pending" || output.stopReason === "deferred" ? "stop" : output.stopReason, message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      log("stream", "error", { model: model.id, err: output.errorMessage });
      flush();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

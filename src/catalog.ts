import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { clientVersion } from "./credentials.js";
import {
  ASSIGN_MODEL,
  GET_CLI_MODELS,
  buildMetadata,
  connectUnary,
  encodeMessage,
  encodeString,
  requireToken,
} from "./connect.js";
import { fieldBool, fieldBuf, fieldInt, fieldString, iterFields } from "./proto.js";
import { log } from "./log.js";

export interface DevinModel {
  id: string;
  name: string;
  disabled: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsTools: boolean;
  isRouter: boolean;
  contextWindow: number;
  maxTokens: number;
}

function decodeFeatures(buf: Buffer): { images: boolean; thinking: boolean; tools: boolean } {
  let images = false;
  let thinking = false;
  let tools = false;
  for (const f of iterFields(buf)) {
    if (f.num === 11) images = fieldBool(f);
    if (f.num === 12) tools = fieldBool(f);
    if (f.num === 15) thinking = fieldBool(f);
  }
  return { images, thinking, tools };
}

function decodeModelInfo(buf: Buffer): {
  maxTokens: number;
  maxOutput: number;
  isRouter: boolean;
  features: ReturnType<typeof decodeFeatures>;
} {
  let maxTokens = 0;
  let maxOutput = 0;
  let isRouter = false;
  let features = { images: false, thinking: false, tools: true };
  for (const f of iterFields(buf)) {
    if (f.num === 4) maxTokens = fieldInt(f);
    if (f.num === 6) features = decodeFeatures(fieldBuf(f));
    if (f.num === 13) maxOutput = fieldInt(f);
    if (f.num === 25) isRouter = fieldBool(f);
  }
  return { maxTokens, maxOutput, isRouter, features };
}

function decodeAliasUid(buf: Buffer): string {
  for (const f of iterFields(buf)) {
    if (f.num === 3) return fieldString(f);
  }
  return "";
}

function decodeClientModel(buf: Buffer): DevinModel | null {
  let label = "";
  let uid = "";
  let disabled = false;
  let supportsImages = false;
  let contextWindow = 0;
  let info: ReturnType<typeof decodeModelInfo> | undefined;
  for (const f of iterFields(buf)) {
    if (f.num === 1) label = fieldString(f);
    if (f.num === 2) uid = uid || decodeAliasUid(fieldBuf(f));
    if (f.num === 4) disabled = fieldBool(f);
    if (f.num === 5) supportsImages = fieldBool(f);
    if (f.num === 18) contextWindow = fieldInt(f);
    if (f.num === 22) uid = fieldString(f) || uid;
    if (f.num === 23) info = decodeModelInfo(fieldBuf(f));
  }
  if (!uid || disabled) return null;
  const features = info?.features;
  return {
    id: uid,
    name: label || uid,
    disabled,
    supportsImages: supportsImages || Boolean(features?.images),
    supportsThinking: Boolean(features?.thinking),
    supportsTools: features ? features.tools : true,
    isRouter: Boolean(info?.isRouter),
    contextWindow: contextWindow || info?.maxTokens || 256_000,
    maxTokens: info?.maxOutput || 128_000,
  };
}

let catalogCache: { at: number; models: DevinModel[] } | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;

export function peekCatalog(): DevinModel[] | null {
  return catalogCache?.models ?? null;
}

export async function listCliModels(force = false): Promise<DevinModel[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  const { token } = requireToken();
  const body = encodeMessage(1, buildMetadata(token, { displays: true }));
  const t0 = Date.now();
  const raw = await connectUnary(GET_CLI_MODELS, body);
  const models: DevinModel[] = [];
  const seen = new Set<string>();
  for (const f of iterFields(raw)) {
    if (f.num !== 1) continue;
    const model = decodeClientModel(fieldBuf(f));
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  catalogCache = { at: Date.now(), models };
  log("catalog", "loaded", { count: models.length, ms: Date.now() - t0 });
  return models;
}

type PiLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const LEVEL_ORDER: PiLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Variant = "fast" | "1m" | null;

interface ParsedModel {
  base: string;
  level: PiLevel | "on" | null;
  variant: Variant;
}

/** Split a display name into base name + thinking level + speed/context variant. */
function parseModelName(name: string): ParsedModel {
  let rest = name.trim();
  let variant: Variant = null;
  for (;;) {
    if (/ Fast$/i.test(rest)) {
      variant = "fast";
      rest = rest.slice(0, -5);
    } else if (/ 1M$/.test(rest)) {
      variant = "1m";
      rest = rest.slice(0, -3);
    } else {
      break;
    }
  }
  let level: ParsedModel["level"] = null;
  let m = rest.match(/ (None|Minimal|Low|Medium|High|XHigh|X-High|Max)( Thinking)?$/i);
  if (m && m.index !== undefined) {
    const w = m[1].toLowerCase();
    level = w === "none" ? "off" : w === "x-high" ? "xhigh" : (w as PiLevel);
    rest = rest.slice(0, m.index);
  } else {
    m = rest.match(/ (No Thinking|Thinking)$/i);
    if (m && m.index !== undefined) {
      level = m[1].toLowerCase() === "thinking" ? "on" : "off";
      rest = rest.slice(0, m.index);
    }
  }
  return { base: rest.trim(), level, variant };
}

/** Fallback: derive level/variant from the uid when the display name carries none. */
function parseModelUid(uid: string): { level: PiLevel | "on"; variant: Variant } | null {
  const m = uid.match(/[-_](none|minimal|low|medium|high|xhigh|max|thinking)(?:[-_](priority|fast|1m))?$/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const level = (w === "none" ? "off" : w === "thinking" ? "on" : w) as PiLevel | "on";
  const v = m[2]?.toLowerCase();
  return { level, variant: v === "1m" ? "1m" : v ? "fast" : null };
}

function parseModel(model: DevinModel): ParsedModel {
  const fromName = parseModelName(model.name);
  if (fromName.level !== null && fromName.variant !== null) return fromName;
  const fromUid = parseModelUid(model.id);
  return {
    base: fromName.base,
    level: fromName.level ?? fromUid?.level ?? null,
    variant: fromName.variant ?? fromUid?.variant ?? null,
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function rank(id: string): number {
  const s = id.toLowerCase();
  if (s === "swe-2") return 0;
  if (s.startsWith("swe-2")) return 1;
  if (s.startsWith("swe-")) return 2;
  if (s.includes("fable-5-1")) return 3;
  if (s.includes("astra")) return 4;
  if (s.includes("fable")) return 5;
  if (s.includes("opus-5")) return 6;
  if (s.includes("sonnet-5")) return 7;
  if (s === "adaptive" || s.startsWith("fusion")) return 8;
  return 20;
}

interface ModelGroup {
  base: string;
  variant: Variant;
  members: DevinModel[];
  levels: Map<PiLevel, string>;
  onUid?: string;
  plain: DevinModel[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function variantLabel(variant: Variant): { idSuffix: string; nameSuffix: string } {
  if (variant === "fast") return { idSuffix: "-fast", nameSuffix: " Fast" };
  if (variant === "1m") return { idSuffix: "-1m", nameSuffix: " 1M" };
  return { idSuffix: "", nameSuffix: "" };
}

function singleModelConfig(model: DevinModel, name: string): ProviderModelConfig {
  return {
    id: model.id,
    name,
    reasoning: model.supportsThinking,
    // Un-leveled thinking models have exactly one behavior — expose it as "high" only.
    thinkingLevelMap: model.supportsThinking
      ? { off: null, minimal: null, low: null, medium: null, high: model.id, xhigh: null, max: null }
      : undefined,
    input: model.supportsImages ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: model.contextWindow || 256_000,
    maxTokens: model.maxTokens || 128_000,
  };
}

/**
 * Group the flattened upstream catalog (base x level x variant) back into one pi
 * model per family. Thinking levels map to upstream uids via thinkingLevelMap so
 * the level switcher picks e.g. swe-2:max -> "swe-2-max" instead of separate models.
 */
export function toProviderModels(models: DevinModel[]): ProviderModelConfig[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const parsed = parseModel(model);
    const key = `${parsed.base}|${parsed.variant ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { base: parsed.base, variant: parsed.variant, members: [], levels: new Map(), plain: [] };
      groups.set(key, group);
    }
    group.members.push(model);
    if (parsed.level === "on") {
      group.onUid ??= model.id;
    } else if (parsed.level) {
      if (!group.levels.has(parsed.level)) group.levels.set(parsed.level, model.id);
    } else if (model.supportsThinking) {
      group.plain.push(model);
    } else if (!group.levels.has("off")) {
      group.levels.set("off", model.id); // non-thinking member serves as the "off" level
    }
  }

  const out: ProviderModelConfig[] = [];
  const usedIds = new Set<string>();
  for (const group of groups.values()) {
    const { idSuffix, nameSuffix } = variantLabel(group.variant);
    const name = `${group.base}${nameSuffix}`;
    const thinkingLevelMap: Record<PiLevel, string | null> = {
      off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
    };
    for (const [level, uid] of group.levels) thinkingLevelMap[level] = uid;
    // Generic "Thinking" member (no graduated level): expose it at the first free slot.
    if (group.onUid) {
      for (const slot of ["high", "medium", "low", "minimal", "xhigh", "max"] as PiLevel[]) {
        if (!thinkingLevelMap[slot]) {
          thinkingLevelMap[slot] = group.onUid;
          break;
        }
      }
    }
    const hasLevels = LEVEL_ORDER.some((level) => thinkingLevelMap[level] !== null);
    if (hasLevels) {
      let id = `${slugify(group.base)}${idSuffix}`;
      for (let i = 2; usedIds.has(id); i++) id = `${slugify(group.base)}${idSuffix}-${i}`;
      usedIds.add(id);
      out.push({
        id,
        name,
        reasoning: group.members.some((m) => m.supportsThinking),
        thinkingLevelMap,
        input: group.members.some((m) => m.supportsImages) ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: Math.max(...group.members.map((m) => m.contextWindow || 256_000)),
        maxTokens: Math.max(...group.members.map((m) => m.maxTokens || 128_000)),
      });
    }
    // Un-leveled members (or leftovers of a mixed group) stay individual entries keyed by uid.
    for (const model of group.plain) {
      out.push(singleModelConfig(model, group.plain.length > 1 ? model.name : name));
    }
    if (!hasLevels && group.plain.length === 0) {
      // Should not happen, but never drop a model silently.
      for (const model of group.members) out.push(singleModelConfig(model, model.name));
    }
  }
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** Resolve the upstream uid for a pi model + thinking level ("off" maps too). */
export function resolveModelUid(
  model: { id: string; thinkingLevelMap?: Partial<Record<string, string | null>> },
  reasoning?: string,
): string {
  const map = model.thinkingLevelMap;
  if (map) {
    const wanted = reasoning && (LEVEL_ORDER as string[]).includes(reasoning) ? reasoning : "high";
    const from = LEVEL_ORDER.indexOf(wanted as PiLevel);
    for (let i = from; i < LEVEL_ORDER.length; i++) {
      const uid = map[LEVEL_ORDER[i]];
      if (typeof uid === "string" && uid) return uid;
    }
    for (let i = from - 1; i >= 0; i--) {
      const uid = map[LEVEL_ORDER[i]];
      if (typeof uid === "string" && uid) return uid;
    }
  }
  return model.id;
}

export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "swe-2",
    name: "SWE-2",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "swe-2-medium", high: "swe-2-high", xhigh: null, max: "swe-2-max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 262000,
    maxTokens: 128000,
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "claude-fable-5-1-low", medium: null, high: "claude-fable-5-1-high", xhigh: "claude-fable-5-1-xhigh", max: "claude-fable-5-1-max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "gpt-6-astra-low", medium: null, high: "gpt-6-astra-high", xhigh: "gpt-6-astra-xhigh", max: "gpt-6-astra-max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
  },
];

const routerCache = new Map<string, { uid: string; jwt: string }>();

export async function assignRouter(routerUid: string, cascadeId: string): Promise<{ uid: string; jwt: string } | null> {
  const key = `${routerUid}|${cascadeId}`;
  const hit = routerCache.get(key);
  if (hit) return hit;
  const { token } = requireToken();
  const body = Buffer.concat([
    encodeMessage(1, buildMetadata(token)),
    encodeString(2, routerUid),
    encodeString(3, cascadeId),
  ]);
  const t0 = Date.now();
  try {
    const raw = await connectUnary(ASSIGN_MODEL, body);
    let jwt = "";
    let uid = "";
    for (const f of iterFields(raw)) {
      if (f.num !== 1) continue;
      for (const inner of iterFields(fieldBuf(f))) {
        if (inner.num === 1) jwt = fieldString(inner);
        if (inner.num === 2) uid = fieldString(inner);
      }
    }
    if (!uid || !jwt) {
      log("router", "no-assignment", { routerUid, ms: Date.now() - t0 });
      return null;
    }
    const resolved = { uid, jwt };
    routerCache.set(key, resolved);
    log("router", "assigned", { routerUid, uid, ms: Date.now() - t0 });
    return resolved;
  } catch (err) {
    log("router", "fail", { routerUid, ms: Date.now() - t0, err: String(err).slice(0, 200) });
    return null;
  }
}

export { encodeMessage, encodeString };

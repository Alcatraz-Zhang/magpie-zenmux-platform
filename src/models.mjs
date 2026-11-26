import { api } from "./zenmux.mjs"

const chat = "chat.completions"
const protocols = {
  [chat]: { npm: "@ai-sdk/openai-compatible", url: api.openai },
  responses: { npm: "@ai-sdk/openai", url: api.openai },
  messages: { npm: "@ai-sdk/anthropic", url: api.anthropic },
  gemini: { npm: "@ai-sdk/google", url: api.vertex },
}

function planModels(plan) {
  if (!Array.isArray(plan?.models)) {
    throw new Error("ZenMux plan catalog: model entitlements are unavailable for this Builder tier.")
  }
  const limited = Array.isArray(plan.timeLimitedModels) ? plan.timeLimitedModels : []
  return new Set(plan.models.concat(limited).map(row => row?.model_slug).filter(id => typeof id === "string"))
}

export function allowedModels(plans, rawTier, hasPlatformKey) {
  const byTier = new Map(plans.map(plan => [plan?.planKey, plan]))
  if (hasPlatformKey) {
    const tier = typeof rawTier === "string" ? rawTier.toLowerCase().trim() : ""
    if (tier === "free") return new Set()
    return planModels(byTier.get(tier))
  }
  const paid = ["starter", "pro", "max", "ultra"].filter(tier => byTier.has(tier))
  if (!(paid.includes("starter") || paid.includes("pro")) || !paid.includes("max") || !paid.includes("ultra")) {
    throw new Error("ZenMux plan catalog: Builder tiers are unavailable. Add a Platform Key to select your tier.")
  }
  const [first, ...others] = paid.map(tier => planModels(byTier.get(tier)))
  return new Set([...first].filter(id => others.every(models => models.has(id))))
}

const modalities = ["text", "image", "audio", "video", "pdf"]
const flags = list => Object.fromEntries(modalities.map(kind => [
  kind, list.includes(kind) || (kind === "pdf" && list.includes("file")),
]))

function price(value) {
  if (typeof value === "string" && value.trim()) value = Number(value)
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function costOf(model, catalog) {
  const rates = model.pricings
  const listPrice = key => price(rates?.[key]?.find?.(rate => rate?.unit === "millionTokens")?.value)
  const input = price(catalog?.pricing_prompt) ?? listPrice("prompt")
  const output = price(catalog?.pricing_completion) ?? listPrice("completion")
  if (input === undefined || output === undefined) return undefined
  const discount = price(catalog?.pricing_discount)
  const factor = discount !== undefined && discount <= 1 ? discount : 1
  const read = price(catalog?.pricing_input_cache_read) ?? listPrice("input_cache_read") ?? 0
  const write = price(catalog?.pricing_input_cache_write) ?? listPrice("input_cache_write") ?? 0
  return { input: input * factor, output: output * factor, cache: { read: read * factor, write: write * factor } }
}

function protocolList(id, suitable) {
  const available = typeof suitable === "string" && suitable.trim()
    ? suitable.split(",").map(value => value.trim().toLowerCase()).filter(value => Object.hasOwn(protocols, value))
    : [chat]
  const preferred = id.startsWith("anthropic/") ? "messages"
    : id.startsWith("openai/") ? "responses" : id.startsWith("google/") ? "gemini" : chat
  const primary = available.includes(preferred) ? preferred : available[0]
  return [primary, ...new Set(available.filter(value => value !== primary))].filter(Boolean)
}

function toModel(model, catalog, providerID) {
  if (!model || typeof model.id !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(model.id) || catalog?.deleted) return null
  const inputs = model.input_modalities ?? catalog?.input_modalities ?? ["text"]
  const outputs = model.output_modalities ?? catalog?.output_modalities ?? ["text"]
  if (!Array.isArray(inputs) || !Array.isArray(outputs) || !outputs.includes("text")) return null
  const [primary, ...alternates] = protocolList(model.id, catalog?.suitable_api)
  if (!primary) return null
  const cost = costOf(model, catalog)
  const context = price(model.context_length) || price(catalog?.context_length)
  const output = price(catalog?.max_completion_tokens) || price(model.max_tokens)
  return {
    id: model.id,
    providerID,
    name: model.display_name || catalog?.name || model.id,
    api: { id: model.id, ...protocols[primary] },
    also: alternates.map(protocol => protocols[protocol].npm),
    status: "active",
    limit: { context: context ?? 0, output: output ?? 0 },
    ...(cost && { cost }),
    capabilities: {
      attachment: inputs.some(value => value !== "text"),
      reasoning: model.capabilities?.reasoning ?? Boolean(catalog?.supports_reasoning),
      toolcall: Boolean(catalog?.supports_tool_parameters),
      input: flags(inputs),
      output: flags(outputs),
    },
  }
}

export function listModels(listed, catalog, allowed, providerID) {
  const byId = new Map(catalog.map(entry => [entry?.slug, entry]))
  const models = []
  for (const raw of listed) {
    if (allowed && !allowed.has(raw?.id)) continue
    const model = toModel(raw, byId.get(raw?.id), providerID)
    if (model) models.push([model.id, model])
  }
  return Object.fromEntries(models)
}

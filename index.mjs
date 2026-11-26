import { api, inferenceFetch, readList, readPlatform } from "./src/zenmux.mjs"
import { allowedModels, listModels } from "./src/models.mjs"
import { builderUsage, paygUsage } from "./src/usage.mjs"

const builder = {
  id: "zenmux-builder",
  name: "ZenMux Builder Plan",
  label: "Builder Subscription Key",
  labelZh: "Builder 订阅 Key",
  hint: "sk-subs-…",
}
const payg = {
  id: "zenmux-payg",
  name: "ZenMux PAYG",
  label: "Pay As You Go Key",
  labelZh: "按量付费 Key",
  hint: "sk-payg-…",
}

const extraUsageOption = {
  key: "extra-usage",
  label: "Extra Usage via ZenMux",
  labels: { zh: "由 ZenMux 处理 Extra Usage" },
  description: "Match the Extra Usage switch in the ZenMux console. On lets ZenMux handle overage on the subscription key. Off lets Magpie use the quota for routing.",
  descriptions: { zh: "请与 ZenMux 控制台的 Extra Usage 开关保持一致。开启后，超额计费交给 ZenMux。关闭后，额度由 Magpie 用于路由。" },
  default: false,
  placement: "top",
}

const keyText = value => typeof value === "string" ? value.trim() : ""

function signIn(account) {
  return {
    type: "api",
    label: account.label,
    labels: { zh: account.labelZh },
    prompts: [
      {
        type: "password",
        key: "inferenceKey",
        message: account.label,
        messages: { zh: account.labelZh },
        placeholder: account.hint,
      },
      {
        type: "password",
        key: "platformKey",
        message: "Platform Key for usage monitoring (optional)",
        messages: { zh: "Platform Key（用于查询用量，可留空）" },
        placeholder: "sk-mgmt-…",
      },
    ],
    async authorize(inputs = {}) {
      const key = keyText(inputs.inferenceKey)
      if (!key) return { type: "failed", error: "Enter a ZenMux inference key." }
      const platformKey = keyText(inputs.platformKey)
      return { type: "success", key, ...(platformKey && { metadata: { platformKey } }) }
    },
  }
}

function providerPlugin(account, isBuilder, magpie) {
  const endpoint = isBuilder ? "subscription" : "balance"
  const formatUsage = isBuilder ? builderUsage : paygUsage

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[account.id] = {
        name: account.name,
        npm: "@ai-sdk/openai-compatible",
        api: api.openai,
        models: {},
      }
    },
    auth: {
      provider: account.id,
      methods: [signIn(account)],
      ...(isBuilder && { options: [extraUsageOption] }),
      async loader(getAuth) {
        if (!keyText((await getAuth())?.key)) return {}
        return {
          async fetch(input, init) {
            const key = keyText((await getAuth())?.key)
            if (!key) throw Object.assign(new Error("ZenMux inference key is missing."), { signIn: "expired" })
            return inferenceFetch(input, init, key)
          },
        }
      },
      async usage(getAuth, _provider, { signal } = {}) {
        const auth = await getAuth()
        const platformKey = keyText(auth?.metadata?.platformKey)
        const empty = { plan: account.name, windows: [], signIn: "kept" }
        if (!platformKey) {
          return { ...empty, error: "Add a Platform Key (sk-mgmt-…) to this sign-in to view ZenMux usage." }
        }
        try {
          const data = await readPlatform(endpoint, platformKey, signal)
          const extraUsage = isBuilder && magpie?.option?.(account.id, extraUsageOption.key) === true
          return formatUsage(data, extraUsage)
        } catch (error) {
          return { ...empty, error: error.message }
        }
      },
    },
    provider: {
      id: account.id,
      async models(_provider, { auth, signal } = {}) {
        const key = keyText(auth?.key)
        if (!key) return {}
        const platformKey = keyText(auth?.metadata?.platformKey)
        const [listed, metadata, tiers, detail] = await Promise.all([
          readList("models", key, signal),
          readList("catalog", "", signal).catch(() => []),
          isBuilder ? readList("plans", "", signal) : null,
          isBuilder && platformKey ? readPlatform("subscription", platformKey, signal) : null,
        ])
        const allowed = isBuilder ? allowedModels(tiers, detail?.plan?.tier, Boolean(platformKey)) : null
        return listModels(listed, metadata, allowed, account.id)
      },
    },
  }
}

export async function ZenMuxBuilder({ magpie } = {}) {
  return providerPlugin(builder, true, magpie)
}

export async function ZenMuxPayg() {
  return providerPlugin(payg, false)
}

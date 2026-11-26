const hour = 3600
const tiers = { free: "Free", starter: "Starter", pro: "Pro", max: "Max", ultra: "Ultra" }
const number = value => typeof value === "number" && Number.isFinite(value) ? value : undefined

function iso(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function quota(name, span, value, extraUsage) {
  if (!value || typeof value !== "object") return null
  const amount = number(value.used_flows)
  const limit = number(value.max_flows)
  const ratio = number(value.usage_percentage) ?? (limit > 0 && amount !== undefined ? amount / limit : undefined)
  return {
    name,
    span,
    used: ratio === undefined ? null : Math.round(Math.max(0, ratio) * 10000) / 100,
    resetsAt: iso(value.resets_at),
    amount,
    limit,
    unit: "flows",
    // Magpie keeps the quota in routing but allows overage when credits
    // are present. Older hosts understand the informational aside flag.
    credits: extraUsage,
    aside: extraUsage,
  }
}

const accountWarnings = {
  monitored: "unusual usage detected, service remains available",
  abusive: "usage restrictions applied",
  suspended: "account suspended",
  banned: "account banned",
}

export function builderUsage(detail, extraUsage) {
  const tier = detail.plan?.tier
  const until = iso(detail.plan?.expires_at)
  const windows = [
    quota("5 hours", 5 * hour, detail.quota_5_hour, extraUsage),
    quota("7 days", 7 * 24 * hour, detail.quota_7_day, extraUsage),
  ].filter(Boolean)
  const count = detail.quota_5_hour?.remaining_resets
  const status = detail.account_status
  const warnings = []
  if (Object.hasOwn(accountWarnings, status)) {
    warnings.push(`ZenMux account status: ${status} (${accountWarnings[status]}).`)
  } else if (typeof status === "string" && status !== "healthy") {
    warnings.push("ZenMux reported an unrecognized account status. Check the ZenMux console.")
  }
  const base = number(detail.base_usd_per_flow)
  const effective = number(detail.effective_usd_per_flow)
  if (base > 0 && effective > base) {
    warnings.push(`ZenMux is applying a higher Flow rate ($${effective} per Flow).`)
  }
  const quotaRead = windows.length > 0
  if (warnings.length) windows.push({ name: "Account status", display: warnings.join(" "), aside: true })
  return {
    plan: Object.hasOwn(tiers, tier) ? `ZenMux Builder · ${tiers[tier]}` : "ZenMux Builder Plan",
    until,
    windows,
    signIn: "kept",
    ...(Number.isInteger(count) && count >= 0 && { resets: { count, byWindow: true, fiveHour: count, until } }),
    ...(!quotaRead && { error: "ZenMux did not return rolling quota data." }),
  }
}

export function paygUsage(balance) {
  const credits = number(balance.total_credits)
  if (credits === undefined) throw new Error("ZenMux PAYG balance: credits are unavailable.")
  return { plan: "ZenMux PAYG", balance: `$${credits.toFixed(2)}`, windows: [], signIn: "kept" }
}

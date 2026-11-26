import assert from "node:assert/strict"
import { test } from "node:test"

import { ZenMuxBuilder, ZenMuxPayg } from "../index.mjs"

const origin = "https://zenmux.ai"
const models = "/api/v1/models"
const catalog = "/api/frontend/model/available/list"
const plans = "/api/subscription/public/get_all_plans"
const subscription = "/api/v1/management/subscription/detail"
const balance = "/api/v1/management/payg/balance"
const ids = ["openai/gpt-5.6-sol", "anthropic/claude-opus-4.8", "google/gemini-3.8-flash", "vendor/payg-only"]
const [gpt, claude, gemini, paygOnly] = ids
const wrap = data => ({ success: true, data })
const plan = (planKey, ids, limited = []) => ({
  planKey,
  models: ids.map(model_slug => ({ model_slug })),
  timeLimitedModels: limited.map(model_slug => ({ model_slug })),
})
const reset5h = "2030-02-03T04:10:00.000Z"
const reset7d = "2030-02-09T04:10:00.000Z"
const detail = {
  plan: { tier: "pro", expires_at: "2030-03-01T00:00:00Z" },
  account_status: "monitored",
  quota_5_hour: { max_flows: 100, used_flows: 100, usage_percentage: 1, resets_at: reset5h, remaining_resets: 0 },
  quota_7_day: { max_flows: 1000, used_flows: 71.5, usage_percentage: 0.0715, resets_at: reset7d },
}
function network(t, routes) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    url = new URL(url)
    assert.equal(url.origin, origin)
    const headers = new Headers(options.headers)
    calls.push({ url, headers, options })
    assert.ok(Object.hasOwn(routes, url.pathname), url.pathname)
    const value = routes[url.pathname]
    return typeof value === "function" ? value({ url, headers, options }) : Response.json(value)
  })
  return calls
}

test("Magpie uses its native API Key form after the optional Platform Key prompt", async () => {
  for (const [entry, id, hint] of [[ZenMuxBuilder, "zenmux-builder", "sk-subs-"], [ZenMuxPayg, "zenmux-payg", "sk-payg-"]]) {
    const { auth } = await entry()
    assert.equal(auth.provider, id)
    const [method] = auth.methods
    assert.equal(method.type, "api")
    assert.equal(method.authorize, undefined, "Magpie must submit from its native API Key form")
    assert.equal(method.placeholder, hint + "…")
    const [platform] = method.prompts
    assert.equal(method.prompts.length, 1)
    assert.equal(platform.key, "platformKey")
    assert.equal(platform.type, "password")
    assert.equal(platform.placeholder, "sk-mgmt-…")
    assert.equal(platform.validate, undefined)
  }
})

test("Builder reports native overage credits only when ZenMux Extra Usage is enabled", async t => {
  let enabled = true
  const { auth } = await ZenMuxBuilder({
    magpie: { option: (id, key) => id === "zenmux-builder" && key === "extra-usage" && enabled },
  })
  assert.equal(auth.options[0].key, "extra-usage")
  assert.equal(auth.options[0].default, false)
  assert.match(auth.options[0].description, /ZenMux console/)
  const calls = network(t, { [subscription]: wrap(detail) })
  const usage = await auth.usage(async () => ({ key: "inference", metadata: { platformKey: "platform" } }))
  assert.deepEqual(usage.windows.filter(w => w.span).map(w => [w.used, w.resetsAt, w.span, w.aside, w.credits]), [
    [100, reset5h, 18000, true, true], [7.15, reset7d, 604800, true, true],
  ])
  assert.equal(usage.resets.fiveHour, 0)
  assert.equal(usage.resets.until, "2030-03-01T00:00:00.000Z")
  assert.equal(usage.error, undefined, "An account warning must not turn a valid quota read into a failure")
  assert.match(usage.windows.find(w => w.name === "Account status")?.display, /monitored/)
  assert.equal(usage.signIn, "kept")
  assert.equal(calls[0].headers.get("authorization"), "Bearer platform")
  enabled = false
  const magpieUsage = await auth.usage(async () => ({ key: "inference", metadata: { platformKey: "platform" } }))
  assert.ok(magpieUsage.windows.filter(w => w.span).every(w => w.aside === false && w.credits === false))
  assert.equal(magpieUsage.windows[0].used, 100)
  assert.equal((await ZenMuxPayg()).auth.options, undefined)
})

test("PAYG distinguishes zero balance from a refused Platform key", async t => {
  const { auth } = await ZenMuxPayg()
  network(t, { [balance]: ({ headers }) => headers.get("authorization") === "Bearer platform"
    ? Response.json(wrap({ total_credits: 0, currency: "usd" }))
    : Response.json({ error: "private content" }, { status: 401 }) })
  const usage = key => auth.usage(async () => ({ key: "inference", metadata: { platformKey: key } }))
  assert.equal((await usage("platform")).balance, "$0.00")
  const denied = await usage("wrong-key")
  assert.equal(denied.signIn, "kept")
  assert.match(denied.error, /Platform Key.*401/)
  assert.doesNotMatch(denied.error, /private content|wrong-key/)
  assert.match((await usage("")).error, /sk-mgmt-/)
})

test("Builder filters to the effective tier including limited models, separately from PAYG", async t => {
  const calls = network(t, {
    [models]: { data: ids.map(id => ({ id, output_modalities: ["text"], context_length: 128000 })) },
    [catalog]: wrap([
      { slug: gpt, suitable_api: "responses,chat.completions,messages" },
      { slug: claude, suitable_api: "chat.completions,messages,responses" },
      { slug: gemini, suitable_api: "gemini,chat.completions" },
      { slug: paygOnly, suitable_api: "chat.completions", pricing_prompt: "0", pricing_completion: "0" },
    ]),
    [plans]: wrap([plan("pro", [gpt], [claude]), plan("starter", [gpt]), plan("max", [gpt, gemini]), plan("ultra", [gpt, claude, gemini])]),
    [subscription]: wrap(detail),
  })
  const builder = (await ZenMuxBuilder()).provider
  const payg = (await ZenMuxPayg()).provider
  const selected = await builder.models({}, { auth: { key: "sub", metadata: { platformKey: "platform" } } })
  assert.deepEqual(Object.keys(selected), [gpt, claude])
  assert.equal(selected[gpt].api.npm, "@ai-sdk/openai")
  assert.deepEqual(selected[gpt].also, ["@ai-sdk/openai-compatible", "@ai-sdk/anthropic"])
  assert.equal(selected[claude].api.npm, "@ai-sdk/anthropic")
  const all = await payg.models({}, { auth: { key: "payg" } })
  assert.deepEqual(Object.keys(all), ids)
  assert.equal(all[gemini].api.npm, "@ai-sdk/google")
  assert.deepEqual(Object.keys(await builder.models({}, { auth: { key: "sub" } })), [gpt])
  assert.deepEqual(await builder.models({}, {}), {})
  assert.deepEqual(calls.filter(c => c.url.pathname === models).map(c => c.headers.get("authorization")),
    ["Bearer sub", "Bearer payg", "Bearer sub"])
  assert.ok(calls.filter(c => [catalog, plans].includes(c.url.pathname)).every(c => !c.headers.has("authorization")))
})

test("Builder fails visibly when the plan catalog is unavailable", async t => {
  network(t, { [models]: { data: [] }, [catalog]: wrap([]), [plans]: () => new Response(null, { status: 503 }) })
  const { provider } = await ZenMuxBuilder()
  await assert.rejects(provider.models({}, { auth: { key: "sub" } }), /plan catalog.*503/i)
})

test("Native protocols keep credentials, bodies and SSE on their intended endpoints", async t => {
  let key = "first"
  const { auth } = await ZenMuxBuilder()
  const target = ["/api/v1/responses", "/api/v1/chat/completions", "/api/anthropic/v1/messages",
    "/api/vertex-ai/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent"]
  const calls = network(t, Object.fromEntries(target.map(path =>
    [path, () => new Response("data: abc\n\n", { headers: { "content-type": "text/event-stream" } })])))
  const loader = await auth.loader(async () => ({ key, metadata: { platformKey: "platform" } }))
  key = "second"
  const body = JSON.stringify({ model: gpt, stream: true })
  const init = { method: "POST", body, redirect: "follow",
    headers: { "content-type": "application/json", authorization: "foreign", "x-api-key": "foreign", "x-goog-api-key": "foreign", "anthropic-beta": "example" } }
  for (const path of ["/api/anthropic/v1/responses", "/api/vertex-ai/v1/chat/completions", "/api/v1/messages", "/api/v1/models/google/gemini-3.8-flash:streamGenerateContent?alt=sse&key=foreign"]) {
    const result = await loader.fetch(origin + path, init)
    assert.equal(result.headers.get("content-type"), "text/event-stream")
    assert.equal(await result.text(), "data: abc\n\n")
  }
  assert.deepEqual(calls.map(c => c.url.pathname), target)
  assert.deepEqual(calls.map(c => [c.headers.get("authorization"), c.headers.get("x-api-key"), c.url.search]), [
    ["Bearer second", null, ""], ["Bearer second", null, ""], [null, "second", ""], ["Bearer second", null, "?alt=sse"],
  ])
  assert.equal(calls[2].headers.get("anthropic-beta"), "example")
  assert.equal(calls[2].headers.get("anthropic-version"), "2023-06-01")
  for (const { options, headers } of calls) {
    assert.equal(options.redirect, "error")
    assert.ok(!headers.has("x-goog-api-key"))
    assert.equal(options.body, body)
  }
})

test("Inference rejects non-ZenMux URLs and management paths before sending keys", async t => {
  const calls = network(t, {})
  const { auth } = await ZenMuxPayg()
  const loader = await auth.loader(async () => ({ key: "payg" }))
  for (const url of ["https://example.invalid/api/v1/responses", "http://zenmux.ai/api/v1/responses",
    "https://zenmux.ai:8443/api/v1/responses", "https://user@zenmux.ai/api/v1/responses",
    origin + subscription, origin + "/api/v1/a/responses"]) {
    await assert.rejects(loader.fetch(url, { method: "POST" }), /ZenMux.*(endpoint|destination)/i)
  }
  assert.equal(calls.length, 0)
})

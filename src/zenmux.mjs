const origin = "https://zenmux.ai"
export const api = {
  openai: origin + "/api/v1",
  anthropic: origin + "/api/anthropic/v1",
  vertex: origin + "/api/vertex-ai/v1",
}

const endpoints = {
  models: [api.openai + "/models", "model list", "inference key"],
  catalog: [origin + "/api/frontend/model/available/list", "public model metadata"],
  plans: [origin + "/api/subscription/public/get_all_plans", "plan catalog"],
  subscription: [api.openai + "/management/subscription/detail", "subscription details", "Platform Key"],
  balance: [api.openai + "/management/payg/balance", "PAYG balance", "Platform Key"],
}

async function readData(endpoint, key, signal, valid) {
  const [url, label, credential] = endpoints[endpoint]
  const timeout = AbortSignal.timeout(8000)
  let response
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...(key && { authorization: `Bearer ${key}` }) },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    throw new Error(`ZenMux ${label}: request failed or timed out.`)
  }
  if (!response.ok) {
    const denied = (response.status === 401 || response.status === 403) && credential
    const reason = denied ? `${credential} refused (HTTP ${response.status}).` : `HTTP ${response.status}.`
    const error = new Error(`ZenMux ${label}: ${reason}`)
    if (endpoint === "models" && response.status === 401) error.signIn = "expired"
    await response.body?.cancel().catch(() => {})
    throw error
  }

  const json = await response.json().catch(() => null)
  if (json?.success === false || !valid(json?.data)) {
    throw new Error(`ZenMux ${label}: unexpected API response.`)
  }
  return json.data
}

export function readList(endpoint, key, signal) {
  return readData(endpoint, key, signal, Array.isArray)
}

export function readPlatform(endpoint, key, signal) {
  return readData(endpoint, key, signal, data => data !== null && typeof data === "object" && !Array.isArray(data))
}

const chatPaths = {
  "/chat/completions": api.openai + "/chat/completions",
  "/responses": api.openai + "/responses",
  "/messages": api.anthropic + "/messages",
  "/messages/count_tokens": api.anthropic + "/messages/count_tokens",
}
const modelSegment = "[a-z0-9][a-z0-9._-]*"
const geminiPath = new RegExp(`^/(?:publishers/(${modelSegment})/models/|models/(?:(${modelSegment})/)?)(${modelSegment}):(streamGenerateContent|generateContent)$`, "i")

function targetOf(input) {
  let requested
  try {
    requested = new URL(input instanceof Request ? input.url : input)
  } catch {
    throw new Error("Invalid ZenMux inference destination.")
  }
  if (requested.origin !== origin || requested.username || requested.password) {
    throw new Error("Invalid ZenMux inference destination.")
  }
  const path = requested.pathname.replace(/^\/(?:api\/(?:anthropic\/|vertex-ai\/)?)?v1(?=\/)/, "")
  if (Object.hasOwn(chatPaths, path)) {
    return { url: chatPaths[path], anthropic: path.startsWith("/messages") }
  }
  const vertex = geminiPath.exec(path)
  if (vertex) {
    const [, publisher, vendor, model, action] = vertex
    const query = action === "streamGenerateContent" ? "?alt=sse" : ""
    return { url: `${api.vertex}/publishers/${publisher ?? vendor ?? "google"}/models/${model}:${action}${query}` }
  }
  throw new Error("Unsupported ZenMux inference endpoint.")
}

export function inferenceFetch(input, init, key) {
  const { url, anthropic } = targetOf(input)
  const request = input instanceof Request ? input : null
  const method = init?.method ?? request?.method ?? "GET"
  if (method.toUpperCase() !== "POST") throw new Error("ZenMux inference endpoint requires POST.")

  const supplied = new Headers(init?.headers ?? request?.headers)
  const headers = new Headers()
  for (const name of ["accept", "content-type", "last-event-id", ...(anthropic ? ["anthropic-beta", "anthropic-version"] : ["openai-beta"])]) {
    if (supplied.has(name)) headers.set(name, supplied.get(name))
  }
  if (anthropic) {
    headers.set("x-api-key", key)
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  } else {
    headers.set("authorization", `Bearer ${key}`)
  }

  const body = init?.body !== undefined ? init.body : request?.body
  return fetch(url, {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream && { duplex: "half" }),
    signal: init?.signal ?? request?.signal,
    redirect: "error",
  })
}

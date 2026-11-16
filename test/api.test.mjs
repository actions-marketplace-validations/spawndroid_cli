import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"

import { createApi } from "../src/api.mjs"

async function consoleWith(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost")
    const status = routes[url.pathname]
    if (status === undefined) {
      response.writeHead(404, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ code: "SESSION_NOT_FOUND", detail: "Session not found." }))
      return
    }
    response.writeHead(status[0], { "Content-Type": "application/json" })
    response.end(JSON.stringify(status[1] ?? {}))
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

test("whoami answers with the scope and plan", async () => {
  const consoleState = await consoleWith({
    "/api/v1/whoami": [200, { scope: "upload", plan: "free", planLabel: "Hobby" }],
  })
  try {
    const api = createApi({ baseUrl: consoleState.baseUrl, apiKey: "test" })
    const probe = await api.probe()
    assert.equal(probe.ok, true)
    assert.equal(probe.scope, "upload")
    assert.equal(probe.planLabel, "Hobby")
  } finally {
    await consoleState.close()
  }
})

test("a deployment without whoami falls back to the session probe", async () => {
  // `/whoami` missing (404) and the unknown session also 404: a valid key.
  const consoleState = await consoleWith({})
  try {
    const api = createApi({ baseUrl: consoleState.baseUrl, apiKey: "test" })
    const probe = await api.probe()
    assert.equal(probe.ok, true)
    assert.equal(probe.scope, null)
  } finally {
    await consoleState.close()
  }
})

test("a rejected key fails both probes", async () => {
  const consoleState = await consoleWith({})
  try {
    const api = createApi({
      baseUrl: consoleState.baseUrl,
      apiKey: "bad",
      fetchImpl: async (url, init) => {
        void init
        return new Response(
          JSON.stringify({ detail: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      },
    })
    const probe = await api.probe()
    assert.equal(probe.ok, false)
  } finally {
    await consoleState.close()
  }
})

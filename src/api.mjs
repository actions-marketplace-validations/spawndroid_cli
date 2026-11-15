/**
 * HTTP client for the Spawndroid console API.
 *
 * Thin on purpose: every method maps to one documented endpoint, and the only
 * parsing it does is of problem+json error bodies so callers can branch on the
 * machine-readable `code` instead of the message.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { randomUUID } from "node:crypto"

export class ApiError extends Error {
  constructor(status, body, path) {
    const detail =
      (body && (body.detail || body.error || body.title)) || `HTTP ${status}`
    super(`${status} ${detail}`)
    this.name = "ApiError"
    this.status = status
    this.code = body?.code ?? null
    this.legacyCode = body?.legacyCode ?? null
    this.body = body ?? null
    this.path = path
  }
}

export function createApi({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const root = baseUrl.replace(/\/$/, "")

  async function request(path, init = {}) {
    const headers = { Accept: "application/json", ...(init.headers ?? {}) }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetchImpl(`${root}${path}`, { ...init, headers })
    if (response.status === 204) return null
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, body, path)
    return body
  }

  return {
    baseUrl: root,

    /**
     * Validate the key without spending anything: an unknown session is a 404
     * for a valid key and a 401/403 for a bad or under-scoped one.
     */
    async probe() {
      try {
        await request(`/api/v1/sessions/probe-${randomUUID()}`)
        return { ok: true }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { ok: true }
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          return { ok: false, error }
        }
        throw error
      }
    },

    async uploadApk(file) {
      const bytes = await readFile(file)
      const form = new FormData()
      form.append("file", new Blob([bytes]), basename(file))
      const body = await request("/api/apps", { method: "POST", body: form })
      return body?.app
    },

    async createSession(fields, idempotencyKey) {
      return request("/api/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(fields),
      })
    },

    async getSession(id) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}`)
    },

    async endSession(id, result) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      })
    },

    async presignFile(id, { filename, path, size }) {
      return request(
        `/api/v1/sessions/${encodeURIComponent(id)}/files/presign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, path, size }),
        }
      )
    },

    async putFile(url, bytes, contentType) {
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: { "Content-Type": contentType ?? "application/octet-stream" },
        body: bytes,
      })
      if (!response.ok) throw new ApiError(response.status, null, "presigned PUT")
    },

    async commitFile(id, fields) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
    },

    async postReport(id, xml) {
      return request(`/api/v1/sessions/${encodeURIComponent(id)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      })
    },
  }
}

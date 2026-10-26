import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://rubegt.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];
const UPSTREAM_ORIGIN = "https://totaljerkface.com/";
const ALLOWED_ROUTES = new Set(["/get_level.hw", "/replay.hw", "/user.hw"]);
const MAX_BODY_SIZE = 1024 * 1024;

function getAllowedOrigins(value = process.env.ALLOWED_ORIGINS) {
  return new Set(
    (value || DEFAULT_ALLOWED_ORIGINS.join(","))
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }

  if (size > MAX_BODY_SIZE) {
    throw new RangeError("Request body is too large");
  }

  return Buffer.concat(chunks);
}

export function createServer({
  allowedOrigins = getAllowedOrigins(),
  fetchImpl = fetch,
  upstreamOrigin = UPSTREAM_ORIGIN
} = {}) {
  return createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const origin = request.headers.origin;

    if (origin && !allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: "Origin is not allowed" });
      return;
    }

    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (!ALLOWED_ROUTES.has(requestUrl.pathname)) {
      sendJson(response, 404, { error: "Route not found" });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("allow", "POST, OPTIONS");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      sendJson(response, 415, { error: "Expected form-encoded request data" });
      return;
    }

    let body;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      if (error instanceof RangeError) {
        sendJson(response, 413, { error: error.message });
        return;
      }
      console.error("Failed to read upstream request body:", error);
      sendJson(response, 400, { error: "Could not read request body" });
      return;
    }

    try {
      const upstreamUrl = new URL(requestUrl.pathname.slice(1), upstreamOrigin);
      const upstreamRequest = {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        signal: AbortSignal.timeout(20_000)
      };
      let upstreamResponse = await fetchImpl(upstreamUrl, upstreamRequest);
      let responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      const action = new URLSearchParams(body.toString()).get("action");

      if (
        requestUrl.pathname === "/get_level.hw" &&
        ((action === "get_cmb_by_user" &&
          responseBody.toString("utf8").startsWith("failure:not_logged_in")) ||
          (action === "get_all" && responseBody.length === 0))
      ) {
        const fallbackBody = new URLSearchParams(body.toString());
        fallbackBody.set("action", "get_featured");
        upstreamResponse = await fetchImpl(upstreamUrl, {
          ...upstreamRequest,
          body: Buffer.from(fallbackBody.toString())
        });
        responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      }

      response.writeHead(upstreamResponse.status, {
        "content-type": upstreamResponse.headers.get("content-type") || "application/xml; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(responseBody);
    } catch (error) {
      console.error(`Upstream request failed for ${requestUrl.pathname}:`, error);
      sendJson(response, 502, { error: "The level service is temporarily unavailable" });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`Level API listening on port ${port}`);
  });
}

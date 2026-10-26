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
const MAX_BODY_SIZE = 13 * 1024 * 1024;
const MAX_LEVEL_XML_LENGTH = 512 * 1024;
const LEVEL_LIST_LIMIT = 100;
const CUSTOM_LEVEL_ID_MIN = 1_900_000_000;

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

function sendSupabaseError(response, status, body) {
  const message = body?.msg || body?.message || body?.error_description || body?.error;
  sendJson(response, status, { error: typeof message === "string" ? message : "Account service request failed" });
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

async function readJsonRequest(request) {
  const body = await readRequestBody(request);
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SyntaxError("Expected a JSON object");
    }
    return value;
  } catch {
    throw new SyntaxError("Expected a JSON request body");
  }
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] || null;
}

function getGameUserId(userId) {
  let hash = 2166136261;
  for (const character of userId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) % 2_147_483_646 + 1;
}

function isValidLevelXml(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_LEVEL_XML_LENGTH &&
    /^\s*<levelXML(?:\s|>)/i.test(value) &&
    /<\/levelXML>\s*$/i.test(value) &&
    !/<!DOCTYPE|<!ENTITY/i.test(value)
  );
}

function decodeEncodedBase64(value) {
  if (typeof value !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(decoded)) {
    return null;
  }
  return Buffer.from(decoded, "base64");
}

function xmlAttribute(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlCdata(value) {
  const safeValue = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
  return `<![CDATA[${safeValue.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function createServer({
  allowedOrigins = getAllowedOrigins(),
  fetchImpl = fetch,
  upstreamOrigin = UPSTREAM_ORIGIN,
  supabaseFetchImpl = fetch,
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAuthRedirectUrl =
    process.env.SUPABASE_AUTH_REDIRECT_URL || "https://rubegt.github.io/Wheels-Happy2/"
} = {}) {
  const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey);
  const supabaseBaseUrl = supabaseUrl?.replace(/\/+$/, "");

  async function callSupabase(path, options = {}) {
    const url = new URL(path, `${supabaseBaseUrl}/`);
    const { apiKey, ...requestOptions } = options;
    const response = await supabaseFetchImpl(url, {
      ...requestOptions,
      headers: {
        apikey: apiKey || supabaseAnonKey,
        ...(requestOptions.headers || {})
      },
      signal: AbortSignal.timeout(20_000)
    });
    const rawBody = await response.text();
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = rawBody;
    }
    return { response, body };
  }

  function requireSupabase(response) {
    if (supabaseConfigured) return true;
    sendJson(response, 503, { error: "Account and level publishing are not configured yet" });
    return false;
  }

  async function getAuthenticatedUser(request) {
    const token = getBearerToken(request);
    if (!token) return { error: "Sign in to continue", status: 401 };
    const { response, body } = await callSupabase("/auth/v1/user", {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      return { error: "Your session is invalid or expired. Please sign in again.", status: 401 };
    }
    return { user: body };
  }

  async function getCustomLevel(id) {
    const params = new URLSearchParams({
      select: "id,author_id,author_name,title,user_comment,playable_character,level_xml,level_record,published",
      id: `eq.${id}`,
      limit: "1"
    });
    const { response, body } = await callSupabase(`/rest/v1/game_levels?${params}`, {
      apiKey: supabaseServiceRoleKey,
      headers: { authorization: `Bearer ${supabaseServiceRoleKey}` }
    });
    if (!response.ok) throw new Error("Could not load the saved level");
    return Array.isArray(body) ? body[0] || null : null;
  }

  async function getPublishedLevelXml() {
    const params = new URLSearchParams({
      select: "id,author_id,author_name,title,user_comment,playable_character,published_at",
      published: "eq.true",
      order: "published_at.desc",
      limit: String(LEVEL_LIST_LIMIT)
    });
    const { response, body } = await callSupabase(`/rest/v1/game_levels?${params}`, {
      apiKey: supabaseServiceRoleKey,
      headers: { authorization: `Bearer ${supabaseServiceRoleKey}` }
    });
    if (!response.ok) throw new Error("Could not load published levels");
    if (!Array.isArray(body) || body.length === 0) return "";
    const records = body.map((level) => {
      const publishDate = new Date(level.published_at || Date.now()).toISOString().slice(0, 10);
      return `<lv id="${xmlAttribute(level.id)}" ln="${xmlAttribute(level.title)}" pc="${xmlAttribute(level.playable_character)}" ps="0" rg="0" ui="${getGameUserId(level.author_id)}" un="${xmlAttribute(level.author_name)}" vs="0" df="${publishDate}" dp="${publishDate}"><uc>${xmlCdata(level.user_comment)}</uc></lv>`;
    });
    return records.join("");
  }

  async function saveGameLevel(request, form, action, response) {
    if (!supabaseConfigured) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("failure:account_service_unavailable");
      return true;
    }
    const auth = await getAuthenticatedUser(request);
    if (auth.error) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("failure:not_logged_in");
      return true;
    }
    const serviceHeaders = {
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=representation"
    };
    if (action === "create" || action === "update") {
      const title = form.get("level_name")?.trim();
      const comment = form.get("user_comment") || "";
      const levelXml = form.get("levelXML");
      const levelRecord = decodeEncodedBase64(form.get("level_record"));
      const character = Number(form.get("playable_character"));
      if (
        !title ||
        title.length > 100 ||
        comment.length > 1000 ||
        !isValidLevelXml(levelXml) ||
        !levelRecord ||
        levelRecord.length === 0 ||
        levelRecord.length > MAX_LEVEL_XML_LENGTH ||
        !Number.isInteger(character) ||
        character < 0 ||
        character > 20
      ) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("failure:bad_param");
        return true;
      }
      const authorName =
        (typeof auth.user.user_metadata?.username === "string"
          ? auth.user.user_metadata.username
          : auth.user.email?.split("@")[0]
        )?.trim().slice(0, 64) || "Player";
      const record = {
        author_id: auth.user.id,
        author_name: authorName,
        title,
        user_comment: comment,
        playable_character: character,
        level_xml: levelXml,
        level_record: levelRecord.toString("base64")
      };
      let url;
      let options;
      if (action === "create") {
        url = "/rest/v1/game_levels?select=id";
        options = {
          method: "POST",
          apiKey: supabaseServiceRoleKey,
          headers: serviceHeaders,
          body: JSON.stringify(record)
        };
      } else {
        const id = form.get("level_id");
        if (!/^\d+$/.test(id || "") || Number(id) < CUSTOM_LEVEL_ID_MIN) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("failure:bad_param");
          return true;
        }
        const existing = await getCustomLevel(id);
        if (!existing || existing.author_id !== auth.user.id) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("failure:not_logged_in");
          return true;
        }
        const params = new URLSearchParams({ id: `eq.${id}`, author_id: `eq.${auth.user.id}` });
        url = `/rest/v1/game_levels?${params}`;
        options = {
          method: "PATCH",
          apiKey: supabaseServiceRoleKey,
          headers: { ...serviceHeaders, prefer: "return=representation" },
          body: JSON.stringify({
            title,
            user_comment: comment,
            playable_character: character,
            level_xml: levelXml,
            level_record: record.level_record,
            updated_at: new Date().toISOString()
          })
        };
      }
      const { response: saveResponse, body: saved } = await callSupabase(url, options);
      if (!saveResponse.ok) {
        sendSupabaseError(response, saveResponse.status, saved);
        return true;
      }
      if (action === "update" && (!Array.isArray(saved) || saved.length === 0)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("failure:level_not_found");
        return true;
      }
      const savedId = action === "create" ? saved?.[0]?.id : form.get("level_id");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`success:${savedId}`);
      return true;
    }

    if (action === "publish") {
      const id = form.get("level_id");
      if (!/^\d+$/.test(id || "") || Number(id) < CUSTOM_LEVEL_ID_MIN) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("failure:bad_param");
        return true;
      }
      const params = new URLSearchParams({ id: `eq.${id}`, author_id: `eq.${auth.user.id}` });
      const { response: publishResponse, body: result } = await callSupabase(
        `/rest/v1/game_levels?${params}`,
        {
          method: "PATCH",
          apiKey: supabaseServiceRoleKey,
          headers: { ...serviceHeaders, prefer: "return=representation" },
          body: JSON.stringify({ published: true, published_at: new Date().toISOString() })
        }
      );
      if (!publishResponse.ok) {
        sendSupabaseError(response, publishResponse.status, result);
        return true;
      }
      if (!Array.isArray(result) || result.length === 0) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("failure:not_logged_in");
        return true;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`success:${id}`);
      return true;
    }

    return false;
  }

  async function saveGameRating(request, form, response) {
    if (!supabaseConfigured) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("failure:account_service_unavailable");
      return true;
    }
    const auth = await getAuthenticatedUser(request);
    if (auth.error) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("failure:not_logged_in");
      return true;
    }
    const levelId = form.get("level_id");
    const rating = Number(form.get("rating"));
    if (
      !/^\d+$/.test(levelId || "") ||
      BigInt(levelId) > BigInt(2_147_483_647) ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("failure:bad_param");
      return true;
    }
    const { response: saveResponse, body } = await callSupabase(
      "/rest/v1/level_ratings?on_conflict=author_id%2Clevel_id",
      {
        method: "POST",
        apiKey: supabaseServiceRoleKey,
        headers: {
          authorization: `Bearer ${supabaseServiceRoleKey}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify({ author_id: auth.user.id, level_id: levelId, rating })
      }
    );
    if (!saveResponse.ok) sendSupabaseError(response, saveResponse.status, body);
    else {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("success");
    }
    return true;
  }

  async function handleApiRequest(request, response, requestUrl) {
    const path = requestUrl.pathname;
    const isAuthRoute = path.startsWith("/api/auth/");
    const replayMatch = /^\/api\/me\/replays\/(\d+)$/.exec(path);
    const isAccountRoute =
      path === "/api/me/levels" || path === "/api/me/replays" || Boolean(replayMatch);
    if (!isAuthRoute && !isAccountRoute) return false;

    if (!requireSupabase(response)) return true;

    try {
      if (
        request.method === "POST" &&
        path !== "/api/auth/logout" &&
        !(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")
      ) {
        sendJson(response, 415, { error: "Expected a JSON request body" });
        return true;
      }

      if (path === "/api/auth/signup" && request.method === "POST") {
        const body = await readJsonRequest(request);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const username = typeof body.username === "string" ? body.username.trim() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(response, 400, { error: "Enter a valid email address" });
          return true;
        }
        if (password.length < 8 || password.length > 128) {
          sendJson(response, 400, { error: "Password must be between 8 and 128 characters" });
          return true;
        }
        if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
          sendJson(response, 400, { error: "Username must be 3-24 letters, numbers, underscores, or hyphens" });
          return true;
        }
        const { response: upstreamResponse, body: result } = await callSupabase(
          `/auth/v1/signup?redirect_to=${encodeURIComponent(supabaseAuthRedirectUrl)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, data: { username } })
          }
        );
        if (!upstreamResponse.ok) {
          sendSupabaseError(response, upstreamResponse.status, result);
          return true;
        }
        sendJson(response, 201, result);
        return true;
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        const body = await readJsonRequest(request);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password || password.length > 128) {
          sendJson(response, 400, { error: "Enter your email and password" });
          return true;
        }
        const { response: upstreamResponse, body: result } = await callSupabase(
          "/auth/v1/token?grant_type=password",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password })
          }
        );
        if (!upstreamResponse.ok) {
          sendSupabaseError(response, upstreamResponse.status, result);
          return true;
        }
        sendJson(response, 200, result);
        return true;
      }

      if (path === "/api/auth/me" && request.method === "GET") {
        const auth = await getAuthenticatedUser(request);
        if (auth.error) sendJson(response, auth.status, { error: auth.error });
        else sendJson(response, 200, auth.user);
        return true;
      }

      if (path === "/api/auth/logout" && request.method === "POST") {
        const token = getBearerToken(request);
        if (!token) {
          sendJson(response, 401, { error: "Sign in to continue" });
          return true;
        }
        const { response: upstreamResponse, body: result } = await callSupabase("/auth/v1/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` }
        });
        if (!upstreamResponse.ok) sendSupabaseError(response, upstreamResponse.status, result);
        else sendJson(response, 200, { status: "signed_out" });
        return true;
      }

      if (isAccountRoute && request.method === "GET") {
        const auth = await getAuthenticatedUser(request);
        if (auth.error) {
          sendJson(response, auth.status, { error: auth.error });
          return true;
        }
        if (replayMatch) {
          const params = new URLSearchParams({
            select: "id,level_id,replay_record,encrypted_meta,encryption_iv,created_at",
            id: `eq.${replayMatch[1]}`,
            author_id: `eq.${auth.user.id}`,
            limit: "1"
          });
          const { response: replayResponse, body: replayResult } = await callSupabase(
            `/rest/v1/replays?${params}`,
            {
              apiKey: supabaseServiceRoleKey,
              headers: { authorization: `Bearer ${supabaseServiceRoleKey}` }
            }
          );
          if (!replayResponse.ok) sendSupabaseError(response, replayResponse.status, replayResult);
          else if (!Array.isArray(replayResult) || replayResult.length === 0) {
            sendJson(response, 404, { error: "Replay not found" });
          } else sendJson(response, 200, replayResult[0]);
          return true;
        }
        const table = path.endsWith("/levels") ? "game_levels" : "replays";
        const columns =
          table === "game_levels"
            ? "id,title,user_comment,published,published_at,created_at"
            : "id,level_id,created_at";
        const params = new URLSearchParams({
          select: columns,
          author_id: `eq.${auth.user.id}`,
          order: "created_at.desc",
          limit: "100"
        });
        const { response: upstreamResponse, body: result } = await callSupabase(
          `/rest/v1/${table}?${params}`,
          {
            apiKey: supabaseServiceRoleKey,
            headers: { authorization: `Bearer ${supabaseServiceRoleKey}` }
          }
        );
        if (!upstreamResponse.ok) sendSupabaseError(response, upstreamResponse.status, result);
        else sendJson(response, 200, result);
        return true;
      }

      if (isAuthRoute || isAccountRoute) {
        response.setHeader("allow", "GET, POST, OPTIONS");
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        sendJson(response, 413, { error: error.message });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: error.message });
      } else {
        console.error(`Account API request failed for ${path}:`, error);
        sendJson(response, 502, { error: "The account service is temporarily unavailable" });
      }
    }
    return true;
  }

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
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "Authorization, Content-Type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (await handleApiRequest(request, response, requestUrl)) return;

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
      const form = new URLSearchParams(body.toString("utf8"));
      const action = form.get("action");
      if (action === "rate_level") {
        if (await saveGameRating(request, form, response)) return;
      }
      if (
        (action === "create" &&
          !form.has("rr") &&
          (form.has("level_name") || form.has("levelXML") || form.has("level_record"))) ||
        ((action === "update" || action === "publish") &&
          /^\d+$/.test(form.get("level_id") || "") &&
          BigInt(form.get("level_id")) >= BigInt(CUSTOM_LEVEL_ID_MIN))
      ) {
        if (await saveGameLevel(request, form, action, response)) return;
      }
      if (action === "get_record" && /^\d+$/.test(form.get("level_id") || "")) {
        const levelId = form.get("level_id");
        if (BigInt(levelId) >= BigInt(CUSTOM_LEVEL_ID_MIN)) {
          if (!supabaseConfigured) {
            response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
            response.end("failure:account_service_unavailable");
            return;
          }
          const level = await getCustomLevel(levelId);
          if (!level) {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("failure:level_not_found");
            return;
          }
          if (!level.published) {
            const auth = await getAuthenticatedUser(request);
            if (!auth.user || auth.user.id !== level.author_id) {
              response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
              response.end("failure:not_logged_in");
              return;
            }
          }
          const record = Buffer.from(level.level_record, "base64");
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-store"
          });
          response.end(record);
          return;
        }
      }

      const upstreamUrl = new URL(requestUrl.pathname.slice(1), upstreamOrigin);
      const upstreamRequest = {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        signal: AbortSignal.timeout(20_000)
      };
      let upstreamResponse = await fetchImpl(upstreamUrl, upstreamRequest);
      let responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      const upstreamAction = new URLSearchParams(body.toString()).get("action");

      if (
        requestUrl.pathname === "/get_level.hw" &&
        ((upstreamAction === "get_cmb_by_user" &&
          responseBody.toString("utf8").startsWith("failure:not_logged_in")) ||
          (upstreamAction === "get_all" && responseBody.length === 0))
      ) {
        const fallbackBody = new URLSearchParams(body.toString());
        fallbackBody.set("action", "get_featured");
        upstreamResponse = await fetchImpl(upstreamUrl, {
          ...upstreamRequest,
          body: Buffer.from(fallbackBody.toString())
        });
        responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      }

      if (
        requestUrl.pathname === "/get_level.hw" &&
        ["get_all", "get_featured", "get_cmb_by_user", "get_pub_by_user", "search_by_name", "search_by_user"].includes(upstreamAction) &&
        supabaseConfigured
      ) {
        try {
          const customLevels = await getPublishedLevelXml();
          if (customLevels.length > 0) {
            const xml = responseBody.toString("utf8");
            const closingTag = xml.lastIndexOf("</lvs>");
            if (closingTag !== -1) {
              responseBody = Buffer.from(
                `${xml.slice(0, closingTag)}${customLevels}${xml.slice(closingTag)}`,
                "utf8"
              );
            }
          }
        } catch (error) {
          console.error("Could not add custom levels to the upstream catalog:", error);
        }
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

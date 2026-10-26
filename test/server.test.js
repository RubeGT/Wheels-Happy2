import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "../api/server.js";

const allowedOrigin = "https://rubegt.github.io";
const supabaseConfig = {
  supabaseUrl: "https://supabase.example",
  supabaseAnonKey: "anon-test-key",
  supabaseServiceRoleKey: "service-test-key"
};
let server;
let baseUrl;
let forwardedRequest;

async function startServer(options = {}) {
  const instance = createServer({
    allowedOrigins: new Set([allowedOrigin]),
    ...options
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return {
    instance,
    root: `http://127.0.0.1:${instance.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

before(async () => {
  const running = await startServer({
    fetchImpl: async (url, options) => {
      forwardedRequest = { url: url.href, options };
      if (new URLSearchParams(options.body.toString()).get("action") === "get_record") {
        return new Response(Uint8Array.from([0, 255, 128, 65]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        });
      }
      return new Response("<lvs><lv id=\"123\" /></lvs>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }
  });
  server = running.instance;
  baseUrl = running.root;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("serves a health check", async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("proxies level requests and returns CORS headers", async () => {
  const response = await fetch(`${baseUrl}/get_level.hw`, {
    method: "POST",
    headers: {
      origin: allowedOrigin,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "action=get_level&level_id=123"
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(await response.text(), /<lv id="123"/);
  assert.equal(forwardedRequest.url, "https://totaljerkface.com/get_level.hw");
  assert.equal(forwardedRequest.options.body.toString(), "action=get_level&level_id=123");
});

test("preserves binary playable-level data", async () => {
  const response = await fetch(`${baseUrl}/get_level.hw`, {
    method: "POST",
    headers: {
      origin: allowedOrigin,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "action=get_record&level_id=10037145&ip_tracking=12345678"
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 128, 65]);
  assert.equal(forwardedRequest.options.body.toString(), "action=get_record&level_id=10037145&ip_tracking=12345678");
});

test("falls back to featured levels when anonymous catalog requests fail", async () => {
  const actions = [];
  const fallback = await startServer({
    fetchImpl: async (_url, options) => {
      const action = new URLSearchParams(options.body.toString()).get("action");
      actions.push(action);
      if (action === "get_all") return new Response(null, { status: 200 });
      return new Response("<lvs><lv id=\"1786343\" /></lvs>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }
  });

  try {
    const response = await fetch(`${fallback.root}/get_level.hw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=get_all&currentPage=1&sortby=newest&uploaded=anytime"
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<lv id="1786343"/);
    assert.deepEqual(actions, ["get_all", "get_featured"]);
  } finally {
    await fallback.close();
  }
});

test("rejects unapproved origins and arbitrary upstream routes", async () => {
  const originResponse = await fetch(`${baseUrl}/get_level.hw`, {
    method: "POST",
    headers: {
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "action=get_level"
  });
  assert.equal(originResponse.status, 403);
  assert.equal((await fetch(`${baseUrl}/anything`)).status, 404);
});

test("signs up through Supabase with the selected username", async () => {
  let requestInfo;
  const authServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url, options) => {
      requestInfo = { url: url.href, options };
      return Response.json({ user: { id: "user-1" }, access_token: "test-token" });
    }
  });

  try {
    const response = await fetch(`${authServer.root}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "player@example.com",
        password: "safe-password",
        username: "HappyPlayer"
      })
    });
    assert.equal(response.status, 201);
    assert.equal(
      requestInfo.url,
      "https://supabase.example/auth/v1/signup?redirect_to=https%3A%2F%2Frubegt.github.io%2FWheels-Happy2%2F"
    );
    assert.equal(requestInfo.options.headers.apikey, "anon-test-key");
    assert.deepEqual(JSON.parse(requestInfo.options.body), {
      email: "player@example.com",
      password: "safe-password",
      data: { username: "HappyPlayer" }
    });
  } finally {
    await authServer.close();
  }
});

test("saves editor-created levels in the game's native request format", async () => {
  const requests = [];
  const editorServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      if (url.pathname === "/auth/v1/user") {
        return Response.json({
          id: "authenticated-user",
          email: "player@example.com",
          user_metadata: { username: "HappyPlayer" }
        });
      }
      return Response.json([{ id: 1900000000 }], { status: 201 });
    }
  });

  try {
    const levelXml = "<levelXML><info v=\"1.87\"/><shapes/><specials/></levelXML>";
    const form = new URLSearchParams({
      action: "create",
      level_name: "First level",
      user_comment: "A test",
      playable_character: "0",
      levelXML: levelXml,
      level_record: encodeURIComponent(Buffer.from("game-record").toString("base64"))
    });
    const response = await fetch(`${editorServer.root}/get_level.hw`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "success:1900000000");
    assert.equal(requests[1].url, "https://supabase.example/rest/v1/game_levels?select=id");
    assert.equal(requests[1].options.headers.apikey, "service-test-key");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      author_id: "authenticated-user",
      author_name: "HappyPlayer",
      title: "First level",
      user_comment: "A test",
      playable_character: 0,
      level_xml: levelXml,
      level_record: Buffer.from("game-record").toString("base64")
    });
  } finally {
    await editorServer.close();
  }
});

test("rejects malformed editor data without writing it", async () => {
  let saveAttempted = false;
  const editorServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url) => {
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "authenticated-user" });
      saveAttempted = true;
      return Response.json([]);
    }
  });

  try {
    const response = await fetch(`${editorServer.root}/get_level.hw`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        action: "create",
        level_name: "Invalid",
        user_comment: "",
        playable_character: "0",
        levelXML: "<html>not a level</html>",
        level_record: encodeURIComponent(Buffer.from("record").toString("base64"))
      })
    });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "failure:bad_param");
    assert.equal(saveAttempted, false);
  } finally {
    await editorServer.close();
  }
});

test("updates and publishes only owned custom levels", async () => {
  const requests = [];
  const levelId = "1900000000";
  const editorServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: "authenticated-user", email: "player@example.com" });
      }
      if (url.searchParams.has("id") && options.method !== "PATCH") {
        return Response.json([{ id: Number(levelId), author_id: "authenticated-user" }]);
      }
      return Response.json([{ id: Number(levelId) }]);
    }
  });

  try {
    const headers = {
      authorization: "Bearer test-token",
      "content-type": "application/x-www-form-urlencoded"
    };
    const updateResponse = await fetch(`${editorServer.root}/get_level.hw`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        action: "update",
        level_id: levelId,
        level_name: "Updated level",
        user_comment: "Revised",
        playable_character: "0",
        levelXML: "<levelXML><info v=\"1.87\"/><shapes/><specials/></levelXML>",
        level_record: encodeURIComponent(Buffer.from("updated-record").toString("base64"))
      })
    });
    assert.equal(updateResponse.status, 200);
    assert.equal(await updateResponse.text(), `success:${levelId}`);
    assert.equal(requests[1].url.pathname, "/rest/v1/game_levels");
    assert.equal(requests[2].options.method, "PATCH");
    assert.equal(requests[2].options.headers.apikey, "service-test-key");

    const publishResponse = await fetch(`${editorServer.root}/get_level.hw`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ action: "publish", level_id: levelId })
    });
    assert.equal(publishResponse.status, 200);
    assert.equal(await publishResponse.text(), `success:${levelId}`);
    assert.equal(requests[4].options.method, "PATCH");
    const published = JSON.parse(requests[4].options.body);
    assert.equal(published.published, true);
    assert.ok(Number.isFinite(Date.parse(published.published_at)));
  } finally {
    await editorServer.close();
  }
});

test("stores level ratings under the authenticated account", async () => {
  const requests = [];
  const accountServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: "authenticated-user", email: "player@example.com" });
      }
      return new Response(null, { status: 201 });
    }
  });

  try {
    const requestUrl = `${accountServer.root}/get_level.hw`;
    const headers = {
      authorization: "Bearer test-token",
      "content-type": "application/x-www-form-urlencoded"
    };
    const ratingResponse = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams({ action: "rate_level", level_id: "12345", rating: "4" })
    });
    assert.equal(ratingResponse.status, 200);
    assert.equal(await ratingResponse.text(), "success");
    assert.equal(requests[1].url.pathname, "/rest/v1/level_ratings");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      author_id: "authenticated-user",
      level_id: "12345",
      rating: 4
    });
  } finally {
    await accountServer.close();
  }
});

test("proxies native game replay saves without requiring account storage", async () => {
  let forwardedRequest;
  const replayServer = await startServer({
    ...supabaseConfig,
    fetchImpl: async (url, options) => {
      forwardedRequest = { url: url.href, body: options.body.toString() };
      return new Response("native-replay-response", { status: 200 });
    },
    supabaseFetchImpl: async () => {
      throw new Error("Native replays must not call Supabase");
    }
  });

  try {
    const body = new URLSearchParams({
      action: "create",
      rr: encodeURIComponent(Buffer.from("replay-data").toString("base64")),
      em: encodeURIComponent(Buffer.from("encrypted-meta").toString("base64")),
      ei: encodeURIComponent(Buffer.from("iv").toString("base64"))
    });
    const response = await fetch(`${replayServer.root}/get_level.hw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "native-replay-response");
    assert.equal(forwardedRequest.url, "https://totaljerkface.com/get_level.hw");
    assert.equal(forwardedRequest.body, body.toString());
  } finally {
    await replayServer.close();
  }
});

test("serves upstream catalogs when the optional Supabase catalog lookup fails", async () => {
  const upstreamCatalog = "<lvs><lv id=\"123\" /></lvs>";
  const catalogServer = await startServer({
    ...supabaseConfig,
    fetchImpl: async () =>
      new Response(upstreamCatalog, {
        status: 200,
        headers: { "content-type": "application/xml" }
      }),
    supabaseFetchImpl: async () => Response.json({ message: "Database unavailable" }, { status: 503 })
  });

  try {
    const response = await fetch(`${catalogServer.root}/get_level.hw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "get_featured" })
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamCatalog);
  } finally {
    await catalogServer.close();
  }
});

test("serves custom game records and adds published levels to the game catalog", async () => {
  const customId = "1900000000";
  const record = Buffer.from([0, 255, 128, 65]);
  const levelXml = "<levelXML><info v=\"1.87\"/><shapes/><specials/></levelXML>";
  const customServer = await startServer({
    ...supabaseConfig,
    fetchImpl: async () =>
      new Response("<lvs><lv id=\"123\" /></lvs>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      }),
    supabaseFetchImpl: async (url) => {
      if (url.pathname === "/rest/v1/game_levels" && url.searchParams.get("id") === `eq.${customId}`) {
        return Response.json([{
          id: Number(customId),
          author_id: "author-1",
          author_name: "LevelMaker",
          title: "Custom ride",
          user_comment: "Have fun",
          playable_character: 0,
          level_xml: levelXml,
          level_record: record.toString("base64"),
          published: true
        }]);
      }
      return Response.json([{
        id: Number(customId),
        author_name: "LevelMaker",
        title: "Custom ride",
        user_comment: "Have fun",
        playable_character: 0,
        published_at: "2025-01-01T00:00:00Z"
      }]);
    }
  });

  try {
    const catalog = await fetch(`${customServer.root}/get_level.hw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "get_featured" })
    });
    assert.equal(catalog.status, 200);
    assert.match(await catalog.text(), /id="1900000000" ln="Custom ride"/);

    const recordResponse = await fetch(`${customServer.root}/get_level.hw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "get_record", level_id: customId })
    });
    assert.equal(recordResponse.status, 200);
    assert.deepEqual([...new Uint8Array(await recordResponse.arrayBuffer())], [...record]);
  } finally {
    await customServer.close();
  }
});

test("lists only the authenticated user's saved replays", async () => {
  const requests = [];
  const replayServer = await startServer({
    ...supabaseConfig,
    supabaseFetchImpl: async (url) => {
      requests.push(url);
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: "authenticated-user", email: "player@example.com" });
      }
      return Response.json([{ id: 1800000000, level_id: null, created_at: "2025-01-01T00:00:00Z" }]);
    }
  });

  try {
    const response = await fetch(`${replayServer.root}/api/me/replays`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      { id: 1800000000, level_id: null, created_at: "2025-01-01T00:00:00Z" }
    ]);
    assert.equal(requests[1].searchParams.get("author_id"), "eq.authenticated-user");
  } finally {
    await replayServer.close();
  }
});

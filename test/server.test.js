import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "../api/server.js";

const allowedOrigin = "https://rubegt.github.io";
let server;
let baseUrl;
let forwardedRequest;

before(async () => {
  server = createServer({
    allowedOrigins: new Set([allowedOrigin]),
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test("falls back to the public featured catalog when browsing requires login", async () => {
  const forwardedActions = [];
  const fallbackServer = createServer({
    allowedOrigins: new Set([allowedOrigin]),
    fetchImpl: async (_url, options) => {
      const action = new URLSearchParams(options.body.toString()).get("action");
      forwardedActions.push(action);
      if (action === "get_cmb_by_user") {
        return new Response("failure:not_logged_in");
      }
      return new Response("<lvs><lv id=\"1786343\" /></lvs>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }
  });
  await new Promise((resolve) => fallbackServer.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${fallbackServer.address().port}/get_level.hw`, {
      method: "POST",
      headers: {
        origin: allowedOrigin,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "action=get_cmb_by_user&user=everyone"
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/xml");
    assert.match(await response.text(), /<lv id="1786343"/);
    assert.deepEqual(forwardedActions, ["get_cmb_by_user", "get_featured"]);
  } finally {
    await new Promise((resolve, reject) => {
      fallbackServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("rejects unapproved origins", async () => {
  const response = await fetch(`${baseUrl}/get_level.hw`, {
    method: "POST",
    headers: {
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "action=get_level"
  });

  assert.equal(response.status, 403);
});

test("does not expose arbitrary upstream routes", async () => {
  const response = await fetch(`${baseUrl}/anything`);
  assert.equal(response.status, 404);
});

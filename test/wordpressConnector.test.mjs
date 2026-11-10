import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WordPressApiError,
  WordPressConnector,
  WordPressRequestBlockedError,
  WordPressRequestPolicyError,
} from "../dist/index.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createConnector(fetchImplementation, baseUrl = "https://example.com") {
  return new WordPressConnector({
    baseUrl,
    username: "api-user",
    appPassword: "test-application-password",
    fetchImplementation,
  });
}

test("listPosts sends Basic auth and WordPress query parameters", async () => {
  let request;
  const connector = createConnector(async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse([{ id: 42 }]);
  });

  const posts = await connector.listPosts({
    perPage: 25,
    status: ["publish", "draft"],
    orderBy: "modified",
  });

  assert.deepEqual(posts, [{ id: 42 }]);
  const url = new URL(request.url);
  assert.equal(url.pathname, "/wp-json/wp/v2/posts");
  assert.equal(url.searchParams.get("per_page"), "25");
  assert.equal(url.searchParams.get("status"), "publish,draft");
  assert.equal(url.searchParams.get("order_by"), "modified");
  assert.equal(
    request.init.headers.Authorization,
    `Basic ${Buffer.from("api-user:test-application-password").toString("base64")}`,
  );
});

let safetyHost = 0;
function safetyConnector(fetchImplementation, options = {}) {
  return new WordPressConnector({
    baseUrl: `https://safety-${++safetyHost}.example`, username: "test", appPassword: "test",
    fetchImplementation, ...options,
  });
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("host-wide default concurrency includes body reading and independent connector instances", async () => {
  let started = 0;
  const bodies = [];
  const fetchImplementation = async () => {
    started++;
    return {
      ok: true, status: 200, headers: new Headers(),
      text: () => new Promise(resolve => bodies.push(() => resolve("[]"))),
    };
  };
  const first = safetyConnector(fetchImplementation);
  const second = safetyConnector(fetchImplementation, { baseUrl: `https://${first.getRequestSafetyState().hostname}/another-site` });
  const requests = [first.listPosts(), second.listPages(), first.getSiteInfo()];
  await flush();
  assert.equal(started, 2);
  assert.equal(first.getRequestSafetyState().queuedRequests, 1);
  bodies.shift()();
  await flush();
  assert.equal(started, 3);
  while (bodies.length) bodies.shift()();
  await Promise.all(requests);
  assert.equal(second.getRequestSafetyState().activeRequests, 0);
});

test("explicit concurrency four is a hard ceiling; unsafe config is rejected", async () => {
  let started = 0;
  const releases = [];
  const connector = safetyConnector(() => new Promise(resolve => {
    started++;
    releases.push(() => resolve(jsonResponse([])));
  }), { maxConcurrency: 4 });
  const requests = Array.from({ length: 7 }, () => connector.listPosts());
  await flush();
  assert.equal(started, 4);
  while (releases.length) {
    releases.splice(0).forEach(release => release());
    await flush();
  }
  await Promise.all(requests);
  for (const options of [
    { maxConcurrency: 5 }, { maxConcurrency: 0 }, { maxConcurrency: 1.5 },
    { maxRequestsPer30Seconds: 251 }, { maxRequestsPer30Seconds: NaN },
    { maxUploadBytes: 32_000_001 },
  ]) assert.throws(() => safetyConnector(async () => jsonResponse([]), options), WordPressRequestPolicyError);
});

test("rolling request budget waits for each timestamp, with no queued request timeout", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const starts = [];
  const connector = safetyConnector(async () => {
    starts.push(Date.now()); return jsonResponse([]);
  }, { maxRequestsPer30Seconds: 2, timeoutMs: 100 });
  await connector.listPosts();
  t.mock.timers.tick(15_000);
  await connector.listPages();
  const third = connector.getSiteInfo();
  const fourth = connector.getCurrentUser();
  t.mock.timers.tick(14_999);
  await flush();
  assert.deepEqual(starts, [0, 15_000]);
  t.mock.timers.tick(1);
  await flush();
  await third;
  assert.deepEqual(starts, [0, 15_000, 30_000]);
  t.mock.timers.tick(15_000);
  await fourth;
  assert.deepEqual(starts, [0, 15_000, 30_000, 45_000]);
});

test("default request budget leaves headroom at 200 starts per rolling 30 seconds", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let started = 0;
  const connector = safetyConnector(async () => { started++; return jsonResponse([]); });
  const requests = Array.from({ length: 201 }, () => connector.listPosts());
  await flush();
  assert.equal(started, 200);
  assert.equal(connector.getRequestSafetyState().queuedRequests, 1);
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(started, 200);
  t.mock.timers.tick(1);
  await Promise.all(requests);
  assert.equal(started, 201);
});

for (const status of [403, 429]) {
  test(`HTTP ${status} stops queued and later same-host calls without retries`, async () => {
    let started = 0;
    const connector = safetyConnector(async () => {
      started++;
      return started === 1 ? jsonResponse({ code: "server_block", message: "Restricted" }, status) : jsonResponse([]);
    }, { maxConcurrency: 1 });
    const requests = Array.from({ length: 5 }, () => connector.listPosts());
    const results = await Promise.allSettled(requests);
    assert.equal(started, 1);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(results[0].reason.status, status);
    assert.equal(results[0].reason.code, "server_block");
    for (const result of results.slice(1)) assert.ok(result.reason instanceof WordPressRequestBlockedError);
    const second = safetyConnector(async () => { started++; return jsonResponse([]); }, { baseUrl: `https://${connector.getRequestSafetyState().hostname}/blog` });
    await assert.rejects(second.getCurrentUser(), WordPressRequestBlockedError);
    assert.equal(started, 1);
    connector.resetRequestCircuit();
    await second.listPages();
    assert.equal(started, 2);
  });
}

test("circuit opens at response headers even if reading the error body fails", async () => {
  let started = 0;
  const connector = safetyConnector(async () => {
    started++;
    return { status: 403, headers: new Headers(), text: async () => { throw new Error("Body failed"); } };
  }, { maxConcurrency: 1 });
  const results = await Promise.allSettled([connector.listPosts(), connector.listPages()]);
  assert.match(results[0].reason.message, /Body failed/);
  assert.ok(results[1].reason instanceof WordPressRequestBlockedError);
  assert.equal(started, 1);
});

for (const dateHeader of [false, true]) {
  test(`Retry-After ${dateHeader ? "HTTP-date" : "seconds"} is a minimum reset delay, never an automatic retry`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 10) });
    const now = Date.now();
    let started = 0;
    const connector = safetyConnector(async () => {
      started++;
      return new Response("Restricted", { status: 429, headers: { "Retry-After": dateHeader ? new Date(now + 60_000).toUTCString() : "60" } });
    });
    await assert.rejects(connector.listPosts(), WordPressApiError);
    assert.equal(connector.getRequestSafetyState().circuit.retryAt, now + 60_000);
    assert.throws(() => connector.resetRequestCircuit(), WordPressRequestBlockedError);
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(started, 1);
    await assert.rejects(connector.listPosts(), WordPressRequestBlockedError);
    connector.resetRequestCircuit();
    assert.equal(connector.getRequestSafetyState().circuit, null);
  });
}

test("batch route aliases are blocked locally, while individual core and plugin endpoints work", async () => {
  const urls = [];
  const connector = safetyConnector(async (url, init) => {
    urls.push(String(url)); assert.equal(init.redirect, "manual"); return jsonResponse([]);
  });
  for (const route of [
    "../../batch/v1", "/wp-json/batch/v1/", "../../%62atch/v1", "../../batch%2Fv1", "../../batch%252Fv1",
    "/index.php?rest_route=%2Fbatch%2Fv1", "/index.php?rest_route=%252Fbatch%252Fv1",
    "/index.php?rest%255Froute=/batch/v1", "../../BATCH/v1/requests",
    `https://${connector.getRequestSafetyState().hostname}/wp-json/batch/v1`,
  ]) await assert.rejects(connector.request("POST", route, {}), error => error.code === "wordpress_batch_disabled");
  await assert.rejects(connector.request("GET", "", undefined, {}, `https://${connector.getRequestSafetyState().hostname}/wp-json/batch/v1/`), WordPressRequestPolicyError);
  assert.equal(urls.length, 0);
  await connector.createPost({ title: "Draft", status: "draft" });
  await connector.createPage({ title: "Page", status: "draft" });
  await connector.uploadMediaBytes(new Uint8Array([1]), "sample.bin");
  await connector.request("GET", "../../givewp/v3/form/130");
  await connector.listPosts({ search: "/batch/v1" });
  assert.equal(urls.length, 5);
  assert.equal(new URL(urls[0]).pathname, "/wp-json/wp/v2/posts");
  assert.equal(new URL(urls[1]).pathname, "/wp-json/wp/v2/pages");
  assert.equal(new URL(urls[2]).pathname, "/wp-json/wp/v2/media");
});

test("redirects and foreign origins cannot bypass the guard or send extra authenticated requests", async () => {
  let started = 0;
  const connector = safetyConnector(async (_url, init) => {
    started++; assert.equal(init.redirect, "manual");
    return new Response("Moved", { status: 302, headers: { Location: "/wp-json/batch/v1" } });
  });
  await assert.rejects(connector.listPosts(), error => error.status === 302);
  await assert.rejects(connector.request("GET", "https://foreign.example/wp-json/wp/v2/posts"), error => error.code === "wordpress_destination_blocked");
  assert.equal(started, 1);
});

test("media permits exactly 32 MB but rejects a larger file before network", async () => {
  let started = 0;
  const connector = safetyConnector(async (_url, init) => {
    started++; assert.equal(init.body.size, 32_000_000); return jsonResponse({ id: 1 });
  });
  await connector.uploadMediaBytes(new Uint8Array(32_000_000), "limit.bin");
  await assert.rejects(connector.uploadMediaBytes(new Uint8Array(32_000_001), "too-big.bin"), error => error.code === "wordpress_upload_too_large");
  const directory = await mkdtemp(path.join(os.tmpdir(), "wordpress-limits-"));
  try {
    const file = path.join(directory, "oversize.bin");
    await writeFile(file, ""); await truncate(file, 32_000_001);
    await assert.rejects(connector.uploadMedia(file), WordPressRequestPolicyError);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.equal(started, 1);
});

test("generic binary and multipart uploads enforce the same per-file limit", async () => {
  let started = 0;
  const connector = safetyConnector(async () => { started++; return jsonResponse([]); }, { maxUploadBytes: 4 });
  for (const body of [new Uint8Array(5), new ArrayBuffer(5), new DataView(new ArrayBuffer(5)), new Blob([new Uint8Array(5)])]) {
    await assert.rejects(connector.request("POST", "media", body), WordPressRequestPolicyError);
  }
  const tooBig = new FormData(); tooBig.set("upload", new Blob([new Uint8Array(5)]), "big.bin");
  await assert.rejects(connector.request("POST", "media", tooBig), WordPressRequestPolicyError);
  assert.equal(started, 0);
  const perFile = new FormData();
  perFile.append("files", new Blob([new Uint8Array(4)]), "one.bin");
  perFile.append("files", new Blob([new Uint8Array(4)]), "two.bin");
  await connector.request("POST", "media", perFile);
  assert.equal(started, 1);
});

test("a multipart body changed while queued is checked again before dispatch", async () => {
  let started = 0, release;
  const connector = safetyConnector(async () => {
    started++;
    return new Promise(resolve => { release = () => resolve(jsonResponse([])); });
  }, { maxConcurrency: 1, maxUploadBytes: 4 });
  const first = connector.listPosts();
  await flush();
  const form = new FormData();form.set("file", new Blob([new Uint8Array(4)]), "safe.bin");
  const queued = connector.request("POST", "media", form);
  form.set("file", new Blob([new Uint8Array(5)]), "changed.bin");
  release();await first;
  await assert.rejects(queued, WordPressRequestPolicyError);
  assert.equal(started, 1);
  assert.equal(connector.getRequestSafetyState().activeRequests, 0);
});

test("same-host instances retain the strictest registered concurrency and rolling budget", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let started = 0;
  const fetchImplementation = async () => { started++; return jsonResponse([]); };
  const first = safetyConnector(fetchImplementation, { maxConcurrency: 4, maxRequestsPer30Seconds: 10 });
  const baseUrl = `https://${first.getRequestSafetyState().hostname}/other-site`;
  const strict = safetyConnector(fetchImplementation, { baseUrl, maxConcurrency: 1, maxRequestsPer30Seconds: 2 });
  safetyConnector(fetchImplementation, { baseUrl, maxConcurrency: 4, maxRequestsPer30Seconds: 250 });
  assert.equal(first.getRequestSafetyState().maxConcurrency, 1);
  assert.equal(first.getRequestSafetyState().maxRequestsPer30Seconds, 2);
  const requests = [first.listPosts(), strict.listPages(), first.getCurrentUser()];
  await flush();
  assert.equal(started, 2);
  t.mock.timers.tick(30_000);
  await Promise.all(requests);
  assert.equal(started, 3);
});

test("a slot granted just before another response opens the circuit never dispatches", async () => {
  let started = 0, finishFirstBody, finishSecondResponse;
  const connector = safetyConnector(() => {
    started++;
    if (started === 1) return {
      ok: true, status: 200, headers: new Headers(),
      text: () => new Promise(resolve => { finishFirstBody = () => resolve("[]"); }),
    };
    return new Promise(resolve => { finishSecondResponse = () => resolve(jsonResponse({ message: "Restricted" }, 403)); });
  });
  const requests = [connector.listPosts(), connector.listPages(), connector.getCurrentUser()];
  const settled = Promise.allSettled(requests);
  await flush();
  assert.equal(started, 2);
  finishFirstBody();
  finishSecondResponse();
  const results = await settled;
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.status, 403);
  assert.ok(results[2].reason instanceof WordPressRequestBlockedError);
  assert.equal(started, 2);
});

test("explicit circuit reset retains the previous rolling request budget", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let started = 0;
  const connector = safetyConnector(async () => {
    started++;
    return started === 1 ? jsonResponse({}, 403) : jsonResponse([]);
  }, { maxRequestsPer30Seconds: 1 });
  await assert.rejects(connector.listPosts(), WordPressApiError);
  connector.resetRequestCircuit();
  const next = connector.listPages();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(started, 1);
  t.mock.timers.tick(1);
  await next;
  assert.equal(started, 2);
});

test("preserves a WordPress subdirectory in REST API URLs", async () => {
  let requestUrl;
  const connector = createConnector(async (url) => {
    requestUrl = String(url);
    return jsonResponse([]);
  }, "https://example.com/blog");

  await connector.listPages();
  assert.equal(new URL(requestUrl).pathname, "/blog/wp-json/wp/v2/pages");
});

test("createPost sends JSON content", async () => {
  let request;
  const connector = createConnector(async (_url, init) => {
    request = init;
    return jsonResponse({ id: 7, status: "draft" }, 201);
  });

  const post = await connector.createPost({
    title: "Draft title",
    content: "<p>Draft content.</p>",
    status: "draft",
  });

  assert.equal(post.id, 7);
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    title: "Draft title",
    content: "<p>Draft content.</p>",
    status: "draft",
  });
});

test("createComment uses the comments endpoint", async () => {
  let requestUrl;
  let requestBody;
  const connector = createConnector(async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(init.body);
    return jsonResponse({ id: 91, post: 12 }, 201);
  });

  const comment = await connector.createComment({
    post: 12,
    content: "A useful comment.",
  });

  assert.equal(new URL(requestUrl).pathname, "/wp-json/wp/v2/comments");
  assert.deepEqual(requestBody, { post: 12, content: "A useful comment." });
  assert.equal(comment.id, 91);
});

test("WordPress errors expose status, code, and payload", async () => {
  const connector = createConnector(async () =>
    jsonResponse(
      {
        code: "rest_post_invalid_id",
        message: "Invalid post ID.",
        data: { status: 404 },
      },
      404,
    )
  );

  await assert.rejects(connector.getPost(999), (error) => {
    assert.ok(error instanceof WordPressApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "rest_post_invalid_id");
    assert.equal(error.message, "Invalid post ID.");
    return true;
  });
});

test("uploadMedia sends binary data and safely quotes the file name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wordpress-connector-"));
  const filePath = path.join(directory, "cover.jpg");
  await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  try {
    let request;
    const connector = createConnector(async (_url, init) => {
      request = init;
      return jsonResponse({ id: 88, source_url: "https://example.com/cover.jpg" }, 201);
    });

    const media = await connector.uploadMedia(filePath, "image/jpeg");

    assert.equal(media.id, 88);
    assert.equal(request.headers["Content-Type"], "image/jpeg");
    assert.equal(
      request.headers["Content-Disposition"],
      'attachment; filename="cover.jpg"',
    );
    assert.ok(request.body instanceof Blob);
    assert.equal(request.body.size, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("constructor rejects incomplete credentials", () => {
  assert.throws(
    () => new WordPressConnector({ baseUrl: "", username: "", appPassword: "" }),
    /base URL, username, and application password are required/i,
  );
});

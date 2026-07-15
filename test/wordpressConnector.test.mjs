import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WordPressApiError,
  WordPressConnector,
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

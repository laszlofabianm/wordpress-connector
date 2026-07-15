# WordPress Connector

An unofficial TypeScript connector for the WordPress REST API. It provides a
small, dependency-free client for posts, pages, media, taxonomy terms,
comments, and authenticated connection checks.

## Features

- Create, read, update, and delete posts and pages
- Upload media and update alt text, captions, and descriptions
- List and create categories and tags
- Create, read, update, moderate, and delete comments
- Authenticate with WordPress Application Passwords
- Support WordPress installations hosted in a subdirectory
- Inject a custom `fetch` implementation for tests or custom runtimes
- Typed API errors with HTTP status, WordPress error code, and payload

## Requirements

- Node.js 20 or newer
- WordPress with the REST API enabled
- HTTPS for production use
- A WordPress user with the capabilities required by each operation
- A WordPress Application Password

## Create An Application Password

1. Sign in to WordPress administration.
2. Open **Users > Profile**.
3. Find **Application Passwords**.
4. Enter a descriptive name and select **Add New Application Password**.
5. Store the generated password securely. WordPress displays it only once.

Application Passwords are separate from the password used to sign in to
WordPress. Revoke the application password if it is exposed.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Add your site credentials to `.env`:

```dotenv
WORDPRESS_BASE_URL=https://example.com
WORDPRESS_USERNAME=your-wordpress-username
WORDPRESS_APP_PASSWORD=replace-with-your-application-password
```

Never commit `.env` or paste a live application password into source code.

## Quick Start

```js
import {
  WordPressConnector,
  getRequiredEnv,
  readEnvFile,
} from "wordpress-connector";

const env = await readEnvFile();
const wordpress = new WordPressConnector({
  baseUrl: getRequiredEnv(env, "WORDPRESS_BASE_URL"),
  username: getRequiredEnv(env, "WORDPRESS_USERNAME"),
  appPassword: getRequiredEnv(env, "WORDPRESS_APP_PASSWORD"),
});

await wordpress.testConnection();
const posts = await wordpress.listPosts({ perPage: 10, status: "publish" });
console.log(posts);
```

Run the included example after configuring `.env`:

```bash
npm run example:list-posts
```

## Create A Draft Post

```js
const post = await wordpress.createPost({
  title: "A new article",
  content: "<p>Article content.</p>",
  excerpt: "A short summary.",
  status: "draft",
  categories: [2],
  tags: [8, 13],
});

console.log(post.id, post.link);
```

To schedule a post, use `status: "future"` and provide an ISO 8601 value in
`date` using the WordPress site's local timezone.

```js
await wordpress.createPost({
  title: "Scheduled article",
  content: "<p>Article content.</p>",
  status: "future",
  date: "2026-08-01T09:00:00",
});
```

## Upload Media

```js
const media = await wordpress.uploadMedia("./cover.jpg", "image/jpeg", {
  altText: "A descriptive image alternative",
  caption: "Optional image caption",
});

const post = await wordpress.createPost({
  title: "Post with a cover image",
  content: "<p>Article content.</p>",
  featured_media: media.id,
  status: "draft",
});
```

The connector first uploads the binary file and then updates its metadata when
alt text or a caption is supplied.

## Create A Comment

Authenticated users can create comments when their WordPress role and site
settings permit it:

```js
const comment = await wordpress.createComment({
  post: 123,
  content: "A useful follow-up to the article.",
});
```

Use comment operations responsibly. WordPress permissions, moderation rules,
anti-spam tools, and applicable platform policies still apply.

## Categories And Tags

```js
const category = await wordpress.createCategory({ name: "Guides" });
const tag = await wordpress.createTag({ name: "TypeScript" });

await wordpress.createPost({
  title: "Tagged article",
  status: "draft",
  categories: [category.id],
  tags: [tag.id],
});
```

## Available Methods

- `getSiteInfo()`
- `testConnection()`
- `getCurrentUser()`
- `listPosts()`, `getPost()`, `createPost()`, `updatePost()`, `deletePost()`
- `listPages()`, `getPage()`, `createPage()`, `updatePage()`, `deletePage()`
- `listCategories()`, `createCategory()`
- `listTags()`, `createTag()`
- `listComments()`, `getComment()`, `createComment()`, `updateComment()`, `deleteComment()`
- `uploadMedia()`, `uploadMediaBytes()`, `updateMedia()`, `deleteMedia()`

## Error Handling

```js
import { WordPressApiError } from "wordpress-connector";

try {
  await wordpress.getPost(999999);
} catch (error) {
  if (error instanceof WordPressApiError) {
    console.error(error.status, error.code, error.message);
  }
}
```

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The test suite uses an injected mock `fetch`; it does not contact a WordPress
site or require credentials.

## API Compatibility

The connector targets the WordPress core REST API under `/wp-json/wp/v2/`.
Plugins and custom post types may add fields or endpoints that are outside this
package's typed surface. Returned objects retain unknown fields for compatible
access by consumers.

This package is not affiliated with or endorsed by the WordPress project.

## License

MIT

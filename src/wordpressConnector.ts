import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertIndividualEndpoint, hostRequestSafety, MAX_UPLOAD_BYTES, safetyLimit,
  WordPressApiError, WordPressRequestPolicyError, type HostRequestSafety,
  type WordPressRequestSafetyState,
} from "./requestSafety.js";
export { WordPressApiError, WordPressRequestBlockedError, WordPressRequestPolicyError, type WordPressRequestSafetyState } from "./requestSafety.js";

export type WordPressPostStatus =
  | "publish"
  | "future"
  | "draft"
  | "pending"
  | "private";

export interface WordPressConnectorConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  /** Host-wide concurrency, default 2; hard maximum 4. */
  maxConcurrency?: number;
  /** Request starts in a rolling 30 seconds, default 200; hard maximum 250. */
  maxRequestsPer30Seconds?: number;
  /** Per-file upload limit; defaults to and cannot exceed 32,000,000 bytes. */
  maxUploadBytes?: number;
}

export interface ListContentParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: WordPressPostStatus | WordPressPostStatus[];
  slug?: string;
  author?: number | number[];
  categories?: number | number[];
  tags?: number | number[];
  include?: number[];
  exclude?: number[];
  order?: "asc" | "desc";
  orderBy?:
    | "author"
    | "date"
    | "id"
    | "include"
    | "modified"
    | "parent"
    | "relevance"
    | "slug"
    | "title";
}

export interface ListTermsParams {
  page?: number;
  perPage?: number;
  search?: string;
  slug?: string | string[];
  include?: number[];
  exclude?: number[];
  hideEmpty?: boolean;
  order?: "asc" | "desc";
  orderBy?: "id" | "include" | "name" | "slug" | "term_group" | "description" | "count";
}

export interface ListCommentsParams {
  page?: number;
  perPage?: number;
  search?: string;
  post?: number | number[];
  parent?: number | number[];
  status?: "hold" | "approve" | "spam" | "trash";
  order?: "asc" | "desc";
  orderBy?: "date" | "date_gmt" | "id" | "include" | "post" | "parent" | "type";
}

export interface WordPressSiteInfo {
  name: string;
  description: string;
  url: string;
  home: string;
  namespaces: string[];
  authentication?: unknown;
  [key: string]: unknown;
}

export interface WordPressRenderedValue {
  rendered: string;
  protected?: boolean;
}

export interface WordPressPostInput {
  title?: string;
  content?: string;
  excerpt?: string;
  slug?: string;
  status?: WordPressPostStatus;
  date?: string;
  date_gmt?: string;
  author?: number;
  featured_media?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  sticky?: boolean;
  template?: string;
  format?: string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
}

export interface WordPressPost {
  id: number;
  date: string;
  modified: string;
  slug: string;
  status: WordPressPostStatus;
  type: "post" | "page" | string;
  link: string;
  title: WordPressRenderedValue;
  content: WordPressRenderedValue;
  excerpt: WordPressRenderedValue;
  featured_media: number;
  [key: string]: unknown;
}

export interface WordPressMedia {
  id: number;
  date: string;
  slug: string;
  type: "attachment";
  link: string;
  title: WordPressRenderedValue;
  source_url: string;
  mime_type: string;
  media_details?: unknown;
  [key: string]: unknown;
}

export interface WordPressTermInput {
  name: string;
  description?: string;
  slug?: string;
  parent?: number;
  meta?: Record<string, unknown>;
}

export interface WordPressTerm {
  id: number;
  count: number;
  description: string;
  link: string;
  name: string;
  slug: string;
  taxonomy: string;
  parent?: number;
  [key: string]: unknown;
}

export interface WordPressCommentInput {
  post?: number;
  parent?: number;
  author?: number;
  author_name?: string;
  author_email?: string;
  author_url?: string;
  content?: string;
  date?: string;
  status?: "hold" | "approve" | "spam" | "trash";
  meta?: Record<string, unknown>;
}

export interface WordPressComment {
  id: number;
  post: number;
  parent: number;
  author: number;
  author_name: string;
  date: string;
  status: string;
  content: WordPressRenderedValue;
  link: string;
  [key: string]: unknown;
}

export interface WordPressUser {
  id: number;
  name: string;
  url: string;
  description: string;
  link: string;
  slug: string;
  [key: string]: unknown;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class WordPressConnector {
  private readonly rootApiUrl: string;
  private readonly apiBaseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestSafety: HostRequestSafety;
  private readonly maxUploadBytes: number;

  constructor(config: WordPressConnectorConfig) {
    if (!config.baseUrl || !config.username || !config.appPassword) {
      throw new Error("WordPress base URL, username, and application password are required.");
    }

    const siteUrl = this.normalizeSiteUrl(config.baseUrl);
    const concurrency = safetyLimit(config.maxConcurrency, 2, 4, "maxConcurrency");
    const requests = safetyLimit(config.maxRequestsPer30Seconds, 200, 250, "maxRequestsPer30Seconds");
    this.maxUploadBytes = safetyLimit(config.maxUploadBytes, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES, "maxUploadBytes");
    this.requestSafety = hostRequestSafety(new URL(siteUrl).hostname, concurrency, requests);
    this.rootApiUrl = new URL("wp-json/", siteUrl).toString();
    this.apiBaseUrl = new URL("wp-json/wp/v2/", siteUrl).toString();
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.authHeader = `Basic ${Buffer.from(
      `${config.username}:${config.appPassword}`,
      "utf8"
    ).toString("base64")}`;
  }

  getRequestSafetyState(): WordPressRequestSafetyState {
    return this.requestSafety.state();
  }

  /** Explicitly resume only after resolving the restriction; Retry-After is a minimum wait. */
  resetRequestCircuit(): void {
    this.requestSafety.reset();
  }

  getSiteInfo(): Promise<WordPressSiteInfo> {
    return this.request("GET", "", undefined, {}, this.rootApiUrl);
  }

  async testConnection(): Promise<boolean> {
    await this.getCurrentUser();
    return true;
  }

  getCurrentUser(): Promise<WordPressUser> {
    return this.request("GET", "users/me");
  }

  listPosts(params: ListContentParams = {}): Promise<WordPressPost[]> {
    return this.request("GET", `posts${this.toQueryString(params)}`);
  }

  getPost(id: number): Promise<WordPressPost> {
    return this.request("GET", `posts/${id}`);
  }

  createPost(input: WordPressPostInput): Promise<WordPressPost> {
    return this.request("POST", "posts", input);
  }

  updatePost(id: number, input: WordPressPostInput): Promise<WordPressPost> {
    return this.request("PUT", `posts/${id}`, input);
  }

  deletePost(id: number, force = false): Promise<unknown> {
    return this.request("DELETE", `posts/${id}${this.toQueryString({ force })}`);
  }

  listPages(params: ListContentParams = {}): Promise<WordPressPost[]> {
    return this.request("GET", `pages${this.toQueryString(params)}`);
  }

  getPage(id: number): Promise<WordPressPost> {
    return this.request("GET", `pages/${id}`);
  }

  createPage(input: WordPressPostInput): Promise<WordPressPost> {
    return this.request("POST", "pages", input);
  }

  updatePage(id: number, input: WordPressPostInput): Promise<WordPressPost> {
    return this.request("PUT", `pages/${id}`, input);
  }

  deletePage(id: number, force = false): Promise<unknown> {
    return this.request("DELETE", `pages/${id}${this.toQueryString({ force })}`);
  }

  listCategories(params: ListTermsParams = {}): Promise<WordPressTerm[]> {
    return this.request("GET", `categories${this.toQueryString(params)}`);
  }

  createCategory(input: WordPressTermInput): Promise<WordPressTerm> {
    return this.request("POST", "categories", input);
  }

  listTags(params: ListTermsParams = {}): Promise<WordPressTerm[]> {
    return this.request("GET", `tags${this.toQueryString(params)}`);
  }

  createTag(input: WordPressTermInput): Promise<WordPressTerm> {
    return this.request("POST", "tags", input);
  }

  listComments(params: ListCommentsParams = {}): Promise<WordPressComment[]> {
    return this.request("GET", `comments${this.toQueryString(params)}`);
  }

  getComment(id: number): Promise<WordPressComment> {
    return this.request("GET", `comments/${id}`);
  }

  createComment(input: WordPressCommentInput): Promise<WordPressComment> {
    return this.request("POST", "comments", input);
  }

  updateComment(id: number, input: WordPressCommentInput): Promise<WordPressComment> {
    return this.request("PUT", `comments/${id}`, input);
  }

  deleteComment(id: number, force = false): Promise<unknown> {
    return this.request("DELETE", `comments/${id}${this.toQueryString({ force })}`);
  }

  async uploadMedia(
    filePath: string,
    mimeType = "application/octet-stream",
    options: { fileName?: string; altText?: string; caption?: string } = {}
  ): Promise<WordPressMedia> {
    this.assertUploadSize((await stat(filePath)).size);
    const bytes = await readFile(filePath);
    const media = await this.uploadMediaBytes(
      bytes,
      options.fileName ?? basename(filePath),
      mimeType
    );

    if (!options.altText && !options.caption) return media;

    return this.updateMedia(media.id, {
      ...(options.altText ? { alt_text: options.altText } : {}),
      ...(options.caption ? { caption: options.caption } : {}),
    });
  }

  uploadMediaBytes(
    bytes: Uint8Array,
    fileName: string,
    mimeType = "application/octet-stream"
  ): Promise<WordPressMedia> {
    return this.request("POST", "media", bytes, {
      "Content-Disposition": `attachment; filename="${this.sanitizeFileName(fileName)}"`,
      "Content-Type": mimeType,
    });
  }

  updateMedia(
    id: number,
    input: { title?: string; caption?: string; description?: string; alt_text?: string }
  ): Promise<WordPressMedia> {
    return this.request("POST", `media/${id}`, input);
  }

  deleteMedia(id: number, force = true): Promise<unknown> {
    return this.request("DELETE", `media/${id}${this.toQueryString({ force })}`);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    baseUrl = this.apiBaseUrl
  ): Promise<T> {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(this.rootApiUrl).origin) {
      throw new WordPressRequestPolicyError(
        "WordPress requests must stay on the configured site's origin.",
        "wordpress_destination_blocked"
      );
    }
    assertIndividualEndpoint(url);
    this.assertBodyUploadSize(body);
    const release = await this.requestSafety.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // A different in-flight call may have opened the circuit after this slot was granted.
      this.requestSafety.assertRunning();
      // Mutable FormData may have changed while waiting in the host-wide queue.
      this.assertBodyUploadSize(body);
      const serializedBody = this.serializeBody(body);
      const response = await this.fetchImplementation(url, {
        method,
        // Automatic redirects could silently dispatch an unbudgeted /batch/v1 request.
        redirect: "manual",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...this.bodyHeaders(body),
          ...headers,
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        signal: controller.signal,
      });

      if (response.status === 403 || response.status === 429) {
        this.requestSafety.stop(response.status, response.headers.get("retry-after"));
      }

      const text = await response.text();
      const payload = text ? this.parseResponse(text) : null;

      if (!response.ok) {
        const errorPayload = this.asErrorPayload(payload);
        throw new WordPressApiError(
          errorPayload?.message ?? `WordPress request failed with HTTP ${response.status}`,
          response.status,
          payload,
          errorPayload?.code
        );
      }

      return payload as T;
    } finally {
      clearTimeout(timeout);
      release();
    }
  }

  private serializeBody(body: unknown): BodyInit | undefined {
    if (body === undefined) return undefined;
    if (body instanceof Blob || body instanceof FormData) return body;
    if (body instanceof ArrayBuffer) return body;
    if (ArrayBuffer.isView(body)) {
      const copy = new ArrayBuffer(body.byteLength);
      new Uint8Array(copy).set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      return new Blob([copy]);
    }
    return JSON.stringify(body);
  }

  private bodyHeaders(body: unknown): Record<string, string> {
    if (body === undefined || body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return {};
    return { "Content-Type": "application/json" };
  }

  private assertUploadSize(bytes: number): void {
    if (bytes > this.maxUploadBytes) {
      throw new WordPressRequestPolicyError(
        `Upload contains ${bytes} bytes; the per-file limit is ${this.maxUploadBytes} bytes (maximum 32 MB).`,
        "wordpress_upload_too_large"
      );
    }
  }

  private assertBodyUploadSize(body: unknown): void {
    if (body instanceof Blob) this.assertUploadSize(body.size);
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) this.assertUploadSize(body.byteLength);
    else if (body instanceof FormData) body.forEach(value => {
      if (value instanceof Blob) this.assertUploadSize(value.size);
    });
    else if (body instanceof ReadableStream) {
      throw new WordPressRequestPolicyError("Streaming request bodies cannot be prechecked against the upload limit. Use a sized Blob or byte array.", "wordpress_unsupported_upload_body");
    }
  }

  private parseResponse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private asErrorPayload(payload: unknown): { message?: string; code?: string } | null {
    if (typeof payload !== "object" || payload === null) return null;
    const candidate = payload as { message?: unknown; code?: unknown };
    return {
      ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }

  private toQueryString(params: object): string {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      query.set(
        this.toSnakeCase(key),
        Array.isArray(value) ? value.join(",") : String(value)
      );
    }

    const serialized = query.toString();
    return serialized ? `?${serialized}` : "";
  }

  private toSnakeCase(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  private normalizeSiteUrl(value: string): string {
    const url = new URL(value);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url.toString();
  }

  private sanitizeFileName(value: string): string {
    return basename(value).replace(/["\r\n]/g, "_");
  }
}

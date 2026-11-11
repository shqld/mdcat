import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type Location =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "url"; readonly url: URL };

export interface LoadedDocument {
  readonly location: Location;
  readonly text: string;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MARKDOWN_PATH = /\.(?:md|markdown)$/i;
const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function locationOf(source: string | null): Location {
  if (source !== null && URL.canParse(source)) {
    const url = new URL(source);
    if (WEB_PROTOCOLS.has(url.protocol)) {
      return { kind: "url", url };
    }
  }
  return { kind: "file", path: resolve(source ?? "-") };
}

export function resolveLink(from: Location, href: string): Location | null {
  if (CONTROL_CHARACTER.test(href) || href.startsWith("#")) {
    return null;
  }
  if (from.kind === "url") {
    return URL.canParse(href, from.url.href) ? webLocation(new URL(href, from.url)) : null;
  }
  if (SCHEME.test(href)) {
    return URL.canParse(href) ? webLocation(new URL(href)) : null;
  }
  const path = decodePath(href.replace(/[?#].*$/s, ""));
  if (path === null || path.length === 0) {
    return null;
  }
  const target = resolve(from.path, "..", path);
  return MARKDOWN_PATH.test(target) ? { kind: "file", path: target } : null;
}

export function displayName(location: Location): string {
  if (location.kind === "url") {
    return location.url.href;
  }
  const local = relative(process.cwd(), location.path);
  return local.startsWith("..") || isAbsolute(local) ? location.path : local;
}

export async function loadLocation(location: Location, fetcher: typeof fetch = fetch): Promise<LoadedDocument> {
  return location.kind === "file" ? readLocalFile(location) : fetchMarkdown(location.url, fetcher);
}

function webLocation(url: URL): Location | null {
  return WEB_PROTOCOLS.has(url.protocol) && MARKDOWN_PATH.test(url.pathname) ? { kind: "url", url } : null;
}

function decodePath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);
    return CONTROL_CHARACTER.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

async function readLocalFile(location: Extract<Location, { kind: "file" }>): Promise<LoadedDocument> {
  const handle = await open(location.path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error(`larger than ${MAX_DOCUMENT_BYTES} bytes`);
    }
    return { location, text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

async function fetchMarkdown(start: URL, fetcher: typeof fetch): Promise<LoadedDocument> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetcher(url, {
      redirect: "manual",
      signal,
      credentials: "omit",
      headers: { accept: "text/markdown, text/plain;q=0.9" },
    });
    const next = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && next !== null) {
      await response.body?.cancel();
      if (!URL.canParse(next, url.href)) {
        throw new Error("redirected to an invalid URL");
      }
      const redirected = new URL(next, url);
      if (!WEB_PROTOCOLS.has(redirected.protocol)) {
        throw new Error("redirected outside http and https");
      }
      url = redirected;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!MARKDOWN_TYPES.has(type)) {
      await response.body?.cancel();
      throw new Error(`not Markdown (${type.length === 0 ? "no content type" : type})`);
    }
    return { location: { kind: "url", url }, text: await readLimited(response) };
  }
  throw new Error("too many redirects");
}

async function readLimited(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error(`larger than ${MAX_DOCUMENT_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
}

export function localPath(location: Location): string | null {
  return location.kind === "file" ? location.path : null;
}

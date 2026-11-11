import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLocation, locationOf, MAX_DOCUMENT_BYTES, resolveLink, type Location } from "../src/location.ts";

const file = (path: string): Location => ({ kind: "file", path });
const web = (url: string): Location => ({ kind: "url", url: new URL(url) });

describe("resolveLink from a local file", () => {
  const from = file("/docs/guide/index.md");

  test("resolves a relative Markdown path against the file's directory", () => {
    expect(resolveLink(from, "../intro.md")).toEqual(file("/docs/intro.md"));
    expect(resolveLink(from, "next.markdown#usage")).toEqual(file("/docs/guide/next.markdown"));
    expect(resolveLink(from, "with%20space.md")).toEqual(file("/docs/guide/with space.md"));
  });

  test("follows an http or https Markdown URL", () => {
    expect(resolveLink(from, "https://example.com/a.md")).toEqual(web("https://example.com/a.md"));
    expect(resolveLink(from, "http://localhost:8000/b.md?x=1")).toEqual(web("http://localhost:8000/b.md?x=1"));
  });

  test("ignores links that are not Markdown, fragments, other schemes and control characters", () => {
    for (const href of ["data.json", "#usage", "file:///etc/hosts.md", "javascript:alert(1)//.md", "mailto:a@example.com", "https://example.com/page", "a\u001b.md", "%1b.md", "%E0%A4%A.md"]) {
      expect(resolveLink(from, href)).toBeNull();
    }
  });
});

describe("resolveLink from a web page", () => {
  const from = web("https://example.com/docs/index.md");

  test("resolves relative and absolute paths on the same site", () => {
    expect(resolveLink(from, "next.md")).toEqual(web("https://example.com/docs/next.md"));
    expect(resolveLink(from, "/etc/passwd.md")).toEqual(web("https://example.com/etc/passwd.md"));
    expect(resolveLink(from, "../../../etc/hosts.md")).toEqual(web("https://example.com/etc/hosts.md"));
  });

  test("never resolves to a local file", () => {
    for (const href of ["file:///etc/hosts.md", "file:hosts.md", "//example.org/x.txt"]) {
      expect(resolveLink(from, href)).toBeNull();
    }
  });
});

describe("locationOf", () => {
  test("reads http and https paths as web locations and anything else as a local path", () => {
    expect(locationOf("https://example.com/a.md")).toEqual(web("https://example.com/a.md"));
    expect(locationOf("file:///etc/hosts.md")).toEqual(file(join(process.cwd(), "file:/etc/hosts.md")));
    expect(locationOf("docs/a.md")).toEqual(file(join(process.cwd(), "docs/a.md")));
  });
});

describe("loadLocation for local files", () => {
  let directory = "";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mdcat-location-"));
  });
  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  test("reads a regular file and a symlink to one", async () => {
    writeFileSync(join(directory, "a.md"), "# A\n");
    symlinkSync(join(directory, "a.md"), join(directory, "link.md"));
    expect((await loadLocation(file(join(directory, "a.md")))).text).toBe("# A\n");
    expect((await loadLocation(file(join(directory, "link.md")))).text).toBe("# A\n");
  });

  test("refuses directories, FIFOs and devices without blocking", async () => {
    mkdirSync(join(directory, "dir.md"));
    execFileSync("mkfifo", [join(directory, "pipe.md")]);
    symlinkSync("/dev/zero", join(directory, "zero.md"));
    for (const name of ["dir.md", "pipe.md", "zero.md"]) {
      await expect(loadLocation(file(join(directory, name)))).rejects.toThrow();
    }
  });

  test("refuses a file larger than the limit", async () => {
    writeFileSync(join(directory, "big.md"), "x".repeat(MAX_DOCUMENT_BYTES + 1));
    await expect(loadLocation(file(join(directory, "big.md")))).rejects.toThrow("larger than");
  });
});

describe("loadLocation for web pages", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/doc.md") {
          return new Response("# Doc\n", { headers: { "content-type": "text/markdown; charset=utf-8" } });
        }
        if (path === "/plain.md") {
          return new Response("plain\n", { headers: { "content-type": "text/plain" } });
        }
        if (path === "/html.md") {
          return new Response("<html></html>", { headers: { "content-type": "text/html" } });
        }
        if (path === "/to-doc.md") {
          return new Response(null, { status: 302, headers: { location: "/doc.md" } });
        }
        if (path === "/to-file.md") {
          return new Response(null, { status: 302, headers: { location: "file:///etc/hosts" } });
        }
        if (path === "/loop.md") {
          return new Response(null, { status: 302, headers: { location: "/loop.md" } });
        }
        if (path === "/huge.md") {
          const chunk = new Uint8Array(1024 * 1024).fill(120);
          let sent = 0;
          return new Response(new ReadableStream({
            pull(controller) {
              sent += 1;
              if (sent > 8) {
                controller.close();
              } else {
                controller.enqueue(chunk);
              }
            },
          }), { headers: { "content-type": "text/markdown" } });
        }
        if (path === "/missing.md") {
          return new Response("gone", { status: 404, headers: { "content-type": "text/markdown" } });
        }
        return new Response(null, { status: 500 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    void server?.stop(true);
  });

  test("reads text/markdown and text/plain", async () => {
    expect((await loadLocation(web(`${base}/doc.md`))).text).toBe("# Doc\n");
    expect((await loadLocation(web(`${base}/plain.md`))).text).toBe("plain\n");
  });

  test("follows an http redirect and reports the final URL", async () => {
    const loaded = await loadLocation(web(`${base}/to-doc.md`));
    expect(loaded.location).toEqual(web(`${base}/doc.md`));
    expect(loaded.text).toBe("# Doc\n");
  });

  test("refuses HTML, error statuses, redirects outside http and redirect loops", async () => {
    await expect(loadLocation(web(`${base}/html.md`))).rejects.toThrow("not Markdown (text/html)");
    await expect(loadLocation(web(`${base}/missing.md`))).rejects.toThrow("HTTP 404");
    await expect(loadLocation(web(`${base}/to-file.md`))).rejects.toThrow("redirected outside http and https");
    await expect(loadLocation(web(`${base}/loop.md`))).rejects.toThrow("too many redirects");
  });

  test("stops reading a body larger than the limit", async () => {
    await expect(loadLocation(web(`${base}/huge.md`))).rejects.toThrow("larger than");
  });

  test("sends no cookies or credentials", async () => {
    const seen: RequestInit[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(init ?? {});
      return fetch(input, init);
    };
    await loadLocation(web(`${base}/doc.md`), Object.assign(fetcher, { preconnect: fetch.preconnect }));
    expect(seen[0]?.credentials).toBe("omit");
    expect(seen[0]?.redirect).toBe("manual");
  });
});

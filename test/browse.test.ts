import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLinkId } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMarkdownDocument } from "../src/diff.ts";
import type { LoadedDocument, Location } from "../src/location.ts";
import { browse, type Browser, type Page } from "../src/ui.ts";

let setup: TestRendererSetup | null = null;
let directory = "";
const previousHyperlink = process.env.FORCE_HYPERLINK;

beforeEach(() => {
  process.env.FORCE_HYPERLINK = "1";
  directory = mkdtempSync(join(tmpdir(), "mdcat-browse-"));
});

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  rmSync(directory, { force: true, recursive: true });
  if (previousHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK;
  } else {
    process.env.FORCE_HYPERLINK = previousHyperlink;
  }
});

function filePage(path: string, text: string): Page {
  return { document: { files: [parseMarkdownDocument(path, text)] }, watched: [path] };
}

async function frame(): Promise<string> {
  if (setup === null) {
    throw new Error("no renderer");
  }
  await setup.renderOnce();
  await setup.waitForVisualIdle();
  return setup.captureCharFrame();
}

async function clickText(browser: Browser, text: string): Promise<void> {
  if (setup === null) {
    throw new Error("no renderer");
  }
  const lines = (await frame()).split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  const x = lines[y]?.indexOf(text) ?? -1;
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click(x + 1, y);
  await browser.settled();
}

describe("browse", () => {
  test("clicking a relative Markdown link opens the file and b goes back", async () => {
    const index = join(directory, "index.md");
    writeFileSync(join(directory, "next.md"), "# Next page\n");
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "# Index\n\nSee [the next page](next.md).\n"));

    await clickText(browser, "the next page");
    expect(await frame()).toContain("Next page");

    setup.mockInput.pressKey("b");
    expect(await frame()).toContain("See the next page.");
  });

  test("clicking a link inside a table cell opens the file", async () => {
    const index = join(directory, "index.md");
    writeFileSync(join(directory, "row.md"), "# Row page\n");
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "| page |\n|---|\n| [cell link](row.md) |\n"));

    await clickText(browser, "cell link");
    expect(await frame()).toContain("Row page");
  });

  test("clicking a link to a file that is not Markdown keeps the page", async () => {
    const index = join(directory, "index.md");
    writeFileSync(join(directory, "data.json"), "{}\n");
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "# Index\n\n[data](data.json)\n"));

    await clickText(browser, "data");
    expect(browser.page().document.files[0]?.path).toBe(index);
  });

  test("a missing link target shows the reason in the footer", async () => {
    const index = join(directory, "index.md");
    setup = await createTestRenderer({ width: 120, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "# Index\n\n[gone](gone.md)\n"));

    await clickText(browser, "gone");
    expect(await frame()).toContain("Cannot open");
  });

  test("relative links are not sent to the terminal as hyperlinks", async () => {
    const index = join(directory, "index.md");
    setup = await createTestRenderer({ width: 80, height: 20 });
    browse(setup.renderer, filePage(index, "[local](next.md) [web](https://example.com/a.md)\n"));
    await frame();

    const buffer = setup.renderer.currentRenderBuffer;
    const urls = new Set<string>();
    for (const attribute of buffer.buffers.attributes) {
      const id = getLinkId(attribute);
      if (id !== 0) {
        urls.add(buffer.lib.linkGetUrl(id));
      }
    }
    expect([...urls]).toEqual(["https://example.com/a.md"]);
  });

  test("clicking a web Markdown link opens it through the loader", async () => {
    const index = join(directory, "index.md");
    const requested: Location[] = [];
    const load = async (location: Location): Promise<LoadedDocument> => {
      requested.push(location);
      return { location, text: "# Remote page\n" };
    };
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "[web](https://example.com/a.md)\n"), { load });
    await frame();
    expect(requested).toEqual([]);

    await clickText(browser, "web");
    expect(requested).toEqual([{ kind: "url", url: new URL("https://example.com/a.md") }]);
    expect(await frame()).toContain("Remote page");
  });

  test("dragging across a link does not open it", async () => {
    const index = join(directory, "index.md");
    writeFileSync(join(directory, "next.md"), "# Next page\n");
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, filePage(index, "See [the next page](next.md) now.\n"));
    const lines = (await frame()).split("\n");
    const y = lines.findIndex((line) => line.includes("the next page"));
    const x = lines[y]?.indexOf("the next page") ?? 0;

    await setup.mockMouse.drag(x, y, x + 8, y);
    await browser.settled();
    expect(browser.page().document.files[0]?.path).toBe(index);
  });
});

describe("watch", () => {
  test("saving the watched file renders the new content", async () => {
    const index = join(directory, "index.md");
    writeFileSync(index, "# First\n");
    const read = async (): Promise<string> => Bun.file(index).text();
    const page: Page = {
      document: { files: [parseMarkdownDocument(index, await read())] },
      reload: async () => ({ files: [parseMarkdownDocument(index, await read())] }),
      watched: [index],
    };
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, page, { watch: true });
    expect(await frame()).toContain("First");

    writeFileSync(index, "# Second\n");
    for (let attempt = 0; attempt < 50 && !(await frame()).includes("Second"); attempt += 1) {
      await Bun.sleep(20);
      await browser.settled();
    }
    expect(await frame()).toContain("Second");
  });

  test("saving the watched file keeps the scroll position", async () => {
    const index = join(directory, "index.md");
    const body = Array.from({ length: 80 }, (_, line) => `line ${line}\n`).join("\n");
    writeFileSync(index, body);
    const read = async (): Promise<string> => Bun.file(index).text();
    const page: Page = {
      document: { files: [parseMarkdownDocument(index, await read())] },
      reload: async () => ({ files: [parseMarkdownDocument(index, await read())] }),
      watched: [index],
    };
    setup = await createTestRenderer({ width: 80, height: 20 });
    const browser = browse(setup.renderer, page, { watch: true });
    await frame();
    browser.viewer().scroll.scrollTop = 40;
    await frame();
    const before = browser.viewer().scroll.scrollTop;

    writeFileSync(index, `${body}\nlast\n`);
    const first = browser.viewer();
    for (let attempt = 0; attempt < 50 && browser.viewer() === first; attempt += 1) {
      await Bun.sleep(20);
      await browser.settled();
    }
    await frame();
    expect(browser.viewer()).not.toBe(first);
    expect(browser.viewer().scroll.scrollTop).toBe(before);
  });
});

describe("terminal output", () => {
  test("control characters in a document do not reach the screen buffer", async () => {
    const index = join(directory, "index.md");
    setup = await createTestRenderer({ width: 80, height: 20 });
    browse(setup.renderer, filePage(index, "a \u001b]52;c;aGk=\u0007 b \u001b[2J c \u009b31m d\n"));
    await frame();

    const controls = Array.from(setup.renderer.currentRenderBuffer.buffers.char).filter((code) => (code > 0 && code < 0x20) || (code >= 0x7f && code < 0xa0));
    expect(controls).toEqual([]);
  });
});

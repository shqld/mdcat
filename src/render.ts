import { showDiff, type BrowseOptions, type Page } from "./ui.ts";

export async function render(name: string, load: () => Promise<Page>, options: BrowseOptions = {}): Promise<number> {
  try {
    const page = await load();
    if (page.document.files.length === 0) {
      process.stdout.write(`${name}: no Markdown changes\n`);
      return 0;
    }
    await showDiff(page, options);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${name}: ${message}\n`);
    return 1;
  }
}

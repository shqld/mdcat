import type { MarkdownDiff } from "./diff.ts";
import { showDiff } from "./ui.ts";

export async function render(name: string, load: () => Promise<MarkdownDiff>): Promise<number> {
  try {
    const document = await load();
    if (document.files.length === 0) {
      process.stdout.write(`${name}: no Markdown changes\n`);
      return 0;
    }
    await showDiff(document);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${name}: ${message}\n`);
    return 1;
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";
// Write to a temp file in the same directory, then rename over the target, so a crash or a second reader
// never sees a half-written file. Unlike writeFileAtomic in mcp/writer.ts this has no compare-and-swap:
// two writers racing on the same file can still lose one update.
export async function writeTextAtomic(filePath, text) {
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
        await fs.writeFile(tempPath, text, "utf-8");
        await fs.rename(tempPath, filePath);
    }
    finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

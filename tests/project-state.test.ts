import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectStatePath, readProjectTrackingState, setProjectTrackingState } from "../src/project-state.js";

describe("project tracking state file safety", () => {
  it("treats a corrupt state file as unknown and recovers on the next write", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-state-corrupt-"));
    const file = projectStatePath({ homeDir });
    await fs.writeFile(file, '{"schemaVersion":1,"projects":{"a', "utf-8");

    expect((await readProjectTrackingState("C:/repo/demo", { homeDir })).state).toBe("unknown");

    await setProjectTrackingState("C:/repo/demo", "opted-out", { homeDir });
    expect((await readProjectTrackingState("C:/repo/demo", { homeDir })).state).toBe("opted-out");
    expect((await fs.readdir(homeDir)).sort()).toEqual(["project-state.json"]);
  });
});

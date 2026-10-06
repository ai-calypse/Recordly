import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { listRecordings } from "./recordings";

it("lists media newest first and ignores other files", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rec-"));
	await fs.writeFile(path.join(dir, "old.mp4"), "a");
	await fs.writeFile(path.join(dir, "notes.txt"), "x");
	await fs.writeFile(path.join(dir, "new.webm"), "bb");
	await fs.utimes(path.join(dir, "old.mp4"), new Date(1000), new Date(1000));
	const { recordings } = await listRecordings(dir);
	expect(recordings.map((r) => r.name)).toEqual(["new.webm", "old.mp4"]);
	expect(recordings[0].sizeBytes).toBe(2);
	expect(await listRecordings(path.join(dir, "missing"))).toEqual({ recordings: [] });
});

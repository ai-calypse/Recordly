import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEditorAutomation } from "./editor";

async function setup() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-"));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
	await fs.writeFile(path.join(dir, "demo.mp4"), "x");
	await fs.writeFile(path.join(outside, "secret.mp4"), "x");
	let onClosed = () => {};
	const window = {
		webContents: { id: 7 },
		close: vi.fn(),
		once: (_: string, cb: () => void) => (onClosed = cb),
	};
	const applySession = vi.fn(async () => ({}));
	const editor = createEditorAutomation({
		recordingsDir: async () => dir,
		applySession,
		createEditor: () => window,
	});
	return { dir, outside, window, applySession, editor, closeWindow: () => onClosed() };
}

describe("editor automation", () => {
	it("rejects files outside the recordings folder", async () => {
		const { editor, outside, dir } = await setup();
		await expect(
			editor.openInEditor({ videoPath: path.join(outside, "secret.mp4") }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await fs.symlink(path.join(outside, "secret.mp4"), path.join(dir, "link.mp4"));
		await expect(
			editor.openInEditor({ videoPath: path.join(dir, "link.mp4") }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			editor.openInEditor({ videoPath: path.join(dir, "missing.mp4") }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("runs one export: claim, progress, completion closes the window", async () => {
		const { editor, dir, window, applySession } = await setup();
		const job = await editor.startExport({
			videoPath: path.join(dir, "demo.mp4"),
			format: "gif",
			quality: "good",
		});
		expect(job.phase).toBe("starting");
		expect(job.outputPath).toMatch(/demo-export-\d+\.gif$/);
		expect(applySession).toHaveBeenCalledOnce();
		await expect(
			editor.startExport({ videoPath: path.join(dir, "demo.mp4"), format: "mp4" }),
		).rejects.toMatchObject({ code: "BUSY" });
		expect(editor.claim(99)).toBeNull();
		const claim = editor.claim(7);
		expect(claim).toMatchObject({ exportId: job.exportId, format: "gif", quality: "good" });
		expect(editor.claim(7)).toBeNull();
		editor.update(99, { exportId: job.exportId, phase: "failed" });
		editor.update(7, { exportId: job.exportId, phase: "exporting", progress: 42.4 });
		expect(editor.get(job.exportId)).toMatchObject({ phase: "exporting", progress: 42 });
		editor.update(7, { exportId: job.exportId, phase: "completed", outputPath: "/etc/passwd" });
		expect(editor.get(job.exportId)).toMatchObject({
			phase: "completed",
			progress: 100,
			outputPath: job.outputPath,
		});
		expect(window.close).toHaveBeenCalledOnce();
	});

	it("fails the job when the editor window closes early", async () => {
		const { editor, dir, closeWindow } = await setup();
		const job = await editor.startExport({
			videoPath: path.join(dir, "demo.mp4"),
			format: "mp4",
		});
		closeWindow();
		expect(editor.get(job.exportId)).toMatchObject({ phase: "failed" });
		expect(editor.get()).toMatchObject({ phase: "failed" });
	});
});

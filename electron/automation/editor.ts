import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	AutomationError,
	type ExportClaim,
	type ExportJob,
	type ExportQuality,
	type ExportUpdate,
	type ExportFormat,
} from "./protocol";

const MEDIA = /\.(mp4|webm|mov|mkv)$/i;
const MAX_JOBS = 20;

export interface EditorWindow {
	webContents: { id: number };
	close(): void;
	once(event: "closed", listener: () => void): unknown;
}

export interface EditorAutomationDeps {
	recordingsDir(): Promise<string>;
	applySession(session: { videoPath: string; webcamPath?: string }): Promise<unknown>;
	createEditor(): EditorWindow;
}

type Files = { videoPath: string; webcamPath?: string };
type Active = { job: ExportJob; windowId: number; quality?: ExportQuality; window: EditorWindow };

const isDone = (job: ExportJob) => job.phase === "completed" || job.phase === "failed";

/** Agent-supplied paths must be media inside Recordly's recordings folder. */
async function managedPath(dir: string, file: string) {
	const [root, real] = await Promise.all([fs.realpath(dir), fs.realpath(file)]).catch(() => {
		throw new AutomationError("NOT_FOUND", "File does not exist.", 404);
	});
	if (!real.startsWith(root + path.sep) || !MEDIA.test(real)) {
		throw new AutomationError(
			"INVALID_PARAMS",
			"Path must be a media file in Recordly's recordings folder (see list_recordings).",
		);
	}
	return real;
}

export function createEditorAutomation(deps: EditorAutomationDeps) {
	const jobs = new Map<string, ExportJob>();
	let active: Active | undefined;
	let latestId: string | undefined;

	const resolveFiles = async (files: Files) => {
		const dir = await deps.recordingsDir();
		return {
			dir,
			videoPath: await managedPath(dir, files.videoPath),
			...(files.webcamPath ? { webcamPath: await managedPath(dir, files.webcamPath) } : {}),
		};
	};

	const finish = (patch: Partial<ExportJob>) => {
		if (!active || isDone(active.job)) return;
		Object.assign(active.job, patch, { updatedAt: new Date().toISOString() });
		if (isDone(active.job)) {
			const { window } = active;
			active = undefined;
			window.close();
		}
	};

	return {
		async openInEditor(files: Files) {
			const { dir: _dir, ...session } = await resolveFiles(files);
			await deps.applySession(session);
			deps.createEditor();
			return { opened: true, videoPath: session.videoPath };
		},

		async startExport(params: Files & { format: ExportFormat; quality?: ExportQuality }) {
			if (active) {
				throw new AutomationError("BUSY", "An export is already running.", 409);
			}
			const { dir, ...session } = await resolveFiles(params);
			const stem = path.basename(session.videoPath, path.extname(session.videoPath));
			const timestamp = new Date().toISOString();
			const job: ExportJob = {
				exportId: randomUUID(),
				videoPath: session.videoPath,
				format: params.format,
				phase: "starting",
				createdAt: timestamp,
				updatedAt: timestamp,
				outputPath: path.join(dir, `${stem}-export-${Date.now()}.${params.format}`),
			};
			await deps.applySession(session);
			const window = deps.createEditor();
			active = { job, windowId: window.webContents.id, quality: params.quality, window };
			jobs.set(job.exportId, job);
			latestId = job.exportId;
			if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value as string);
			window.once("closed", () =>
				finish({
					phase: "failed",
					error: "The editor window closed before the export finished.",
				}),
			);
			return { ...job };
		},

		/** The editor window asks for its job once it has mounted. */
		claim(senderId: number): ExportClaim | null {
			if (!active || active.windowId !== senderId || active.job.phase !== "starting") {
				return null;
			}
			finish({ phase: "exporting", progress: 0 });
			const { job, quality } = active;
			return {
				exportId: job.exportId,
				format: job.format,
				quality,
				outputPath: job.outputPath as string,
			};
		},

		update(senderId: number, update: ExportUpdate) {
			if (
				!active ||
				active.windowId !== senderId ||
				active.job.exportId !== update.exportId
			) {
				return;
			}
			if (update.phase === "failed") {
				finish({
					phase: "failed",
					error: String(update.error ?? "Export failed").slice(0, 1000),
				});
			} else if (update.phase === "completed") {
				finish({ phase: "completed", progress: 100 });
			} else if (typeof update.progress === "number") {
				finish({ progress: Math.min(99, Math.max(0, Math.round(update.progress))) });
			}
		},

		get(exportId?: string) {
			const id = exportId ?? latestId;
			if (!id) return { phase: "idle" };
			const job = jobs.get(id);
			if (!job)
				throw new AutomationError("NOT_FOUND", "Export ID is unknown or expired.", 404);
			return { ...job };
		},
	};
}

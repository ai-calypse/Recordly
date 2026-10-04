export const AUTOMATION_API_VERSION = 1;

export type AutomationCommand =
	| { method: "list_sources"; params: Record<string, never> }
	| { method: "get_recording_status"; params: { recordingId?: string } }
	| { method: "start_recording"; params: { requestId: string; sourceId: string } }
	| { method: "stop_recording"; params: { recordingId: string } }
	| { method: "pause_recording"; params: { recordingId: string } }
	| { method: "resume_recording"; params: { recordingId: string } }
	| { method: "cancel_recording"; params: { recordingId: string } }
	| { method: "list_recordings"; params: Record<string, never> }
	| { method: "open_in_editor"; params: { videoPath: string; webcamPath?: string } }
	| {
			method: "export_recording";
			params: {
				videoPath: string;
				webcamPath?: string;
				format: ExportFormat;
				quality?: ExportQuality;
			};
	  }
	| { method: "get_export_status"; params: { exportId?: string } };

export type ExportFormat = "mp4" | "gif";
export type ExportQuality = "medium" | "good" | "high" | "source";
export const EXPORT_QUALITIES: readonly ExportQuality[] = ["medium", "good", "high", "source"];

/** Answered by the main process without the recording window. */
export type MainCommand = Extract<
	AutomationCommand,
	{ method: "list_recordings" | "open_in_editor" | "export_recording" | "get_export_status" }
>;
export type RecordingCommand = Exclude<AutomationCommand, MainCommand>;

/** Commands the recording window executes. */
export type RendererCommand = Exclude<RecordingCommand, { method: "get_recording_status" }>;

export type ExportPhase = "starting" | "exporting" | "completed" | "failed";

export interface ExportJob {
	exportId: string;
	videoPath: string;
	format: ExportFormat;
	phase: ExportPhase;
	createdAt: string;
	updatedAt: string;
	/** 0-100 while exporting. */
	progress?: number;
	outputPath?: string;
	error?: string;
}

export type ExportUpdate = Pick<ExportJob, "exportId" | "phase"> &
	Partial<Pick<ExportJob, "progress" | "outputPath" | "error">>;

/** What the editor window needs to run a claimed export. */
export interface ExportClaim {
	exportId: string;
	format: ExportFormat;
	quality?: ExportQuality;
	outputPath: string;
}

export type RecordingPhase =
	| "starting"
	| "recording"
	| "finalizing"
	| "completed"
	| "cancelled"
	| "failed";

export interface AutomationRecording {
	recordingId: string;
	sourceId: string;
	phase: RecordingPhase;
	createdAt: string;
	updatedAt: string;
	paused?: boolean;
	videoPath?: string;
	webcamPath?: string | null;
	error?: string;
	warnings?: string[];
}

export type RecordingUpdate = Pick<AutomationRecording, "recordingId" | "phase"> &
	Partial<
		Pick<AutomationRecording, "paused" | "videoPath" | "webcamPath" | "error" | "warnings">
	>;

export interface AutomationSource {
	id: string;
	name: string;
	type: "screen" | "window";
	requiresSelection: boolean;
}

export interface AutomationApproval {
	sourceName: string;
	microphone: boolean;
	systemAudio: boolean;
	webcam: boolean;
}

export interface RendererAutomationCommand {
	id: string;
	command: RendererCommand;
}

export interface RendererAutomationResult {
	id: string;
	result?: unknown;
	error?: string;
}

export class AutomationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		this.name = "AutomationError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAutomationCommand(value: unknown): AutomationCommand {
	if (!isRecord(value) || typeof value.method !== "string" || !isRecord(value.params)) {
		throw new AutomationError("INVALID_COMMAND", "Expected a method and params object.");
	}
	if (Object.keys(value).some((key) => key !== "method" && key !== "params")) {
		throw new AutomationError("INVALID_COMMAND", "Unknown command property.");
	}
	const params = value.params;
	const allowed: Record<string, string[]> = {
		list_sources: [],
		get_recording_status: ["recordingId"],
		start_recording: ["requestId", "sourceId"],
		stop_recording: ["recordingId"],
		pause_recording: ["recordingId"],
		resume_recording: ["recordingId"],
		cancel_recording: ["recordingId"],
		list_recordings: [],
		open_in_editor: ["videoPath", "webcamPath"],
		export_recording: ["videoPath", "webcamPath", "format", "quality"],
		get_export_status: ["exportId"],
	};
	if (!Object.keys(allowed).includes(value.method)) {
		throw new AutomationError("UNKNOWN_METHOD", "Unknown automation method.");
	}
	if (Object.keys(params).some((key) => !allowed[value.method as string].includes(key))) {
		throw new AutomationError("INVALID_PARAMS", "Unknown command parameter.");
	}
	const id = (key: string) => {
		const result = params[key];
		if (typeof result !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(result)) {
			throw new AutomationError("INVALID_PARAMS", `${key} must be an 8–128 character ID.`);
		}
		return result;
	};
	switch (value.method) {
		case "list_sources":
		case "list_recordings":
			return { method: value.method, params: {} };
		case "open_in_editor":
		case "export_recording": {
			const path = (key: string, required: boolean) => {
				const result = params[key];
				if (result === undefined && !required) return undefined;
				if (typeof result !== "string" || result.length === 0 || result.length > 4096) {
					throw new AutomationError("INVALID_PARAMS", `${key} must be a file path.`);
				}
				return result;
			};
			const files = {
				videoPath: path("videoPath", true) as string,
				...(path("webcamPath", false) ? { webcamPath: path("webcamPath", false) } : {}),
			};
			if (value.method === "open_in_editor") return { method: value.method, params: files };
			if (params.format !== "mp4" && params.format !== "gif") {
				throw new AutomationError("INVALID_PARAMS", "format must be mp4 or gif.");
			}
			const quality = params.quality;
			if (quality !== undefined && !EXPORT_QUALITIES.includes(quality as ExportQuality)) {
				throw new AutomationError("INVALID_PARAMS", "Unknown export quality.");
			}
			return {
				method: value.method,
				params: {
					...files,
					format: params.format,
					...(quality ? { quality: quality as ExportQuality } : {}),
				},
			};
		}
		case "get_export_status":
			return {
				method: value.method,
				params: params.exportId === undefined ? {} : { exportId: id("exportId") },
			};
		case "get_recording_status":
			return {
				method: value.method,
				params: params.recordingId === undefined ? {} : { recordingId: id("recordingId") },
			};
		case "start_recording": {
			if (
				typeof params.sourceId !== "string" ||
				params.sourceId.length > 256 ||
				(!params.sourceId.startsWith("screen:") && !params.sourceId.startsWith("window:"))
			) {
				throw new AutomationError(
					"INVALID_PARAMS",
					"sourceId must come from list_sources.",
				);
			}
			return {
				method: value.method,
				params: { requestId: id("requestId"), sourceId: params.sourceId },
			};
		}
		default:
			return {
				method: value.method as
					| "stop_recording"
					| "pause_recording"
					| "resume_recording"
					| "cancel_recording",
				params: { recordingId: id("recordingId") },
			};
	}
}

export function isTerminalPhase(phase: RecordingPhase) {
	return phase === "completed" || phase === "failed" || phase === "cancelled";
}

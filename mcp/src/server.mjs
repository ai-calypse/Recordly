import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const recordingId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const tools = [
	{
		name: "list_sources",
		description:
			"List Recordly screen and window capture sources. On Wayland the portal source requires the user to choose a surface in the system picker.",
		inputSchema: z.object({}).strict(),
		readOnly: true,
	},
	{
		name: "start_recording",
		description:
			"Request a Recordly recording of a source from list_sources. Uses the microphone, system audio, webcam and countdown settings currently configured in Recordly. The desktop app asks the user to approve capture. Returns starting immediately; poll get_recording_status until recording before performing the demo. Supply a unique requestId and reuse it on retries; it becomes the recordingId. The most recent 100 recording IDs are retained until Recordly exits.",
		inputSchema: z
			.object({
				requestId: recordingId.describe(
					"Unique request ID (for example a UUID); reuse exactly this ID for retries.",
				),
				sourceId: z
					.string()
					.min(1)
					.max(256)
					.regex(/^(screen|window):/)
					.describe("Source ID returned by list_sources."),
			})
			.strict(),
		readOnly: false,
	},
	{
		name: "get_recording_status",
		description:
			"Read an automation recording's phase: starting, recording, finalizing, completed, cancelled or failed. Without an ID returns the latest automation recording, or idle. A completed result includes the raw videoPath and optional webcamPath; polished editor export is separate. The paused flag reflects the user's pause control.",
		inputSchema: z.object({ recordingId: recordingId.optional() }).strict(),
		readOnly: true,
	},
	{
		name: "stop_recording",
		description:
			"Stop and save the specified automation recording. Returns finalizing; poll get_recording_status until completed or failed. Retrying the same recordingId never starts a new recording. Cannot stop a manually started recording or a recording still awaiting approval.",
		inputSchema: z.object({ recordingId }).strict(),
		readOnly: false,
	},
	{
		name: "pause_recording",
		description:
			"Pause the active automation recording. Poll get_recording_status for paused: true. Only valid while phase is recording.",
		inputSchema: z.object({ recordingId }).strict(),
		readOnly: false,
	},
	{
		name: "resume_recording",
		description:
			"Resume a paused automation recording. Poll get_recording_status for paused: false.",
		inputSchema: z.object({ recordingId }).strict(),
		readOnly: false,
	},
	{
		name: "cancel_recording",
		description:
			"Discard the active automation recording without saving it. The recording ends as cancelled and cannot be recovered. Use stop_recording to keep the footage.",
		inputSchema: z.object({ recordingId }).strict(),
		readOnly: false,
		destructive: true,
	},
	{
		name: "list_recordings",
		description:
			"List the newest 50 media files in Recordly's recordings folder (path, size, modified time). Works with or without an automation recording, so agents can find earlier footage.",
		inputSchema: z.object({}).strict(),
		readOnly: true,
	},
	{
		name: "wait_for_recording",
		description:
			"Block until a recording reaches a state instead of polling. until=recording (default) returns once it is recording or has ended, so call it after start_recording and the user's approval. until=done returns once it is completed, failed or cancelled, so call it after stop_recording. Returns the status plus timedOut; on timeout call it again.",
		inputSchema: z
			.object({
				recordingId: recordingId.optional(),
				until: z.enum(["recording", "done"]).default("recording"),
				timeoutSeconds: z.number().int().min(1).max(180).default(60),
			})
			.strict(),
		readOnly: true,
		run: waitForRecording,
	},
];

const TERMINAL = ["completed", "failed", "cancelled"];

async function waitForRecording({ recordingId, until, timeoutSeconds }, call, signal) {
	const targets = until === "done" ? TERMINAL : ["recording", ...TERMINAL];
	const deadline = Date.now() + timeoutSeconds * 1000;
	for (;;) {
		signal?.throwIfAborted();
		const status = await call(
			"get_recording_status",
			recordingId ? { recordingId } : {},
			signal,
		);
		const reached = targets.includes(status.phase);
		if (reached || Date.now() >= deadline) return { ...status, timedOut: !reached };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

export function createMcpServer(callRecordly) {
	const server = new McpServer({ name: "recordly", version: "0.1.0" });
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: {
					readOnlyHint: tool.readOnly,
					destructiveHint: tool.destructive ?? false,
					idempotentHint: tool.readOnly,
					openWorldHint: false,
				},
			},
			async (params, context) => {
				try {
					const result = tool.run
						? await tool.run(params, callRecordly, context.signal)
						: await callRecordly(tool.name, params, context.signal);
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						structuredContent: result,
					};
				} catch (error) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: error instanceof Error ? error.message : String(error),
							},
						],
					};
				}
			},
		);
	}
	return server;
}

import path from "node:path";
import { app, ipcMain } from "electron";
import { applyRecordingSession } from "../ipc/register/project";
import { getRecordingsDir } from "../ipc/utils";
import { createEditorWindow, createHudOverlayWindow, getHudOverlayWindow } from "../windows";
import { createAutomationBridge } from "./bridge";
import { RecordingController } from "./controller";
import { createEditorAutomation } from "./editor";
import { listRecordings } from "./recordings";
import { startAutomationServer } from "./server";

export async function startRecordingAutomation() {
	if (process.env.RECORDLY_AUTOMATION !== "1" && !process.argv.includes("--enable-automation"))
		return;
	const connectionFile =
		process.argv
			.find((arg) => arg.startsWith("--automation-connection-file="))
			?.split("=")
			.slice(1)
			.join("=") ??
		process.env.RECORDLY_AUTOMATION_FILE ??
		path.join(app.getPath("userData"), "automation.json");
	const controller = new RecordingController((command) => bridge.execute(command));
	const bridge = createAutomationBridge({
		getWindow: getHudOverlayWindow,
		ensureWindow: () => {
			if (!getHudOverlayWindow()) createHudOverlayWindow();
		},
		onUpdate: (update) => controller.update(update),
		onClosed: () => controller.rendererClosed(),
	});
	const editor = createEditorAutomation({
		recordingsDir: getRecordingsDir,
		// Agents must not swap the video in editors the user already has open.
		applySession: (session) => applyRecordingSession(session, { broadcast: false }),
		createEditor: createEditorWindow,
	});
	ipcMain.handle("automation:export-claim", (event) => editor.claim(event.sender.id));
	ipcMain.on("automation:export-update", (event, update) =>
		editor.update(event.sender.id, update),
	);
	try {
		const server = await startAutomationServer({
			connectionFile,
			dispatch: async (command) => {
				switch (command.method) {
					case "list_recordings":
						return listRecordings(await getRecordingsDir());
					case "open_in_editor":
						return editor.openInEditor(command.params);
					case "export_recording":
						return editor.startExport(command.params);
					case "get_export_status":
						return editor.get(command.params.exportId);
					default:
						return controller.call(command);
				}
			},
		});
		console.info(`Recordly automation connection file: ${connectionFile}`);
		app.once("will-quit", () => {
			ipcMain.removeHandler("automation:export-claim");
			ipcMain.removeAllListeners("automation:export-update");
			server.close();
			bridge.close();
		});
	} catch (error) {
		bridge.close();
		console.error("Recordly automation could not start:", error);
	}
}

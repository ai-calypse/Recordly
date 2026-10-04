import { useEffect, useRef, useState } from "react";
import type { ExportClaim } from "../../../../electron/automation/protocol";
import type { ExportFormat, ExportSettings } from "@/lib/exporter";
import type { useExportSession } from "./useExportSession";

const READY_TIMEOUT_MS = 60_000;

type Input = {
	ready: boolean;
	loadError: string | null;
	session: ReturnType<typeof useExportSession>;
	resolveSettings: (format: ExportFormat) => ExportSettings | null;
	handleExport: (
		settings: ExportSettings,
		options?: { destination?: "download" | "share"; outputPath?: string },
	) => Promise<string | undefined>;
};

/** Runs the export an agent queued for this editor window (see automation/editor.ts), then reports back. */
export function useAutomationExport({
	ready,
	loadError,
	session,
	resolveSettings,
	handleExport,
}: Input) {
	const [claim, setClaim] = useState<ExportClaim | null>(null);
	const startedRef = useRef(false);
	const latest = useRef({ error: session.exportError, progress: session.exportProgress });
	latest.current = { error: session.exportError, progress: session.exportProgress };

	useEffect(() => {
		// Not cancelled on cleanup: the claim is one-shot, and StrictMode mounts effects twice in dev.
		void window.electronAPI.claimAutomationExport?.().then((job) => {
			if (job) setClaim(job);
		});
	}, []);

	const fail = (exportId: string, error: string) => {
		startedRef.current = true;
		window.electronAPI.reportAutomationExport({ exportId, phase: "failed", error });
	};

	useEffect(() => {
		if (!claim) return;
		const timer = window.setTimeout(() => {
			if (!startedRef.current)
				fail(claim.exportId, "The editor did not finish loading the video.");
		}, READY_TIMEOUT_MS);
		return () => window.clearTimeout(timer);
	}, [claim]);

	useEffect(() => {
		if (!claim || startedRef.current) return;
		if (loadError) return fail(claim.exportId, loadError);
		if (!ready) return;
		startedRef.current = true;
		void (async () => {
			try {
				const settings = resolveSettings(claim.format);
				if (!settings) throw new Error("Video metadata is not ready.");
				const outputPath = await handleExport(
					claim.format === "mp4" && claim.quality
						? { ...settings, quality: claim.quality }
						: settings,
					{ destination: "download", outputPath: claim.outputPath },
				);
				window.electronAPI.reportAutomationExport(
					outputPath
						? { exportId: claim.exportId, phase: "completed", outputPath }
						: {
								exportId: claim.exportId,
								phase: "failed",
								error: latest.current.error ?? "Export failed.",
							},
				);
			} catch (error) {
				window.electronAPI.reportAutomationExport({
					exportId: claim.exportId,
					phase: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	}, [claim, ready, loadError, resolveSettings, handleExport]);

	const percentage = session.exportProgress?.percentage;
	useEffect(() => {
		if (claim && startedRef.current && typeof percentage === "number") {
			window.electronAPI.reportAutomationExport({
				exportId: claim.exportId,
				phase: "exporting",
				progress: percentage,
			});
		}
	}, [claim, percentage]);
}

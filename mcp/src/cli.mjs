#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRecordlyClient } from "./client.mjs";
import { createMcpServer } from "./server.mjs";

try {
	const { values } = parseArgs({
		options: {
			connection: { type: "string" },
			"enable-desktop-control": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.error(
			"Usage: recordly-mcp --connection /absolute/path/to/automation.json [--enable-desktop-control]\nAlternatively set RECORDLY_CONNECTION_FILE. --enable-desktop-control (or RECORDLY_MCP_DESKTOP_CONTROL=1) adds tools that drive the real keyboard and mouse. Start Recordly with automation enabled. MCP uses stdio; diagnostics use stderr.",
		);
	} else {
		const connectionFile = values.connection ?? process.env.RECORDLY_CONNECTION_FILE;
		if (!connectionFile || !path.isAbsolute(connectionFile))
			throw new Error(
				"Provide --connection with an absolute path to Recordly's automation connection file.",
			);
		const desktopControl =
			values["enable-desktop-control"] || process.env.RECORDLY_MCP_DESKTOP_CONTROL === "1";
		const handle = serveStdio(
			() => createMcpServer(createRecordlyClient(connectionFile), { desktopControl }),
			{
				onerror: (error) => console.error(error.message),
			},
		);
		for (const signal of ["SIGINT", "SIGTERM"]) {
			process.once(signal, () => {
				void handle.close().finally(() => process.exit(0));
			});
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

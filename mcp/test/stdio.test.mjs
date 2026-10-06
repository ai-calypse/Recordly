import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("a separate MCP process discovers tools and controls Recordly over authenticated HTTP", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "recordly-mcp-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const connectionFile = path.join(directory, "connection.json");
	const token = "a".repeat(64);
	const calls = [];
	const http = createServer(async (request, response) => {
		assert.equal(request.headers.authorization, `Bearer ${token}`);
		let body = "";
		for await (const chunk of request) body += chunk;
		const command = JSON.parse(body);
		calls.push(command);
		response.setHeader("content-type", "application/json");
		if (command.method === "start_recording") {
			response.end(
				JSON.stringify({
					result: { recordingId: command.params.requestId, phase: "starting" },
				}),
			);
		} else if (command.method === "stop_recording") {
			response.end(
				JSON.stringify({
					result: { recordingId: command.params.recordingId, phase: "finalizing" },
				}),
			);
		} else if (command.method === "get_recording_status") {
			response.end(
				JSON.stringify({
					result: {
						recordingId: "recording-test",
						phase: "completed",
						videoPath: "/tmp/demo.webm",
					},
				}),
			);
		} else {
			response.end(
				JSON.stringify({ result: { sources: [{ id: "screen:1:0", name: "Screen" }] } }),
			);
		}
	});
	await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		http.closeAllConnections();
		http.close();
	});
	await writeFile(
		connectionFile,
		JSON.stringify({
			apiVersion: 1,
			endpoint: `http://127.0.0.1:${http.address().port}/v1/command`,
			token,
		}),
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			fileURLToPath(new URL("../src/cli.mjs", import.meta.url)),
			"--connection",
			connectionFile,
		],
		stderr: "pipe",
	});
	const client = new Client({ name: "recordly-test", version: "1.0.0" });
	t.after(() => client.close());
	await client.connect(transport);
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((tool) => tool.name).sort(), [
		"cancel_recording",
		"export_recording",
		"get_export_status",
		"get_recording_status",
		"list_recordings",
		"list_sources",
		"open_in_editor",
		"pause_recording",
		"resume_recording",
		"start_recording",
		"stop_recording",
		"wait_for_export",
		"wait_for_recording",
	]);
	const list = await client.callTool({ name: "list_sources", arguments: {} });
	assert.equal(list.structuredContent.sources[0].id, "screen:1:0");
	const start = await client.callTool({
		name: "start_recording",
		arguments: { requestId: "recording-test", sourceId: "screen:1:0" },
	});
	assert.equal(start.structuredContent.phase, "starting");
	const stop = await client.callTool({
		name: "stop_recording",
		arguments: { recordingId: "recording-test" },
	});
	assert.equal(stop.structuredContent.phase, "finalizing");
	const status = await client.callTool({
		name: "get_recording_status",
		arguments: { recordingId: "recording-test" },
	});
	assert.equal(status.structuredContent.videoPath, "/tmp/demo.webm");
	const waited = await client.callTool({
		name: "wait_for_recording",
		arguments: { recordingId: "recording-test", until: "done", timeoutSeconds: 1 },
	});
	assert.equal(waited.structuredContent.phase, "completed");
	assert.equal(waited.structuredContent.timedOut, false);
	assert.equal(calls.length, 5);
	const invalid = await client.callTool({
		name: "start_recording",
		arguments: { sourceId: "screen:1:0" },
	});
	assert.equal(invalid.isError, true);
	assert.equal(calls.length, 5);
	await rm(connectionFile);
	const disconnected = await client.callTool({ name: "list_sources", arguments: {} });
	assert.equal(disconnected.isError, true);
	assert.match(disconnected.content[0].text, /connection file/);
});

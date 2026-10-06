import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { screenctlArgs } from "../src/desktop.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function connect(t, { args = [], env = {} } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "recordly-desktop-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const client = new Client({ name: "desktop-test", version: "1.0.0" });
	t.after(() => client.close());
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "--connection", path.join(dir, "automation.json"), ...args],
			env: { ...process.env, ...env },
			stderr: "pipe",
		}),
	);
	return { client, dir };
}

test("desktop tools are off unless enabled", async (t) => {
	const { client } = await connect(t);
	const names = (await client.listTools()).tools.map((tool) => tool.name);
	assert.ok(!names.some((name) => name.startsWith("desktop_")));
});

test("screenctlArgs maps params to flags without a shell", () => {
	const args = screenctlArgs("click", { title: "a; rm -rf /", x: 10, y: 20, double: true });
	assert.deepEqual(args.slice(1), [
		"click",
		"--title",
		"a; rm -rf /",
		"--x",
		"10",
		"--y",
		"20",
		"--double",
	]);
});

test(
	"desktop tools run screenctl, surface refusals, and return screenshots",
	{ skip: process.platform === "win32" },
	async (t) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "fake-python-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const fake = path.join(dir, "fake-python");
		// argv: $1 screenctl.py, $2 action, rest flags. Writes a 1-byte "png" for shot.
		await writeFile(
			fake,
			`#!/bin/sh
case "$2" in
  list) printf '7\\t0,0,10,10\\tTitle A\\n8\\t0,0,5,5\\tTitle B\\n' ;;
  focus) echo "FOCUS_UNCONFIRMED: nope"; exit 1 ;;
  shot) while [ "$1" != "--out" ]; do shift; done; printf x > "$2"; echo "shot ok" ;;
  *) echo "ran $*" ;;
esac
`,
		);
		await chmod(fake, 0o755);
		const { client } = await connect(t, {
			args: ["--enable-desktop-control"],
			env: { RECORDLY_MCP_PYTHON: fake },
		});
		const names = (await client.listTools()).tools
			.map((tool) => tool.name)
			.filter((n) => n.startsWith("desktop_"));
		assert.deepEqual(names.sort(), [
			"desktop_click",
			"desktop_doctor",
			"desktop_focus_window",
			"desktop_key",
			"desktop_list_windows",
			"desktop_paste",
			"desktop_screenshot",
			"desktop_scroll",
			"desktop_type",
		]);
		const list = await client.callTool({ name: "desktop_list_windows", arguments: {} });
		assert.deepEqual(list.structuredContent.windows[1], {
			id: "8",
			geometry: "0,0,5,5",
			title: "Title B",
		});
		const focus = await client.callTool({
			name: "desktop_focus_window",
			arguments: { title: "x" },
		});
		assert.equal(focus.isError, true);
		assert.match(focus.content[0].text, /^FOCUS_UNCONFIRMED/);
		const shot = await client.callTool({
			name: "desktop_screenshot",
			arguments: { title: "x" },
		});
		assert.equal(shot.content[0].type, "image");
		assert.equal(shot.content[0].data, Buffer.from("x").toString("base64"));
		const typed = await client.callTool({
			name: "desktop_type",
			arguments: { title: "x", text: "hi" },
		});
		assert.match(typed.structuredContent.output, /--title x --text hi/);
		const bad = await client.callTool({
			name: "desktop_scroll",
			arguments: { title: "x", amount: 999 },
		});
		assert.equal(bad.isError, true);
	},
);

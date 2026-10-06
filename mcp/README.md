# Recordly MCP

A standalone Node.js MCP server that lets an agent record through the Recordly desktop app. It runs over stdio and connects to Recordly's authenticated local automation API. The desktop app owns capture, permissions, cursor telemetry, audio, saving, and the editor.

Requires Node.js 22+ and a Recordly build that includes the automation API. This package can be copied and installed separately from the desktop source tree. It is not published to npm yet.

## Run from this repository

Install the standalone server's dependencies once:

```bash
npm ci --prefix mcp --ignore-scripts
```

Start Recordly with automation enabled. From the repository root on Linux or macOS:

```bash
RECORDLY_AUTOMATION=1 \
RECORDLY_AUTOMATION_FILE="$PWD/.tmp/automation.json" \
npm run dev
```

In another terminal, start the MCP process:

```bash
node mcp/src/cli.mjs --connection "$PWD/.tmp/automation.json"
```

The MCP process waits for protocol messages on stdin. Usually your agent client launches it using the configuration below. `npm run mcp -- --connection /absolute/path/automation.json` is an equivalent convenience command.

For a packaged Recordly build, fully quit the app first, then launch its executable with:

```bash
recordly --enable-automation --automation-connection-file=/absolute/path/automation.json
```

Use the executable path for your installation (`Recordly.exe` on Windows or `/Applications/Recordly.app/Contents/MacOS/Recordly` on macOS). In PowerShell, the development environment can be set with:

```powershell
$env:RECORDLY_AUTOMATION = "1"
$env:RECORDLY_AUTOMATION_FILE = "$PWD\.tmp\automation.json"
npm run dev
```

The app creates the connection file on startup. Without an explicit file path it uses `automation.json` in Electron's app user-data directory and logs its location. Use an absolute path in your own user directory. The file contains a random authentication token; do not commit it or share it. On Unix it is created with mode `0600`.

## Configure an agent client

For clients accepting an `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "recordly": {
      "command": "node",
      "args": [
        "/absolute/path/Recordly/mcp/src/cli.mjs",
        "--connection",
        "/absolute/path/Recordly/.tmp/automation.json"
      ]
    }
  }
}
```

Use an absolute Node executable path if the client does not inherit your shell's PATH. Alternatively, set `RECORDLY_CONNECTION_FILE` in the MCP process's environment. The server can start and list its tools while Recordly is closed; tool calls report that the app is unavailable until its connection file becomes usable. Credentials are re-read on each call, so the MCP process can reconnect after Recordly restarts.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_sources` | `{}` | Screen/window IDs, display names, selection requirements, and current capture settings |
| `start_recording` | `requestId`, `sourceId` | A recording ID and `starting` phase |
| `get_recording_status` | Optional `recordingId` | The specified or most recent automation recording, or `idle` |
| `stop_recording` | `recordingId` | `finalizing`, or the existing terminal result on retries |
| `pause_recording` / `resume_recording` | `recordingId` | Pause or resume; confirm via `paused` in `get_recording_status` |
| `cancel_recording` | `recordingId` | Discards the recording; ends as `cancelled` |
| `wait_for_recording` | Optional `recordingId`, `until` (`recording` or `done`), `timeoutSeconds` (max 55) | Blocks instead of polling; returns status plus `timedOut` |
| `list_recordings` | `{}` | Newest 50 media files in the recordings folder |
| `open_in_editor` | `videoPath`, optional `webcamPath` | Opens a new editor window; leaves open editors alone |
| `export_recording` | `videoPath`, `format` (`mp4`/`gif`), optional `quality` | An `exportId`; renders with the editor's current look into the recordings folder |
| `get_export_status` / `wait_for_export` | Optional `exportId` | `exporting` with `progress`, then `completed` with `outputPath` or `failed` |

`open_in_editor` and `export_recording` only accept media files inside Recordly's recordings folder (symlinks resolved), and exports are written there under a generated name, so an agent cannot read or overwrite other paths. One export runs at a time.

An example agent workflow:

1. Call `list_sources` and choose the requested screen or window.
2. Call `start_recording` with that `sourceId` and a fresh UUID as `requestId`.
3. The user approves recording in Recordly. Poll `get_recording_status` until `phase` is `recording` before beginning the demonstration.
4. Perform the demonstration using the agent's existing browser or computer controls.
5. Call `stop_recording`, then poll until `completed`, `failed`, or `cancelled`.
6. A completed result contains `videoPath` and optionally `webcamPath`.

Example start arguments:

```json
{
  "requestId": "01c25e2a-4dac-4520-bb83-23dfebca5b3e",
  "sourceId": "screen:1:0"
}
```

Use a real source ID returned by `list_sources`. Reuse the same request ID when retrying the same start. It becomes the recording ID. Reusing an ID with a different source is rejected. The desktop app retains the most recent 100 automation recordings in memory until it exits. Old IDs may expire; generate a new UUID for each new recording.

Capture uses the microphone, system audio, webcam, devices, and countdown already configured in Recordly. The approval dialog shows which inputs are enabled. OS permission dialogs and Wayland's screen picker still require user interaction. On Wayland, use `screen:linux-portal` when appropriate; the final surface is chosen in the OS picker. Recordly's recording HUD hides itself for the duration of an agent recording so its controls stay out of the captured frame, which also means the usual pause, resume, stop, and cancel buttons are unavailable until the recording reaches a terminal phase; stop it through `stop_recording`, or from the tray. Status includes `paused` while recording.

`completed` is reported after background media finalization. Check any `warnings` for unavailable audio or webcam tracks. The returned video is the source capture; editor effects and polished MP4/GIF exports are separate. No media is uploaded by this integration. Recording continues if the MCP process disconnects; reconnect and query its status, or stop it from the tray. A failed result may include a recoverable `videoPath`.

## Desktop control (opt-in)

Add `--enable-desktop-control` (or `RECORDLY_MCP_DESKTOP_CONTROL=1`) to the MCP command and the server also exposes tools that drive the real keyboard and mouse, so an agent can arrange windows, run the demo, and record it in one session. They are off by default and are separate from the recording API: they act on the MCP process's own desktop session and do not use the Recordly connection file.

| Tool | Notes |
| --- | --- |
| `desktop_doctor` | Checks binaries and OS permissions (Accessibility, Screen Recording). Run first |
| `desktop_list_windows` | Window IDs, geometry and titles |
| `desktop_focus_window` | Foregrounds a window and proves it |
| `desktop_screenshot` | Returns the window as an image |
| `desktop_type` / `desktop_paste` | Short literals / verbatim text via the clipboard. Neither sends Enter |
| `desktop_key` | Named keys and chords such as `enter`, `cmd+v` |
| `desktop_click` / `desktop_scroll` | Coordinates and wheel, inside a focused window |

They wrap `src/screenctl.py` (Python 3, standard library only; macOS also needs `cliclick`, Linux `xdotool`). Every input first re-verifies that the target window is in focus and refuses otherwise, and each action is logged to `~/.screenctl/actions.log`. Set `RECORDLY_MCP_PYTHON` to use a specific interpreter. The server instructions tell the agent to act only after the user has handed over the machine, to treat screen content as untrusted, and to close nothing it did not open. Anything that can start this MCP process with the flag can control the desktop, so enable it only for clients you trust.

## Architecture and limits

```text
Agent → MCP stdio process → authenticated HTTP on 127.0.0.1
      → Electron recording controller → trusted HUD IPC → existing recording workflow
```

The MCP package has no Electron imports or native capture dependencies (desktop control, when enabled, shells out to `screenctl.py`). Recordly's API has no MCP SDK dependency. New recording capabilities can be added to the versioned control contract and exposed as tools without duplicating capture implementations.

Recordly supports one capture at a time. Multiple MCP processes can connect to the same app; concurrent starts are rejected, and stop requires a known automation recording ID. Manual recordings cannot be stopped by these tools. The API binds an ephemeral loopback port, requires a per-launch token, rejects browser origins and unexpected Host headers, and limits command bodies and pending requests. Each automated start requires visible approval by default; automation is disabled unless explicitly enabled at app startup.

## Unattended starts

The approval dialog carries an "Allow agent recordings until Recordly quits" checkbox, which skips the prompt for the rest of that app run. To skip it from the first start, launch the app with `--automation-auto-approve` or `RECORDLY_AUTOMATION_AUTO_APPROVE=1`. Both are deliberately opt-in per launch and are never persisted: any agent that can reach the local API can then start recording your screen without asking.

The system screen picker is a separate gate and cannot be waived from inside Recordly. On X11 and on macOS and Windows an agent start needs no picker interaction once a source is chosen. On Wayland the compositor's `xdg-desktop-portal` decides, and Chromium requests a fresh capture session for each start rather than persisting a restore token, so the picker appears on every start even when the portal is configured to allow tokens by default.

The local API is `POST /v1/command` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Its body is `{ "method": "tool_name", "params": { ... } }`. Responses contain `result` or an `error` with `code` and `message`. The connection file's `apiVersion` is checked by the MCP client. Do not expose this API through a public proxy.

## Troubleshooting

- **Connection file missing:** Start an updated Recordly build with automation enabled. Ensure the app and MCP process use the same absolute connection-file path.
- **Connection file already exists:** Another instance may own it. If Recordly crashed, confirm that instance has exited, remove the stale file, then restart. The app deliberately refuses to overwrite an existing connection file. Normal app shutdown removes it.
- **Starting for too long:** Check the approval dialog and OS permission/selection dialogs. An unanswered start times out after three minutes. A timed-out approval cannot later start capture.
- **Source unavailable:** List sources again; window IDs can change when windows close or reopen.
- **Recording failed:** Read its status error and check Recordly. A window closing or renderer failure can interrupt capture. Use the editor's recovery facilities for available media.

## Development checks

```bash
npx tsc --noEmit
npx vitest run electron/automation src/hooks/recordingAutomation.test.ts
npm --prefix mcp test

# Linux desktop + ffprobe, after npx vite build:
npm run smoke:mcp
```

The MCP test launches the actual standalone process and speaks MCP over stdio against a local test API. Desktop tests cover lifecycle, retries, approval, and local API access. The Linux smoke launches an isolated Electron profile, substitutes an animated canvas for screen/camera capture, automatically approves only its test recording dialog, and checks the encoded output with `ffprobe`. It does not capture the real desktop. Native backend and real portal verification is tracked in [issue #3](https://github.com/Nuu-maan/Recordly/issues/3).

To prepare a standalone archive locally, run `npm pack` inside `mcp/`. The package is marked private to prevent accidental registry publication.

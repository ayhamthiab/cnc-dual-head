# DMHC Local Machine Agent

This is the desktop-side component for the DMHC CNC Middleware workspace. It
runs on the Windows computer that has the Arduino/GRBL controllers connected.
It uses **UGS Core**, not the UGS desktop GUI, and it never exposes serial
ports to the internet.

## What it currently provides

- Separate UGS `GrblController` sessions for **Head 1** and **Head 2**.
- Windows serial-port discovery through UGS/JSerialComm.
- One-port/one-head enforcement: the same COM port cannot be claimed twice.
- GRBL initialization, firmware information, status, DRO positions, alarms,
  stream lifecycle, and console messages.
- Local HTTP API plus Server-Sent Events for live browser telemetry.
- Explicit APIs for Home, incremental Jog, Reset, Unlock, console commands,
  and G-code streaming.
- Local machine profiles storing a profile name plus Head 1/Head 2 port and
  baud settings. Profiles **only populate settings**; they never auto-connect.
- A local bearer token and loopback-only binding (`127.0.0.1` by default).

No connection, homing, jogging, command, or G-code stream occurs on startup.
All motion-capable endpoints require `confirm: true`; the web UI additionally
requires an explicit acknowledgement for each command.

## Build on Windows

Prerequisites:

1. A Java 17+ JDK and Maven.
2. Git.
3. A supported Arduino/GRBL USB serial driver.

Open PowerShell in this directory:

```powershell
.\scripts\build-agent.ps1
java -jar .\target\dmhc-machine-agent.jar
```

The first build checks out the UGS commit documented in
[`UGS_VERSION.md`](UGS_VERSION.md), installs only the `ugs-core` Maven module
into the local Maven cache, and builds the agent JAR. It does not install or
launch the UGS desktop application.

The agent prints a one-time bearer token in its console if `DMHC_AGENT_TOKEN`
or `--token` is not supplied. In the DMHC web UI, open **Machine Controller**,
copy that token into the **Agent token** field, then click **Save & check**.
The token stays only in that browser's local storage and is not sent to the
DMHC cloud/API server.

### Build an installer

On Windows, install the WiX tooling required by `jpackage` and use a JDK with
`jpackage` included:

```powershell
.\scripts\package-windows.ps1
```

This produces an MSI under `target\installer`. Installer validation with an
actual COM device still needs to be done on the machine where the controllers
are attached.

## Local API

Base URL: `http://127.0.0.1:18888/api/v1`

`GET /health` is intentionally token-free so the UI can report whether an
agent is running. Serial, profile, telemetry, and controller endpoints require
`Authorization: Bearer <agent-token>` (SSE can use `?token=` because
`EventSource` cannot supply custom headers).

The web UI reports application API health, local Agent reachability,
authenticated serial-port discovery, live telemetry, and both head connection
states separately. A successful `/health` request means only that the local
Agent process is reachable; it does not prove the token is valid or that Windows
returned any COM ports.

### Complete local Windows startup

Run these in separate PowerShell windows from the project root:

```powershell
# 1. Build the pinned UGS Core and the Machine Agent, then start it.
cd machine-agent
.\scripts\build-agent.ps1
$env:DMHC_AGENT_TOKEN = "<choose-a-local-token>"
.\scripts\run-agent.ps1
```

```powershell
# 2. Start the API server on the requested local port.
$env:PORT = "25309"
pnpm --filter @workspace/api-server run dev
```

```powershell
# 3. Start the frontend and open http://127.0.0.1:25308/machine.
$env:PORT = "25308"
$env:BASE_PATH = "/"
pnpm --filter @workspace/dmhc-ui run dev
```

Enter `http://127.0.0.1:18888/api/v1` and the same local token in Machine
Controller, then select **Save & check**. Serial discovery must report success
before either head can connect.

### If Connect waits or times out

Only one Windows process can own a COM port. Before connecting from DMHC, close
UGS Platform, Arduino Serial Monitor/Plotter, Candle, PuTTY, and any other
serial terminal. If opening a port takes more than 10 seconds, the Agent now
returns a timeout instead of leaving the web request pending. Unplug/reconnect
that Arduino and restart the Agent before retrying, because a blocked Windows
USB-serial driver call cannot be safely reused inside the same Java process.

The Agent enables status polling as soon as UGS reports that its GRBL
initialization sequence completed, then considers the controller ready after
the next real status (`Idle`, `Alarm`, etc.). This ordering matters because UGS
keeps its public state at `Connecting` until that post-initialization status
arrives. A controller that opens but never completes the UGS handshake or sends
no post-initialization status still fails with a clear port/baud/firmware message.

If that first resolved status is `Alarm`, the Agent sends `$X` to that head and
waits for a refreshed non-alarm status before reporting the connection ready.
Automated Drawing performs the same per-head check immediately before its first
motion stage, which also covers a previously connected head that entered Alarm.
An `Idle` head is never sent `$X`, and Head 1/Head 2 checks remain isolated.

UGS console and telemetry events are delivered to browser SSE clients on
separate per-client workers. A slow or disconnected browser console therefore
cannot block the UGS thread after Windows opens the COM handle and before GRBL
initialization completes.

When the page is served from Replit/cloud, `127.0.0.1` still means the computer
running the operator's browser. Replit servers never receive COM-port access.
Browser mixed-content, private-network-access, or CORS policy can block an
HTTPS cloud page from calling an HTTP loopback Agent; use the fully local
frontend/API/Agent workflow above for predictable hardware operation.

### Serial connection diagnostics

Connection events distinguish two stages:

- `controller.connect.opening`: UGS has selected the requested port and is
  waiting inside the Windows/JSerialComm native port open.
- `controller.connect.transport-open`: Windows opened the serial transport and
  the Agent is waiting for GRBL firmware identification and status.

If the first event appears without the second, the request has not reached the
GRBL initialization loop. Close Arduino Serial Monitor, UGS, and other programs
that may own the COM port, then verify the USB serial driver/device in Windows.
Port enumeration alone does not prove that Windows can open the device.

| Endpoint | Purpose |
| --- | --- |
| `GET /serial-ports` | Available real serial ports and their current owner |
| `GET /profiles`, `POST /profiles`, `DELETE /profiles/:id` | Local setup profiles |
| `GET /heads/:id/status` | Status/DRO/alarm snapshot for Head `1` or `2` |
| `GET /heads/:id/settings` | Read the UGS Core GRBL settings cache for one head |
| `GET /heads/:id/settings?refresh=true` | Send UGS Core's `$$` read command and return refreshed GRBL settings |
| `POST /heads/:id/settings` | Change one GRBL setting through UGS Core, requires `confirm:true`; returns the UGS-confirmed setting |
| `POST /heads/:id/work-zero` | Set X/Y/Z/ALL work zero, requires confirmation |
| `POST /heads/:id/work-offset` | Set a work-coordinate value without machine motion |
| `POST /heads/:id/connect` | Explicitly connect Head `1` or `2` |
| `POST /heads/:id/disconnect` | Disconnect a selected head |
| `GET /events` | Live Server-Sent Events |
| `POST /heads/:id/home` | Home, requires `{"confirm":true}` |
| `POST /heads/:id/jog` | Incremental jog, requires `confirm:true` |
| `POST /heads/:id/command` | One console command, requires `confirm:true` |
| `POST /heads/:id/stream` | G-code stream, requires `confirm:true` |
| `POST /heads/:id/pause`, `/resume`, `/stop` | Stream controls, require confirmation |

### GRBL settings diagnostics

All commands below stay on the local Windows Agent. Replace `<token>` with the
agent token and `1` with `2` to address the other independently connected head.

```powershell
# Read the settings currently known by UGS Core.
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18888/api/v1/heads/1/settings

# Request a real GRBL $$ refresh through UGS Core.
curl.exe -H "Authorization: Bearer <token>" "http://127.0.0.1:18888/api/v1/heads/1/settings?refresh=true"

# Write one setting only after an explicit confirmation value.
curl.exe -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" `
  -d "{\"confirm\":true,\"key\":\"$100\",\"value\":\"250\"}" `
  http://127.0.0.1:18888/api/v1/heads/1/settings
```

The backend never silently selects a physical controller. The UI requires the
operator to select Head 1 or Head 2 for every control action. **Gap Fill is
not yet assigned to a controller**; do not send a generated Gap Fill program
until that operating decision is made explicitly in the UI/API.

## Hardware-test boundary

This repository verifies the Java build, agent endpoints, and UI safety paths
without an Arduino attached. It does **not** claim that a real GRBL controller,
limit switch, homing direction, motor, or COM driver was tested. Validate each
of those steps on the actual machine before production use.

## UGS license

UGS Core is GPLv3. Its source pin and usage details are in
[`UGS_VERSION.md`](UGS_VERSION.md). Keep UGS's GPL `COPYING` file and the
included [`NOTICE.md`](NOTICE.md) with any distributed agent; the build script
copies them to `target/third-party-licenses/`.
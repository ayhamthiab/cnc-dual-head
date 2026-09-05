---
name: UGS initialization readiness
description: Avoid the circular wait between UGS initializer completion, status polling, and the public controller state.
---

Treat UGS’s successful handshake completion separately from its public controller state. Once the handshake is complete, enable status polling before requiring the state to leave `CONNECTING`.

**Why:** UGS can finish firmware/version/settings/modal initialization while leaving the public state at `CONNECTING`. That state changes only after a later status report, and the poller does nothing while its enabled flag is false.

**How to apply:** A successful UGS handshake authorizes polling; the first subsequent real status determines readiness as `IDLE`, `ALARM`, `HOLD`, or another concrete GRBL state. Do not infer failed initialization solely from a lingering `CONNECTING` state while polling is disabled.
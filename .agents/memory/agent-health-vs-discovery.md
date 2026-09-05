---
name: Agent health vs discovery
description: UI and API state invariant for local Agent reachability, authentication, and serial-port discovery.
---

Unauthenticated local Agent health means “reachable,” never “connected” or “ready.” Authenticated serial discovery must have its own success/error state.

**Why:** Health can succeed with a missing or rejected token while serial-port discovery fails, which previously produced a false global success and an unexplained empty port list.

**How to apply:** Display application API, local Agent reachability, authenticated discovery, telemetry, and each head state independently. Gate new controller connections on successful authenticated discovery. On page mount, restore the saved local URL and token before starting health or discovery requests so an unauthenticated request cannot race and overwrite the valid result.
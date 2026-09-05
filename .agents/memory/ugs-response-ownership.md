---
name: UGS response ownership
description: Safety rule for serializing Automated Run stages and handling acknowledgements that no longer have an owning UGS command.
---

Do not advance an Automated Run stage merely because GRBL telemetry reports `Idle` or clears `ALARM`. The UGS controller and communicator queues must also show that the preceding command response has been consumed.

**Why:** GRBL realtime status can overtake a normal command acknowledgement. Advancing after telemetry alone lets unlock or homing overlap the next stage. Separately, a delayed `ok` after a queue reset or cancellation has no reliable command identity and must not be guessed.

**How to apply:** Keep response ownership per head. Wait for both the expected machine state and an empty pending-response queue at lifecycle boundaries. If `ok` arrives with no pending command, publish a controller-scoped error and discard it; never let it complete a later command.
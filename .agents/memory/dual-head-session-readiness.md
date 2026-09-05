---
name: Dual-head session readiness
description: Safety invariants for independent controller initialization and serial-port leasing.
---

Treat an open serial transport as “connecting,” not “connected.” A head becomes externally connected and control-ready only after UGS has identified real firmware and received controller status.

**Why:** UGS opens the COM port before its asynchronous GRBL initialization finishes. Reporting success earlier enables controls against a controller that may still fail initialization.

**How to apply:** Keep readiness separate from transport-open state. Gate snapshots and controller actions on readiness, and surface initialization failure to that head’s console.

Serialize connect/disconnect and lease acquisition/release per head, while retaining separate locks for the two heads. Reject duplicate port acquisition even when the existing owner ID matches.

**Why:** A same-head reconnect racing a disconnect can otherwise release a newer reservation, allowing the other head to claim a port still being opened or used.

**How to apply:** Keep each head’s lease lifecycle atomic. Cross-head exclusion still belongs in the shared lease book so both heads may operate concurrently only on different ports.
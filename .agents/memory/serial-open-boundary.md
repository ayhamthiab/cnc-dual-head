---
name: Serial enumeration vs open
description: Diagnostic boundary between Windows COM enumeration, native serial open, and GRBL initialization.
---

A COM port appearing in discovery proves only that Windows enumerated it. Treat native serial transport open and GRBL firmware/status initialization as separate later stages.

**Why:** UGS logs the JSerialComm URL before calling the native Windows port open. If no transport-open event follows, the request is blocked before the Agent's GRBL initialization loop; changing the GRBL readiness timeout cannot fix that stage.

**How to apply:** Report connection stages separately and cap native open waits so an HTTP request cannot remain pending forever. Never hold a session monitor while waiting for UGS on another thread if a synchronous UGS listener reacquires that monitor; the serial receive thread can still print a GRBL banner while the opener is deadlocked. Keep browser console/SSE I/O off UGS threads too. After a true native-open timeout, require an Agent restart rather than reusing that session.
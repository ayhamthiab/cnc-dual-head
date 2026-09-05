---
name: Local machine-agent safety
description: Durable safety boundaries for the desktop-side GRBL/UGS Core agent.
---

The machine-control capability belongs in a desktop-side agent, never in the
cloud/Replit API. The agent must bind only to loopback, expose independent
Head 1 and Head 2 controller sessions, and prevent the same serial port from
being assigned to both sessions.

**Why:** Browser-hosted/cloud code cannot safely or reliably access a
machine's physical COM ports. Mixed controller telemetry could lead an operator
to move one head while reading another head's position.

**How to apply:** Keep bearer-token requests and realtime events local. The
web UI may only target `http` loopback agent URLs, must retain status/DRO by
controller ID, and must require separate operator confirmation before a
motion-capable action. Loading a machine profile may populate port/baud fields
but must not auto-connect, home, jog, or stream. Gap Fill requires an explicit
controller assignment before it becomes streamable.

Work zero and manual work-position updates must call UGS/GRBL's coordinate
system APIs (`resetCoordinateToZero` / `setWorkPosition`) rather than alter the
displayed DRO locally.

**Why:** A local UI-only offset creates a false coordinate display while the
controller continues to run in a different WCS.

**How to apply:** Label these commands as WCS updates that do not move axes,
but still require an explicit confirmation because they write controller state.

Multi-step physical workflows must be owned by a single-run state machine in
the local Agent. The browser may start, observe, pause, resume, or abort that
workflow, but must not advance stages by chaining HTTP responses.

**Why:** Controller responses can mean a command was queued or acknowledged,
not that homing or motion physically finished. Browser refreshes and network
interruptions must not duplicate or skip machine stages.

**How to apply:** Give each motion and stream a terminal success/failure signal,
block competing manual actions while automation owns the heads, stop both heads
on any partial failure, and expose resumable status plus an event log to the UI.
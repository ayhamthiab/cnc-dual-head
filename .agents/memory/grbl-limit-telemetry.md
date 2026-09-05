---
name: GRBL limit telemetry
description: Limits of standard GRBL pin reporting and how setup UI must present switch state.
---

Standard GRBL status reports can indicate an active limit signal for an axis, but do not reliably identify which physical min/max switch caused it. Treat individual switch identity as unknown unless the connected controller explicitly supplies it.

**Why:** Presenting an inactive or aggregate axis bit as a verified per-switch state can give an operator a false safety assurance while commissioning a machine.

**How to apply:** Show unavailable or "axis triggered — switch unspecified" in machine setup. Only mark a particular X+/X−, Y+/Y−, or Z+/Z− switch as triggered when the controller’s telemetry includes that specific identity.
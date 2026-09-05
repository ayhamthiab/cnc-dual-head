---
name: GRBL command locale safety
description: Prevent locale-specific number rendering from corrupting commands sent to GRBL.
---

GRBL commands sent by the Local Machine Agent must render numbers with an ASCII-invariant formatter, regardless of the operating-system language or locale.

**Why:** UGS Core's general G-code formatting path uses locale-derived decimal symbols. On systems using non-Latin numerals, a simulator/controller can receive unparseable numeric bytes rather than the intended axis distance or feed rate.

**How to apply:** For controller-bound JOG and coordinate-offset commands, use the Agent's locale-invariant command builder and send the result through UGS Core's controller/communicator. Do not route these commands through UGS UI-oriented localized formatters.
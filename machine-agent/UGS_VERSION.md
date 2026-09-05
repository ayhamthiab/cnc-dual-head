# UGS Core source pin

The agent uses the `ugs-core` Maven module from the official Universal Gcode
Sender repository, not the UGS desktop GUI.

| Field | Value |
| --- | --- |
| Repository | `https://github.com/winder/Universal-G-Code-Sender` |
| Pinned commit | `7c7d45b6b94a718589ce4b444865cd790c34882a` |
| UGS Maven version | `2.0-SNAPSHOT` |
| Required Java release | 17 |
| License | GNU General Public License v3.0 |

`scripts/build-agent.sh` and `scripts/build-agent.ps1` clone this exact commit
into a local cache and install only `ugs-core` into the local Maven cache before
building the agent. The checkout is intentionally not copied into this project.

The Machine Agent directly overrides UGS Core's transitive jSerialComm 2.11.0
dependency with jSerialComm 2.11.4. This preserves the UGS source pin while
using the current Windows native serial transport release.

The distributed agent must include UGS's `COPYING` file and the notices in
`NOTICE.md`. See the build scripts and `README.md`.
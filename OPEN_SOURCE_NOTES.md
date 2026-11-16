# Open Source Notes

These projects informed the current collection strategy:

- `FightZhanAng/wb-token-meter`
  - WorkBuddy usage is described as locally readable.
  - Trae CN token ledgers are described as encrypted at rest and requiring a key from the running process.
- `Annihilater/token-stats`
  - Documents a Trae login + sync flow.
  - Synced Trae session dumps are stored under `~/.config/tokscale/trae-cache/sessions/*.json`.
- `splunk/token-meter`
  - Uses local-first evidence and labels estimates explicitly.
  - Treats missing evidence as unavailable instead of forcing zero.
- `@aiusage/cli`
  - Scans usage across multiple AI tools from local state.

What we adopted here:

- scan Trae local folders for plaintext evidence
- scan token-stats-style synced Trae session caches
- keep exact/estimated boundaries explicit
- avoid inferring token usage from context window size, prompt length, or request count alone

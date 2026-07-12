# signalk-sail-setup - notes and roadmap

## Data model (decided 2026-07-12)

Config stays lightweight: groups are just a name + comma-separated list of sail
names (as in the embryo). No sail metadata (area, wind range, id) - if that's
ever needed for real polar work, it can be added later without breaking this.

Front-of-mast groups in front of the mast (headsail, staysail, spinnaker/assy/
zero) each hold a single mutually-exclusive value. The mainsail group works
the same way, with reef states modeled as "sails" (Full, Reef1, Reef2, ...)
so the button UI stays uniform across all groups.

SignalK paths emitted:
- `sails.<group>` - current value for one group, e.g. `sails.headsail = "A4"`.
  Kept from the embryo for simple per-group subscriptions.
- `sails.set` - array of every currently-active sail across all groups, empty/
  "none" slots omitted, e.g. `["A4","SS","Full-Reef1"]`. This is the one to
  subscribe to for a single-glance view of the whole rig, and the join key
  for any future performance analysis (see below). Order follows group config
  order, not alphabetical.
- Group name `set` is reserved (can't be used as a group name - would collide
  with the array path).

We deliberately did *not* align with the official `SignalK/sailsconfiguration`
plugin's `sails.inventory.<id>` convention - that plugin models a sail
inventory with area/wind-range/reef metadata for the same `sails.` namespace.
If ecosystem interop ever matters (e.g. a third-party polar tool that already
expects `sails.inventory.*`), this plugin could optionally publish to both
without changing the config UI, since `sails.set` and `sails.inventory.*`
don't collide.

## Logging

`sail-log.csv` in the plugin's data dir gets one row per change:
`utc,group,sail,set` - `set` is the full rig at that moment (pipe-separated),
not just the group that changed. That means grepping the file for a sail name
finds every time it was part of the rig, not just the moment it went up.

## Hours-in-use tracking (done 2026-07-12)

Went with event-based accumulation instead of the originally-planned CSV
heartbeat sampling - it's exact rather than estimated, and needed a genuine
design decision: mainsail hours have to keep counting across Full/Reef1/
Reef2 transitions (it's still "the main"), while individual headsails (J2 vs
J3) genuinely are different physical sails whose wear you want tracked
separately.

Solved by tracking hours at two levels from the same accumulator: every
group-value change "settles" elapsed time into *both* the specific sail's
bucket (`hours[group].bySail[sail]`) and the group's running total
(`hours[group].total`), so switching reef points splits time between
buckets without ever resetting the group total. Persisted to
`sail-hours.json` alongside `current-sails.json`; if a sail is still up
across a plugin/server restart the clock (`activeSince`) survives in the
file and keeps counting the downtime as in-use time, since a restart is a
process reload, not an unrig.

`sails.hours.<group>` is published as a live SignalK path (seconds) so other
instruments/dashboards can show "hours on main" directly. Per-sail
granularity is available via the `/hours` endpoint and the webapp table but
deliberately not published as individual SignalK paths, to avoid one path
per sail in the inventory. No reset mechanism - accumulates forever from
install; retiring a physical sail just means renaming it in config (e.g.
`J2` → `J2-old`) to freeze its total and start fresh under the old name.

## Deferred / future work

- **Per-sail-set polar** - correlate `sails.set` combos against boat speed /
  TWA / TWS to build performance curves per combination, and compare
  combinations at the same TWA/TWS to see which is faster. Needs a separate
  analysis/aggregation step (probably outside this plugin) that joins the
  sail-log against SignalK's own logged navigation data.
- **Optional `sails.inventory` alignment** - if per-sail metadata (area, wind
  range) becomes useful for the polar work, add it as an optional additional
  publish, without changing the simple comma-list config.

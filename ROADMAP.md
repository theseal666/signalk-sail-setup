# signalk-sail-setup - notes and roadmap

## Data model (decided 2026-07-12)

Config stays lightweight: groups are just a name + comma-separated list of sail
names (as in the embryo). No sail metadata (area, wind range, id) - if that's
ever needed for real polar work, it can be added later without breaking this.

Front-of-mast groups in front of the mast (headsail, staysail, spinnaker/assy/
zero) each hold a single mutually-exclusive value. The mainsail group
originally worked the same way, with reef states modeled as "sails" (Full,
Reef1, Reef2, ...) so the button UI stayed uniform across all groups - see
"Reefs are states, not sails" below for why that didn't survive contact with a
second mainsail.

SignalK paths emitted:
- `sails.<group>` - current value for one group, e.g. `sails.headsail = "A4"`.
  Kept from the embryo for simple per-group subscriptions.
- `sails.set` - array of every currently-active sail across all groups, empty/
  "none" slots omitted, e.g. `["A4","SS","M1-Reef1"]`. This is the one to
  subscribe to for a single-glance view of the whole rig, and the join key
  for any future performance analysis (see below). Order follows group config
  order, not alphabetical.
- Group names `set`, `hours` and `reef` are reserved (would collide with the
  array path and the two path prefixes).

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
design decision: mainsail hours have to keep counting across reef changes and
across a swap from one main to another (it's still "the main"), while
individual headsails (J2 vs J3) genuinely are different physical sails whose
wear you want tracked separately.

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

## Speed gate + auto-clear at the dock (done 2026-07-13)

Real problem: forget to untoggle sails at the end of the day and hours quietly
rack up all night. Two independent, both opt-in (off by default, no behavior
change for existing configs unless set):

- **minSpeedKnots** pauses hours accumulation (not sails.set, not the CSV -
  those still reflect whatever's actually toggled) below a speed threshold.
  Defaults to `navigation.speedOverGround` rather than `speedThroughWater`
  deliberately - a paddlewheel isn't direction-aware, and backing down under
  engine to douse the main (or drifting backward while raising it
  head-to-wind) spins it just like sailing forward would. GPS SOG doesn't
  have that failure mode. Fails open (keeps counting) with no data or a
  stale reading, so a sensor dropout can't silently zero out real hours.

- **autoClearMinutes** goes a step further: if genuinely stationary (per the
  same speed gate) for that many minutes with nothing touched, it clears
  every toggled sail outright, not just pausing their hours - "there's no
  way in hell people are sailing now." The trap we almost fell into: raising
  the main is *also* usually done at ~0kn, head to wind. A naive "sail is
  set + stationary" timer would auto-clear the sail you just hoisted if the
  hoist takes longer than the threshold. Fixed by resetting the stationary
  countdown on every button press, not just every speed update - active
  interaction is itself evidence someone's aboard, independent of whether
  the boat is actually moving yet. Auto-clears are tagged `trigger=auto` in
  the CSV (vs `user` for a real press) so the log stays honest about what
  happened.

Implementation is event-based (subscribes to the speed path via
`app.streambundle`, checks on every new value plus a periodic tick as a
fallback) rather than polling, so it reacts as fast as the boat's own speed
source updates.

## Reefs are states, not sails (changed 2026-10-04)

Two mainsails, two reefs each, broke the original "reefs are just sails in the
mainsail group" model outright: with `mainsail: M1, M2, Reef1, Reef2`, `Reef1`
is a *sibling* of `M1`, so tapping it replaced the sail instead of reefing it.
The rig genuinely has two dimensions - which main is up, and how deeply it's
reefed - and one mutually-exclusive value can't hold both.

Groups now take an optional ordered `states` ladder that applies to whichever
sail in the group is up. Stateless groups are untouched, so headsail/staysail/
spinnaker behave exactly as before and existing configs don't change meaning.

Decisions worth keeping a record of:

- **Ladder, not independent flags.** Reefs are ordinal: the second reef implies
  the first is in. So the level is a single number (0..n) rather than a set of
  booleans, which also keeps `sails.reef.<group>` a plain number other
  instruments can display or threshold.
- **Tapping the active reef steps down one, not to full.** First attempt
  cleared the whole ladder (2 → 0), on the theory that it matched the
  tap-to-clear idiom of the sail buttons. Wrong manoeuvre: shaking out the
  second reef leaves the first one in. 2 → 1, and tapping the lower button
  again gets you to full.
- **`sails.<group>` stays the bare sail name**, with the level in a separate
  `sails.reef.<group>`. A child path under `sails.<group>` isn't an option -
  that path is a leaf holding the sail name, and SignalK doesn't want a value
  and children on the same path. Keeping the sail name bare also means the
  value always matches something in the config, which a composite wouldn't.
- **The composite only appears where it's a label**: `sails.set` and the CSV's
  `sail` cell (`M1-Reef2`), with the sail name as the leading token so grepping
  for `M1` still finds every row. That keeps the CSV's column count unchanged,
  so no existing log needs migrating - and the CSV becomes the record of reef
  history, since:
- **Hours bucket on the base sail, never on the reef state.** M1 reefed and M1
  full are the same physical sail taking the same wear; splitting them would
  scatter M1's total across three buckets and leave no single "hours on M1"
  number. Reef changes still settle the clock (so no time is lost) but bank
  into the bucket they came from.
- **Reefing with nothing up is refused** (409) rather than silently stored: a
  group carrying a reef level with no sail is a state `sails.set` can't express
  and the hours clock has nothing to bank against.
- `current-sails.json` gained a version field (`v: 2`) to carry the reef levels.
  A v1 flat `{ group: sail }` map still loads, keeping whatever was up and
  starting it unreefed.

## Deferred / future work

- **Per-sail-set polar** - correlate `sails.set` combos against boat speed /
  TWA / TWS to build performance curves per combination, and compare
  combinations at the same TWA/TWS to see which is faster. Needs a separate
  analysis/aggregation step (probably outside this plugin) that joins the
  sail-log against SignalK's own logged navigation data.
- **Optional `sails.inventory` alignment** - if per-sail metadata (area, wind
  range) becomes useful for the polar work, add it as an optional additional
  publish, without changing the simple comma-list config.

const fs = require('fs')
const path = require('path')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-sail-setup',
    name: 'Sail Setup',
    description: 'Declare which sails are up; configurable inventory; emits sails.<group> per group, sails.set (full combo), sails.hours.<group> (time in use)'
  }

  let options = {}
  let state = {}      // { group: sail } - which sail is up in each group
  let reefs = {}      // { group: level } - 0 = unreefed, 1..n = index into the group's states list
  let hours = {}       // { group: { bySail: { sail: seconds }, total: seconds } }
  let activeSince = {} // { group: timestampMs } - when the group's current sail went up
  let timer = null
  let stateFile = null
  let hoursFile = null
  let unsubscribeSpeed = null
  let lastSpeedMs = null   // last known speed, m/s (SignalK SI)
  let lastSpeedTs = null   // when we last heard from speedPath

  plugin.schema = {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        title: 'Sail groups',
        default: [
          { name: 'headsail', sails: 'JZ, J2, J3, J3.5' },
          { name: 'staysail', sails: 'SS, GS' },
          { name: 'spinnaker', sails: 'A1, A2, A4, A6, Code0' },
          { name: 'mainsail', sails: 'Main, Trysail', states: 'Reef1, Reef2' }
        ],
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Group name (becomes path sails.<name>)' },
            sails: { type: 'string', title: 'Sails (comma-separated)' },
            states: {
              type: 'string',
              title: 'Reef states (comma-separated, optional). A reef LADDER applied on top of whichever sail in this group is up: first = 1 reef, second = 2 reefs, and so on. Leave empty for groups where a sail is simply up or down (headsails, spinnakers).'
            }
          }
        }
      },
      reemitSeconds: {
        type: 'number',
        title: 'Re-emit current state every N seconds (0 = off). Keeps value in every log window.',
        default: 60
      },
      hoursTracking: {
        type: 'boolean',
        title: 'Track and log hours-in-use per sail/group (sails.hours.<group>, /hours endpoint, webapp table)',
        default: true
      },
      minSpeedKnots: {
        type: 'number',
        title: 'Pause hours tracking below this speed in knots (e.g. 1) - stops sails logging hours if you forget to clear them at the dock. 0 = disabled, always count (default).',
        default: 0
      },
      speedPath: {
        type: 'string',
        title: 'SignalK path to check against minSpeedKnots',
        default: 'navigation.speedOverGround'
      },
      autoClearMinutes: {
        type: 'number',
        title: 'Auto-clear every toggled sail after this many minutes continuously below minSpeedKnots (0 = disabled). Needs minSpeedKnots set too - this is the "forgot to douse at the dock" safety net.',
        default: 0
      }
    }
  }

  function groups () {
    return (options.groups || []).map(g => ({
      name: (g.name || '').trim(),
      sails: (g.sails || '').split(',').map(s => s.trim()).filter(Boolean),
      states: (g.states || '').split(',').map(s => s.trim()).filter(Boolean)
    })).filter(g => g.name && g.sails.length &&
      g.name !== 'set' && g.name !== 'hours' && g.name !== 'reef') // reserved path prefixes
  }

  function groupStates (g) {
    const grp = groups().find(x => x.name === g)
    return grp ? grp.states : []
  }

  // Display/log label for a group: the base sail, suffixed with its reef state if any -
  // 'M1' unreefed, 'M1-Reef2' with the second reef in. The base sail name stays the
  // leading token so grepping the CSV for 'M1' still finds every row it was up, reefed
  // or not.
  function label (g) {
    const sail = state[g]
    if (!sail) return null
    const lvl = reefs[g] || 0
    const st = groupStates(g)
    return lvl > 0 && st[lvl - 1] ? sail + '-' + st[lvl - 1] : sail
  }

  // The full current sail set, e.g. ['A4','SS','M1-Reef2'] - empty/cleared slots omitted.
  // Order follows group config order, so it's stable as long as groups aren't reordered.
  // 'none' is still filtered out for backwards compatibility with configs that list it
  // explicitly as a sail - new configs don't need it, tapping the active button clears it.
  function currentSet () {
    return groups()
      .map(g => label(g.name))
      .filter(v => v && v.toLowerCase() !== 'none')
  }

  function emitGroup (name) {
    if (!(name in state)) return
    app.handleMessage(plugin.id, {
      updates: [{
        values: [{ path: 'sails.' + name, value: state[name] || null }]
      }]
    })
  }

  // sails.reef.<group>: current reef level as a number (0 = unreefed, null = nothing up in
  // that group). Deliberately a sibling path rather than a child of sails.<group>: that
  // path is a leaf holding the sail name, and SignalK doesn't want a value and children on
  // the same path. Only emitted for groups that actually define states.
  function emitReef (name) {
    if (!groupStates(name).length) return
    app.handleMessage(plugin.id, {
      updates: [{
        values: [{ path: 'sails.reef.' + name, value: state[name] ? (reefs[name] || 0) : null }]
      }]
    })
  }

  // Single atomic path with the whole current combo - easiest thing to log/grep/graph,
  // and what a future per-sail-set polar comparison would key off of.
  function emitSet () {
    app.handleMessage(plugin.id, {
      updates: [{
        values: [{ path: 'sails.set', value: currentSet() }]
      }]
    })
  }

  function hoursEnabled () { return options.hoursTracking !== false }

  // Speed gate: pause hours accumulation below minSpeedKnots, so leaving a sail
  // toggled on overnight at the dock/mooring doesn't quietly rack up hours. Defaults
  // to navigation.speedOverGround (GPS) rather than speedThroughWater - a paddlewheel
  // isn't direction-aware, so backing down to douse the main would spin it and read as
  // "moving" even though you're basically still at the dock. GPS SOG doesn't have that
  // problem. Fails open (counts hours) if the threshold is 0, if no speed data has ever
  // been seen, or if the last reading is stale - a sensor dropout shouldn't silently
  // zero out real sailing hours.
  function subscribeSpeed () {
    const p = (options.speedPath || 'navigation.speedOverGround').trim()
    if (!p || !app.streambundle) return
    try {
      unsubscribeSpeed = app.streambundle.getSelfStream(p).onValue(v => {
        lastSpeedMs = v
        lastSpeedTs = Date.now()
        checkAutoClear()
      })
    } catch (e) { app.error('' + e) }
  }

  function isMoving () {
    const minKn = options.minSpeedKnots || 0
    if (minKn <= 0) return true // gating disabled
    if (lastSpeedTs == null) return true // never heard from speedPath - fail open
    if ((Date.now() - lastSpeedTs) / 1000 > 120) return true // stale reading - fail open
    return (lastSpeedMs || 0) >= minKn * 0.514444
  }

  function ensureGroupHours (g) {
    if (!hours[g]) hours[g] = { bySail: {}, total: 0 }
    return hours[g]
  }

  // Bank whatever time the group's currently-active sail has accrued since the last
  // settle into the accumulators, then reset the clock. Every settle adds to BOTH the
  // specific sail's bucket and the group total, so swapping M1 for M2 mid-passage splits
  // time between their buckets without ever resetting the group's "hours on the main".
  // Note it keys on the BASE sail (state[g]) and not on label(g): a reef change settles
  // like any other change, but banks into the same bucket it came from, because reefing
  // in and out is the same physical sail taking the same wear. Reef-level history lives
  // in the CSV instead. If the speed gate says we're not moving, the
  // elapsed span is discarded instead of banked - that's the "at the dock" pause.
  function settle (g) {
    const since = activeSince[g]
    const sail = state[g]
    if (!since || !sail) return
    const elapsed = Math.max(0, (Date.now() - since) / 1000)
    activeSince[g] = Date.now()
    if (!isMoving()) return
    const h = ensureGroupHours(g)
    h.bySail[sail] = (h.bySail[sail] || 0) + elapsed
    h.total += elapsed
  }

  function settleAll () { Object.keys(activeSince).forEach(settle) }

  // Read-only: total seconds for a group including whatever's accrued since the last
  // settle, without mutating anything.
  function liveHoursSeconds (g) {
    const h = hours[g]
    let total = h ? h.total : 0
    const since = activeSince[g]
    if (since && state[g]) total += Math.max(0, (Date.now() - since) / 1000)
    return total
  }

  // Human-readable summary (hours, not seconds) for the webapp / /hours endpoint.
  function hoursSummary () {
    const out = {}
    groups().forEach(g => {
      const h = hours[g.name] || { bySail: {}, total: 0 }
      const bySail = Object.assign({}, h.bySail)
      const since = activeSince[g.name]
      if (since && state[g.name]) {
        bySail[state[g.name]] = (bySail[state[g.name]] || 0) + Math.max(0, (Date.now() - since) / 1000)
      }
      const bySailHours = {}
      Object.keys(bySail).forEach(s => { bySailHours[s] = +(bySail[s] / 3600).toFixed(2) })
      out[g.name] = { totalHours: +(liveHoursSeconds(g.name) / 3600).toFixed(2), bySailHours }
    })
    return out
  }

  // sails.hours.<group>: live seconds in use (SI, like the rest of SignalK), regardless
  // of which specific sail within the group - this is the "main hours" number.
  function emitHours () {
    groups().forEach(g => {
      app.handleMessage(plugin.id, {
        updates: [{
          values: [{ path: 'sails.hours.' + g.name, value: +liveHoursSeconds(g.name).toFixed(1) }]
        }]
      })
    })
  }

  function emitAll () {
    Object.keys(state).forEach(g => { emitGroup(g); emitReef(g) })
    emitSet()
    if (hoursEnabled()) emitHours()
  }

  // v2 adds reef levels alongside the sails. A v1 file is a flat { group: sail } map with
  // no version key, so upgrading keeps whatever was up and starts it unreefed.
  function saveState () {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ v: 2, sails: state, reefs: reefs }))
    } catch (e) { app.error('' + e) }
  }

  function loadState () {
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { saved = {} }
    if (saved && saved.v === 2) {
      state = saved.sails || {}
      reefs = saved.reefs || {}
    } else {
      state = saved || {}
      reefs = {}
    }
  }

  function saveHours () {
    try { fs.writeFileSync(hoursFile, JSON.stringify({ hours, activeSince })) } catch (e) { app.error('' + e) }
  }

  // CSV ground-truth log: one row per change, plus the full set at that moment so you
  // can grep the file for a sail name and see every time it was part of the rig, not
  // just the moment its own group changed. The sail cell carries the reef state too
  // ('M1-Reef2'), which keeps the column count unchanged while making the log the record
  // of reef history - hours deliberately don't split by reef. Empty sail cell = cleared.
  // 'trigger' distinguishes a button press ('user') from the auto-clear-at-the-dock
  // safety net ('auto'), so the log stays trustworthy about what actually happened.
  function logChange (g, trigger) {
    try {
      const csv = path.join(app.getDataDirPath(), 'sail-log.csv')
      if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'utc,group,sail,set,trigger\n')
      const setField = '"' + currentSet().join('|') + '"'
      fs.appendFileSync(csv, new Date().toISOString() + ',' + g + ',' + (label(g) || '') + ',' + setField + ',' + trigger + '\n')
    } catch (e) { app.error('' + e) }
  }

  // "There is no way in hell people are sailing now": if the boat has been under the
  // speed-gate threshold continuously for autoClearMinutes, drop whatever's still
  // toggled on so a forgotten sail doesn't sit "hoisted" (and out of sync with reality)
  // into the next morning. Only does anything if both minSpeedKnots and
  // autoClearMinutes are configured - off by default.
  let stationarySince = null
  function checkAutoClear () {
    const minutes = options.autoClearMinutes || 0
    if (minutes <= 0) return
    if (isMoving()) { stationarySince = null; return }
    if (stationarySince == null) { stationarySince = Date.now(); return }
    if ((Date.now() - stationarySince) / 60000 < minutes) return
    const activeGroups = groups().filter(g => state[g.name])
    if (!activeGroups.length) { stationarySince = null; return }
    activeGroups.forEach(g => {
      if (hoursEnabled()) { settle(g.name); activeSince[g.name] = null }
      state[g.name] = null
      reefs[g.name] = 0
      emitGroup(g.name)
      emitReef(g.name)
      logChange(g.name, 'auto')
    })
    saveState()
    if (hoursEnabled()) saveHours()
    emitSet()
    if (hoursEnabled()) emitHours()
    app.setPluginStatus('Auto-cleared ' + activeGroups.map(g => g.name).join(', ') + ' after ' + minutes + 'min stationary')
    stationarySince = null
  }

  plugin.start = function (opts) {
    options = opts || {}
    stateFile = path.join(app.getDataDirPath(), 'current-sails.json')
    hoursFile = path.join(app.getDataDirPath(), 'sail-hours.json')
    loadState()
    try {
      const saved = JSON.parse(fs.readFileSync(hoursFile, 'utf8'))
      hours = saved.hours || {}
      activeSince = saved.activeSince || {}
    } catch (e) { hours = {}; activeSince = {} }
    if (!hoursEnabled()) {
      // Tracking is off - drop any running clock so it can't silently accrue a huge
      // "elapsed" span (covering the whole time it was switched off) if re-enabled later.
      activeSince = {}
    } else {
      // If a group was active when we last shut down, its clock (activeSince) survives
      // the restart, so a plugin/server restart never resets an in-progress sail's hours -
      // it's still the same sail flying, just a reload of the process watching it. But if
      // a group is set and has no clock (tracking was just turned on, or it was set while
      // tracking was off), start counting from now - not retroactively.
      groups().forEach(g => {
        if (state[g.name] && !activeSince[g.name]) activeSince[g.name] = Date.now()
      })
    }
    if ((options.minSpeedKnots || 0) > 0) subscribeSpeed()
    emitAll()
    const n = options.reemitSeconds === undefined ? 60 : options.reemitSeconds
    if (n > 0) {
      timer = setInterval(() => {
        if (hoursEnabled()) { settleAll(); saveHours() }
        checkAutoClear() // fallback in case speedPath isn't updating fast enough on its own
        emitAll()
      }, n * 1000)
    }
    app.setPluginStatus('Running')
  }

  plugin.stop = function () {
    if (timer) { clearInterval(timer); timer = null }
    if (unsubscribeSpeed) { unsubscribeSpeed(); unsubscribeSpeed = null }
  }

  plugin.registerWithRouter = function (router) {
    router.get('/setup', (req, res) => {
      res.json({
        groups: groups(),
        current: state,
        reefs: reefs,
        set: currentSet(),
        hours: hoursEnabled() ? hoursSummary() : null
      })
    })
    router.get('/hours', (req, res) => {
      if (!hoursEnabled()) return res.json({ enabled: false })
      res.json(hoursSummary())
    })
    // GET so it works from the most limited MFD browsers (no fetch/POST needed).
    // Two shapes, one endpoint:
    //   ?group=mainsail&sail=M1    - which sail is up in that group
    //   ?group=mainsail&state=Reef2 - how deeply that sail is reefed
    // Every button is a real toggle: tapping the sail that's already set for this group
    // clears the group instead of re-setting it, and tapping the reef level that's already
    // in shakes everything out back to full - no dedicated 'none' or 'full' button needed.
    router.get('/declare', (req, res) => {
      const g = req.query.group
      const v = req.query.sail
      const st = req.query.state
      const grp = groups().find(x => x.name === g)
      if (!grp) return res.status(400).json({ ok: false, error: 'unknown group' })
      if (v !== undefined && st !== undefined) {
        return res.status(400).json({ ok: false, error: 'pass either sail or state, not both' })
      }
      if (v === undefined && st === undefined) {
        return res.status(400).json({ ok: false, error: 'missing sail or state' })
      }
      if (v !== undefined && grp.sails.indexOf(v) < 0) {
        return res.status(400).json({ ok: false, error: 'unknown sail' })
      }
      if (st !== undefined && grp.states.indexOf(st) < 0) {
        return res.status(400).json({ ok: false, error: 'unknown state' })
      }
      // A reef is a state OF a sail, so there has to be one up to reef. Without this the
      // group could end up carrying a reef level with no sail, which sails.set can't
      // express and the hours clock has nothing to bank against.
      if (st !== undefined && !state[g]) {
        return res.status(409).json({ ok: false, error: 'no sail set in ' + g })
      }
      // Any button press is evidence someone's actively there - resets the auto-clear
      // countdown. Otherwise hoisting the main head-to-wind (boat sitting at ~0kn or
      // even briefly reversing while you sort out halyards/sheets) would look exactly
      // like "abandoned at the dock" and could clear itself mid-hoist.
      stationarySince = null
      if (hoursEnabled()) settle(g) // bank time accrued so far before anything changes
      if (st !== undefined) {
        // Reef ladder, not independent flags: the states list is ordered, so Reef2 means
        // level 2 and implies the first reef is in. Tapping the level that's already set
        // goes back to full; tapping a lower one than you're on shakes out down to it.
        const lvl = grp.states.indexOf(st) + 1
        reefs[g] = (reefs[g] || 0) === lvl ? 0 : lvl
      } else {
        const turningOff = state[g] === v
        state[g] = turningOff ? null : v
        // Changing or dousing the sail resets the ladder - a new hoist starts unreefed,
        // and a cleared group has nothing to carry a reef level for.
        reefs[g] = 0
        if (hoursEnabled()) activeSince[g] = turningOff ? null : Date.now()
      }
      if (hoursEnabled()) saveHours()
      saveState()
      emitGroup(g)
      emitReef(g)
      emitSet()
      if (hoursEnabled()) emitHours()
      logChange(g, 'user')
      res.json({
        ok: true,
        group: g,
        current: state[g],
        reef: reefs[g] || 0,
        label: label(g),
        set: currentSet(),
        hours: hoursEnabled() ? hoursSummary()[g] : null
      })
    })
  }

  return plugin
}

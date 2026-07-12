const fs = require('fs')
const path = require('path')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-sail-setup',
    name: 'Sail Setup',
    description: 'Declare which sails are up; configurable inventory; emits sails.<group> per group, sails.set (full combo), sails.hours.<group> (time in use)'
  }

  let options = {}
  let state = {}
  let hours = {}       // { group: { bySail: { sail: seconds }, total: seconds } }
  let activeSince = {} // { group: timestampMs } - when the group's current sail went up
  let timer = null
  let stateFile = null
  let hoursFile = null

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
          { name: 'mainsail', sails: 'Full, Reef1, Reef2, Trysail' }
        ],
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Group name (becomes path sails.<name>)' },
            sails: { type: 'string', title: 'Sails (comma-separated)' }
          }
        }
      },
      reemitSeconds: {
        type: 'number',
        title: 'Re-emit current state every N seconds (0 = off). Keeps value in every log window.',
        default: 60
      }
    }
  }

  function groups () {
    return (options.groups || []).map(g => ({
      name: (g.name || '').trim(),
      sails: (g.sails || '').split(',').map(s => s.trim()).filter(Boolean)
    })).filter(g => g.name && g.sails.length && g.name !== 'set' && g.name !== 'hours') // reserved path prefixes
  }

  // The full current sail set, e.g. ['A4','SS','Full'] - empty/cleared slots omitted.
  // Order follows group config order, so it's stable as long as groups aren't reordered.
  // 'none' is still filtered out for backwards compatibility with configs that list it
  // explicitly as a sail - new configs don't need it, tapping the active button clears it.
  function currentSet () {
    return groups()
      .map(g => state[g.name])
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

  // Single atomic path with the whole current combo - easiest thing to log/grep/graph,
  // and what a future per-sail-set polar comparison would key off of.
  function emitSet () {
    app.handleMessage(plugin.id, {
      updates: [{
        values: [{ path: 'sails.set', value: currentSet() }]
      }]
    })
  }

  function ensureGroupHours (g) {
    if (!hours[g]) hours[g] = { bySail: {}, total: 0 }
    return hours[g]
  }

  // Bank whatever time the group's currently-active sail has accrued since the last
  // settle into the accumulators, then reset the clock. This is what makes mainsail
  // hours keep counting across Full/Reef1/Reef2 transitions: every settle adds to
  // BOTH the specific sail's bucket and the group total, regardless of which sail it
  // was, so switching reef points never loses time off the group's running total -
  // it just splits it between buckets.
  function settle (g) {
    const since = activeSince[g]
    const sail = state[g]
    if (!since || !sail) return
    const elapsed = Math.max(0, (Date.now() - since) / 1000)
    const h = ensureGroupHours(g)
    h.bySail[sail] = (h.bySail[sail] || 0) + elapsed
    h.total += elapsed
    activeSince[g] = Date.now()
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
    Object.keys(state).forEach(emitGroup)
    emitSet()
    emitHours()
  }

  function saveState () {
    try { fs.writeFileSync(stateFile, JSON.stringify(state)) } catch (e) { app.error('' + e) }
  }

  function saveHours () {
    try { fs.writeFileSync(hoursFile, JSON.stringify({ hours, activeSince })) } catch (e) { app.error('' + e) }
  }

  plugin.start = function (opts) {
    options = opts || {}
    stateFile = path.join(app.getDataDirPath(), 'current-sails.json')
    hoursFile = path.join(app.getDataDirPath(), 'sail-hours.json')
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { state = {} }
    try {
      const saved = JSON.parse(fs.readFileSync(hoursFile, 'utf8'))
      hours = saved.hours || {}
      activeSince = saved.activeSince || {}
    } catch (e) { hours = {}; activeSince = {} }
    // If a group was active when we last shut down, its clock (activeSince) survives
    // the restart, so a plugin/server restart never resets an in-progress sail's hours -
    // it's still the same sail flying, just a reload of the process watching it.
    emitAll()
    const n = options.reemitSeconds === undefined ? 60 : options.reemitSeconds
    if (n > 0) {
      timer = setInterval(() => { settleAll(); saveHours(); emitAll() }, n * 1000)
    }
    app.setPluginStatus('Running')
  }

  plugin.stop = function () { if (timer) { clearInterval(timer); timer = null } }

  plugin.registerWithRouter = function (router) {
    router.get('/setup', (req, res) => {
      res.json({ groups: groups(), current: state, set: currentSet(), hours: hoursSummary() })
    })
    router.get('/hours', (req, res) => { res.json(hoursSummary()) })
    // GET so it works from the most limited MFD browsers (no fetch/POST needed)
    // Every button is a real toggle: tapping the sail that's already set for this
    // group clears the group instead of re-setting it - no dedicated "none" button needed.
    router.get('/declare', (req, res) => {
      const g = req.query.group
      const v = req.query.sail
      const grp = groups().find(x => x.name === g)
      if (!grp || grp.sails.indexOf(v) < 0) {
        return res.status(400).json({ ok: false, error: 'unknown group or sail' })
      }
      settle(g) // bank whatever time the previous sail (if any) has accrued before switching
      const turningOff = state[g] === v
      state[g] = turningOff ? null : v
      activeSince[g] = turningOff ? null : Date.now()
      saveState()
      saveHours()
      emitGroup(g)
      emitSet()
      emitHours()
      // CSV ground-truth log: one row per change, plus the full set at that moment so you
      // can grep the file for a sail name and see every time it was part of the rig,
      // not just the moment its own group changed. Empty sail cell = group was cleared.
      try {
        const csv = path.join(app.getDataDirPath(), 'sail-log.csv')
        if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'utc,group,sail,set\n')
        const setField = '"' + currentSet().join('|') + '"'
        fs.appendFileSync(csv, new Date().toISOString() + ',' + g + ',' + (state[g] || '') + ',' + setField + '\n')
      } catch (e) { app.error('' + e) }
      res.json({ ok: true, group: g, current: state[g], set: currentSet(), hours: hoursSummary()[g] })
    })
  }

  return plugin
}

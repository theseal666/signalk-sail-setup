const fs = require('fs')
const path = require('path')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-sail-setup',
    name: 'Sail Setup',
    description: 'Declare which sails are up; configurable inventory; emits sails.<group> per group plus sails.set (array of the full current sail combo)'
  }

  let options = {}
  let state = {}
  let timer = null
  let stateFile = null

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
    })).filter(g => g.name && g.sails.length && g.name !== 'set') // 'set' is reserved for the aggregate path below
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

  function emitAll () {
    Object.keys(state).forEach(emitGroup)
    emitSet()
  }

  function saveState () {
    try { fs.writeFileSync(stateFile, JSON.stringify(state)) } catch (e) { app.error('' + e) }
  }

  plugin.start = function (opts) {
    options = opts || {}
    stateFile = path.join(app.getDataDirPath(), 'current-sails.json')
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { state = {} }
    emitAll()
    const n = options.reemitSeconds === undefined ? 60 : options.reemitSeconds
    if (n > 0) timer = setInterval(emitAll, n * 1000)
    app.setPluginStatus('Running')
  }

  plugin.stop = function () { if (timer) { clearInterval(timer); timer = null } }

  plugin.registerWithRouter = function (router) {
    router.get('/setup', (req, res) => {
      res.json({ groups: groups(), current: state, set: currentSet() })
    })
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
      const turningOff = state[g] === v
      state[g] = turningOff ? null : v
      saveState()
      emitGroup(g)
      emitSet()
      // CSV ground-truth log: one row per change, plus the full set at that moment so you
      // can grep the file for a sail name and see every time it was part of the rig,
      // not just the moment its own group changed. Empty sail cell = group was cleared.
      try {
        const csv = path.join(app.getDataDirPath(), 'sail-log.csv')
        if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'utc,group,sail,set\n')
        const setField = '"' + currentSet().join('|') + '"'
        fs.appendFileSync(csv, new Date().toISOString() + ',' + g + ',' + (state[g] || '') + ',' + setField + '\n')
      } catch (e) { app.error('' + e) }
      res.json({ ok: true, group: g, current: state[g], set: currentSet() })
    })
  }

  return plugin
}

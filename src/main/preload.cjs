// src/main/preload.cjs — the ONLY bridge into the sandboxed renderer.
// Exposes exactly the SPEC §6 `window.orbit` surface over contextBridge; every
// method is a thin ipcRenderer.invoke of a whitelisted 'orbit:*' channel. No
// eval, no raw SQL, no fs, no network — the renderer cannot reach anything else.
//
// CommonJS + .cjs on purpose: Electron loads sandboxed preloads with a CJS
// loader, so an ESM preload fails with "Cannot use import statement outside a
// module" and the bridge silently never installs. The package is
// "type":"module", hence the explicit .cjs extension. Keeping sandbox:true is
// worth more than ESM consistency in this one file. (SPEC §7)

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke('orbit:' + channel, ...args);

const orbit = {
  digest: {
    whoIsOnNow: () => call('digest.whoIsOnNow'),
    heatmap: (personId) => call('digest.heatmap', personId),
    birthdays: (withinDays) => call('digest.birthdays', withinDays),
    statusBoard: () => call('digest.statusBoard'),
    changeFeed: (sinceTs) => call('digest.changeFeed', sinceTs),
  },
  people: {
    list: (filter) => call('people.list', filter),
    get: (id) => call('people.get', id),
    setNote: (id, text) => call('people.setNote', id, text),
    addManual: (person) => call('people.addManual', person),
    link: (idA, idB) => call('people.link', idA, idB),
    unlink: (idA, idB) => call('people.unlink', idA, idB),
    linkSuggestions: (id) => call('people.linkSuggestions', id),
    forget: (id) => call('people.forget', id),
  },
  sources: {
    status: () => call('sources.status'),
    token: () => call('sources.token'),
    runNow: (plugin) => call('sources.runNow', plugin),
    configure: (plugin, cfg) => call('sources.configure', plugin, cfg),
    test: (plugin, cfg) => call('sources.test', plugin, cfg),
    disconnect: (plugin) => call('sources.disconnect', plugin),
    // §0.5: what one platform's data amounts to, and deleting it. Both take a
    // Person.source ("steam", "discord"). preview never writes; forgetData never
    // touches credentials — disconnect is the separate act.
    preview: (source) => call('sources.preview', source),
    forgetData: (source) => call('sources.forgetData', source),
  },
  settings: {
    get: () => call('settings.get'),
    set: (patch) => call('settings.set', patch),
  },
};

contextBridge.exposeInMainWorld('orbit', orbit);

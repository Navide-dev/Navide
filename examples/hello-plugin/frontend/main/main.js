document.getElementById('status').textContent = 'Loaded at ' + new Date().toLocaleTimeString()

// Tell Navide the view has mounted; without this the Host rejects the package at install.
// This is the call createPluginViewRuntimeClient().ready() makes. Once the view has a build
// step, import @navide/plugin-sdk and use that instead.
window.nav.ready()

// Explicit vue-tsc CLI adapter; never a Bun global preload.
// Relay Volar's own transformed compiler bytes through Bun's CommonJS hook.
// Installed compiler/library files and plain tsc are left unchanged.
if (require.main === module) {
  const vueTsc = require('vue-tsc')
  if (!process.versions.bun) {
    vueTsc.run()
  } else {
    const fs = require('node:fs')
    const target = require.resolve('typescript/lib/tsc')
    const original = require.extensions['.js']
    // Only this explicit Vue operation installs the hook. An unrelated fs
    // override or importing this adapter cannot activate it.
    require.extensions['.js'] = function (module, filename) {
      if (filename === target) {
        module._compile(fs.readFileSync(target, 'utf8'), filename)
      } else {
        original(module, filename)
      }
    }
    try {
      vueTsc.run(target)
    } finally {
      require.extensions['.js'] = original
    }
  }
}

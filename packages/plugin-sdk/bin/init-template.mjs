// `navide-plugin init`: a minimal frontend-only Manifest v2 plugin that
// validates and packages as written, with no build step.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const DISPLAY_NAME = /^[^\r\n<>]{1,80}$/
// `engines.navide` is a minimum: the Navide release this scaffold targets.
const MIN_NAVIDE = '>=0.2.13'

function titleCase(slug) {
  return slug.split('-').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function files(id, name) {
  const html = name.replaceAll('&', '&amp;')
  const publisher = id.split('.')[0]
  const manifest = {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name,
    version: '0.1.0',
    publisher,
    engines: { navide: MIN_NAVIDE },
    permissions: {},
    marketplace: { description: `${name}, a Navide plugin.`, license: 'MIT' },
    contributes: {
      views: [{ id: 'main', kind: 'custom', location: 'main', title: name, entry: 'frontend/main/index.html' }],
    },
  }
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'frontend/main/index.html': [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      `    <title>${html}</title>`,
      '  </head>',
      '  <body>',
      `    <h1>${html}</h1>`,
      '    <p id="status"></p>',
      '    <script src="./main.js"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'frontend/main/main.js': [
      "document.getElementById('status').textContent = 'Loaded at ' + new Date().toLocaleTimeString()",
      '',
      '// Tell Navide the view has mounted; without this the Host rejects the package at install.',
      '// This is the call createPluginViewRuntimeClient().ready() makes. Once the view has a build',
      '// step, import @navide/plugin-sdk and use that instead.',
      'window.nav.ready()',
      '',
    ].join('\n'),
    'README.md': `# ${name}\n\n${manifest.marketplace.description}\n`,
    'artifact-files.json': `${JSON.stringify(
      { files: ['manifest.json', 'README.md', 'frontend/main/index.html', 'frontend/main/main.js'] },
      null,
      2,
    )}\n`,
    '.gitignore': '*.key\n*.vsix\n*.sig\n',
  }
}

export function initPlugin(directory, id, name) {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`plugin id '${id}' must be <namespace>.<name> in lowercase letters, digits and hyphens`)
  }
  const displayName = name ?? titleCase(id.split('.').slice(1).join('-'))
  if (!DISPLAY_NAME.test(displayName)) {
    throw new Error('plugin name must be 1-80 characters without newlines or angle brackets')
  }
  const root = resolve(directory)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`'${directory}' already exists and is not empty`)
  }
  for (const [path, contents] of Object.entries(files(id, displayName))) {
    const fullPath = join(root, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, contents, { flag: 'wx' })
  }
  return { root, id, name: displayName }
}

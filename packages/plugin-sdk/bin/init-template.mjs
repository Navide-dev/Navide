// `navide-plugin init`: a minimal frontend-only Manifest v2 plugin that
// validates and packages as written, with no build step.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { vueTemplateFiles } from './init-template-vue.mjs'

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const DISPLAY_NAME = /^[^\r\n<>]{1,80}$/
// `engines.navide` is a minimum: the Navide release this scaffold targets.
const MIN_NAVIDE = '>=0.2.13'
// The CLI is not on npm: the scaffold's package.json installs it from the
// GitHub Release of this SDK's own version, so `npm run check` never reaches
// for an npm package of the same name.
const SDK_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const PLUGIN_PACKAGES_RELEASE = `https://github.com/Navide-dev/Navide/releases/download/plugin-packages-${SDK_VERSION}`

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
    // Not in artifact-files.json, so never packaged: it only installs the CLI.
    'package.json': `${JSON.stringify(
      {
        name: `${publisher}-${id.split('.').slice(1).join('-')}-navide-plugin`,
        private: true,
        scripts: {
          check: 'navide-plugin validate . && navide-plugin scan .',
          package: 'navide-plugin package .',
        },
        devDependencies: {
          '@navide/plugin-contracts': `${PLUGIN_PACKAGES_RELEASE}/navide-plugin-contracts-${SDK_VERSION}.tgz`,
          '@navide/plugin-sdk': `${PLUGIN_PACKAGES_RELEASE}/navide-plugin-sdk-${SDK_VERSION}.tgz`,
        },
      },
      null,
      2,
    )}\n`,
    'artifact-files.json': `${JSON.stringify(
      { files: ['manifest.json', 'README.md', 'frontend/main/index.html', 'frontend/main/main.js'] },
      null,
      2,
    )}\n`,
    '.gitignore': 'node_modules/\n*.key\n*.vsix\n*.sig\n',
  }
}

export const INIT_TEMPLATES = ['default', 'vue']

export function initPlugin(directory, id, name, template = 'default') {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`plugin id '${id}' must be <namespace>.<name> in lowercase letters, digits and hyphens`)
  }
  if (!INIT_TEMPLATES.includes(template)) {
    throw new Error(`unknown template '${template}'; templates: ${INIT_TEMPLATES.join(', ')}`)
  }
  const displayName = name ?? titleCase(id.split('.').slice(1).join('-'))
  if (!DISPLAY_NAME.test(displayName)) {
    throw new Error('plugin name must be 1-80 characters without newlines or angle brackets')
  }
  // The vue template's names are checked before anything is written.
  const generated = template === 'vue' ? vueTemplateFiles(id, displayName) : files(id, displayName)
  const root = resolve(directory)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`'${directory}' already exists and is not empty`)
  }
  for (const [path, contents] of Object.entries(generated)) {
    const fullPath = join(root, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, contents, { flag: 'wx', ...(contents.startsWith('#!') ? { mode: 0o755 } : {}) })
  }
  return { root, id, name: displayName, template }
}

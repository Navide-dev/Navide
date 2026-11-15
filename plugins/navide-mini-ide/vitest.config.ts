import { pluginVitestConfig } from '../../vitest.plugin'

export default pluginVitestConfig('navide-mini-ide', {
  setupFiles: ['plugins/navide-mini-ide/src/miniIdeMessages.ts'],
  heavy: ['tests/packageBoundary.test.ts'],
})

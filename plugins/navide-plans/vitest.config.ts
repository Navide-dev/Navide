import { pluginVitestConfig } from '../../vitest.plugin'

export default pluginVitestConfig('navide-plans', {
  setupFiles: ['plugins/navide-plans/tests/support/messages.ts'],
  heavy: ['tests/packageBoundary.test.ts'],
})

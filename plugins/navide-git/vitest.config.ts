import { pluginVitestConfig } from '../../vitest.plugin'

export default pluginVitestConfig('navide-git', {
  setupFiles: ['plugins/navide-git/src/gitMessages.ts'],
  heavy: ['tests/compositionBoundary.test.ts'],
})

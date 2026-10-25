import { ref, watch, type Ref } from 'vue'

/** Which Navide plugin "main" view's stage tab is active, or null while a
 *  run-group tab is. Null at start, so installing a plugin never takes the
 *  stage over. Any change of the active run-group tab (a tab click, "+", a pane
 *  revealed from the sidebar, MCP ui.tab.switch, a restore) leaves the plugin
 *  tab, and so does the view's contribution going away. A path that asks for
 *  the run-group tab already active changes nothing, so it calls `leave`. */
export function usePluginMainTab(activeTab: Ref<string>, tabKeys: Ref<readonly string[]>) {
  const activeKey = ref<string | null>(null)
  const open = (key: string): void => {
    activeKey.value = key
  }
  const leave = (): void => {
    activeKey.value = null
  }
  watch(activeTab, leave)
  watch(tabKeys, (keys) => {
    if (activeKey.value !== null && !keys.includes(activeKey.value)) leave()
  })
  return { activeKey, open, leave }
}

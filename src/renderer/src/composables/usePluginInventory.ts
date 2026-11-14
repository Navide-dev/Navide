import { ref, type Ref } from 'vue'

// The installed/bundled plugin inventory, shared by every surface that shows or
// changes it. Extensions (the list) and Marketplace (the installer) are two
// separate settings pages but one inventory: when Marketplace commits an
// install, the already-mounted Extensions list has to show it. Module-level
// refs are what makes that true without either page knowing about the other.
const installed = ref<InstalledPluginSummary[]>([])
const factoryPackages = ref<FactoryPluginSummary[]>([])

export interface PluginInventory {
  installed: Ref<InstalledPluginSummary[]>
  factoryPackages: Ref<FactoryPluginSummary[]>
  refresh: () => Promise<void>
}

export function usePluginInventory(): PluginInventory {
  async function refresh(): Promise<void> {
    const api = window.agentTeam?.plugins
    if (!api) return
    const [nextInstalled, nextFactory] = await Promise.all([
      api.listInstalled(),
      api.listFactoryPackages(),
    ])
    // No answer is a failed read, not an empty inventory: the pages say so.
    if (!Array.isArray(nextInstalled) || !Array.isArray(nextFactory)) {
      throw new Error('The installed Navide plugins could not be read.')
    }
    installed.value = nextInstalled
    factoryPackages.value = nextFactory
  }

  return { installed, factoryPackages, refresh }
}

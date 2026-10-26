<script setup lang="ts">
// What an update changes (plan B D2/D-d): added items labelled "New", removed
// ones greyed and labelled "Removed", unchanged ones folded. The diff is the
// Host's own (prepareInstall compares the installed and the downloaded
// manifests), so this component only words it. Facts, not warnings.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fsScopeChangeWidens, isFsScopeItem, type DisclosureDiff, type DisclosureItem } from '../../../shared/pluginDisclosure'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

const props = defineProps<{ diff: DisclosureDiff }>()
const { t, te } = useI18n()

function itemText(item: DisclosureItem): string {
  const key = `pluginDisclosure.diff.item.${item.kind}`
  // Keys come from the package: invisible characters are spelled out (L3 on #360).
  const shown = revealInvisibleText(item.key)
  return te(key) ? t(key, { key: shown }) : `${item.kind}: ${shown}`
}

const riskChanged = computed(() => props.diff.from.risk !== props.diff.to.risk)

/** A declared file scope is informational: Navide does not enforce it. When
 *  this update's scope change claims no more than before (fsScopeChangeWidens),
 *  its items stay listed under "New" / "Removed" and also say they are a
 *  declared scope, so a narrower declaration does not read as more access. */
const scopeIsInformational = computed(() => !fsScopeChangeWidens(
  [...props.diff.removed, ...props.diff.unchanged],
  [...props.diff.added, ...props.diff.unchanged],
))
const informational = (item: DisclosureItem): boolean => scopeIsInformational.value && isFsScopeItem(item)
/** #647 review L1: the tag alone does not say what "informational" means. */
const showsDeclaredScope = computed(() => [...props.diff.added, ...props.diff.removed].some(informational))
</script>

<template>
  <section class="nv-diff" :aria-label="$t('pluginDisclosure.diff.heading')">
    <h5 class="nv-diff-heading">{{ $t('pluginDisclosure.diff.heading') }}</h5>
    <p class="nv-diff-versions">{{ $t('pluginDisclosure.diff.versions', { from: diff.from.version, to: diff.to.version }) }}</p>
    <p v-if="riskChanged" class="nv-diff-risk">
      {{ $t('pluginDisclosure.diff.risk', { from: $t(`pluginDisclosure.risk.${diff.from.risk}`), to: $t(`pluginDisclosure.risk.${diff.to.risk}`) }) }}
    </p>
    <p v-if="!diff.added.length && !diff.removed.length" class="nv-diff-none">{{ $t('pluginDisclosure.diff.none') }}</p>
    <ul v-if="diff.added.length" class="nv-diff-added">
      <li v-for="item in diff.added" :key="`${item.kind}:${item.key}`">
        <span class="nv-diff-tag">{{ $t('pluginDisclosure.diff.added') }}</span> <template v-if="informational(item)"><span class="nv-diff-tag nv-diff-tag--info">{{ $t('pluginDisclosure.diff.declaredScope') }}</span>{{ ' ' }}</template>{{ itemText(item) }}
      </li>
    </ul>
    <ul v-if="diff.removed.length" class="nv-diff-removed">
      <li v-for="item in diff.removed" :key="`${item.kind}:${item.key}`">
        <span class="nv-diff-tag">{{ $t('pluginDisclosure.diff.removed') }}</span> <template v-if="informational(item)"><span class="nv-diff-tag nv-diff-tag--info">{{ $t('pluginDisclosure.diff.declaredScope') }}</span>{{ ' ' }}</template>{{ itemText(item) }}
      </li>
    </ul>
    <p v-if="showsDeclaredScope" class="nv-diff-scope-note">{{ $t('pluginDisclosure.diff.declaredScopeNote') }}</p>
    <details v-if="diff.unchanged.length" class="nv-diff-unchanged">
      <summary>{{ $t('pluginDisclosure.diff.unchanged', { count: diff.unchanged.length }) }}</summary>
      <ul>
        <li v-for="item in diff.unchanged" :key="`${item.kind}:${item.key}`">{{ itemText(item) }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.nv-diff {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-xs);
}
.nv-diff ul {
  margin: 0;
  padding-left: 1.2em;
}
.nv-diff-heading,
.nv-diff-versions,
.nv-diff-risk,
.nv-diff-none,
.nv-diff-scope-note {
  margin: 0;
}
.nv-diff-versions,
.nv-diff-none,
.nv-diff-scope-note,
.nv-diff-unchanged {
  color: var(--text-secondary);
}
.nv-diff-risk {
  font-weight: 600;
}
.nv-diff-tag {
  display: inline-block;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.nv-diff-added .nv-diff-tag {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.nv-diff-removed {
  color: var(--text-secondary);
}
.nv-diff-removed .nv-diff-tag {
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
}
/* Neutral in both lists: it qualifies the item, it is not a direction. */
.nv-diff .nv-diff-tag--info {
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
}
</style>

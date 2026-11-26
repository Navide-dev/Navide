import { SectionList, StyleSheet, Text, View } from 'react-native'
import type { ConnectionState } from '../../connection/transport.ts'
import { statusLabel, t } from '../../i18n/index.ts'
import { paneKey, paneState, type DesktopRoster, type PaneSummary } from '../../types/pane.ts'
import { useTheme, type Theme } from '../../ui/theme.ts'

interface Section {
  title: string
  data: { key: string; pane: PaneSummary }[]
}

/** Panes grouped by computer and workspace; the ones waiting on you first. */
function sections(roster: DesktopRoster[]): Section[] {
  const out: Section[] = []
  for (const d of roster) {
    const byWorkspace = new Map<string, PaneSummary[]>()
    for (const p of d.panes) byWorkspace.set(p.workspace, [...(byWorkspace.get(p.workspace) ?? []), p])
    for (const [workspace, panes] of byWorkspace) {
      const sorted = [...panes].sort(
        (a, b) => Number(paneState(b) === 'attention') - Number(paneState(a) === 'attention'),
      )
      out.push({
        title: roster.length > 1 ? `${d.deviceName} · ${workspace}` : workspace,
        data: sorted.map((pane) => ({ key: paneKey(d.deviceId, pane), pane })),
      })
    }
  }
  return out
}

export function PanesScreen({ roster, connection }: { roster: DesktopRoster[]; connection: ConnectionState }) {
  const theme = useTheme()
  const s = styles(theme)
  return (
    <View style={{ flex: 1 }}>
      <ConnectionBanner state={connection} />
      <SectionList
        sections={sections(roster)}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListEmptyComponent={connection === 'online' ? <Text style={s.empty}>{t('panes.empty')}</Text> : undefined}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderItem={({ item }) => <PaneRow pane={item.pane} />}
        stickySectionHeadersEnabled={false}
      />
    </View>
  )
}

function PaneRow({ pane }: { pane: PaneSummary }) {
  const theme = useTheme()
  const s = styles(theme)
  const state = paneState(pane)
  const color = theme.state[state]
  const detail =
    state === 'attention'
      ? pane.awaitingKind === 'question'
        ? t('panes.hasQuestion')
        : t('panes.needsApproval')
      : statusLabel(pane.status)
  return (
    <View
      style={[s.row, state === 'attention' && { borderColor: color, borderWidth: 2 }]}
      accessible
      accessibilityLabel={`${pane.name}, ${t(`panes.state.${state}`)}, ${detail}`}
    >
      <View style={[s.dot, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={s.name} numberOfLines={1}>
          {pane.name}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {pane.agentKey ? `${pane.agentKey} · ` : ''}
          {detail}
        </Text>
      </View>
      <Text style={[s.badge, { color }]}>{t(`panes.state.${state}`)}</Text>
    </View>
  )
}

export function ConnectionBanner({ state }: { state: ConnectionState }) {
  const theme = useTheme()
  if (state === 'online') return null
  return (
    <View style={{ backgroundColor: theme.card, paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ textAlign: 'center', color: theme.muted }}>{t(`connection.${state}`)}</Text>
    </View>
  )
}

const styles = (theme: Theme) =>
  StyleSheet.create({
    section: { fontSize: 13, fontWeight: '600', color: theme.muted, marginTop: 12, marginBottom: 4, textTransform: 'uppercase' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 12,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    name: { fontSize: 16, fontWeight: '600', color: theme.text },
    meta: { fontSize: 13, color: theme.muted, marginTop: 2 },
    badge: { fontSize: 13, fontWeight: '600' },
    empty: { textAlign: 'center', color: theme.muted, marginTop: 48, fontSize: 15 },
  })

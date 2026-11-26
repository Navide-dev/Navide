import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { t } from '../../i18n/index.ts'
import { useTheme, type Theme } from '../../ui/theme.ts'
import type { PaneEvent } from './events.ts'

export function eventTitle(e: PaneEvent): string {
  return t(`notifications.${e.kind}`, { pane: e.paneName })
}

function eventColor(theme: Theme, e: PaneEvent): string {
  return e.kind === 'done' ? theme.state.idle : theme.state.attention
}

export function NotificationsScreen({ events }: { events: PaneEvent[] }) {
  const theme = useTheme()
  const s = styles(theme)
  return (
    <FlatList
      data={events}
      keyExtractor={(e) => e.id}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      ListHeaderComponent={<Text style={s.hint}>{t('notifications.openWhileRunning')}</Text>}
      ListEmptyComponent={<Text style={s.empty}>{t('notifications.empty')}</Text>}
      renderItem={({ item }) => (
        <View style={s.row}>
          <View style={[s.bar, { backgroundColor: eventColor(theme, item) }]} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>{eventTitle(item)}</Text>
            <Text style={s.meta}>
              {t('notifications.where', { workspace: item.workspace, device: item.deviceName })} ·{' '}
              {new Date(item.at).toLocaleTimeString()}
            </Text>
          </View>
        </View>
      )}
    />
  )
}

/** A short banner at the top while the app is open. */
export function EventBanner({ event, onPress }: { event: PaneEvent; onPress: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[s.row, s.banner]}>
      <View style={[s.bar, { backgroundColor: eventColor(theme, event) }]} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>{eventTitle(event)}</Text>
        <Text style={s.meta}>{t('notifications.where', { workspace: event.workspace, device: event.deviceName })}</Text>
      </View>
    </Pressable>
  )
}

const styles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      gap: 12,
      padding: 14,
      borderRadius: 12,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
    },
    banner: { marginHorizontal: 12, marginTop: 8, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 },
    bar: { width: 4, borderRadius: 2 },
    title: { fontSize: 15, fontWeight: '600', color: theme.text },
    meta: { fontSize: 13, color: theme.muted, marginTop: 2 },
    hint: { fontSize: 13, color: theme.muted, marginBottom: 4 },
    empty: { textAlign: 'center', color: theme.muted, marginTop: 48, fontSize: 15 },
  })

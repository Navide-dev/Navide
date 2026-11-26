import Constants from 'expo-constants'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { transport } from '../../connection/index.ts'
import { MockTransport } from '../../connection/mockTransport.ts'
import { t } from '../../i18n/index.ts'
import type { Credential } from '../../identity/store.ts'
import { useTheme, type Theme } from '../../ui/theme.ts'

export function SettingsScreen({ credential, onUnpair }: { credential: Credential | null; onUnpair: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const mock = transport instanceof MockTransport ? transport : null
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {mock && <Text style={s.hint}>{t('settings.demoMode')}</Text>}
      <Text style={s.section}>{t('settings.pairedWith')}</Text>
      {credential?.desktops.map((d) => (
        <View key={d.deviceId} style={s.card}>
          <Text style={s.name}>{d.deviceName}</Text>
        </View>
      ))}
      <Text style={s.hint}>{t('settings.unpairHint')}</Text>
      <Pressable accessibilityRole="button" style={s.card} onPress={onUnpair}>
        <Text style={[s.name, { color: theme.danger }]}>{t('settings.unpair')}</Text>
      </Pressable>
      {mock && (
        <Pressable accessibilityRole="button" style={s.card} onPress={() => mock.simulateRevoke()}>
          <Text style={[s.name, { color: theme.accent }]}>{t('settings.demoRevoke')}</Text>
        </Pressable>
      )}
      <Text style={s.hint}>{t('settings.version', { version: Constants.expoConfig?.version ?? '' })}</Text>
    </ScrollView>
  )
}

const styles = (theme: Theme) =>
  StyleSheet.create({
    section: { fontSize: 13, fontWeight: '600', color: theme.muted, textTransform: 'uppercase' },
    card: { padding: 14, borderRadius: 12, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
    name: { fontSize: 16, fontWeight: '600', color: theme.text },
    hint: { fontSize: 13, color: theme.muted },
  })

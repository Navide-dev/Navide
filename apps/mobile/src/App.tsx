import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { EventBanner, NotificationsScreen } from './features/notifications/NotificationsScreen.tsx'
import { PairingScreen } from './features/pairing/PairingScreen.tsx'
import { PanesScreen } from './features/panes/PanesScreen.tsx'
import { SettingsScreen } from './features/settings/SettingsScreen.tsx'
import { t } from './i18n/index.ts'
import { useTheme } from './ui/theme.ts'
import { useNavide } from './useNavide.ts'

type Tab = 'panes' | 'notifications' | 'settings'
const TABS: Tab[] = ['panes', 'notifications', 'settings']
const BANNER_MS = 5_000

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  )
}

function Root() {
  const theme = useTheme()
  const app = useNavide()
  const [tab, setTab] = useState<Tab>('panes')
  const { latest, dismissLatest } = app

  useEffect(() => {
    if (!latest) return
    const timer = setTimeout(dismissLatest, BANNER_MS)
    return () => clearTimeout(timer)
  }, [latest, dismissLatest])

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar style="auto" />
      {app.phase === 'loading' && <ActivityIndicator style={{ flex: 1 }} color={theme.accent} />}
      {app.phase === 'unpaired' && (
        <PairingScreen notice={app.revoked ? t('settings.revoked') : null} onPaired={(c) => void app.paired(c)} />
      )}
      {app.phase === 'paired' && (
        <>
          <View style={{ flex: 1 }}>
            {tab === 'panes' && <PanesScreen roster={app.roster} connection={app.connection} />}
            {tab === 'notifications' && <NotificationsScreen events={app.events} />}
            {tab === 'settings' && <SettingsScreen credential={app.credential} onUnpair={() => void app.unpair()} />}
          </View>
          {latest && tab !== 'notifications' && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
              <EventBanner
                event={latest}
                onPress={() => {
                  dismissLatest()
                  setTab('notifications')
                }}
              />
            </View>
          )}
          <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            {TABS.map((name) => (
              <Pressable
                key={name}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === name }}
                onPress={() => setTab(name)}
                style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}
              >
                <Text style={{ color: tab === name ? theme.accent : theme.muted, fontWeight: '600' }}>
                  {t(`tabs.${name}`)}
                  {name === 'notifications' && app.events.length > 0 ? ` (${app.events.length})` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </SafeAreaView>
  )
}

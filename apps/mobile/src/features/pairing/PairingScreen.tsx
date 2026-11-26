import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Device from 'expo-device'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { isMock, transport } from '../../connection/index.ts'
import { MOCK_OFFER } from '../../connection/mockTransport.ts'
import { PairError, type PairSession } from '../../connection/transport.ts'
import { t } from '../../i18n/index.ts'
import { loadOrCreateKeys, type Credential } from '../../identity/store.ts'
import { useTheme } from '../../ui/theme.ts'
import { parseOffer, type PairOffer } from './offer.ts'

type Step =
  | { kind: 'start' }
  | { kind: 'scan' }
  | { kind: 'contacting' }
  | { kind: 'waiting'; code: string }
  | { kind: 'error'; message: string }

export function PairingScreen({ notice, onPaired }: { notice: string | null; onPaired: (c: Credential) => void }) {
  const theme = useTheme()
  const [step, setStep] = useState<Step>({ kind: 'start' })
  const [permission, requestPermission] = useCameraPermissions()
  const session = useRef<PairSession | null>(null)
  const scanned = useRef(false)

  useEffect(() => () => session.current?.cancel(), [])

  async function begin(offer: PairOffer) {
    setStep({ kind: 'contacting' })
    try {
      const keys = await loadOrCreateKeys()
      const s = await transport.pair(offer, keys, Device.deviceName ?? Device.modelName ?? 'Phone')
      session.current = s
      setStep({ kind: 'waiting', code: s.code })
      onPaired(await s.approved)
    } catch (e) {
      const code = e instanceof PairError ? e.code : 'network'
      setStep({ kind: 'error', message: t(`pairing.error.${code}`) })
    } finally {
      session.current = null
    }
  }

  function onScan(data: string) {
    if (scanned.current) return
    const offer = parseOffer(data)
    if (!offer) return setStep({ kind: 'error', message: t('pairing.notNavideCode') })
    scanned.current = true
    void begin(offer)
  }

  function startScan() {
    scanned.current = false
    setStep({ kind: 'scan' })
  }

  const s = styles(theme)

  if (step.kind === 'scan') {
    if (!permission?.granted) {
      return (
        <View style={s.center}>
          <Text style={s.body}>{t('pairing.cameraNeeded')}</Text>
          <Button label={t('pairing.allowCamera')} onPress={() => void requestPermission()} />
          <Button label={t('pairing.cancel')} quiet onPress={() => setStep({ kind: 'start' })} />
        </View>
      )
    }
    return (
      <View style={{ flex: 1 }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScan(data)}
        />
        <View style={s.footer}>
          <Button label={t('pairing.cancel')} quiet onPress={() => setStep({ kind: 'start' })} />
        </View>
      </View>
    )
  }

  return (
    <View style={s.center}>
      {step.kind === 'start' && (
        <>
          <Text style={s.title}>{t('pairing.title')}</Text>
          {notice && <Text style={[s.body, { color: theme.danger }]}>{notice}</Text>}
          <Text style={s.body}>{t('pairing.intro')}</Text>
          <Button label={t('pairing.scan')} onPress={startScan} />
          {isMock && <Button label={t('pairing.demo')} quiet onPress={() => void begin(MOCK_OFFER)} />}
        </>
      )}
      {step.kind === 'contacting' && (
        <>
          <ActivityIndicator color={theme.accent} />
          <Text style={s.body}>{t('pairing.connecting')}</Text>
        </>
      )}
      {step.kind === 'waiting' && (
        <>
          <Text style={s.title}>{t('pairing.waitingTitle')}</Text>
          <Text style={s.code} accessibilityLabel={step.code.split('').join(' ')}>
            {step.code.slice(0, 3)} {step.code.slice(3)}
          </Text>
          <Text style={s.body}>{t('pairing.waitingBody')}</Text>
          <ActivityIndicator color={theme.accent} />
          <Button
            label={t('pairing.cancel')}
            quiet
            onPress={() => {
              session.current?.cancel()
              setStep({ kind: 'start' })
            }}
          />
        </>
      )}
      {step.kind === 'error' && (
        <>
          <Text style={[s.body, { color: theme.danger }]}>{step.message}</Text>
          <Button label={t('pairing.tryAgain')} onPress={() => setStep({ kind: 'start' })} />
        </>
      )}
    </View>
  )
}

function Button({ label, onPress, quiet }: { label: string; onPress: () => void; quiet?: boolean }) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 14,
          paddingHorizontal: 22,
          borderRadius: 12,
          alignSelf: 'stretch',
          alignItems: 'center',
          backgroundColor: quiet ? 'transparent' : theme.accent,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text style={{ color: quiet ? theme.accent : '#fff', fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  )
}

const styles = (theme: ReturnType<typeof useTheme>) =>
  StyleSheet.create({
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 18 },
    title: { fontSize: 24, fontWeight: '700', color: theme.text, textAlign: 'center' },
    body: { fontSize: 16, lineHeight: 23, color: theme.muted, textAlign: 'center' },
    code: { fontSize: 44, fontWeight: '700', letterSpacing: 6, color: theme.text, fontVariant: ['tabular-nums'] },
    footer: { position: 'absolute', bottom: 40, left: 28, right: 28 },
  })

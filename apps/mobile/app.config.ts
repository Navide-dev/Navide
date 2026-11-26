import type { ExpoConfig } from 'expo/config'

// Provisional identifiers: the store name is confirmed before any public
// listing.
const config: ExpoConfig = {
  name: 'Navide',
  slug: 'navide-mobile',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'navide',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'dev.navide.mobile',
    supportsTablet: true,
  },
  android: {
    package: 'dev.navide.mobile',
  },
  plugins: [
    [
      'expo-camera',
      {
        cameraPermission: 'Navide uses the camera to scan the pairing code shown on your computer.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    'expo-secure-store',
  ],
}

export default config

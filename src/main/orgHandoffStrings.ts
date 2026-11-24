import { hostStrings, type HostStringTable } from './hostLocale'

// The notice shown when opening the organization site from the app fails —
// most often from navide://org/login, where no window may be open to say so.
export interface OrgHandoffStrings {
  title: string
  body: string
}

export const ORG_HANDOFF_STRINGS: HostStringTable<OrgHandoffStrings> = {
  'en-US': { title: 'Could not open the organization site', body: 'Make sure this machine is signed in to Navide Cloud, then try again.' },
  'zh-TW': { title: '無法開啟組織網站', body: '請確認這台機器已登入 Navide Cloud，再試一次。' },
  'zh-CN': { title: '无法打开组织网站', body: '请确认这台机器已登录 Navide Cloud，再试一次。' },
  'ja-JP': { title: '組織サイトを開けませんでした', body: 'このマシンが Navide Cloud にサインインしていることを確認して、もう一度お試しください。' },
  'ko-KR': { title: '조직 사이트를 열 수 없습니다', body: '이 기기가 Navide Cloud에 로그인되어 있는지 확인한 뒤 다시 시도하세요.' },
  'de-DE': { title: 'Die Organisationsseite konnte nicht geöffnet werden', body: 'Prüfe, ob dieser Rechner bei Navide Cloud angemeldet ist, und versuche es erneut.' },
  'fr-FR': { title: 'Impossible d’ouvrir le site de l’organisation', body: 'Vérifiez que cette machine est connectée à Navide Cloud, puis réessayez.' },
  'es-ES': { title: 'No se pudo abrir el sitio de la organización', body: 'Comprueba que esta máquina haya iniciado sesión en Navide Cloud y vuelve a intentarlo.' },
  'pt-BR': { title: 'Não foi possível abrir o site da organização', body: 'Confira se esta máquina está conectada ao Navide Cloud e tente de novo.' },
  'ru-RU': { title: 'Не удалось открыть сайт организации', body: 'Убедитесь, что эта машина вошла в Navide Cloud, и попробуйте ещё раз.' },
  'vi-VN': { title: 'Không mở được trang tổ chức', body: 'Hãy kiểm tra máy này đã đăng nhập Navide Cloud rồi thử lại.' },
}

export function orgHandoffStrings(locale: string): OrgHandoffStrings {
  return hostStrings(ORG_HANDOFF_STRINGS, locale)
}

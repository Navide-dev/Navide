import type { AppLockScreenStrings } from '../shared/appLock'
import { hostStrings, type HostStringTable } from './hostLocale'

// The lock screen is a bare page with no vue-i18n (it must load fast and on
// its own), so its few strings live in main like the menu's. `{system}` is
// Touch ID or Windows Hello, a product name never translated. `systemReason`
// completes macOS's "Navide is trying to …" line in the Touch ID dialog and
// is the message line of the Windows Hello one.
export interface AppLockHostStrings {
  screen: AppLockScreenStrings
  systemReason: string
}

export const APP_LOCK_STRINGS: HostStringTable<AppLockHostStrings> = {
  'en-US': {
    screen: {
      title: 'Navide is locked',
      subtitle: 'Agents, terminals and schedules keep running.',
      pinLabel: 'PIN',
      unlock: 'Unlock',
      unlockWithSystem: 'Unlock with {system}',
      wrongPin: 'Wrong PIN.',
      cooldown: 'Too many attempts. Try again in {seconds} s.',
      systemFailed: '{system} did not unlock Navide. Use your PIN.',
      forgotPin: 'Forgot your PIN? Unlock with {system}, then set a new one in Settings > App Lock.',
    },
    systemReason: 'unlock Navide',
  },
  'zh-TW': {
    screen: {
      title: 'Navide 已鎖定',
      subtitle: 'agent、終端機與排程都會繼續執行。',
      pinLabel: 'PIN',
      unlock: '解鎖',
      unlockWithSystem: '用 {system} 解鎖',
      wrongPin: 'PIN 不正確。',
      cooldown: '嘗試次數過多，請在 {seconds} 秒後再試。',
      systemFailed: '{system} 未能解鎖 Navide，請改用 PIN。',
      forgotPin: '忘記 PIN？先用 {system} 解鎖，再到「設定 > App Lock」設定新的 PIN。',
    },
    systemReason: '解鎖 Navide',
  },
  'ja-JP': {
    screen: {
      title: 'Navide はロックされています',
      subtitle: 'エージェント、ターミナル、スケジュールは動作を続けます。',
      pinLabel: 'PIN',
      unlock: 'ロック解除',
      unlockWithSystem: '{system} でロック解除',
      wrongPin: 'PIN が違います。',
      cooldown: '試行回数が多すぎます。{seconds} 秒後にもう一度お試しください。',
      systemFailed: '{system} でロックを解除できませんでした。PIN を使ってください。',
      forgotPin: 'PIN を忘れた場合は、{system} でロックを解除してから「設定 > App Lock」で新しい PIN を設定してください。',
    },
    systemReason: 'Navide のロックを解除',
  },
  'zh-CN': {
    screen: {
      title: 'Navide 已锁定',
      subtitle: 'agent、终端和调度都会继续运行。',
      pinLabel: 'PIN',
      unlock: '解锁',
      unlockWithSystem: '用 {system} 解锁',
      wrongPin: 'PIN 不正确。',
      cooldown: '尝试次数过多，请在 {seconds} 秒后重试。',
      systemFailed: '{system} 未能解锁 Navide，请改用 PIN。',
      forgotPin: '忘记 PIN？先用 {system} 解锁，再到“设置 > App Lock”设置新的 PIN。',
    },
    systemReason: '解锁 Navide',
  },
  'ko-KR': {
    screen: {
      title: 'Navide가 잠겼습니다',
      subtitle: '에이전트, 터미널, 일정은 계속 실행됩니다.',
      pinLabel: 'PIN',
      unlock: '잠금 해제',
      unlockWithSystem: '{system}로 잠금 해제',
      wrongPin: 'PIN이 올바르지 않습니다.',
      cooldown: '시도 횟수가 너무 많습니다. {seconds}초 후에 다시 시도하세요.',
      systemFailed: '{system}로 Navide 잠금을 해제하지 못했습니다. PIN을 사용하세요.',
      forgotPin: 'PIN을 잊으셨나요? {system}로 잠금을 해제한 뒤 설정 > App Lock에서 새 PIN을 설정하세요.',
    },
    systemReason: 'Navide 잠금 해제',
  },
  'es-ES': {
    screen: {
      title: 'Navide está bloqueado',
      subtitle: 'Los agentes, los terminales y las programaciones siguen en marcha.',
      pinLabel: 'PIN',
      unlock: 'Desbloquear',
      unlockWithSystem: 'Desbloquear con {system}',
      wrongPin: 'PIN incorrecto.',
      cooldown: 'Demasiados intentos. Vuelve a intentarlo en {seconds} s.',
      systemFailed: '{system} no ha desbloqueado Navide. Usa tu PIN.',
      forgotPin: '¿Has olvidado el PIN? Desbloquea con {system} y define uno nuevo en Ajustes > App Lock.',
    },
    systemReason: 'desbloquear Navide',
  },
  'fr-FR': {
    screen: {
      title: 'Navide est verrouillé',
      subtitle: 'Les agents, les terminaux et les planifications continuent de tourner.',
      pinLabel: 'PIN',
      unlock: 'Déverrouiller',
      unlockWithSystem: 'Déverrouiller avec {system}',
      wrongPin: 'PIN incorrect.',
      cooldown: 'Trop de tentatives. Réessayez dans {seconds} s.',
      systemFailed: '{system} n’a pas déverrouillé Navide. Utilisez votre PIN.',
      forgotPin: 'PIN oublié\u00a0? Déverrouillez avec {system}, puis définissez-en un nouveau dans Réglages > App Lock.',
    },
    systemReason: 'déverrouiller Navide',
  },
  'de-DE': {
    screen: {
      title: 'Navide ist gesperrt',
      subtitle: 'Agents, Terminals und Zeitpläne laufen weiter.',
      pinLabel: 'PIN',
      unlock: 'Entsperren',
      unlockWithSystem: 'Mit {system} entsperren',
      wrongPin: 'Falsche PIN.',
      cooldown: 'Zu viele Versuche. Versuchen Sie es in {seconds} s erneut.',
      systemFailed: '{system} hat Navide nicht entsperrt. Verwenden Sie Ihre PIN.',
      forgotPin: 'PIN vergessen? Mit {system} entsperren und dann unter Einstellungen > App Lock eine neue festlegen.',
    },
    systemReason: 'Navide entsperren',
  },
  'pt-BR': {
    screen: {
      title: 'O Navide está bloqueado',
      subtitle: 'Agentes, terminais e agendamentos continuam em execução.',
      pinLabel: 'PIN',
      unlock: 'Desbloquear',
      unlockWithSystem: 'Desbloquear com {system}',
      wrongPin: 'PIN incorreto.',
      cooldown: 'Tentativas demais. Tente novamente em {seconds} s.',
      systemFailed: 'O {system} não desbloqueou o Navide. Use seu PIN.',
      forgotPin: 'Esqueceu o PIN? Desbloqueie com o {system} e defina um novo em Configurações > App Lock.',
    },
    systemReason: 'desbloquear o Navide',
  },
  'ru-RU': {
    screen: {
      title: 'Navide заблокирован',
      subtitle: 'Агенты, терминалы и расписания продолжают работать.',
      pinLabel: 'PIN',
      unlock: 'Разблокировать',
      unlockWithSystem: 'Разблокировать с {system}',
      wrongPin: 'Неверный PIN.',
      cooldown: 'Слишком много попыток. Повторите через {seconds} с.',
      systemFailed: '{system} не разблокировал Navide. Используйте PIN.',
      forgotPin: 'Забыли PIN? Разблокируйте с {system}, затем задайте новый в разделе Настройки > App Lock.',
    },
    systemReason: 'разблокировать Navide',
  },
  'vi-VN': {
    screen: {
      title: 'Navide đang bị khóa',
      subtitle: 'Agent, terminal và lịch chạy vẫn tiếp tục hoạt động.',
      pinLabel: 'PIN',
      unlock: 'Mở khóa',
      unlockWithSystem: 'Mở khóa bằng {system}',
      wrongPin: 'PIN không đúng.',
      cooldown: 'Quá nhiều lần thử. Hãy thử lại sau {seconds} giây.',
      systemFailed: '{system} không mở khóa được Navide. Hãy dùng PIN.',
      forgotPin: 'Quên PIN? Hãy mở khóa bằng {system} rồi đặt PIN mới trong Cài đặt > App Lock.',
    },
    systemReason: 'mở khóa Navide',
  },
}

export function appLockStrings(locale: string, system: string): AppLockHostStrings {
  const strings = hostStrings(APP_LOCK_STRINGS, locale)
  const screen = Object.fromEntries(
    Object.entries(strings.screen).map(([key, text]) => [key, text.replaceAll('{system}', system)]),
  ) as unknown as AppLockScreenStrings
  return { ...strings, screen }
}

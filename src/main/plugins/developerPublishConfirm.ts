// 0.2.43 #2b: the one step that grants publishing rights when the Marketplace
// developer sign-in reuses the Navide Cloud account. It is a native dialog
// shown by the main process, so no renderer page and no agent tool (ui_invoke
// included) can press it; the Registry still checks the account is an approved
// developer and a member of the namespace.
import type { MessageBoxOptions } from 'electron'
import { hostStrings, type HostStringTable } from '../hostLocale'
import type { PublishConfirmRequest } from './developerAccount'

interface PublishConfirmStrings {
  message: string
  detail: string
  grant: string
  cancel: string
}

export const PUBLISH_CONFIRM_STRINGS: HostStringTable<PublishConfirmStrings> = {
  'en-US': {
    message: 'Allow this Navide to publish plugins as you?',
    detail: 'Navide Cloud account: {account}\n\nNavide will be able to sign and upload plugin versions to the Navide Marketplace under the namespace you choose. The Marketplace still checks that you are an approved developer of that namespace. You can sign out under Settings > Navide Marketplace > Developer at any time.',
    grant: 'Allow as {namespace}',
    cancel: 'Cancel',
  },
  'zh-TW': {
    message: '允許這台 Navide 以你的身分發佈外掛？',
    detail: 'Navide Cloud 帳號：{account}\n\nNavide 將能以你選的 namespace，簽署並上傳外掛版本到 Navide Marketplace。Marketplace 仍會確認你是該 namespace 的已核准開發者。隨時可在「設定 > Navide Marketplace > 開發者」登出。',
    grant: '以 {namespace} 允許',
    cancel: '取消',
  },
  'ja-JP': {
    message: 'この Navide があなたとしてプラグインを公開することを許可しますか？',
    detail: 'Navide Cloud アカウント：{account}\n\n選択した namespace で、Navide がプラグインのバージョンに署名して Navide Marketplace にアップロードできるようになります。Marketplace は引き続き、その namespace の承認済み開発者であることを確認します。「設定 > Navide Marketplace > 開発者」でいつでもサインアウトできます。',
    grant: '{namespace} として許可',
    cancel: 'キャンセル',
  },
}

/** The dialog for `request`, and the namespace a pressed button grants (null: cancelled). */
export function publishConfirmDialog(
  request: PublishConfirmRequest,
  locale: string,
): { options: MessageBoxOptions; namespaceFor: (response: number) => string | null } {
  const strings = hostStrings(PUBLISH_CONFIRM_STRINGS, locale)
  const account = request.accountName ? `${request.accountName} (${request.memberId})` : request.memberId
  const buttons = [...request.namespaces.map((namespace) => strings.grant.replace('{namespace}', namespace)), strings.cancel]
  const cancelId = buttons.length - 1
  return {
    options: {
      type: 'question',
      title: 'Navide',
      message: strings.message,
      detail: strings.detail.replace('{account}', account),
      buttons,
      // Cancel is the default and the Escape answer: granting takes a deliberate press.
      defaultId: cancelId,
      cancelId,
      noLink: true,
    },
    namespaceFor: (response) => (response >= 0 && response < cancelId ? request.namespaces[response] : null),
  }
}

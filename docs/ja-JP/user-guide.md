# ユーザーガイド

[English](../en-US/user-guide.md) | [繁體中文](../zh-TW/user-guide.md) | 日本語 | [ドキュメント](README.md)

## プロダクトモデル

Navide は、一人のエンジニアが複数の AI Agent を指揮するために設計されています。主な操作は常に File Editing とは限りません。Outcome の設定、Session の協調、Progress の観察、意味ある Exception の処理、検証済み Result の受け入れです。

日々の作業は三つの Loop を通じて進みます。

1. **Genesis** は Pipeline を使い、Idea を最初に動く Prototype へ変えます。
2. **Evolution** は一つ以上の Agent Session を通じて既存 Project を反復的に開発、Test、Fix、Refine します。
3. **Intervention** は Diff、Editor、Terminal、Diagnostics、Git、Review Tool を通じて、エンジニアが Result を確認または直接変更できるようにします。

現在の Pipeline は Genesis Loop を実装しています。Manual Pane と Maintenance Mode は初期 Evolution Workflow を提供し、Editor と Review Surface は Intervention を提供します。

## Runtime の考え方

Navide には三つの Work Level があります。

1. **Workspace** は Project Folder であり、Project State、Run History、Git Operation の境界です。
2. **Pane** は Agent CLI または Plain Shell を実行する Live Terminal Session です。
3. **Pipeline** は設定可能な Stage の順序付き集合です。各 Stage は一つ以上の Parallel Slot を持ち、各 Slot が Agent と Role を選びます。

## Workspace

Welcome Screen は Recent Workspace を一覧表示し、Pinning をサポートし、存在しない Folder を示します。Workspace を開くと UI State と対象 Session が復元されます。Workspace を切り替える、または閉じる前に、中断してはならない Active Work を完了または Abort してください。

Navide は Workspace 内の `.agent-team/` に、ユーザーごとに非公開の Project Intelligence を保存します。この Directory は Git から除外され、共有 Team State として扱ってはなりません。個々のエンジニアの Local Workflow に属する Task Context、Session Metadata、Run History、Handoff、Token Information が含まれる場合があります。

Source Code と明示的に共有された Documentation は、Repository における Team-visible Truth であり続けます。`.agent-team/` の情報を共有する必要がある場合は、Specification、Architecture Decision、Test Report、Issue、Commit、Pull Request など、意図的な Artifact に変換してください。

## Manual Agent Pane

完全な Genesis Pipeline が不要な Exploration、Maintenance、Evolution Task では Manual Spawn を使います。

- Agent と Role を選択します。
- Spawn 前に Launch Command を確認します。
- Agent が不要な場合は Plain Terminal Pane を使います。
- Main Layout を占有せず PTY を維持するには Pane を Minimize します。
- Navide が再利用可能な Session ID を検出した後にのみ Rebuild または Resume します。

Auto、Spotlight、Fullscreen Layout では、更新の右にある三角形ボタン（ツールバーの順序：**+ → 更新 → ▾/▸**）で現在のタブの子孫カードをグループごとに一括で折りたたみ・展開できます。親カードの枠付き子孫数の横にある三角形と同じ動作です。対象グループが一つでも開いていればすべて折りたたみ、すべて閉じていれば、個別に閉じた入れ子のグループも含めてすべて展開します。対象は子孫を持つ、最小化されていない親 Pane です。

折りたたむと子孫カードが非表示になり、最上位の親カード、子孫数、メイン Terminal は表示されたままです。タブごとのグループ状態は独立しており、現在のウィンドウのメモリ内だけに保持されます。Grid Layout または対象の親グループがないタブでは、一括操作ボタンは無効です。

A new empty Codex pane waits for your input without sending an artificial session-discovery message. Its session ID may become available only after the first real user or configured task turn; until then, Rebuild remains unavailable. The same applies to a fresh rebuild or restore. If Codex asks to review the Navide session hook, review it in Codex; YOLO mode does not approve hooks. Existing shared session homes may need that trusted hook to associate the new conversation with its pane.

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

組み込みで対応する Agent Key は 14 種類のコーディング CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）です。正確な CLI Behavior と Provider Billing は各 External Tool が引き続き管理します。

### CLI risk observations

An active agent pane can show one yellow or red risk pill. Open its popover to inspect the backend's evidence and observation times; multiple findings share that popover. Disk findings apply to the vendor's active panes, while network findings belong to the observed pane's process tree, including its CLI, MCP servers and tools. Reclaimed placeholders show no risk pill.

- **Yellow network:** a sampled numeric IP and port fall outside a complete, current expected-address snapshot. The count is from the last sample, and “observed since” describes sampled observations, not connection duration. Legitimate tools, proxies and different DNS answers can produce a mismatch.
- **Yellow disk:** after a successful baseline, a file first observed following prior absence qualifies within 24 hours if it exceeds 100 MiB and bounded content inspection does not recognize its format. Files already in the baseline are excluded; timestamps and familiar extensions alone do not establish that a file is new or recognized.
- **Red disk:** a previously flagged path was successfully observed present, then absent, then present again with opaque content in the same 100 MiB size class. This does not identify who removed or recreated it, or establish that its contents are the same.

**Ignore** persists for the displayed vendor/IP across all ports, or vendor/canonical file path, including later severity changes. **Allow this IP** adds only the displayed exact IP for that vendor across all ports; it does not allow an inferred hostname or certify the destination. Both decisions apply across that vendor's panes and survive restart. Disk **Reveal in folder** opens the existing native folder action so you can inspect the file.

Observations use existing resource requests: normally every 30 seconds, or every 2 seconds while the resource panel is open. Disk attempts, including failed attempts, are throttled to once per five minutes per active vendor. Work finishes in the backend and appears in a later response; opening Storage is unnecessary. Descendant discovery and polling can delay network evidence, and short-lived connections or file replacement between samples can be missed.

Default network declarations currently cover Claude Code and Codex; other vendors have no expected-address comparison. Captured proxy or provider-endpoint overrides disable that comparison. Network observation covers established TCP on macOS and Linux; Windows network observation and UDP/QUIC are unsupported. Disk roots are declared per vendor, with Aider unsupported; symlinks beneath a resolved data root are skipped. Roots use the captured pane home and declared environment overrides; later changes inside CLI settings, command arguments or shell startup scripts can fall outside that snapshot. Failed or incomplete collection, unavailable declarations and expired DNS must not be read as a clean result. Historical findings can remain visible as stale evidence. **No pill is not an assurance of safety.**

These observations help you inspect local activity; they do not prove exfiltration or unlawful intent. Navide does not automatically block a connection, pause a CLI or delete a file. See [Privacy and Data Flows](privacy.md#cli-risk-observation-data) for local reads, retained metadata and DNS requests.

## Pipeline

付属 Pipeline は Requirement、Planning、Design、Implementation、Security Review、Testing を網羅します。Stage、Slot、Role、Kickoff Prompt、Question、Completion Sentinel は**パイプライン管理**で編集します（Window ▸ パイプライン管理、またはサイドバーの Pipeline タブにある **パイプラインを管理** ボタン）。**スイムレーン**と**キャンバス**の表示は同じ Pipeline をステップのグラフとして編集し、**実行履歴**は実行とその操作ボタンを表示します。Pipeline はワークスペースではなく、このコンピューターの Navide の設定に保存されます。別のコンピューターへ移すには、設定の**設定一式をエクスポート**を使います。

### 実行を始める

実行は、サイドバー（タスクを入力して **▶ パイプラインを実行**）、エディターのツールバー（**この実行のタスク** を入力して **▶ パイプラインを実行**）、コマンド、スケジュール、または MCP ツール `pipeline_start` を使う CLI から始められます。エディターから始めると、編集中のパイプラインを既定のパイプラインに変えずに実行します。ボタンが無効なときは、ツールチップに理由が表示されます（タスクがない、ワークスペースが開いていない、ステップがない、バックエンドに接続していない）。一つのワークスペースで同時に動く実行は一つだけです。実行中にもう一度始めようとすると、「この workspace ではすでに pipeline が実行中です。先に中止してください。」と表示されて拒否されます。

- **中止**は実行を一時停止します。Navide は実行を進めるのをやめますが、ペインは開いたまま残り、あとから再開できます。サイドバーやエディターから中止するときは確認（「この実行を中止しますか？」）があります。
- **実行履歴**とステップの Inspector にある**復旧**メニューには、続け方が説明付きで並びます。**再開**は止まった実行を最初の未完了のステージから、ペインとコンテキストを保ったまま続けます。**最初からやり直す**はこの実行のペインを閉じ、同じタスクを最初のステージから実行し直します。**リセット**は実行を消去し、このウィンドウのすべてのペインを閉じます。自分で開いたペインも含みます。ステップの Inspector には、さらに**このステップをリトライ**と**ここから再実行**があります。復旧は常にそのパイプラインの最新の実行に対して行われます。以前の実行を表示している間はメニューが無効になり、**最新の実行を表示**で戻れます。サイドバーのバナーにも**再開**があります。
- **リセット**の前には確認があり、閉じるペインの名前と、「この実行以外で開いたもの」の印が表示されます。

実行や編集が拒否されたときは、理由が UI の言語で表示されます（例：「このパイプラインは実行中のため、今は変更できません。先に中止するか、実行の終了を待ってください。」）。**詳細**にはバックエンドの元のメッセージが表示されます。ステップが失敗した理由は、そのステップの**出力**タブと**実行履歴**の上部に表示されます。

### ステップ、接続、分岐

- **承認ゲート（Gate）。** パレットから追加すると、二つのステップの間で実行を一時停止します。**確認する内容**には、確認者が何を見るべきかを書きます。実行が待っている間、エディターには**確認する**付きのバナーが表示され、ゲートでは**承認して続行**または**差し戻す**を選べ、エージェントへのメモを添えられます。サイドバーの Next ではゲートを越えられません。
- **差し戻しループ（Loop）。** キャンバス表示で、ステップの下側のハンドルから上流のステップへドラッグします。**差し戻す**を押すと、そのステップから作業がやり直され、メモがその Kickoff の前に置かれます。ループは **↺ 最大** ピルに表示された回数（既定 2、上限 10）まで実行されます。ゲートにループがないとき、またはループを使い切ったときは、実行が失敗として終わるため、**差し戻す**の前に確認（「実行を終了しますか？」）があります。ペインは残ります。
- **分岐とエラーの接続。** ステップの Inspector の**接続先**に、そのステップの接続が並びます。**接続の種類**と**接続先のステップ**を選んで**接続を追加**を押します。キャンバスでステップから別のステップへ接続を引いて選ぶこともできます。接続の種類は **常に**（既定）、**分岐（条件）**、**失敗時** です。分岐の接続は、ステップが報告した値が**分岐の値**と一致したときだけ実行されます。ステップのエージェントは Kickoff に書かれたシグナル行（`---BRANCH:…: <値>---`）で値を報告し、大文字と小文字は区別しません。値が `default` の分岐は、そのステップの他の分岐がどれも一致しなかったときに実行されます。エラーの接続は、リトライしてもステップが失敗したとき（エージェントが `---NODE-FAILED---` を報告した、またはタスクが届かなかったとき）だけ実行され、実行は止まらずにその接続の先へ続きます。一つのステップから二本引けば分岐、一つのステップへ二本引けば合流になります。
- **失敗時にリトライ。** ステップの Inspector の**失敗時にリトライ**で、失敗した試行（タスクがエージェントに届かなかった、またはエージェントが失敗を報告した）を同じステップでやり直します。試行は合計 5 回まで、各リトライの前に最大 300 秒待てます。実行が止まった後は、**このステップをリトライ**で失敗したステップをもう一度実行できます。実行はそのステップから再開し、後続のステップがすでに実行済みなら、そのステップから実行し直します。
- **サブ Pipeline。** パレットの**フロー制御**から追加し、**実行する Pipeline** を選びます。実行はそこで一時停止し、同じワークスペースでそのパイプラインを実行して、その結果を持って続きます。その間、この実行のペインは開いたままです。**その実行のタスク**は省略でき、空ならこの実行のタスクを使います。サブ Pipeline の入れ子は 3 段までで、自分自身を呼ぶことになる設定は拒否されます。
- **出力を固定（Pin）。** Inspector で固定したステップは、以降の実行でスキップされ、前回の出力が再利用されます。
- **ここから再実行（Restart from）。** ステップの Inspector で、その Pipeline に停止済みの実行があるとき、そのステップから新しい実行を始め、それ以前のステップの出力を保持します — すべてをやり直す**最初からやり直す**より安く済みます。

パイプライン管理で自分が作ったパイプラインのステップをリセット（⋯ ▸ **既定に戻す**）するときは、確認があります。ゲート、ループ、分岐が描かれているパイプラインでは、それらも削除されて元に戻せないことが確認に表示されます。

### インポートとスケジュール

- パイプライン管理の **n8n からインポート**（パイプライン一覧、または各パイプラインの ⋯ メニュー）は、n8n のワークフローを新しいパイプラインに変換します。書き込む前に、すべてのステップをプレビューで確認できます。[n8n からインポート](import-from-n8n.md)を参照してください。
- **実行をスケジュールする。** **ターン統計 ▸ スケジュール**で **＋ 新規**を押し、**アクション**を **Pipeline を開始** にして、ワークスペース、パイプライン、タスクを選びます。存在しないパイプラインは保存時に拒否されます。実行のたびにそのパイプラインの CLI ペインが開き、利用枠を消費します。ウィンドウは開かないため、どのウィンドウもワークスペースを開いていないときの実行は失敗し、その理由が表示されます。失敗したジョブには理由と**修復**ボタンが表示されますが、ワークスペースが開いていないままなら、修復しても再実行はされません。

### 組み込みのパイプライン

組み込みのパイプラインは、名前を変えるまで UI の言語の名前で表示されます。3 つ目の組み込み **提案反映パイプライン**（id `evolve-landing`）は、承認された自己最適化の提案を、あなたか指揮役の pane が作業として割り当てた後にたどる経路です。実装 → 読み取り専用のレビュー → CI チェック（workflow run の各 job の結果を報告するだけで、rerun もマージもしない）→ あなただけが通せる承認 gate の順に進みます。これはテンプレートで、自動では開始されず、使用中の pipeline にもならず、マージ、公開、プラグインの読み込み、skill の配信、スケジュール作成の手順はありません。Navide は既存の pipeline 一覧にこれを一度だけ追加し、削除した場合は再追加しません。**リセット**で手順と gate を元に戻せます。

一つの Stage で複数 Slot を並行実行できます。Navide は設定された Completion Signal と Agent State に基づいて進行します。Generated Change と Test Result は必ず確認してください。Automatic Completion は Workflow Progress を示すもので、Correctness を保証しません。

## Manager と Worker の協調

一つの Slot を Global Manager として動かせます。Manager は Stage 間 Context を受け取り、Worker に作業を Delegation し、Worker Question を処理し、Navide の Routing Protocol を通じて Stage Completion を Signal します。

Task が Decomposition または Parallel Ownership の恩恵を受ける場合に Manager を使います。小さな Task では、Single-agent Stage の方が通常は低コストで確認しやすくなります。

## Automation Mode

- **YOLO** は対応 CLI で Approval または Trust Prompt を回避する CLI-specific Flag を渡します。一部 CLI は Confirmation Gate なしですでに Tool を実行する場合があります。
- **Full Auto** は利用可能な Task Context を使い、Analyzer が Agent Question に回答できるようにします。
- **Strict** は選択された Timeout または Progression Boundary で確認を求めます。
- **Continuous** は設定された Automation Behavior に従って Pipeline を進行させます。
- **Local Analyzer** は Local Intent Classification と関連 Automation を有効化します。

保守的な設定から始めてください。YOLO と Full Auto は、追加の User Confirmation なしに Agent が File を変更したり Command を実行したりする可能性があります。

## Management by Exception

Navide の長期的な運用哲学は、可逆的で観察可能な作業を Agent に継続させ、人間の判断に価値があるときだけエンジニアへ注意を戻すことです。現在の Automation Mode は初期 Control であり、完全な Policy Engine ではありません。

次の場合に介入してください。

- Requirement に大きく異なる複数の有効な解釈がある
- Architecture または Product Choice が長期的な影響を持つ
- Session が Ownership、File、Technical Direction をめぐって Conflict している
- Test と明示された Acceptance Criteria が一致しない
- Credential、Payment、Deployment、Publication、Destructive Operation、External System が関係する
- Result に Subjective Product Judgment または Quality Judgment が必要

Routine Exploration、Reversible Edit、Local Test、Diagnostic、Repair は、可視性と中断可能性を保ちながら、最終的には Approval Noise なしで進むべきです。

## History と Token Tracking

History は Pipeline、Stage、Pane、Question、Analyzer、Handoff、Warning Event の Append-only Timeline です。Run History は `.agent-team/runs/` に保存され、Filter または Export できます。

Token Stats は対応 Local CLI Log を Parse し、Usage を Workspace、Pane、Stage、Run に Attribution します。Observability Feature であり、Provider Invoice ではありません。Provider 側の Usage と Billing が正式な情報です。

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

## Git と Review

Marketplace Install が利用可能になるまで、Navide は削除可能な Official Git Factory Package を提供します。Active Package Version は Embedded Left View と Dedicated Git Window の両方を提供します。Extensions で Bundled Git を削除すると再起動後も削除状態が維持され、同じ画面の **Restore** で Factory Copy を復元できます。Verified Marketplace Version が存在する場合はそちらが優先されます。Git View は Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue、関連 Workflow をサポートし、Multi-repository Workspace では検出された Repository を切り替えられます。Repository Operation は Navide の Host／Backend Boundary 内に留まり、GitHub／GitLab Issue Detection は利用可能な場合に設定済みの `gh` または `glab` CLI を使用します。選択された v2 Package が Load、Mount、または Ready Report に失敗した場合、その Process では Retained Legacy Git Renderer を明示して使用します。Security／Trust／Permission Denial は Fallback を Trigger しません。

Extensions の **.vsix ファイルからインストール…** で、自分で選んだ Navide プラグインのパッケージファイルをインストールできます。このパッケージは Navide の審査を受けておらず署名もないため、作成者を確認できません。ダイアログはそのことを明記し、公開元を「自称」、スキャンを「未スキャン」と表示し、リスクを理解したことを確認するまで同意できません。ファイルからインストールした Navide プラグインは自動更新されません。承認した内容はすぐに有効になり、**再起動**も Navide の再起動も不要です。初回インストールは承認した時点で有効になり、承認した更新（および agent が開始した、現在のバージョンと開示内容がまったく同じ自動更新）はすぐに切り替わります。承認の前にダイアログで、そのプラグインの開いている画面が再読み込みされること、Navide SDK で状態を保存している画面は元の状態に戻り、それ以外の保存していない内容は失われることを説明します。切り替える直前に、Navide は新しいバージョンの画面が起動できるかをもう一度確認し、できなければ実行中のバージョンをそのまま動かします。切り替え中、プラグインのパネルは空白にならず、切り替え中であることを表示します。切り替えはすべてお知らせに記録され、前のバージョンに**戻す**ボタンが付きます。ファイルから更新した場合は置き換えたファイルのバージョンを保持し、そこへ戻すには改めて同意が必要です。切り替えに失敗した場合は元のバージョンのまま動作し、更新は保留されたままになります。あなたが承認した更新の場合は「設定 → Navide プラグイン」にすぐ理由が表示され、**再起動**と**破棄**が残り、次回 Navide を起動したときにお知らせに**今すぐ適用**付きで表示されます。agent が開始した自動更新の場合は、理由と**今すぐ適用**を示す行がすぐにお知らせに表示されます。同じ id のインストール済み Navide プラグインを置き換えるときは（どちらの方向でも）先に確認され、置き換え後は以前の権限、ネイティブバックエンドの同意、ファイル変更を許可したワークスペース、agent ツールの許可を引き継ぎません。提供元が変わるときは、保存データ（ネイティブバックエンドのデータとビューのストレージ）は新しい版に渡さず別に保管され、Navide マーケットプレイス版に戻すときに戻すかどうかを確認します（既定では戻しません）。行の **Navide マーケットプレイス版に戻す** で元に戻せます。**開発者モード**は既定でオフです。オンにすると、開発中の Navide プラグインをフォルダーから読み込めます。Navide の中ではこの画面でのみ切り替えられ、ここでの変更はすべて記録されます。この設定ファイルはあなたの権限で動くほかのプログラム（agent CLI を含む）も変更できます（Navide Guard は agent によるこのファイルへの書き込みを critical と判定します）が、Navide は自分で書き込んだ項目ごとに署名を保存します。Navide が書き込んでいない項目は適用されません。スイッチはオフのまま、フォルダーは読み込まれず、一覧上の注意と起動時の通知でそのことが示され、アクティビティログにも記録されます。この画面でスイッチをもう一度オンにするか、そのフォルダーにもう一度同意するまで有効になりません。0.2.28 より前からアップグレードした場合や署名ファイルがない場合も同じで、スイッチをもう一度オンにし、フォルダーごとにもう一度同意します。制限は plugin-development-v2.md を参照してください。オンの間は一覧の上に常に注意が表示され、起動のたびにも通知されます。フォルダーは権限またはバックエンドの宣言が変わったときだけ再確認され、ファイル（ネイティブバックエンドのプログラム自体を含む）を編集しただけでは確認されません。製品版では、自前の Registry（`AGENT_TEAM_MARKETPLACE_URL`）が使われるのも開発者モードがオンのときだけで、オフのときはそこからインストールした Navide プラグインは読み込まれず、画面に理由が表示されます。

特に Automatic または Parallel Run の後は、Commit 前に変更を確認してください。Agent-generated Change が Git Panel に表示されたというだけで、安全になるわけではありません。

## Editor と AI Terminal

Editor は Monaco を使用し、File Editing、Diagnostics、Plan Rendering、Diff、Conflict、AI-assisted Workflow を提供します。右側の AI パネルは実際の Coding Agent CLI Terminal（メインウィンドウと同じ Agent）を組み込み、起動時に Editor の Context を注入します。

これらの Tool は、より広い Engineering Environment における Intervention Surface です。Navide は最終的に、従来の IDE を主要環境として必要としない完全な Professional Workflow を提供することを目指します。

## Navide MCP で Skills を管理する

許可を受けた Agent は **Settings → Skills** と同じライブラリを利用できます。

1. `skills_list` の ID を `skills_inspect` に渡し、指示、ファイル、所有者、出所の記録と現在の `delivery_revision` を確認します。
2. `skills_prepare_install` には `owner/repo`、HTTPS の `github.com/owner/repo` URL、またはローカル skill フォルダの絶対パス（`~` 展開対応）を指定します。GitHub の `ref` と `subdir` は別引数です。`subdir: "."` は repository のルートを選びます。候補が複数なら `selection_required` と `candidates` を返し、インストール用 preview ID は発行しません。パスを選んで再度 prepare してください。Private repository、任意の URL、GitHub tree URL は対象外です。
3. 指示全文、ファイル一覧、スクリプト警告、出所と digest を確認し、preview ID、同じ digest、明示的な targets で `skills_install` を呼びます。これは要求を送るだけです。ユーザーが Navide のウィンドウで承認または拒否し（承認は共有ルートへの初回書き込みへの同意も兼ねます）、結果は `skills_install_status` で確認します。Agent がユーザーの代わりに承認することはできません。同名の管理対象、ユーザー所有、native skill は拒否します。宛先を排他的に作成し、添付ファイルと metadata の後に `SKILL.md` を公開するため、不完全なパッケージが検出されません。ディレクトリ全体の atomic rename ではありません。
4. 配信設定の変更には ID と最新の `delivery_revision` を `skills_set_delivery` に渡します。古い revision は失敗し、別の呼び出し元の判断を上書きしません。CLI を外す、またはスキルを無効にするだけの変更はすぐに適用されます。別の CLI に配信する、またはスキルを有効にする変更は、インストールと同じく Navide ウィンドウでの承認を待ちます。このフローは追加専用で、既存インストールの更新や再取得は行いません。

準備した bytes は認証済み呼び出し元に結び付けられ、15 分後または backend 再起動時に失効します。インストール時にローカルの再読込や再ダウンロードは行いません。許可の再試行には有効な preview を再利用でき、再試行用の記録が残っている間だけ、成功後の再送は元の結果を返し、再書き込みしません。有効な準備は最大 8 パッケージで、内容を持たない軽量な完了記録を別に最大 8 件保持します。インストールが成功すると、パッケージ bytes と有効な準備枠を解放します。記録は元の preview の期限で失効し、上限に達するとインストール成功が最も古い記録から破棄します。失効または破棄後の再送は missing/expired を返し、再インストールしません。GitHub archive は圧縮 10 MiB、展開 32 MiB、4,096 entries が上限で、選んだ skill は 64 ファイル、各 256 KiB、合計 512 KiB までです。危険なパス、リンク、特殊ファイル、予約 metadata、不正な manifest は黙って除外せず拒否します。

共有 skill の `targets: null` は全 wired vendor、`targets: []` は Navide の追加配信なしを意味します。Native skill の targets は他の CLI への追加配信を指定し、空配列や `null` はそれを解除します。共有ルートを直接読む CLI は Navide の targets や有効スイッチに関係なく skill を発見できます。これらの設定は隔離境界ではありません。

`materialized_in_current_session: null` と `loaded_in_current_session: null` は現在の session の実配信とロードが未確認であることを示します。互換フィールド `delivered_to_me` も設定情報です。配信変更後は新しい CLI session を開いて確認してください。インストールや設定変更の成功だけでは、実行中の CLI が新しい内容をロードしたとはいえません。

ローカルの出所記録には source、準備時 digest、時刻が含まれ、編集、切り替え、再起動後も inspect で読めます。digest はインストールした snapshot を表し、後のローカル編集を表しません。管理 marker と出所記録は既存の export／Skills sync に含まれず、デバイス間の保持は保証しません。Skills sync が有効なら条件を満たす内容と配信設定は既存フローで同期できますが、サイズ上限を満たすことは同期完了の証拠ではありません。

Skills 画面は backend の変更成功と再接続で更新されます。未保存の内容と元の revision を保持するため、古い保存は引き続き conflict になります。他のツールによる直接のファイル変更は手動更新が必要です。準備とインストールは添付スクリプトや plugin hooks を実行しません。後の利用には CLI 自身のツール権限が適用されます。

## Settings と Portability

**設定 → 言語** は、サイドバーの「外観」の次にある独立したページです。繁體中文、English、日本語から選択できます。このユーザー設定はすべてのワークスペースに適用されます。初回起動時に言語設定が保存されていなければ、日本語のシステムでは日本語が選択されます。言語の変更は初期設定画面、Navide のネイティブメニュー項目、独立した Plans とトークンモニターのウィンドウにも反映されます。OS が提供するメニュー項目や外部のコンテンツは、それぞれの言語で表示される場合があります。

Settings は Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance、Keyboard Shortcut を扱います。Navide が MCP Server を停止するとき（Navide の終了、再読み込み、Server の起動失敗）は、その Server が起動してまだ動いているすべてのプロセスも終了します。Server があなたのために開いたプログラム（起動したブラウザーなど）も含みます。CLI Agents では Install 済みの Coding CLI も管理します。バージョン、Install 方法、重複 Install、その CLI 自身の最後の更新結果を表示し、その CLI 公式の更新コマンドと診断コマンドを Terminal で実行できます。Navide はベンダーのコマンドを提示して実行するだけで、CLI 自体を更新することはありません。Export された Settings は API Key と Token を Redact します。Third-party Server を有効化する前に、MCP Command と Environment Variable を確認してください。

**Accounts** では CLI Account ごとに 1 枚のカードを扱い、CLI 自身のサインインを使います。Navide 0.2.32 でカードの Portable Credential（`claude setup-token` が出力する値などを貼り付けるもの）は廃止されました。使っていた Device では更新時に保存済みの値が消去され、新しい Claude Pane は Claude 自身のサインインを使います。別の Account になり、Quota もその Account のものが使われる場合があります。

**アカウントに名前を付ける。**内蔵の Default を含め、すべての Account に好きな名前を付けられます。Accounts でカードにカーソルを合わせて鉛筆を押すか、Quota Badge の Account 一覧の行にある鉛筆を使います。その名前は Account が表示されるあらゆる場所——Pane ヘッダー、Account 一覧、カード、切り替え通知、Turn Stats——で主表示になり、サインイン中の識別情報はその隣に残ります。欄を空にすると自動生成の名前（Account 1、Account 2…）に戻ります。Credential が識別情報を持たない CLI では、付けた名前だけが 2 つの Account を見分ける手段です。名前はログインではなく Account のスロットに属します。そのスロットに後から別の email でサインインしても、名前はそのまま残ります。

Pane ヘッダーの Quota Badge は、その数値がどの Account のものかを、パーセント表示の前の独立したセクションに示します。付けた名前、名前がない場合はサインイン中の email の `@` より前の部分です。警告と枠切れの色は数値のセクションだけに付き、読み取り中は Badge 全体が破線のままで、完全なアドレスは Tooltip にあります。Pane が狭いときは名前の 1 文字目に縮みます。名前も識別情報もなく、その CLI に見分けるべき 2 つ目の Account もない場合、Badge には何も加わらず、従来どおりの表示のままです。数値はその CLI の現在の Account のものであり、Account 切り替え前に開いた Pane については、その Pane が今動いている Account とは限りません。

**CLI の Quota が尽きたときの Account 切り替え。**ある CLI の使用中 Account が利用上限に達すると、Navide はそれを 1 件の Incident として扱い（いくつの Pane や Window が検知しても 1 件です）、Account 切り替えポリシーに従って動きます。**Off**（何もしない）、**Notify**（既定。Announcement にその CLI の切り替え先候補を一覧し、各 Account には読み取りの信頼度——新しい余裕あり、リセット済みの見込み、古い読み取り、不明——を付け、除外された Account には理由——サインアウト済み、まだ枯渇中、この回で試行済みなど——を示します）、**Auto**（Navide が最良の候補で 1 回だけ試みます）。自動切り替えは CLI の Credential Pool ごとに直近 5 時間で最大 3 回、間隔は最低 10 分です。手動の切り替えは数えません。失敗——候補なし、Credential を移せない、Pane を再開できない、新しい Account も枯渇していた——はいずれもその Incident を理由付きで終了させます。Navide が勝手に次の Account を試すことも、自動で元に戻すことも、Pane が既に行った作業を再送することもありません。元の Account のリセット時刻を過ぎても Announcement は「回復した*見込み*」としか言いません。戻すのはあなたが押すボタンです。

Claude Code はリクエストごとに Credential を読み直すため、何も再起動せずに切り替わります。他の CLI は Credential をメモリに保持するため、影響を受ける Pane にまず確認します。ターンの途中、権限プロンプトの待機中、未送信の入力がある Pane は決して停止しません。切り替えは影響を受ける Pane がすべて安全にアイドルになるまで待ち、それから停止し、Credential を移し、各会話を自身の Session で再開します。再開できない Pane があれば、何かを動かす前に切り替えを止めます。Aider と MiniMax Code は会話を再開できないため、代わりに新しい会話の確認を求めます。切り替え後は 3 つの結果を別々に表示します。Account が切り替わったか、各会話が再開したか、新しい Account の Quota が確認できたか——最後の項目はその Account の新しい読み取り（または完了したターン）だけを根拠にし、2 分以内に何も届かなければ Announcement は*切り替え済み、Quota 未確認*と表示します。Credential は移ったのに Account の記録を保存できなかった場合、どの Account が実際に使われているかをあなたが確認するまで、その CLI の以降の切り替えは拒否されます。その間、何も上書きされません。同様に、現在使われている Credential が使用中 Account の控えと一致しない場合も切り替えは拒否されます。Credential 自体が Account の身元を含む CLI では Navide が自分で見分けます（トークンの更新は別 Account ではありません）。身元を含まない CLI では、現在の Credential が使用中 Account のものであることをあなたに確認し、その確認は表示された状態そのものにだけ適用されます。

新しい Account のサインインは Claude Code、Codex、Grok、Kimi、Pi、Droid、MiniMax Code では隔離されています。サインイン用の Pane は専用の Home を使い、使用中の Account と実行中の Pane には触れません。他の CLI は Credential の保存場所が 1 つしかないため、サインインは一時的に現在の Credential を置き換えます。Navide は先に使用中の Account のスナップショットを取り、サインインが完了したら新しいサインインをそれ自身の Account カードへ退避し、使用中の Account を復元します——サインインが放棄された場合も同様です。このようなサインインが保留中の間、Navide はその CLI の他の Pane を開かず、その CLI の Pane が実行中のときはこのサインインを開始しません。すべての CLI の Account 切り替えの仕組みはベンダー自身のコードから読み取ったものです。Navide の中で 2 つの実 Account を往復した CLI はまだなく、MiniMax Code の対応は最も新しいものです。

これらの Credential は**この Machine から出ることはありません**。アカウントの Credential と Key はローカルにのみ保存されるため、**Sync** セクション（Settings → Sync）に 「認証情報とキー」の行はなく、古いビルドでオンのまま残った「認証情報とキー」のスイッチはオフとして扱われます。Sync セクションは Sync Key の ID を表示し（同期する資産を暗号化する Key で、CLI の Credential ではありません）、漏洩が疑われるときに Rotate を提供します。すべての Record が再暗号化され、ペアリング済みの Device は新しい Key を受け取ります。

**App Lock**（設定 → App Lock）は、すべての Navide ウィンドウをロック画面で覆い、4〜12 桁の PIN で解除します。Mac では Touch ID、Windows 11 では Windows Hello を先に使えます。Windows 10 と Linux では PIN でのみ解除し、設定ページにもそう表示されます。これはプライバシー画面であり、アクセス制御ではありません。下では agent、ターミナル、チャットチャンネル、MCP ツール、ほかのデバイス、スケジュールがそのまま動き続け、コンピューターの前にいる詳しい人なら回避できます。ロック中は、隠す・終了・ウィンドウ操作と、PIN 入力欄に必要な編集キーを除いてアプリケーションメニューがグレー表示になり、キー入力も下のウィンドウには届かないため、メニューのクリックでもショートカットでも背後の App を操作できません。DevTools は変わりません。「今すぐロック」（⌘⌥L、Windows と Linux では Ctrl+Alt+L）で手動でロックできるほか、一定時間操作がないとき、画面がロックされたとき、コンピューターがスリープしたとき、Navide の起動時（既定でオフ）に自動でロックできます。PIN を忘れた場合は Touch ID または Windows Hello で確認してから再設定します。どちらもない場合は、Navide を終了して Navide のデータフォルダーにある `app-lock.json` を削除してください。App Lock とその PIN だけが削除され、ほかには影響しません。

`.agent-team/` は現在 Portability Mechanism ではありません。将来 Machine 間で移行する場合は Git Synchronization ではなく、Redaction と Retention Control を備えた明示的な Local Export/Import Flow を使用すべきです。

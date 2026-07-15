# 0005: LLMプロバイダは全エージェントでCloudflare Workers AIに統一する

## Status
Accepted (2026-07-14)、同日改訂（当初のAnthropic Claude併用案を撤回）

## Context
3つのLLMエージェント（[[エージェントの役割分担]]）はいずれもPages Functions経由でLLM APIを
呼ぶが、それぞれ要求する出力の性質が異なる。

- 質問選定エージェント・仮説形成エージェント: JSON構造化出力のみ。ユーザーの目に触れない。
- 結果生成エージェント（ライブLLM演出）: ユーザーが直接読む一言コメント。
  [[スコープ境界]]で確認した「一般論にせず具体的で刺さる内容にする」という
  診断結果の品質基準に直結する。

全エージェントを同一プロバイダに統一する案（実装がシンプル）と、用途によって
プロバイダを分ける案を検討した。実際の料金表（Anthropic Claude、Cloudflare Workers AI）を
比較した結果、Workers AIは対象モデル（Llama 3.2系等）が無料枠内で収まる想定で、
JSON生成のような品質要求が低いタスクには十分な一方、Anthropic Claudeは有料だが
文章の質が明確に高い。

## Decision
当初は「質問選定・仮説形成エージェントはWorkers AI、結果生成エージェントだけAnthropic
Claude」という用途別の分離案を採用したが、同日中に撤回し、**3エージェントすべてを
Cloudflare Workers AIに統一**する。

- **質問選定エージェント・仮説形成エージェント**: Cloudflare Workers AI（小さめのLlama
  モデル、構造化JSON出力用）。
- **結果生成エージェント（ライブLLM演出）**: Cloudflare Workers AI（大きめのLlama
  モデル、例: Llama 3.3 70B想定、文章生成用）。

理由: Anthropicのアカウント作成・課金設定というハッカソン準備の摩擦点を無くし、
運用コストを完全にゼロに保つことを優先した。文章品質はClaude Sonnetに一歩譲る
可能性があるが、以下の安全網により許容できると判断:
- `FlourishResponse`の`status: "fallback"`により、失敗時は静的テンプレート
  （[[パーソナライズ層]]）に自動で切り替わる。
- `prompts/result-writer.md`は既にfew-shot例付きで書かれており、モデルを
  差し替えても流用できる。

## Consequences
- Pages FunctionsのWrangler設定はWorkers AIバインディング（`env.AI`）1つだけで済む。
  Anthropic APIキーの管理は不要（`.dev.vars`にも含めない）。
- `functions/api/_lib/agents.ts`の3関数（`runQuestionAgent` / `runHypothesisAgent` /
  `runResultWriter`）は、いずれも内部で`env.AI`を呼ぶ（モデルIDだけが異なる）
  （[[LLM呼び出し＋検証＋リトライ＋フォールバックの共通処理]]参照）。
- 未検証リスク: 小さいLlamaモデルが期待するJSONスキーマを安定して守れるかは
  **2026-07-15にスモークテスト実施済み**（`@cf/meta/llama-3.2-3b-instruct`、
  実際の`prompts/question-agent.md`を使用、3サンプル）。結果: 3件中2件は一発で
  スキーマ通り、1件は許可されていないキー（`primary_release_date`をネストした
  オブジェクトで返す、`with_genres`に`null`を混入）で無効、さらに有効判定された
  1件でも`vote_count.gte`に`1000000`という非現実的な値を返した（TMDb的には
  該当0件になりうる）。結論: 単純な「1回呼んで信じる」運用は不可能で、
  [[LLM呼び出し＋検証＋リトライ＋フォールバックの共通処理]]の「厳格なキー検証＋
  最低1回のリトライ」は必須。加えて`functions/api/_lib/tmdb.ts`側で
  `vote_count.gte`等の数値を現実的な範囲にクランプする防御的サニタイズを追加した
  （LLMの検証だけでは「型は正しいが値が非現実的」なケースを防げないため）。
  大きいLlamaモデルの文章の質（結果生成エージェント用）は引き続き未検証
  （そちらの実装時にスモークテストする）。文章品質が実用に耐えない場合は、
  この決定を再度見直しAnthropicの併用に戻す可能性がある
  （その場合はコストゼロ前提が崩れる点に注意）。

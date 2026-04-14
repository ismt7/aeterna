# フロー型タスク管理ツール Aeterna

Aeterna は、`src/data` 配下の YAML ファイルを読み込み、依存関係つきのタスクフローを可視化しながら進捗を管理する Next.js アプリです。

タスクごとの状態、サブタスクの完了状況、経過時間をブラウザ上で扱えます。進捗はファイル単位で `localStorage` に保存されます。

## セットアップ

依存関係をインストールします。

```bash
npm install
```

開発サーバーを起動します。

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

## 使い方

1. `src/data/*.yaml` を編集または追加します。
2. アプリを開くと、YAML からタスクフローが読み込まれます。
3. タスクの状態やサブタスク、タイマー操作の進捗はブラウザに保存されます。

特定のファイルを直接開きたい場合は、`file` クエリを使います。

```text
http://localhost:3000/?file=default-flow.yaml
```

サブディレクトリ配下の YAML も読み込まれます。`file` には `src/data` からの相対パスを指定します。

## YAML の基本構造

最小限の構造は次のとおりです。

```yaml
id: sample-flow
title: サンプルフロー

tasks:
  - id: prepare
    title: 準備する

  - id: execute
    title: 実行する
    depends_on:
      - prepare
```

よく使うフィールド:

- `id`: フロー全体の識別子
- `title`: フロー名
- `tasks`: タスク一覧
- `tasks[].id`: タスクの識別子
- `tasks[].title`: タスク名
- `tasks[].description`: タスク詳細
- `tasks[].estimate_minutes`: 想定工数（0以上の整数）
- `tasks[].depends_on`: 依存先タスク ID の配列
- `tasks[].subtasks`: チェック可能なサブタスク一覧
- `tasks[].parts`: 詳細カードに表示するテキストやリンク
- `sections.parts`: `parts` から `ref` で再利用できる共有パーツ定義

既存の task に後から `parts` を追加したい場合は、次のように最小構成で足せます。

```yaml
tasks:
  - id: execute
    title: 実行する
    parts:
      - type: text
        label: 補足メモ
        text: 実行前に環境変数を確認する
```

共通化したいパーツは `sections.parts` に寄せて、`ref` で差し込めます。

```yaml
sections:
  parts:
    release-check:
      - type: text
        label: リリース前チェック
        text: ステージングで動作確認してから本番反映する

tasks:
  - id: execute
    title: 実行する
    parts:
      - ref: release-check
```

実例は [src/data/default-flow.yaml](/Users/ishimototatsuya/Documents/privates/aeterna/src/data/default-flow.yaml) を参照してください。
特に「既存タスクにパーツを追加する」例は `既存タスクにパーツを追加する` タスクで確認できます。

## 補足

- YAML に構文や参照エラーがある場合、そのファイルは正常なフローとしては読み込まれません。
- 依存関係は DAG である必要があります。循環参照はエラーになります。
- 利用可能なスクリプトは `npm run dev`, `npm run build`, `npm run start`, `npm run lint` です。

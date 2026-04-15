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

## Docker で起動する

イメージは [GitHub Container Registry (GHCR)](https://ghcr.io/ismt7/aeterna) に公開されています。リポジトリのクローンなしで、すぐに起動できます。

### docker run で起動する（最速）

```bash
docker run --rm -p 3000:3000 \
  -v "/path/to/your/flows:/app/src/data:ro" \
  ghcr.io/ismt7/aeterna:latest
```

`/path/to/your/flows` は自分の YAML ファイルが入ったディレクトリの絶対パスに書き換えます。  
ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

```bash
# 例: カレントディレクトリの yaml/ フォルダを使う
docker run --rm -p 3000:3000 \
  -v "$(pwd)/yaml:/app/src/data:ro" \
  ghcr.io/ismt7/aeterna:latest

# 例: ホームディレクトリの my-flows/ を使う
docker run --rm -p 3000:3000 \
  -v "$HOME/my-flows:/app/src/data:ro" \
  ghcr.io/ismt7/aeterna:latest
```

### docker compose で起動する（推奨）

自前の compose ファイルを用意すると、毎回オプションを書かずに済みます。任意のディレクトリに `compose.yml` を作成します。

```yaml
# compose.yml
services:
  aeterna:
    image: ghcr.io/ismt7/aeterna:latest
    ports:
      - "3000:3000"
    volumes:
      - /path/to/your/flows:/app/src/data:ro
```

起動します。

```bash
docker compose up
```

ポート番号を変えたい場合は `ports` の左辺を書き換えます（例: `"8080:3000"`）。  
最新イメージに更新したいときは `docker compose pull && docker compose up` を実行します。

### YAML ファイルを差し替える

`-v` でマウントするディレクトリを変えるだけで、表示するフローを切り替えられます。

```bash
# プロジェクト A のフローを使う
docker run --rm -p 3000:3000 \
  -v "$HOME/projects/project-a/flows:/app/src/data:ro" \
  ghcr.io/ismt7/aeterna:latest

# プロジェクト B のフローを使う
docker run --rm -p 3000:3000 \
  -v "$HOME/projects/project-b/flows:/app/src/data:ro" \
  ghcr.io/ismt7/aeterna:latest
```

マウントするディレクトリには `.yaml` ファイルを置くだけで自動的に読み込まれます。サブディレクトリも対応しています。

複数の YAML が存在する場合、URL の `file` パラメータで表示するフローを指定できます。

```text
http://localhost:3000/?file=my-flow.yaml
http://localhost:3000/?file=subdir/project.yaml
```

### イメージのタグ

| タグ | 内容 |
|------|------|
| `latest` | `main` ブランチの最新ビルド |
| `main` | 同上 |
| `sha-xxxxxxx` | コミット SHA ごとのビルド |

### ソースからビルドする（開発者向け）

リポジトリをクローンしてローカルでビルドする場合は以下を参照します。

**開発用コンテナ（ホットリロード付き）:**

```bash
docker compose -f infra/docker/compose.yml up --build
```

`src/data` を含むローカルファイルがコンテナへマウントされるため、YAML やソースの編集内容をそのまま反映できます。

`node_modules` ボリュームを作り直したい場合:

```bash
docker compose -f infra/docker/compose.yml down -v
docker compose -f infra/docker/compose.yml up --build
```

**本番イメージをローカルビルド:**

```bash
docker build -f infra/docker/Dockerfile --target runner -t aeterna:local .
docker run --rm -p 3000:3000 \
  -v "$(pwd)/src/data:/app/src/data:ro" \
  aeterna:local
```

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

<div align="center">
  <img src="docs/icon_gb@wh512.png" width="128" height="128" alt="MySekaiStoryteller ロゴ" />
  <h1>MySekaiStoryteller</h1>
  <p>プロジェクトセカイ向けの二次創作ストーリーエディター。Live2D、ボイス、エフェクトなどに対応。</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri" />
    <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PixiJS-E91E63?style=for-the-badge&logo=pixiv&logoColor=white" alt="PixiJS" />
  </p>
</div>

[English](README.md) | [简体中文](README-ZH.md) | **日本語**

---

MySekaiStorytellerでは、Live2Dモデル、背景、ボイス、トランジション、ビジュアルエフェクトを組み合わせて二次創作ストーリーを制作し、リアルタイムでプレビューできます。デスクトップとAndroidに対応しています。

> 本プロジェクトは現在ベータ版です。アップグレードする前に、プロジェクトデータをバックアップしてください。

## 主な機能

- 会話、シーン切り替え、モーション、エフェクトなどのスニペットを組み合わせてストーリーを制作
- プロジェクトセカイに限らず、さまざまなゲームのLive2Dモデルに対応
- Parallelスニペットによる複数アニメーションの同時実行
- ドラッグ＆ドロップによるスニペットの並べ替え
- リップシンクに対応
- エディター内でのリアルタイムプレビューと、専用プレイヤーウィンドウでの通し再生

## ダウンロード

最新版は[GitHub Releases](https://github.com/Untitled-Story/MySekaiStoryteller/releases)からダウンロードできます。

## コミュニティ

- Discord：[サーバーに参加](https://discord.gg/cGWNG6fFdP)
- QQグループ：[753850881](https://qm.qq.com/q/TIFODIZkKk)

## 開発

Node.js 22、pnpm 10、Rust、およびお使いのプラットフォーム向けの[Tauri v2システム依存関係](https://v2.tauri.app/start/prerequisites/)が必要です。

```bash
pnpm install
pnpm tauri dev
```

主なチェックコマンド：

```bash
pnpm typecheck
pnpm lint
pnpm build
cd src-tauri && cargo check
```

ネイティブインストーラーをビルドする場合：

```bash
pnpm tauri build
```

### Android

Android SDK / NDK、JDK、およびRustのAndroidターゲットが必要です。

```bash
# 初回セットアップ（gen/androidがすでに存在する場合は不要）
pnpm android:init

# 実機またはエミュレーターで実行
pnpm android:dev

# リリース用APK/AABをビルド
pnpm tauri android build --apk --target aarch64
```

補足：

- 初回ビルド時には、GradleとAndroidの依存関係がGoogle MavenおよびMaven Centralの公式リポジトリからダウンロードされます。アクセスが制限されたネットワークでは、`MSS_USE_ALIYUN_MAVEN=true`を設定するとAliyun Mavenミラーを利用できます。
- 画面遷移はアプリ内で`#/editor/:project`および`#/player/:project`を使用して処理され、複数ウィンドウは開きません。
- プレイヤーはタイムラインに沿って自動再生され、タップによるページ送りはありません。
- デスクトップブラウザでモバイルシェルを確認するには、`localStorage.setItem('mss.mobileShell','1')`を実行するか、URLに`?mobileShell=1`を追加してください。

## 謝辞

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- MySekaiStorytellerをテストし、開発に貢献し、このアプリで物語を作ってくださるすべての皆さま

## ライセンス

- ソースコード：[GNU GPL v3.0](LICENSE)
- 本プロジェクトが所有する素材およびプロジェクトの出力物：[POMOLA](POMOLA.md)

## 支援

開発を支援していただける場合は、[愛発電（Afdian）](https://afdian.com/a/devguangchen)をご利用ください。ご支援の有無にかかわらず、本プロジェクトに関心を寄せていただきありがとうございます。

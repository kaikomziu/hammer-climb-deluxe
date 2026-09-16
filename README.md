# HAMMER CLIMB DELUXE

Getting Over It 風の物理登りゲーム。ハンマー1本で理不尽な山を登る。

- スマホ対応(タッチドラッグ操作)
- 進んだ高さを自動でセーブ、次回「つづきから」で再開可能
- GitHub Pages で公開: https://kaikomziu.github.io/hammer-climb-deluxe/

## 操作

画面をドラッグ(スマホは指で)してハンマーを振り回す。岩に叩きつけたり出っ張りに引っかけたりして、体を持ち上げて山頂を目指す。

## 構成

- `index.html` — 画面構造・UI
- `css/style.css` — スタイル
- `js/terrain.js` — 山の地形生成(折れ線+当たり判定)
- `js/game.js` — 物理演算・入力・描画・セーブ・UI制御

# ミニゲーム追加手順

この統合版は、ミニゲームを後から増やせるようにアーケード一覧を `manifest.js` から生成します。

## 1. ゲームを追加
`games/my-game/index.html` のように、1ゲーム1フォルダで配置します。

ゲーム側は同一オリジンの `localStorage` を使い、以下の共通キーを使います。

- メダル残高: `medicine-medal-arcade-wallet-v2`
- 週間服薬: `medicine-medal-weekly-adherence-v1`
- 音/振動設定: `medicine-medal-arcade-settings-v1`

## 2. manifest.js に1項目追加

```js
{
  id: 'my-game',
  title: 'ゲーム名',
  subtitle: '30秒',
  icon: '●',
  path: 'games/my-game/index.html',
  description: '短い説明',
  kind: 'standard', // standard または score
  cost: 1,
  reward: 'win',    // win / consume など
  motivation: []
}
```

これだけでアーケードTOPにカードが自動追加されます。メイン `index.html` の修正は不要です。

### スコアチャレンジの場合
`kind: 'score'`、メダル消費のみなら `reward: 'consume'` とします。スコアチャレンジ欄へ自動分類されます。

## 3. 埋め込み表示
アーケードTOPはゲームを `?embed=1` 付きでiframe表示します。

既存ゲームでは `html.embed` のCSSで、試作用の週間UI・開発ボタン・「試しにあそぶ」を非表示にしています。

## 4. 6タイプ理論
`motivation` は将来のHexad分類用の予約フィールドです。現段階では無理に分類せず空配列で構いません。

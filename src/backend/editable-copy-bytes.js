// 「編集可能として別名保存」(ADR-0030) — 元 PDF バイト列から「同じ見た目で
// fingerprint だけが異なる」別個体を作る。
//
// K-PDF3 の workspace は元 PDF バイト列の SHA-256 (fingerprint) で索引される
// (ADR-0007)。元ファイルをそのまま別名コピーすると fingerprint が一致して
// 同じ workspace を共有してしまい、「別名で保存したフォーム記入が元ファイル
// を開いても見える」事故になる。別名コピーを独立した文書として扱うには
// バイト列が 1 バイトでも違う必要がある。
//
// 方式: mupdf の増分保存 (incremental) で Info 辞書にマーカーを足す。
//   - 元バイト列は先頭からそのまま保たれ (前方一致)、末尾に小さな
//     xref セクションが追記されるだけ。中身の再シリアライズは起きない。
//   - PDF 仕様上まっとうな更新なので Adobe / Dropbox プレビューでも警告なし。
//   - 失敗時 (壊れた PDF 等) は %%EOF の後ろにコメント行を追記する
//     フォールバック。PDF リーダは末尾の余分な行を無視する。
//
// 閾値超の巨大 PDF (β.134 サイドカー経路) は mupdf に全体を載せると
// malloc 失敗の前科 (741MB、2026-08-18) があるため、最初からフォールバック
// (末尾追記) を使う。

import * as mupdf from "mupdf";

/** mupdf に載せる上限。これ以上は末尾追記フォールバック。 */
export const INCREMENTAL_MAX_BYTES = 200 * 1024 * 1024;

const INFO_KEY = "KPDF3EditableCopy";

/**
 * @param {Buffer | Uint8Array} bytes  元 PDF (workspace が保持する平文バイト列)
 * @param {{ stamp?: string, maxIncrementalBytes?: number }} [opts]
 *   - stamp: マーカー文字列 (既定 = 現在時刻 ISO + 乱数)。同じ stamp を
 *     2 回使っても mupdf 側の xref オフセット等は同じなので、呼び出し側は
 *     fingerprint 衝突時に stamp を変えて再試行する。
 * @returns {{ bytes: Buffer, method: "incremental" | "append" }}
 */
export function makeDistinctPdfBytes(bytes, opts = {}) {
  const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const stamp = opts.stamp ?? defaultStamp();
  const max = opts.maxIncrementalBytes ?? INCREMENTAL_MAX_BYTES;
  if (src.length <= max) {
    try {
      const out = incrementalWithMarker(src, stamp);
      // 前方一致 + 長さ増 = 期待どおりの増分保存。そうでなければ (mupdf が
      // 修復モードで全体を書き直した等) フォールバックへ。
      if (out.length > src.length && out.subarray(0, src.length).equals(src)) {
        return { bytes: out, method: "incremental" };
      }
    } catch {
      /* fall through to append */
    }
  }
  return { bytes: appendMarkerComment(src, stamp), method: "append" };
}

function defaultStamp() {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${new Date().toISOString()} ${rnd}`;
}

function incrementalWithMarker(src, stamp) {
  const doc = mupdf.PDFDocument.openDocument(src, "application/pdf");
  try {
    const trailer = doc.getTrailer();
    let info = trailer.get("Info");
    if (!info || !info.isDictionary()) {
      info = doc.addObject(doc.newDictionary());
      trailer.put("Info", info);
    }
    info.put(INFO_KEY, doc.newString(stamp));
    const out = doc.saveToBuffer("incremental").asUint8Array().slice();
    return Buffer.from(out);
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * %%EOF の後ろに PDF コメント行を追記する。コメント以外の構文は足さない
 * ので xref / trailer は不変 — リーダは末尾から %%EOF を後方検索するため
 * 短い追記は無害 (Adobe / mupdf / qpdf で実績のある「末尾ゴミ」の範囲)。
 */
function appendMarkerComment(src, stamp) {
  const safe = String(stamp).replace(/[\r\n%]/g, " ");
  const tail = Buffer.from(`\n%${INFO_KEY} ${safe}\n`, "latin1");
  return Buffer.concat([src, tail]);
}

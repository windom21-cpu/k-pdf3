// mupdf 修復再保存 — pdf-lib 堅牢性ギャップの fallback (§8.2🔴(1))。
//
// mupdf は壊れかけ flate (zlib ヘッダ無しの raw deflate 等) を寛容に
// inflate して開けるが、pdf-lib の FlateStream は zlib ヘッダを厳格に
// 検査して `Unknown compression method in flate stream: <cmf>, <flg>`
// を throw する。ユーザーの大部 (100 頁超) PDF の別名保存が
// `175, 253` で失敗した実事例 (2026-07-06) の構図:
// 「mupdf では正常に開けて閲覧・編集できるのに、書き出し/印刷の
//  assembleHybridPdf 内の pdf-lib load / copyPages / embedPdf で落ちる」。
//
// 修復 = mupdf で開き直して保存し直す。save オプションが肝で、
// "compress" 単独では既存 flate ストリームのバイトが素通しされて
// 直らない (2026-07-06 に合成 raw-deflate PDF で実験確認)。
// "clean"/"sanitize" が content stream を decode → 再シリアライズ
// するので、壊れた flate が clean な zlib に書き直り pdf-lib が通る。
//
//   garbage   : 未参照オブジェクトの除去 (修復後のゴミ掃除)
//   clean     : content stream の再シリアライズ (これが本体)
//   sanitize  : content stream の不正オペレータ除去
//   compress  : 再圧縮 (大部 PDF の膨張防止)
//
// ベクター/文字/フォントは preserve される (ラスタ化はしない)。
// 呼び出し側の約束: 失敗時のみ発火させること — 正常系の高速
// byte-copy / verbatim copyPages 経路にこの再保存を挟んではならない
// (修復再保存は元バイトの bit-identity を壊すため)。

import * as mupdf from "mupdf";

export const REPAIR_SAVE_OPTS = "garbage,clean,sanitize,compress";

/**
 * mupdf で開き直して clean に再保存した PDF バイト列を返す。
 * mupdf でも開けない/保存できない入力はそのまま throw (呼び出し側は
 * 元のエラーへフォールバックする)。
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {Buffer}
 */
export function repairPdfBytes(bytes) {
  const doc = mupdf.PDFDocument.openDocument(
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    "application/pdf",
  );
  try {
    // .slice() で WASM ヒープから切り離す (vector-text-layer.js と同流儀)
    return Buffer.from(doc.saveToBuffer(REPAIR_SAVE_OPTS).asUint8Array().slice());
  } finally {
    try { doc.destroy(); } catch { /* noop */ }
  }
}

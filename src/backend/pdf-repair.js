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
import { pdfIsEncrypted } from "./mupdf-pdf-info.js";

// 2026-07-14: `decrypt` を追加。mupdf の save は既定で既存の暗号化を
// **維持** する (PDF_ENCRYPT_KEEP) ため、暗号化 PDF を修復しても
// 暗号化されたまま = pdf-lib は相変わらず読めない。実験でも修復後に
// `Unknown compression method in flate stream: 1, 80` と別の乱数バイトで
// 落ち直した (下記 decryptPdfBytesIfEncrypted の経緯も参照)。
export const REPAIR_SAVE_OPTS = "garbage,clean,sanitize,compress,decrypt";

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

/**
 * 暗号化 PDF なら復号した PDF バイト列を返す (非暗号化ならそのまま返す)。
 *
 * **pdf-lib には復号機能が一切無い**。`ignoreEncryption: true` は「暗号化を
 * 見ても throw しない」だけで、ストリームは暗号化バイトのまま扱われる:
 *   - `embedPdf` (回転ベイク・overlay 経路) は content stream を inflate
 *     しようとして `Unknown compression method in flate stream: <乱数>, <乱数>`
 *     で throw する ← ユーザー報告の `190, 7` / `175, 253` と同じ署名
 *   - `copyPages` (無回転・overlay 無し経路) は生ストリームを素通しするので
 *     **エラーにならず、中身が復号不能な = 白紙のページを出力する** (無言事故)
 *
 * 元 PDF (source_pdf) は import 時に qpdf で復号済 (ADR-0025) だが、
 * **挿入した外部 PDF (inserted_source_pdfs) は復号ゲートを通っていない** ため
 * 暗号化のまま blob 保存され、mupdf は普通に開ける (= 画面・サムネは正常) のに
 * 書き出し/印刷だけが上記のどちらかになる。ここが唯一の穴だった (2026-07-14)。
 *
 * pdf-lib に渡す直前で潰すのが構造的に正しい (source / external の両方、
 * 既存ワークスペースに既に入っている暗号化 blob も救える)。
 * 権限のみの暗号化 (ユーザーパスワード空) は mupdf が黙って開けるので復号でき、
 * 本物のユーザーパスワード付き PDF はそもそも import/挿入の時点で弾かれている。
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {Uint8Array | Buffer} 非暗号化なら **入力そのもの** (正常系は 1 バイトも触らない)
 */
export function decryptPdfBytesIfEncrypted(bytes) {
  if (!bytes || bytes.length === 0) return bytes;
  let encrypted = false;
  try {
    encrypted = pdfIsEncrypted(bytes);
  } catch {
    return bytes; // 判定不能なら従来どおり pdf-lib に賭ける (挙動不変)
  }
  if (!encrypted) return bytes;
  const doc = mupdf.PDFDocument.openDocument(
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    "application/pdf",
  );
  try {
    // "decrypt" 単独 — clean/sanitize は掛けない。壊れ flate の修復と違って
    // 復号はストリームの再シリアライズを要さないので、ベクター/フォント/
    // 構造を最大限そのまま残す (RC4-128 / AES-256 とも実験で確認済)。
    return Buffer.from(doc.saveToBuffer("decrypt").asUint8Array().slice());
  } finally {
    try { doc.destroy(); } catch { /* noop */ }
  }
}

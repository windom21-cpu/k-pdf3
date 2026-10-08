// ADR-0030「編集可能として別名保存」— workspace を丸ごと複製して、別の
// PDF バイト列 (fingerprint だけ違う同じ見た目の PDF) に紐づけ直す。
//
// 用途: フォーム枠・テキスト・印影などの書き込み (overlay) とページ構造
// (回転・削除・挿入・並び順・しおり・画像アセット) をそのまま持った
// 「新しいファイル」を作る。複製元 workspace には一切書き込まない。
//
// 手順:
//   1. SQLite online backup で .kpdf3 を複製 (WAL 未チェックポイント分も含む)
//   2. 複製の source_pdf を新バイト列に差し替え (pages テーブルは温存)
//   3. 呼び出し側が渡した「いま画面にある」overlay スナップショットと
//      未確定の削除 (pendingDeletedPages) を複製に反映
//   4. 複製元の lineage (predecessor) / 書き出し履歴 / 暗号化フラグを消す
//
// Electron 非依存 (better-sqlite3 と mupdf のみ) なので electron-runner の
// テストで直接呼べる。registry 登録とファイル書き出しは main.js の責務。

import { rmSync } from "node:fs";
import { Workspace } from "./workspace.js";

function removeWorkspaceFiles(path) {
  for (const suffix of ["", "-wal", "-shm", ".source.pdf"]) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * @param {object} args
 * @param {Workspace} args.source        複製元 (開いたまま渡す)
 * @param {string} args.destPath         複製先 .kpdf3 の絶対パス (未存在)
 * @param {Buffer} args.bytes            複製に紐づける PDF バイト列
 *                                       (makeDistinctPdfBytes の出力)
 * @param {string} args.fileName         複製 PDF の表示名 (basename)
 * @param {Array<object> | null} [args.overlays]  画面側の overlay
 *        スナップショット。null なら複製元の永続分をそのまま使う。
 * @param {number[]} [args.pendingDeletedPageNos]  未フラッシュの削除
 * @returns {Promise<Workspace>}  開いたままの複製 (呼び出し側が close する)
 */
export async function cloneWorkspaceAsEditableCopy({
  source,
  destPath,
  bytes,
  fileName,
  overlays = null,
  pendingDeletedPageNos = [],
}) {
  if (!source || !source.db) throw new Error("cloneWorkspaceAsEditableCopy: source workspace missing");
  if (!destPath) throw new Error("cloneWorkspaceAsEditableCopy: destPath missing");
  removeWorkspaceFiles(destPath);
  // Online backup copies the logical database (committed pages in the
  // WAL included), independent of the on-disk journal state.
  await source.db.backup(destPath);
  let clone;
  try {
    clone = Workspace.open(destPath);
    await clone.replaceSourceBytes(bytes, fileName);
    if (Array.isArray(overlays)) clone.saveOverlays(overlays);
    for (const pageNo of pendingDeletedPageNos ?? []) {
      if (Number.isInteger(pageNo) && pageNo > 0) clone.setPageDeleted(pageNo, true);
    }
    clone.clearPredecessor();
    clone.clearExportHistory();
    clone.clearSourceWasEncrypted();
    return clone;
  } catch (err) {
    try { clone?.close(); } catch { /* ignore */ }
    removeWorkspaceFiles(destPath);
    throw err;
  }
}

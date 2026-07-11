// スタンプ一式の書き出し / 取り込み (別 PC への持ち運び):
//
//   - exportStampsDbTo: 開いたままの stamps.db の整合コピーを任意パスへ
//   - importStampsDbFrom: 検証 → .bak 退避 → 丸ごと置き換え → 再オープン。
//     壊れたファイルは置き換え前の probe で reject し、現行 db は不変。
//
// Runs inside Electron main process via electron-runner.cjs (better-sqlite3
// needs Electron ABI; store は app.getPath("userData") で保存先を決める)。
//
// ⚠️ このテストは userData を一時ディレクトリへ差し替える (app.setPath)。
// 実ユーザーの stamps.db に触れないための隔離だが、以降のテストにも同じ
// userData が見えるため、electron-runner の実行順で最後に置くこと。

import { app } from "electron";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log("stamp-export-import: スタンプ書き出し/取り込み");

const workDir = mkdtempSync(join(tmpdir(), "kpdf3-stamp-port-"));
app.setPath("userData", join(workDir, "userData"));

// setPath 後に import することで getDb() が隔離 userData を見る
// (top-level static import だと束縛順は保証されるが、意図を明示するため
// dynamic import にしている — getDb 自体は lazy なのでどちらでも安全)。
const {
  addStampPresetGlobal,
  addStampAssetGlobal,
  getStampAssetGlobal,
  listStampPresetsGlobal,
  exportStampsDbTo,
  importStampsDbFrom,
} = await import("../src/main/global-stamp-store.js");

// ---- 準備: プリセット 1 件 (画像 asset 付き) を登録 --------------------
const blob = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const assetId = addStampAssetGlobal({ mime: "image/png", blob, label: "印影" });
addStampPresetGlobal({ kind: "image", label: "社判", assetId });
ok(listStampPresetsGlobal().length === 1, "準備: プリセット 1 件を登録");

// ---- 書き出し ----------------------------------------------------------
const exportPath = join(workDir, "stamps-export.db");
await exportStampsDbTo(exportPath);
ok(existsSync(exportPath), "書き出し: ファイルが作られる");
{
  const probe = new Database(exportPath, { readonly: true });
  const n = probe.prepare("SELECT COUNT(*) AS n FROM stamp_presets").get().n;
  const a = probe.prepare("SELECT blob FROM assets").get();
  probe.close();
  ok(n === 1, "書き出し: プリセットがコピーに含まれる");
  ok(
    a && Buffer.compare(Buffer.from(a.blob), Buffer.from(blob)) === 0,
    "書き出し: 画像 asset の blob が bit 一致",
  );
}

// ---- 取り込み (丸ごと置き換え) ------------------------------------------
// 現行 store を 2 件に増やしてから、1 件だけの書き出しファイルを取り込む
// → 「合体せず置き換え」で 1 件に戻り、直前状態が .bak に退避される。
addStampPresetGlobal({ kind: "text", label: "済" });
ok(listStampPresetsGlobal().length === 2, "準備: 2 件に増やす");

const res = importStampsDbFrom(exportPath);
ok(res.presetCount === 1, "取り込み: 戻り値 presetCount が取り込んだ件数");
const after = listStampPresetsGlobal();
ok(after.length === 1 && after[0].label === "社判", "取り込み: 置き換え (合体しない)");
const importedAsset = getStampAssetGlobal(after[0].assetId);
ok(
  importedAsset && Buffer.compare(Buffer.from(importedAsset.blob), Buffer.from(blob)) === 0,
  "取り込み: 画像 asset も blob ごと戻る",
);
ok(
  res.backupPath && existsSync(res.backupPath),
  "取り込み: 直前状態の .bak が退避される",
);
{
  const bak = new Database(res.backupPath, { readonly: true });
  const n = bak.prepare("SELECT COUNT(*) AS n FROM stamp_presets").get().n;
  bak.close();
  ok(n === 2, "取り込み: .bak は取り込み直前の内容 (2 件)");
}

// ---- 壊れたファイルの取り込みは reject + 現行 db 不変 -------------------
const bogusPath = join(workDir, "not-a-db.db");
writeFileSync(bogusPath, "これはただのテキストです");
let threw = false;
try {
  importStampsDbFrom(bogusPath);
} catch {
  threw = true;
}
ok(threw, "検証: SQLite でないファイルは throw");

const schemaOnlyPath = join(workDir, "schema-missing.db");
{
  const other = new Database(schemaOnlyPath);
  other.exec("CREATE TABLE totally_unrelated (id INTEGER)");
  other.close();
}
threw = false;
try {
  importStampsDbFrom(schemaOnlyPath);
} catch (err) {
  threw = /stamp_presets/.test(String(err?.message ?? err));
}
ok(threw, "検証: stamp スキーマの無い SQLite は throw (メッセージにテーブル名)");
ok(
  listStampPresetsGlobal().length === 1 && listStampPresetsGlobal()[0].label === "社判",
  "検証: 失敗後も現行 db は不変で開いたまま使える",
);

console.log(`\nstamp-export-import: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;

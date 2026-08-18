// 巨大 PDF 用の /Outlines 読み取り fallback (2026-08-18)。
//
// mupdf 経路 (workspace.getOutline() → extractOutline) は元 PDF を丸ごと
// Buffer に読み、さらに WASM ヒープへコピーするため、700MB 級の PDF では
// `malloc (740227416 bytes) failed` で落ちる。実機事故 (2026-08-18):
// 741MB の記録 PDF を確定保存 → 新フラット workspace への自動取込
// (autoImportOutlinesIfEmpty) がこの OOM で無言失敗 → しおりペインが 0 件
// になり「しおりが全部消えた」ように見えた。さらにその状態で再確定すると
// workspace しおり 0 件 → main.js の /Outlines write-back がスキップされ、
// 今度は本当にファイルからしおりが消える。
//
// qpdf はファイルを逐次読みするのでメモリを食わない。同梱バイナリ
// (vendor/qpdf/{win,mac,linux}、findQpdfBinary の探索順は qpdf-sanitize.js
// 参照) に `--json=2 --json-key=outlines` を投げ、返ってきた JSON を
// mupdf 側と同じ OutlineNode 形へ整形して返す。
//
// 注意: これは fallback 専用。通常は mupdf 経路のままにする (名前付き
// destination の解決など、mupdf のほうが素直に読める)。

import { spawn } from "node:child_process";
import { findQpdfBinary } from "./qpdf-sanitize.js";

/** stdout の暴走ガード。outlines キーだけなので実際は数百 KB 止まり。 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * qpdf でファイル経路から /Outlines を読む (メモリに全体を載せない)。
 *
 * @param {string} pdfPath                絶対パス (β.134 のサイドカー実体)
 * @param {{ qpdfPath?: string | null, timeoutMs?: number }} [opts]
 * @returns {Promise<import("../backend/mupdf-pdf-info.js").OutlineNode[]>}
 * @throws qpdf が見つからない / 失敗した / JSON が壊れているとき
 */
export async function extractOutlineViaQpdf(pdfPath, opts = {}) {
  const { qpdfPath = findQpdfBinary(), timeoutMs = 180_000 } = opts;
  if (!qpdfPath) throw new Error("qpdf binary not found");
  if (!pdfPath) throw new Error("extractOutlineViaQpdf: pdfPath required");

  const stdout = await runQpdfJson(qpdfPath, pdfPath, timeoutMs);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`qpdf JSON parse failed: ${err.message ?? err}`);
  }
  return convertQpdfOutlines(parsed?.outlines);
}

/**
 * qpdf --json の outlines 配列を mupdf 側と同じ形 (title / pageNo /
 * children) に整形する。destpageposfrom1 は 1-based。解決できない
 * destination では欠落する (= pageNo null → 取込側で親のページを継承)。
 */
export function convertQpdfOutlines(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((n) => ({
    title: typeof n?.title === "string" ? n.title : "",
    pageNo:
      typeof n?.destpageposfrom1 === "number" && n.destpageposfrom1 > 0
        ? n.destpageposfrom1
        : null,
    children: convertQpdfOutlines(n?.kids),
  }));
}

function runQpdfJson(qpdfPath, pdfPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    // --warning-exit-0: 壊れかけ xref 等の警告だけで exit 3 になるのを防ぐ
    // (しおりが読めていれば十分。修復は pdf-repair の領分)。
    const args = [
      "--json=2",
      "--json-key=outlines",
      "--no-warn",
      "--warning-exit-0",
      pdfPath,
    ];
    const child = spawn(qpdfPath, args, { windowsHide: true });
    const out = [];
    let outLen = 0;
    let errText = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`qpdf outline extraction timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      outLen += chunk.length;
      if (outLen > MAX_STDOUT_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        reject(new Error("qpdf outline extraction: stdout too large"));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errText += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`qpdf exited ${code}: ${errText.trim().slice(0, 400)}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

// テキスト選択モード — OCR 済み PDF の文字をなぞって選択し、コピーする。
//
// ページは canvas (画像) として描画されるため、そのままでは文字を選択
// できない。このモジュールは mupdf の structured text (行単位の box) を
// kpdf3.getPageText で取得し、ページ画像の上に「透明な文字」レイヤーを
// 重ねる。文字自体は透明だが選択ハイライトは見えるので、Adobe / ブラウザ
// の PDF ビューアと同じ操作感で選択 → Ctrl+C できる (pdf.js textLayer と
// 同じ手法)。
//
// 設計上の約束:
//   - 表示専用の追加レイヤー。既存の描画・保存・印刷経路 (exporter /
//     rotate-place / byte-copy) には一切触れない。
//   - 座標は fitz 空間 (post-/Rotate、page bounds 左上原点) × zoom。これは
//     viewer の pixmap と同一空間なので、canvas と同じ「中央合わせ +
//     rotate(userRotation)」でレイヤーごと回すと userRotation にも追従する
//     (viewer.js の canvas 描画と同じ流儀)。
//   - テキストは pageNo キーでキャッシュ (point 座標なので zoom 非依存)。
//     タブ切替 / PDF 差し替え時は reset() を呼んでもらう。

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container            viewer container (.viewer-page 群の祖先)
 * @param {() => number} deps.getZoom
 * @param {() => Array<{pageNo:number, userRotation?:number}>} deps.getPages
 * @param {(pageNo:number) => Promise<{w:number,h:number,lines:Array<{x:number,y:number,w:number,h:number,text:string,size:number,wmode:0|1}>}>} deps.getPageText
 */
export function initTextSelect({ container, getZoom, getPages, getPageText }) {
  let enabled = false;
  /** @type {Map<number, Promise<{w:number,h:number,lines:any[]}>>} */
  const cache = new Map();
  /** @type {IntersectionObserver | null} */
  let io = null;
  const measureCtx = document.createElement("canvas").getContext("2d");

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    container.classList.toggle("text-select-mode", on);
    if (on) observePages();
    else teardown();
  }

  /** タブ切替 / PDF 差し替えで呼ぶ。キャッシュを捨てて (必要なら) 作り直す。 */
  function reset() {
    cache.clear();
    if (enabled) {
      for (const layer of container.querySelectorAll(".text-select-layer")) {
        layer.remove();
      }
      observePages();
    }
  }

  function observePages() {
    io?.disconnect();
    // 見えているページだけ取得・構築する (数百ページの一括抽出を避ける)。
    io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) void buildLayer(/** @type {HTMLElement} */ (en.target));
        }
      },
      { root: container, rootMargin: "200px" },
    );
    for (const div of container.querySelectorAll(".viewer-page")) {
      io.observe(div);
    }
  }

  function teardown() {
    io?.disconnect();
    io = null;
    for (const layer of container.querySelectorAll(".text-select-layer")) {
      layer.remove();
    }
    // 選択が残っているとモード解除後も青ハイライトが見えるので解除する。
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  }

  function fetchText(pageNo) {
    let entry = cache.get(pageNo);
    if (!entry) {
      entry = getPageText(pageNo).catch(() => ({ w: 0, h: 0, lines: [] }));
      cache.set(pageNo, entry);
    }
    return entry;
  }

  async function buildLayer(div) {
    if (!enabled) return;
    const pageNo = Number(div.dataset.pageNo) || 0;
    if (pageNo <= 0) return; // synthetic page はソーステキストなし
    if (div.querySelector(":scope > .text-select-layer")) return;
    const data = await fetchText(pageNo);
    // await 中にモード解除 / ページ DOM 差し替えが起きたら捨てる。
    if (!enabled || !div.isConnected) return;
    if (div.querySelector(":scope > .text-select-layer")) return;
    if (!data || data.w <= 0 || data.h <= 0 || data.lines.length === 0) return;

    const z = getZoom() || 1;
    const row = getPages()?.find((p) => p.pageNo === pageNo);
    const userRot = (((row?.userRotation ?? 0) % 360) + 360) % 360;

    const layer = document.createElement("div");
    layer.className = "text-select-layer";
    layer.style.width = `${data.w * z}px`;
    layer.style.height = `${data.h * z}px`;
    layer.style.left = "50%";
    layer.style.top = "50%";
    layer.style.transform = `translate(-50%, -50%) rotate(${userRot}deg)`;

    for (const line of data.lines) {
      // 行 = block 要素 1 つ。コピー時に Chromium が block 境界で改行を
      // 入れてくれるので、複数行選択が自然な改行付きテキストになる。
      const el = document.createElement("div");
      el.className = "text-select-line";
      el.textContent = line.text;
      const fontPx = Math.max(1, (line.size || line.h) * z);
      el.style.left = `${line.x * z}px`;
      el.style.top = `${line.y * z}px`;
      el.style.fontSize = `${fontPx}px`;
      if (line.wmode === 1) {
        // 縦書き行: bbox 高さに合わせて縦に流す。
        el.style.writingMode = "vertical-rl";
        el.style.height = `${line.h * z}px`;
      } else {
        el.style.lineHeight = `${line.h * z}px`;
        // 実フォントの字送りは PDF の字送りと一致しないので、実測幅 →
        // bbox 幅への横スケールで選択の当たり位置を合わせる。
        measureCtx.font = `${fontPx}px sans-serif`;
        const measured = measureCtx.measureText(line.text).width;
        if (measured > 0) {
          el.style.transform = `scaleX(${(line.w * z) / measured})`;
        }
      }
      layer.appendChild(el);
    }
    div.appendChild(layer);
  }

  // zoom / 回転 / ページ操作で viewer がページ DOM を作り直したら旧レイヤー
  // は DOM ごと消えている。観測を張り直して見えているページから再構築する
  // (テキスト自体は cache 済みなので IPC は再発行されない)。
  container.addEventListener("kpdf3:pages-rebuilt", () => {
    if (enabled) observePages();
  });

  return { setEnabled, reset, isEnabled: () => enabled };
}

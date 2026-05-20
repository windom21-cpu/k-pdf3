// β.105: OS インストール済フォント一覧を取得し、<select> へ <optgroup>
// として動的に追加する共通ロジック。renderer.js と stamp-dialogs.js
// から呼ばれる (どちらも renderer 側、main IPC `kpdf3:list-system-fonts`
// が単一ソース。main 側は session キャッシュ持ち、ここでも renderer
// 側で 1 セッション 1 回だけ promise を fire する)。
//
// 既存 select の HTML option はそのまま <optgroup label="プリセット">
// に詰め直し、system フォントは末尾に <optgroup label="システム">。
// fontFace 値は preset 名 (mincho/gothic/...) もしくは OS フォント名
// (= preset に存在しない任意文字列) のどちらでも保存される。viewer /
// 印刷経路は fonts.js の getTextFontStack / getStampFontStack で解決
// (preset 名以外は CSS font-family にダイレクトに引き渡す)。

const { kpdf3 } = window;

let _systemFontsPromise = null;

function _loadSystemFontsOnce() {
  if (_systemFontsPromise) return _systemFontsPromise;
  if (!kpdf3?.listSystemFonts) {
    _systemFontsPromise = Promise.resolve([]);
    return _systemFontsPromise;
  }
  _systemFontsPromise = kpdf3.listSystemFonts().then(
    (fonts) => (Array.isArray(fonts) ? fonts : []),
    (err) => {
      console.warn("[system-fonts] load failed:", err);
      return [];
    },
  );
  return _systemFontsPromise;
}

/**
 * 与えた <select> に <optgroup label="プリセット"> + <optgroup label="システム">
 * を構築する。元 option は preset 側へ移動。既に append 済の場合は no-op。
 *
 * @param {HTMLSelectElement} sel
 * @param {{presetLabel?: string}} [opts]
 */
export async function appendSystemFontsToSelect(sel, opts = {}) {
  if (!sel || sel._systemFontsAppended) return;
  const fonts = await _loadSystemFontsOnce();
  if (!fonts.length) return;
  if (sel._systemFontsAppended) return; // 二重 fire 防御 (await 中に再呼出)
  sel._systemFontsAppended = true;
  const oldValue = sel.value;
  const presetLabel = opts.presetLabel ?? "プリセット";
  const presetGroup = document.createElement("optgroup");
  presetGroup.label = presetLabel;
  const existing = [...sel.querySelectorAll("option")];
  for (const opt of existing) presetGroup.appendChild(opt);
  sel.innerHTML = "";
  sel.appendChild(presetGroup);
  const sysGroup = document.createElement("optgroup");
  sysGroup.label = "システム";
  for (const name of fonts) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    opt.style.fontFamily = `"${name.replace(/"/g, '\\"')}"`;
    sysGroup.appendChild(opt);
  }
  sel.appendChild(sysGroup);
  if (oldValue) sel.value = oldValue;
}

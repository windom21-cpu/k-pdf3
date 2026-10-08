// フォーム枠の「連動グループ」(2026-10-08) — 純関数。
//
// 要望: テンプレのテキスト枠①に記入した内容を③にも自動で入れたい。ただし
// ③は既定では①と同じ内容になるが、必要なら③だけ別の内容を手入力できる。
//
// 仕組み (radio の radioGroupId と同じ「同じ名前 = 同じ仲間」方式):
//   - text 枠の properties.linkGroup (文字列) が同じ枠が 1 つのグループ。
//   - グループの「連動元」= Tab 順で最初の枠 (①)。残りは「連動先」。
//   - ①を commit → 連動先は全部①の新しい値に揃える (手入力で別の内容に
//     していた連動先も①に戻る。ユーザー指定 2026-10-08: 「①を直したら③も
//     連動させたい」)。
//   - 連動先を commit → 他には伝播しない (①は変わらない) = ③だけ別の内容
//     にできる。空にして commit したときは①の現在値に戻る。
//
// 呼び出し側 (overlay-edit.handleTextEditCommit) は返った patch を
// CompositeCommand で 1 回の履歴 (Undo 1 回) にまとめて適用する。
// 描画 (viewer / exporter) は各枠の value をそのまま描くので変更なし。

/**
 * @param {object} args
 * @param {Array<{id:string, type:string, properties?:object}>} args.fields
 *   overlay スナップショット (form_field 以外が混ざっていてよい)
 * @param {string} args.editedId   commit された枠
 * @param {string} [args.oldValue] commit 前の値 (互換のため受け取るが未使用)
 * @param {string} args.newValue   commit 後の値
 * @param {string[]} args.orderIds  Tab 順 (id 配列)。無い id は末尾扱い
 * @returns {Array<{id:string, value:string}>}  editedId 以外に適用する value
 */
export function planLinkPropagation({ fields, editedId, oldValue, newValue, orderIds }) {
  const edited = fields.find((o) => o.id === editedId);
  const group = linkGroupOf(edited);
  if (!group) return [];
  const members = fields
    .filter((o) => isTextField(o) && linkGroupOf(o) === group)
    .sort((a, b) => rank(a.id, orderIds) - rank(b.id, orderIds));
  if (members.length < 2) return [];
  const master = members[0];
  void oldValue;
  const next = newValue ?? "";
  if (master.id === editedId) {
    const out = [];
    for (const f of members) {
      if (f.id === editedId) continue;
      const cur = f.properties?.value ?? "";
      if (cur !== next) out.push({ id: f.id, value: next });
    }
    return out;
  }
  // 連動先の commit: 空にしたときだけ①の現在値に戻す。
  if (next === "") {
    const mv = master.properties?.value ?? "";
    if (mv !== "") return [{ id: editedId, value: mv }];
  }
  return [];
}

/** 枠が連動グループの「連動元」(Tab 順で最初) かどうか。UI 表示用。 */
export function linkRoleOf(field, fields, orderIds) {
  const group = linkGroupOf(field);
  if (!group) return null;
  const members = fields
    .filter((o) => isTextField(o) && linkGroupOf(o) === group)
    .sort((a, b) => rank(a.id, orderIds) - rank(b.id, orderIds));
  if (members.length < 2) return "alone";
  return members[0].id === field.id ? "master" : "follower";
}

export function linkGroupOf(o) {
  const g = o?.properties?.linkGroup;
  return typeof g === "string" ? g.trim() : "";
}

function isTextField(o) {
  return o && o.type === "form_field" && o.properties?.fieldKind === "text";
}

function rank(id, orderIds) {
  const i = Array.isArray(orderIds) ? orderIds.indexOf(id) : -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

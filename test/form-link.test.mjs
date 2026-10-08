// フォーム枠の連動グループ (form-link.js、2026-10-08) — 純関数テスト。
//
//   ① (Tab 順で最初 = 連動元) に記入 → ③に同じ値
//   ③を手入力で別の内容にできる (①には伝播しない)
//   ①を直すと③は別内容にしていても①に揃う (ユーザー指定 2026-10-08)
//   ③を空にして commit すると①の値に戻る

import { test } from "node:test";
import assert from "node:assert/strict";
import { planLinkPropagation, linkRoleOf } from "../src/renderer/form-link.js";

function tf(id, value, linkGroup) {
  return { id, type: "form_field", properties: { fieldKind: "text", value, linkGroup } };
}
const order = ["f1", "f2", "f3", "f4"];

test("①に記入 → 空の③に伝播、別グループ / 連動なし / check には触らない", () => {
  const fields = [
    tf("f1", "", "氏名"),
    tf("f2", "", ""),            // 連動なし
    tf("f3", "", "氏名"),
    tf("f4", "", "住所"),         // 別グループ
    { id: "c1", type: "form_field", properties: { fieldKind: "check", value: "", linkGroup: "氏名" } },
  ];
  const out = planLinkPropagation({ fields, editedId: "f1", oldValue: "", newValue: "山田", orderIds: order });
  assert.deepEqual(out, [{ id: "f3", value: "山田" }]);
});

test("①を書き換え → 追従中の③も、手入力で別内容にした③も①に揃う", () => {
  const fields = [
    tf("f1", "山田", "氏名"),
    tf("f3", "山田", "氏名"),  // 追従中
    tf("f4", "佐藤", "氏名"),  // 手入力で上書き済み → ①を直せば揃う
    tf("f2", "田中", "氏名"),  // 既に新しい値と同じ → patch 不要
  ];
  const out = planLinkPropagation({ fields, editedId: "f1", oldValue: "山田", newValue: "田中", orderIds: order });
  assert.deepEqual(out, [{ id: "f3", value: "田中" }, { id: "f4", value: "田中" }]);
});

test("③ (連動先) を手入力 → ①には伝播しない", () => {
  const fields = [tf("f1", "山田", "氏名"), tf("f3", "山田", "氏名")];
  const out = planLinkPropagation({ fields, editedId: "f3", oldValue: "山田", newValue: "佐藤", orderIds: order });
  assert.deepEqual(out, []);
});

test("③を空にして commit → ①の現在値に戻る", () => {
  const fields = [tf("f1", "山田", "氏名"), tf("f3", "佐藤", "氏名")];
  const out = planLinkPropagation({ fields, editedId: "f3", oldValue: "佐藤", newValue: "", orderIds: order });
  assert.deepEqual(out, [{ id: "f3", value: "山田" }]);
  // ①も空なら何もしない
  const out2 = planLinkPropagation({
    fields: [tf("f1", "", "氏名"), tf("f3", "x", "氏名")],
    editedId: "f3", oldValue: "x", newValue: "", orderIds: order,
  });
  assert.deepEqual(out2, []);
});

test("連動元は Tab 順で決まる (明示 Tab 順で③が先なら③が連動元)", () => {
  const fields = [tf("f1", "", "氏名"), tf("f3", "", "氏名")];
  const out = planLinkPropagation({ fields, editedId: "f3", oldValue: "", newValue: "山田", orderIds: ["f3", "f1"] });
  assert.deepEqual(out, [{ id: "f1", value: "山田" }]);
  assert.equal(linkRoleOf(fields[1], fields, ["f3", "f1"]), "master");
  assert.equal(linkRoleOf(fields[0], fields, ["f3", "f1"]), "follower");
});

test("グループ名は前後空白を無視、1 枠だけのグループは連動なし", () => {
  const fields = [tf("f1", "", " 氏名 "), tf("f3", "", "氏名")];
  const out = planLinkPropagation({ fields, editedId: "f1", oldValue: "", newValue: "a", orderIds: order });
  assert.deepEqual(out, [{ id: "f3", value: "a" }]);
  const alone = [tf("f1", "", "氏名")];
  assert.deepEqual(planLinkPropagation({ fields: alone, editedId: "f1", oldValue: "", newValue: "a", orderIds: order }), []);
  assert.equal(linkRoleOf(alone[0], alone, order), "alone");
  assert.equal(linkRoleOf(tf("x", "", ""), alone, order), null);
});

test("①を空に戻す → 連動先も全部空に", () => {
  const fields = [tf("f1", "山田", "氏名"), tf("f3", "山田", "氏名"), tf("f4", "佐藤", "氏名")];
  const out = planLinkPropagation({ fields, editedId: "f1", oldValue: "山田", newValue: "", orderIds: order });
  assert.deepEqual(out, [{ id: "f3", value: "" }, { id: "f4", value: "" }]);
});

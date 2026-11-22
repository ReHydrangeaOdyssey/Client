import {boundary, fail, ok, opfsDirectory, writeFile} from "./io.js";

const DB_NAME = "reorsg-offline";
const STORE = "quest";
const ROOT_KEY = "state";
const U32_MAX = 4294967295;
const validId = value => Number.isInteger(value) && value >= 0 && value <= U32_MAX;
const validCount = value => Number.isSafeInteger(value) && value > 0;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("別のタブで保存データを使用しています"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function transaction(change, mode = "readwrite") {
  const result = await boundary(async () => {
    const db = await openDatabase();
    return new Promise(resolve => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const request = store.get(ROOT_KEY);
      let answer = fail("保存処理に失敗しました");
      request.onsuccess = () => {
        const state = request.result ?? {
          next_run_id: 1, offline_balance_revision: 0, balances: {}, results: {},
        };
        try {
          answer = change(state);
          if (!answer.ok) { tx.abort(); return; }
          if (mode === "readwrite") store.put(state, ROOT_KEY);
        } catch (error) {
          answer = fail(error.message);
          tx.abort();
        }
      };
      tx.oncomplete = () => { db.close(); resolve(answer); };
      tx.onabort = () => { db.close(); resolve(answer.ok ? fail(tx.error?.message ?? "保存が中断されました") : answer); };
      tx.onerror = () => { answer = fail(tx.error?.message ?? "保存処理に失敗しました"); };
    });
  });
  return result.ok ? result.value : result;
}

export async function acquireQuestLease() {
  if (!navigator.locks) return fail("このブラウザーではQuestの排他保存を利用できません");
  return new Promise(resolve => {
    const request = navigator.locks.request("reorsg-quest-run", {mode: "exclusive", ifAvailable: true},
      async lock => {
        if (!lock) { resolve(fail("別のタブでQuestを実行中です")); return; }
        let release;
        let held = true;
        const done = new Promise(end => { release = end; });
        let pending = 0;
        let closing = false;
        const lease = {
          async perform(work) {
            if (!held || closing) return fail("Questの実行権がありません");
            pending++;
            try { return await work(); }
            finally { pending--; if (closing && pending === 0) release(); }
          },
          release() { closing = true; if (pending === 0) release(); },
        };
        resolve(ok(new QuestStorage(lease)));
        await done;
        held = false;
      });
    request.catch(error => resolve(fail(error.message)));
  });
}

class QuestStorage {
  #lease;
  #busy = false;
  constructor(lease) { this.#lease = lease; }
  release() { this.#lease.release(); }
  async #exclusive(work) {
    if (this.#busy) return fail("Questの保存処理中です");
    this.#busy = true;
    try {
      const result = await boundary(() => this.#lease.perform(work));
      return result.ok ? result.value : result;
    }
    finally { this.#busy = false; }
  }
  allocateRun() {
    return this.#exclusive(() => transaction(state => {
      if (Object.values(state.results).some(result => !result.reward_receipt_acknowledged))
        return fail("先にQuestの報酬を確認してください");
      if (!Number.isSafeInteger(state.next_run_id) || state.next_run_id < 1
          || state.next_run_id === Number.MAX_SAFE_INTEGER) return fail("QuestRunIDの上限です");
      const id = state.next_run_id;
      state.next_run_id++;
      return ok(id);
    }));
  }
  results() {
    return this.#exclusive(() => transaction(state => ok(structuredClone(state)), "readonly"));
  }
  finalize(runId, questId, fixedRewards, drops) {
    return this.#exclusive(() => transaction(state => {
      if (!validCount(runId) || runId >= state.next_run_id || !validId(questId))
        return fail("不正なQuest結果です");
      const existing = state.results[runId];
      if (existing) {
        if (existing.quest_id !== questId || JSON.stringify(existing.fixed_rewards) !== JSON.stringify(fixedRewards)
            || JSON.stringify(existing.drops) !== JSON.stringify(drops)) return fail("確定済み結果と一致しません");
        return ok(structuredClone(existing));
      }
      if (![fixedRewards, drops].every(Array.isArray) || drops.length > 4)
        return fail("不正な報酬明細です");
      if ([...fixedRewards, ...drops].some(item => !validId(item.item_id) || !validCount(item.count)))
        return fail("不正な報酬明細です");
      const result = {
        quest_run_id: runId, quest_id: questId,
        result_finalized: true, reward_applied: false, reward_receipt_acknowledged: false,
        fixed_rewards: structuredClone(fixedRewards), drops: structuredClone(drops),
      };
      state.results[runId] = result;
      return ok(structuredClone(result));
    }));
  }
  receive(runId) {
    return this.#exclusive(() => transaction(state => {
      const result = state.results[runId];
      if (!result?.result_finalized) return fail("確定したQuest結果がありません");
      if (result.reward_applied) return ok(structuredClone(result));
      for (const item of [...result.fixed_rewards, ...result.drops]) {
        const before = state.balances[item.item_id] ?? 0;
        if (!Number.isSafeInteger(before) || before < 0 || !validCount(item.count) || !validId(item.item_id))
          return fail("所持数または報酬データが不正です");
        // New offline balance = committed balance + awarded quantity, bounded by JSON safe integers.
        const balance = before + item.count;
        if (!Number.isSafeInteger(balance)) return fail("所持数の上限です");
        state.balances[item.item_id] = balance;
      }
      if (!Number.isSafeInteger(state.offline_balance_revision) || state.offline_balance_revision < 0
          || !Number.isSafeInteger(state.offline_balance_revision + 1)) return fail("保存世代の上限です");
      state.offline_balance_revision++;
      result.offline_balance_revision = state.offline_balance_revision;
      result.reward_applied = true;
      return ok(structuredClone(result));
    }));
  }
  acknowledge(runId) {
    return this.#exclusive(() => transaction(state => {
      const result = state.results[runId];
      if (!result?.reward_applied) return fail("先に報酬を受け取ってください");
      result.reward_receipt_acknowledged = true;
      return ok(structuredClone(result));
    }));
  }
  readCheckpoint() {
    return this.#exclusive(async () => {
      const result = await boundary(async () => {
        const directory = await opfsDirectory([".cache"]);
        const handle = await directory.getFileHandle("quest.json");
        return (await handle.getFile()).text();
      });
      return result;
    });
  }
  saveCheckpoint(text, validate) {
    return this.#exclusive(async () => {
      const validated = validate(text);
      if (!validated.ok) return validated;
      const snapshot = JSON.parse(text);
      const state = await transaction(value => ok(structuredClone(value)), "readonly");
      if (!state.ok) return state;
      if (!validCount(snapshot.quest_run_id) || snapshot.quest_run_id >= state.value.next_run_id)
        return fail("未採番のQuestRunIDです");
      if (Object.values(state.value.results).some(result => !result.reward_receipt_acknowledged)
          || state.value.results[snapshot.quest_run_id]?.result_finalized)
        return fail("確定したQuest結果があるため戦闘データを更新できません");
      const result = await boundary(async () => {
        const directory = await opfsDirectory([".cache"], true);
        await writeFile(directory, "quest.pending.json", text);
        const handle = await directory.getFileHandle("quest.pending.json");
        const saved = await (await handle.getFile()).text();
        const checked = validate(saved);
        if (!checked.ok || saved !== text) return fail("再開データの保存検証に失敗しました");
        // createWritable keeps the prior committed file until close succeeds.
        await writeFile(directory, "quest.json", saved);
        return ok(null);
      });
      return result.ok ? result.value : result;
    });
  }
  deleteCheckpoint(expectedRunId, explicitlyDeclined = false) {
    return this.#exclusive(async () => {
      const state = await transaction(value => ok(structuredClone(value)), "readonly");
      if (!state.ok) return state;
      const result = state.value.results[expectedRunId];
      if (!explicitlyDeclined && !result?.reward_applied) return fail("報酬の保存が完了していません");
      const removed = await boundary(async () => {
        const directory = await opfsDirectory([".cache"]);
        const handle = await directory.getFileHandle("quest.json");
        const snapshot = JSON.parse(await (await handle.getFile()).text());
        if (snapshot.quest_run_id !== expectedRunId) return fail("別のQuestの保存データです");
        await directory.removeEntry("quest.json");
        return ok(null);
      });
      return removed.ok ? removed.value : removed;
    });
  }
}

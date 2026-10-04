// Pure data operations. No Tavern Helper, DOM, or network dependency.
export const KEY = 'worldbook_regex_native';
export const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const emptyState = () => ({ version: 1, enabled: true, bindings: [], library: [] });

function requireValue(condition, message) {
    if (!condition) throw new Error(message);
}

export function validateState(value) {
    requireValue(value?.version === 1 && typeof value.enabled === 'boolean', '不支援或損壞的備份版本。');
    requireValue(Array.isArray(value.bindings) && Array.isArray(value.library), '綁定／備份清單格式錯誤。');
    const ids = new Set();
    for (const entry of value.library) {
        requireValue(typeof entry?.id === 'string' && entry.id.length > 0 && !ids.has(entry.id), '正則 ID 缺少或重複。');
        requireValue(entry.script?.id === entry.id && typeof entry.script.scriptName === 'string'
            && typeof entry.script.findRegex === 'string' && typeof entry.script.replaceString === 'string'
            && Array.isArray(entry.script.placement), '正則備份不完整；不會覆寫目前設定。');
        requireValue(Number.isInteger(entry.index) && entry.index >= 0, '正則排序資料錯誤。');
        ids.add(entry.id);
    }
    const books = new Set();
    for (const binding of value.bindings) {
        requireValue(typeof binding?.worldbook === 'string' && binding.worldbook.length > 0
            && !books.has(binding.worldbook) && Array.isArray(binding.regexIds), '世界書綁定格式錯誤。');
        requireValue(binding.regexIds.every(id => ids.has(id))
            && new Set(binding.regexIds).size === binding.regexIds.length, '綁定指向不存在或重複的正則備份。');
        books.add(binding.worldbook);
    }
    return clone(value);
}

const boundIds = bindings => new Set(bindings.flatMap(item => item.regexIds));

export function capture(state, scripts, ids) {
    scripts.forEach((script, index) => {
        if (!ids.has(script.id)) return;
        const existing = state.library.find(entry => entry.id === script.id);
        if (existing) {
            existing.script = clone(script);
            // Keep original slots while other managed scripts are unloaded.
        } else {
            state.library.push({ id: script.id, index, script: clone(script) });
        }
    });
}

/** Immutable transaction: snapshots and the global list are committed together. */
export function reconcile(input, current, activeBooks, previousBindings = input.bindings) {
    const state = validateState(input);
    requireValue(Array.isArray(current), '酒館的全域正則欄位不是清單。');
    const managed = boundIds(state.bindings);
    const previous = boundIds(previousBindings);
    const allManaged = new Set([...managed, ...previous]);
    const currentIds = current.filter(item => allManaged.has(item.id)).map(item => item.id);
    requireValue(new Set(currentIds).size === currentIds.length, '全域清單有重複的綁定正則 ID；已停止同步，請先處理重複項目。');
    capture(state, current, allManaged);
    const wanted = new Set(state.bindings.filter(b => activeBooks.has(b.worldbook)).flatMap(b => b.regexIds));
    const released = new Set([...previous].filter(id => !managed.has(id)));
    const scripts = current.filter(script => !managed.has(script.id) || !state.enabled || wanted.has(script.id)).map(clone);
    for (const entry of [...state.library].sort((a, b) => a.index - b.index)) {
        const shouldRestore = released.has(entry.id) || managed.has(entry.id) && (!state.enabled || wanted.has(entry.id));
        if (!shouldRestore) continue;
        let script = scripts.find(item => item.id === entry.id);
        if (!script) {
            script = clone(entry.script);
            scripts.splice(Math.min(entry.index, scripts.length), 0, script);
        }
        if (state.enabled && managed.has(entry.id)) script.disabled = false;
    }
    validateState(state);
    return { state, scripts, stateChanged: !equal(input, state), listChanged: !equal(current, scripts) };
}

export function setBookBinding(input, current, worldbook, ids) {
    const state = clone(input);
    capture(state, current, new Set(ids));
    state.bindings = state.bindings.filter(b => b.worldbook !== worldbook);
    if (ids.length) state.bindings.push({ worldbook, regexIds: [...new Set(ids)] });
    return validateState(state);
}

export function mergeBackup(current, backup) {
    const imported = validateState(backup);
    const next = clone(current);
    // Conflicting IDs must never silently replace a user's different regex.
    for (const entry of imported.library) {
        const existing = next.library.find(item => item.id === entry.id);
        requireValue(!existing || equal(existing.script, entry.script), `正則 ID 衝突：${entry.script.scriptName}。請先匯出目前備份。`);
        if (!existing) next.library.push(entry);
    }
    for (const binding of imported.bindings) {
        const existing = next.bindings.find(item => item.worldbook === binding.worldbook);
        if (existing) existing.regexIds = [...new Set([...existing.regexIds, ...binding.regexIds])];
        else next.bindings.push(binding);
    }
    return validateState(next);
}

export function decodeBackup(value) {
    if (value?.version === 1) return validateState(value);
    const legacy = value?.data?.worldbook_regex_binder ?? value?.worldbook_regex_binder;
    requireValue(legacy?.version === 4 && Array.isArray(legacy.bindings), '請選擇本插件備份，或包含變數的舊 v4 腳本匯出檔。');
    const state = emptyState();
    for (const binding of legacy.bindings) {
        const ids = [];
        for (const target of binding.regexes ?? []) {
            requireValue(target.scope === 'global', '舊備份含非全域綁定，請先分開處理。');
            requireValue(target.regex?.raw?.id === target.id, '舊備份缺少完整原生正則快照；請先從酒館匯出正則。');
            const existing = state.library.find(item => item.id === target.id);
            requireValue(!existing || equal(existing.script, target.regex.raw), '舊備份中的同 ID 快照不一致。');
            if (!existing) state.library.push({ id: target.id, index: target.index ?? 0, script: clone(target.regex.raw) });
            ids.push(target.id);
        }
        state.bindings.push({ worldbook: binding.worldbook, regexIds: ids });
    }
    return validateState(state);
}

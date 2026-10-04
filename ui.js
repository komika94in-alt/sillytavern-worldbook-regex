import { KEY, emptyState, validateState, reconcile, setBookBinding, mergeBackup, decodeBackup } from './core.js';

export function createBinder(ctx, worldInfo, doc) {
    const win = doc.defaultView;
    let timer, poll, observer, running = false, pending = false, stopped = false;
    let lastSignature = '', lastError = '', lastSync = '尚未同步';
    const listeners = [];
    const readState = () => ctx.extensionSettings[KEY] === undefined
        ? emptyState() : validateState(ctx.extensionSettings[KEY]);
    const globals = () => ctx.extensionSettings.regex ?? [];
    const active = () => {
        if (!Array.isArray(worldInfo.selected_world_info)) throw new Error('此酒館版本未提供即時全域世界書清單；為避免誤卸載，已停止同步。');
        return new Set(worldInfo.selected_world_info);
    };
    function report(error) {
        lastError = error.message ?? String(error);
        console.error('[世界書正則綁定]', error);
        win.toastr?.error(lastError, '世界書正則綁定');
    }
    function element(tag, text, className) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function button(label, action) {
        const node = element('button', label, 'menu_button');
        node.type = 'button';
        node.addEventListener('click', () => Promise.resolve().then(action).catch(report));
        return node;
    }
    function commit(transaction, force = false) {
        if (!force && !transaction.stateChanged && !transaction.listChanged) return;
        const priorState = ctx.extensionSettings[KEY];
        const priorRegex = ctx.extensionSettings.regex;
        // Both fields belong to the same settings payload; never save removal without its snapshot.
        ctx.extensionSettings[KEY] = transaction.state;
        ctx.extensionSettings.regex = transaction.scripts;
        try { ctx.saveSettingsDebounced(); }
        catch (error) {
            ctx.extensionSettings[KEY] = priorState;
            ctx.extensionSettings.regex = priorRegex;
            throw error;
        }
    }
    async function refreshList() {
        // ST's regex renderer isn't exported. Its CHAT_CHANGED listener clears the
        // regex cache and rebuilds the actual native list, including edit controls.
        // Never re-initialize the regex extension or reload a chat during generation.
        await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, ctx.getCurrentChatId());
    }
    async function synchronize() {
        if (stopped) return;
        if (running) { pending = true; return; }
        running = true;
        try {
            do {
                pending = false;
                const transaction = reconcile(readState(), globals(), active());
                commit(transaction);
                lastSync = new Date().toLocaleTimeString();
                lastError = '';
                if (transaction.listChanged) await refreshList();
            } while (pending && !stopped);
        } catch (error) { report(error); }
        finally { running = false; }
    }
    function schedule() {
        if (stopped) return;
        win.clearTimeout(timer);
        timer = win.setTimeout(() => void synchronize(), 50);
    }
    async function apply(next) {
        const previous = readState();
        const transaction = reconcile(next, globals(), active(), previous.bindings);
        commit(transaction, true);
        if (transaction.listChanged) await refreshList();
        schedule();
    }
    function exportBackup() {
        const transaction = reconcile(readState(), globals(), active());
        // Export captures edits without mutating the live list.
        const blob = new win.Blob([JSON.stringify(transaction.state, null, 2)], { type: 'application/json' });
        const url = win.URL.createObjectURL(blob);
        const anchor = element('a');
        anchor.href = url;
        anchor.download = `worldbook-regex-backup-${new Date().toISOString().slice(0, 10)}.json`;
        doc.body.append(anchor);
        anchor.click();
        anchor.remove();
        win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    }
    async function importBackup(file) {
        const backup = decodeBackup(JSON.parse(await file.text()));
        const result = await ctx.callGenericPopup(
            `匯入 ${backup.bindings.length} 本世界書、${backup.library.length} 個正則備份？綁定會合併，並立即依全域世界書選區同步。`,
            ctx.POPUP_TYPE.CONFIRM,
        );
        if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return false;
        // Read the current settings after confirmation, not before it.
        const current = reconcile(readState(), globals(), active()).state;
        // Compare imported snapshots with unbound live regexes too.
        for (const entry of backup.library) {
            const live = globals().find(script => script.id === entry.id);
            if (live && JSON.stringify(live) !== JSON.stringify(entry.script)) {
                throw new Error(`全域正則與備份同 ID 但內容不同：${entry.script.scriptName}。請先另行備份並處理衝突。`);
            }
        }
        await apply(mergeBackup(current, backup));
        return true;
    }
    async function openManager() {
        const state = readState();
        const draft = new Map(state.bindings.map(b => [b.worldbook, new Set(b.regexIds)]));
        const books = [...new Set([...(worldInfo.world_names ?? []), ...draft.keys()])].sort();
        const root = element('div', undefined, 'wbr-panel');
        root.append(element('h3', '世界書 × 全域正則綁定'));
        root.append(element('p', '只跟隨「全域世界書」選區。套用＝加入並開啟正則；卸下＝從全域正則清單移除並保留備份。解除最後一個綁定會把正則交回全域清單。'));
        if (doc.getElementById('th-worldbook-regex-binder-button')) {
            root.append(element('p', '⚠ 偵測到舊酒館助手腳本入口。請停用舊腳本並重新整理，避免兩套同步互相覆寫。'));
        }
        if (ctx.extensionSettings.disabledExtensions?.includes('regex')) {
            root.append(element('p', '⚠ 酒館內建「正則」擴充目前已停用。請先在擴充功能清單啟用它，正則才會實際執行。'));
        }
        const enabledLabel = element('label');
        const enabled = element('input');
        enabled.type = 'checkbox'; enabled.checked = state.enabled;
        enabledLabel.append(enabled, doc.createTextNode(' 啟用自動綁定（關閉並儲存會還原所有綁定正則，停止管理）'));
        root.append(enabledLabel);
        const select = element('select', undefined, 'text_pole');
        select.setAttribute('aria-label', '綁定的世界書');
        for (const book of books) {
            const option = element('option', book + ((worldInfo.world_names ?? []).includes(book) ? '' : '（不存在／已改名）'));
            option.value = book; select.append(option);
        }
        const editor = doc.querySelector('#world_editor_select');
        const selectedIndex = editor?.value;
        const preferred = selectedIndex !== undefined && selectedIndex !== '' ? worldInfo.world_names?.[Number(selectedIndex)] : null;
        if (books.includes(preferred)) select.value = preferred;
        root.append(select);
        const status = element('div', undefined, 'wbr-status');
        const list = element('div', undefined, 'wbr-list');
        root.append(status, list);
        function render() {
            const book = select.value;
            const ids = draft.get(book) ?? new Set();
            const current = globals();
            const saved = readState();
            const candidates = new Map(saved.library.map(entry => [entry.id, entry.script]));
            for (const script of current) if (script.id) candidates.set(script.id, script);
            status.textContent = `即時全域選取：${[...active()].join('、') || '無'}\n目前世界書：${book || '無世界書'}｜綁定 ${ids.size} 個｜${active().has(book) ? '已套用' : '未套用'}\n上次同步：${lastSync}${lastError ? `\n錯誤：${lastError}` : ''}`;
            list.replaceChildren();
            if (!candidates.size) list.append(element('p', '請先在酒館的全域正則清單匯入正則，或使用下方匯入備份。'));
            for (const [id, script] of candidates) {
                const row = element('label', undefined, 'wbr-row');
                const check = element('input');
                check.type = 'checkbox'; check.checked = ids.has(id); check.disabled = !book;
                check.dataset.regexId = id;
                check.addEventListener('change', () => {
                    const values = draft.get(book) ?? new Set();
                    if (check.checked) values.add(id); else values.delete(id);
                    draft.set(book, values); render();
                });
                const live = current.find(item => item.id === id);
                row.append(check, element('span', script.scriptName || id), element('small', live ? live.disabled ? '全域／停用' : '全域／啟用' : '備份／已卸下'));
                list.append(row);
            }
        }
        select.addEventListener('change', render);
        const actions = element('div', undefined, 'wbr-actions');
        const upload = element('input');
        upload.type = 'file'; upload.accept = '.json,application/json'; upload.hidden = true;
        upload.addEventListener('change', async () => {
            try {
                if (upload.files[0] && await importBackup(upload.files[0])) {
                    // Refresh the draft after the explicit import action.
                    const imported = readState(); draft.clear();
                    imported.bindings.forEach(b => draft.set(b.worldbook, new Set(b.regexIds)));
                    for (const b of imported.bindings) if (!books.includes(b.worldbook)) {
                        books.push(b.worldbook);
                        const option = element('option', b.worldbook); option.value = b.worldbook; select.append(option);
                    }
                    render();
                }
            } catch (error) { report(error); }
            finally { upload.value = ''; }
        });
        actions.append(button('匯出已儲存備份', exportBackup), button('匯入備份／舊 v4', () => upload.click()), button('重新讀取狀態', render), upload);
        root.append(actions, element('p', '匯入是立即執行的獨立操作；下方「取消」只取消尚未儲存的勾選。世界書改名後，請將綁定移到新名稱。'));
        render();
        const result = await ctx.callGenericPopup(root, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: '儲存並同步', cancelButton: '取消', wide: true, large: true, allowVerticalScrolling: true,
        });
        if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        let next = readState();
        for (const [book, ids] of draft) next = setBookBinding(next, globals(), book, [...ids]);
        next.enabled = enabled.checked;
        await apply(next);
        win.toastr?.success('已儲存並同步全域正則。', '世界書正則綁定');
    }
    function mount() {
        if (doc.getElementById('wbr-worldbook-button')) return;
        const select = doc.querySelector('#world_editor_select');
        if (!select) return;
        const control = button('正則綁定', openManager);
        control.id = 'wbr-worldbook-button';
        control.title = '世界書 × 全域正則綁定（原生插件）';
        const anchor = select.nextElementSibling?.classList.contains('select2') ? select.nextElementSibling : select;
        anchor.insertAdjacentElement('afterend', control);
    }
    function start() {
        readState(); active(); // Fail closed on corrupt settings or unsupported ST.
        mount();
        observer = new win.MutationObserver(mount);
        observer.observe(doc.body, { childList: true, subtree: true });
        for (const name of ['WORLDINFO_SETTINGS_UPDATED', 'SETTINGS_UPDATED', 'CHAT_CHANGED']) {
            const event = ctx.eventTypes[name];
            if (event) { ctx.eventSource.on(event, schedule); listeners.push(event); }
        }
        // Also detect other extensions' writes without a native selection event.
        poll = win.setInterval(() => {
            const signature = JSON.stringify([worldInfo.selected_world_info, globals()]);
            if (signature !== lastSignature) { lastSignature = signature; schedule(); }
        }, 1000);
        schedule();
    }
    function stop() {
        stopped = true;
        win.clearTimeout(timer); win.clearInterval(poll); observer?.disconnect();
        for (const event of listeners) ctx.eventSource.removeListener(event, schedule);
        doc.getElementById('wbr-worldbook-button')?.remove();
    }
    return { start, stop, synchronize, openManager, importBackup };
}

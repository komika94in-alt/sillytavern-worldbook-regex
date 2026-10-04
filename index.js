import * as worldInfo from '../../../world-info.js';
import { createBinder } from './ui.js';

// Namespace access retains the live ES-module binding when ST replaces the array.
// Do not destructure selected_world_info or read world_info.globalSelect.
const context = SillyTavern.getContext();
let instance;
context.eventSource.on(context.eventTypes.APP_READY, () => {
    if (instance) return;
    try {
        instance = createBinder(context, worldInfo, document);
        instance.start();
    } catch (error) {
        console.error('[世界書正則綁定]', error);
        toastr.error(`插件啟動失敗：${error.message}`, '世界書正則綁定');
    }
});

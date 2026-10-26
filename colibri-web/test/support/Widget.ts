import { SyncModel } from '../../src/SyncModel';
import { Synced } from '../../src/Synced';

export class Widget extends SyncModel<Widget> {
    @Synced() accessor label = '';
}

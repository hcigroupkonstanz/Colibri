import { Colibri } from '../Colibri';
import { whenColibriCreated } from '../lifecycle';

// Runs `action` now, or once `new Colibri()` has constructed the instance. SendMessage drops
// messages sent before that, and a module-level RegisterModelSync usually runs first.
export const withColibri = (action: (colibri: Colibri) => void) => {
    const colibri = Colibri.getInstance(false);
    if (colibri) action(colibri);
    else whenColibriCreated(action);
};

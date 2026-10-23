import type { Routes } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { ClientsComponent } from './app/pages/clients/clients.component';
import { ModelsComponent } from './app/pages/models/models.component';
import { ServerComponent } from './app/pages/server/server.component';

// One segment each: the production build's <base href="./"> resolves asset URLs against the
// page's directory, so /log/x would load them from /log/.
export const routes: Routes = [
    { path: 'log', component: LogComponent, title: 'Log · Colibri' },
    { path: 'clients', component: ClientsComponent, title: 'Clients · Colibri' },
    { path: 'models', component: ModelsComponent, title: 'Models · Colibri' },
    { path: 'server', component: ServerComponent, title: 'Server · Colibri' },
    // Old URL of the Statistics page, kept so existing links and bookmarks still work
    { path: 'statistics', redirectTo: '/clients' },
    { path: '**', redirectTo: '/log' },
];

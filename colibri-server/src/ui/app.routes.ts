import { Routes } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { ClientsComponent } from './app/pages/clients/clients.component';
import { ModelsComponent } from './app/pages/models/models.component';
import { ServerComponent } from './app/pages/server/server.component';

// One segment each: the production build's <base href="./"> resolves against the page's path.
export const routes: Routes = [
    { path: 'log', component: LogComponent, title: 'Log · Colibri' },
    { path: 'clients', component: ClientsComponent, title: 'Clients · Colibri' },
    { path: 'models', component: ModelsComponent, title: 'Models · Colibri' },
    { path: 'server', component: ServerComponent, title: 'Server · Colibri' },
    // the page the client table and the latency chart were on before
    { path: 'statistics', redirectTo: '/clients' },
    { path: '**', redirectTo: '/log' },
];

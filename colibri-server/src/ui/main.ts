import { enableProdMode, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { providePrimeNG } from 'primeng/config';
import ColibriTheme from './theme';

import { environment } from './environments/environment';
import { FormsModule } from '@angular/forms';
import { provideAnimations } from '@angular/platform-browser/animations';
import { BrowserModule, bootstrapApplication } from '@angular/platform-browser';
import { RootComponent } from './app/pages/root/root.component';
import { Routes, provideRouter } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { StatisticsComponent } from './app/pages/statistics/statistics.component';

if (environment.production) {
  enableProdMode();
}

const routes: Routes = [
  { path: 'log', component: LogComponent },
  { path: 'statistics', component: StatisticsComponent },
  { path: '**', redirectTo: '/log' },
];


bootstrapApplication(RootComponent, {
    providers: [
        provideZoneChangeDetection(),
        provideRouter(routes),
        importProvidersFrom(BrowserModule, FormsModule),
        provideAnimations(),
        providePrimeNG({ theme: { preset: ColibriTheme } })
    ]
})
  .catch(err => console.error(err));

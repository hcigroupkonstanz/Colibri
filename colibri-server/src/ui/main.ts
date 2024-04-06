import { enableProdMode, importProvidersFrom } from '@angular/core';


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
    provideRouter(routes),
        importProvidersFrom(BrowserModule, FormsModule),
        provideAnimations()
    ]
})
  .catch(err => console.error(err));

import { enableProdMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { environment } from './environments/environment';
import { RootComponent } from './app/shell/root.component';
import { appConfig } from './app.config';

if (environment.production) {
    enableProdMode();
}

bootstrapApplication(RootComponent, appConfig)
    .catch(err => console.error(err));

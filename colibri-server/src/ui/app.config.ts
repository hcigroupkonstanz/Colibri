import { ApplicationConfig, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { providePrimeNG } from 'primeng/config';
import ColibriTheme from './theme';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
    providers: [
        provideZoneChangeDetection(),
        provideRouter(routes),
        importProvidersFrom(BrowserModule, FormsModule),
        provideAnimations(),
        providePrimeNG({ theme: { preset: ColibriTheme, options: { darkModeSelector: '.app-dark' } } })
    ]
};

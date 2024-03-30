import { enableProdMode, importProvidersFrom } from '@angular/core';


import { environment } from './environments/environment';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { MatBadgeModule } from '@angular/material/badge';
import { MatCardModule } from '@angular/material/card';
import { FormsModule } from '@angular/forms';
import { provideAnimations } from '@angular/platform-browser/animations';
import { BrowserModule, bootstrapApplication } from '@angular/platform-browser';
import { RootComponent } from './app/pages/root/root.component';
import { Routes, provideRouter } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';

if (environment.production) {
  enableProdMode();
}

const routes: Routes = [
  { path: 'log', component: LogComponent },
  { path: '**', redirectTo: '/log' },
];


bootstrapApplication(RootComponent, {
    providers: [
    provideRouter(routes),
        importProvidersFrom(BrowserModule, FormsModule, MatCardModule, MatBadgeModule, MatChipsModule, MatExpansionModule, MatButtonModule, MatIconModule, MatInputModule, MatSelectModule, ScrollingModule),
        provideAnimations()
    ]
})
  .catch(err => console.error(err));

import { Component, OnDestroy, OnInit } from '@angular/core';
import { LogMessage, LogService } from '../../services';
import { Subscription } from 'rxjs';
import { MatSelectChange } from '@angular/material/select';

@Component({
  selector: 'app-filter-bar',
  templateUrl: './filter-bar.component.html',
  styleUrls: ['./filter-bar.component.scss']
})
export class FilterBarComponent implements OnInit, OnDestroy {
    appNames: string[] = [];
    selected = '';

    private subscription!: Subscription;

    constructor(private log: LogService) { }

    ngOnInit(): void {
        this.log.messages.forEach(m => this.updateAppNames(m));
        this.subscription = this.log.messages$.subscribe(m => this.updateAppNames(m));
        this.log.filter$.subscribe(f => this.selected = f);
    }

    private updateAppNames(m: LogMessage): void {
        if (m.metadata && m.metadata.clientApp) {
            const app = m.metadata.clientApp as string;
            if (!this.appNames.includes(app)) {
                this.appNames.push(app);
            }
        }
    }

    onFilterChanged(e: MatSelectChange): void {
        this.log.filter$.next(e.value);
    }

    ngOnDestroy(): void {
        this.subscription.unsubscribe();
    }
}

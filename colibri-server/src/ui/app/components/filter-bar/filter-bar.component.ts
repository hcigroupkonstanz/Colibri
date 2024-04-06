import { Component, OnDestroy, OnInit } from '@angular/core';
import { LogMessage, LogService } from '../../services';
import { Subscription } from 'rxjs';
import { NgFor } from '@angular/common';
import { DropdownChangeEvent, DropdownModule } from 'primeng/dropdown';
import { FormsModule } from '@angular/forms';

interface ListElement {
    name: string;
}

@Component({
    selector: 'app-filter-bar',
    templateUrl: './filter-bar.component.html',
    styleUrls: ['./filter-bar.component.scss'],
    standalone: true,
    imports: [NgFor, DropdownModule, FormsModule]
})
export class FilterBarComponent implements OnInit, OnDestroy {
    appNames: ListElement[] = [];
    selected: ListElement | undefined = undefined;

    private subscription!: Subscription;

    constructor(private log: LogService) { }

    ngOnInit(): void {
        this.log.messages.forEach(m => this.updateAppNames(m));
        this.subscription = this.log.messages$.subscribe(m => this.updateAppNames(m));
        this.log.filter$.subscribe(f => this.selected = this.appNames.find(a => a.name === f));

    }

    private updateAppNames(m: LogMessage): void {
        if (m.metadata && m.metadata.clientApp) {
            const app = m.metadata.clientApp as string;
            if (!this.appNames.find(c => c.name === app)) {
                this.appNames.push({ name: app });
            }
        }
    }

    onFilterChanged(e: DropdownChangeEvent): void {
        this.log.filter$.next(e.value);
    }

    ngOnDestroy(): void {
        this.subscription.unsubscribe();
    }
}

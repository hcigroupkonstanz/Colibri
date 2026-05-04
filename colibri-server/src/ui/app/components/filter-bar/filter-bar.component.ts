import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { LogMessage, LogService } from '../../services';
import { Subscription } from 'rxjs';
import { SelectChangeEvent, SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';

interface ListElement {
    name: string;
}

@Component({
    selector: 'app-filter-bar',
    standalone: true,
    templateUrl: './filter-bar.component.html',
    styleUrls: ['./filter-bar.component.scss'],
    imports: [SelectModule, FormsModule]
})
export class FilterBarComponent implements OnInit, OnDestroy {
    private log = inject(LogService);

    appNames: ListElement[] = [];
    selected: ListElement | undefined = undefined;

    private subscription!: Subscription;

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

    onFilterChanged(e: SelectChangeEvent): void {
        this.log.filter$.next(e.value);
    }

    ngOnDestroy(): void {
        this.subscription.unsubscribe();
    }
}

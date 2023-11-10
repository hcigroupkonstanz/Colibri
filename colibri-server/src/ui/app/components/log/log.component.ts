import { Component, OnInit, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import PerfectScrollbar from 'perfect-scrollbar';
import { GroupedLogMessage, LogService } from '../../services';

@Component({
    selector: 'app-log',
    templateUrl: './log.component.html',
    styleUrls: ['./log.component.scss']
})
export class LogComponent implements OnInit, AfterViewChecked {
    @ViewChild('scrollContainer', { static: true }) private scrollContainer!: ElementRef;
    manualScroll = false;

    private appFilter: string | null = null;

    constructor(public log: LogService) {
    }

    ngOnInit() {
        this.scrollContainer.nativeElement.addEventListener('wheel', (ev: WheelEvent) => this.onScroll(ev.deltaY));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const ps = new PerfectScrollbar(this.scrollContainer.nativeElement);
    }

    ngAfterViewChecked(): void {
        this.scrollToBottom();
    }

    private scrollToBottom(): void {
        if (!this.manualScroll) {
            try {
                this.scrollContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollHeight;
            } catch (err) {
                console.error(err);
            }
        }
    }

    getId(index: number, entry: GroupedLogMessage): number {
        return entry.id;
    }

    onScroll(deltaY: number): void {
        const el = this.scrollContainer.nativeElement;
        if (deltaY < 0) {
            this.manualScroll = true;
        } else if (el.scrollTop + el.offsetHeight >= el.scrollHeight) {
            this.manualScroll = false;
        }
    }

    scrollAutomatically(): void {
        this.manualScroll = false;
        this.scrollToBottom();
    }

    onFilterChange(filter: string | null): void {
        this.appFilter = filter;
    }

    getMessages(): GroupedLogMessage[] {
        if (this.appFilter) {
            return this.log.messages.filter(m => m.metadata && m.metadata.clientApp === this.appFilter);
        }

        return this.log.messages;
    }
}

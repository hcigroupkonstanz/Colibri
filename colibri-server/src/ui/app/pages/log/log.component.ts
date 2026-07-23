import { Component, OnInit, ElementRef, ViewChild, AfterViewChecked, inject } from '@angular/core';
import { LogMessage, LogService } from '../../services';

import { LogMessageComponent } from '../../components/log-message/log-message.component';
import { CdkVirtualScrollableElement, CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { ButtonModule } from 'primeng/button';

@Component({
    selector: 'app-log',
    templateUrl: './log.component.html',
    styleUrls: ['./log.component.scss'],
    imports: [CdkVirtualScrollableElement, CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf, LogMessageComponent, ButtonModule]
})
export class LogComponent implements OnInit, AfterViewChecked {
    log = inject(LogService);

    @ViewChild('scrollContainer', { static: true }) private scrollContainer!: ElementRef;
    manualScroll = false;

    ngOnInit() {
        this.scrollContainer.nativeElement.addEventListener('wheel', (ev: WheelEvent) => this.onScroll(ev.deltaY), { passive: true });
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

    getId(index: number, entry: LogMessage): string {
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

    isNewDay(index: number): boolean {
        if (index === 0) 
            return true;

        const currentDay = new Date(this.log.messages[index].created);
        const previousDay = new Date(this.log.messages[index - 1].created);
        return currentDay.getDate() !== previousDay.getDate();
    }
}

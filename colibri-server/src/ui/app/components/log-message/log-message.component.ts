import { Component, Input } from '@angular/core';
import { LogMessage } from '../../services';
import { NgIf, DatePipe } from '@angular/common';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss'],
    standalone: true,
    imports: [NgIf, DatePipe]
})
export class LogMessageComponent {
    @Input() public log!: LogMessage;
    @Input() public isNewDay = false;

    constructor() { }
}

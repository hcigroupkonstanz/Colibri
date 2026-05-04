import { Component, Input } from '@angular/core';
import { LogMessage } from '../../services';
import { DatePipe } from '@angular/common';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss'],
    imports: [DatePipe]
})
export class LogMessageComponent {
    @Input() public log!: LogMessage;
    @Input() public isNewDay = false;

    constructor() { }
}

import { Component, Input } from '@angular/core';
import { LogMessage } from '../../services';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss']
})
export class LogMessageComponent {
    @Input() public log!: LogMessage;
    @Input() public isNewDay = false;

    constructor() { }
}

import { Component, Input } from '@angular/core';
import { GroupedLogMessage } from '../../services';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss']
})
export class LogMessageComponent {

    @Input() public log!: GroupedLogMessage;

    constructor() { }
}

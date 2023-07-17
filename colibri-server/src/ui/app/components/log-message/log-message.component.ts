import { Component, OnInit, Input } from '@angular/core';
import { GroupedLogMessage } from '../../services';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss']
})
export class LogMessageComponent implements OnInit {

    @Input() public log!: GroupedLogMessage;

    constructor() { }

    ngOnInit() {
    }

}

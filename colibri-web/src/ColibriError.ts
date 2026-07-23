import { CustomError } from 'ts-custom-error';

export class ColibriError extends CustomError {
    constructor(message?: string) {
        super(message);
    }
}

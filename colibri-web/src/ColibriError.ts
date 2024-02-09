import { CustomError } from 'ts-custom-error';

export default class ColibriError extends CustomError {
    constructor(message?: string) {
        super(message);
    }
}

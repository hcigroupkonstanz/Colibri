import * as readline from 'node:readline';

console.log('==============================================================================');
console.log('Please start a second instance of this application to see the sample in action');
console.log('==============================================================================');

export const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Everyone who runs the samples with the same app name is in one app, and on a shared server sees
// the others' data: each sample asks for one.
export const colibriApp = async () => {
    return new Promise<string>(resolve => {
        rl.question(
            'Please specify an app name of your own, the same in every client (default: myAppName) >> ',
            answer => {
                resolve(answer.trim().length === 0 ? 'myAppName' : answer.trim());
            }
        );
    });
};

export const colibriAddress = async () => {
    return new Promise<string>(resolve => {
        rl.question('Please specify a colibri server address (default: colibri.hci.uni-konstanz.de) >> ', answer => {
            resolve(answer.trim().length === 0 ? 'colibri.hci.uni-konstanz.de' : answer);
        });
    });
};

export const colibriPort = async () => {
    return new Promise<number>(resolve => {
        rl.question('Please specify a colibri server port (default: 9211) >> ', answer => {
            const port = parseInt(answer);
            resolve(port > 0 ? port : 9211);
        });
    });
};

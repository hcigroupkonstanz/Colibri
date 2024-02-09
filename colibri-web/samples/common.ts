import * as readline from 'readline';

console.log(
    '=============================================================================='
);
console.log(
    'Please start a second instance of this application to see the sample in action'
);
console.log(
    '=============================================================================='
);

export const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

export const colibriAddress = async () => {
    return new Promise<string>((res) => {
        rl.question(
            'Please specify a colibri server address (default: colibri.hci.uni-konstanz.de) >> ',
            (answer) => {
                res(
                    answer.trim().length === 0
                        ? 'colibri.hci.uni-konstanz.de'
                        : answer
                );
            }
        );
    });
};

export const colibriPort = async () => {
    return new Promise<number>((res) => {
        rl.question(
            'Please specify a colibri server port (default: 9011) >> ',
            (answer) => {
                const port = parseInt(answer);
                res(port > 0 ? port : 9011);
            }
        );
    });
};

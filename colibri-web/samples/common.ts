import * as readline from 'readline';

console.log('==============================================================================');
console.log('Please start a second instance of this application to see the sample in action');
console.log('==============================================================================');

export const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

export const colibriAddress = async () => {
    return new Promise<string>((res) => {
        rl.question('Please specify a colibri server address: ', (answer) => {
            res(answer);
        });
    });
};

/* eslint-disable @typescript-eslint/no-var-requires */
const p = require('./package.json');
const { exec } = require('child_process');

const run = (cmd) => {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            console.log(stdout);

            if (err) {
                console.error(stderr);
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
};

(async () => {
    await run(`docker build . -t hcikn/colibri:${p.version}`);
    await run(`docker push hcikn/colibri:${p.version}`);
    await run(`docker tag hcikn/colibri:${p.version} hcikn/colibri:latest`);
    await run('docker push hcikn/colibri:latest');
})();

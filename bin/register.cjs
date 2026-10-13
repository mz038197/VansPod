// Register a packaged install without starting the classroom service. A source
// checkout has not been compiled during npm install and needs no registration.
const fs = require('node:fs');
const path = require('node:path');
const entry = path.join(__dirname, '../dist/installations.js');
if (fs.existsSync(entry)) {
  require(entry).registerInstallation().catch(error => {
    process.stderr.write(`VansPod 安裝紀錄無法保存：${error.message}\n`);
    process.exitCode = 1;
  });
}

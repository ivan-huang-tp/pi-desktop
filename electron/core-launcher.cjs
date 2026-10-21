// Pi 核心啟動器：讓打包後的 App 用自己內建的 Electron（當作 Node 執行）跑 Pi CLI，
// 使用者的 Windows 不需要另外安裝 Node.js。
//
// 呼叫方式（由 pi-bridge.cjs 產生）：
//   ELECTRON_RUN_AS_NODE=1 <App.exe> core-launcher.cjs <cli.js> [...args]
//
// ELECTRON_RUN_AS_NODE 只在「這個程序啟動時」有意義，Electron 已經據此決定以 Node 模式執行；
// 之後若不移除，Pi agent 透過 bash 工具開的所有子程序都會繼承它，
// 使用者在 agent 裡啟動任何 Electron App（例如 `npm run electron:dev`、VS Code）都會變成純 Node 而壞掉。
delete process.env.ELECTRON_RUN_AS_NODE;

const { pathToFileURL } = require('url');

const cliPath = process.argv[2];
if (!cliPath) {
  process.stderr.write('[core-launcher] 缺少 cli.js 路徑\n');
  process.exit(2);
}

// 把 argv 調整成 Pi CLI 直接被 node 執行時的形狀：[execPath, cli.js, ...args]
process.argv.splice(1, 1);

import(pathToFileURL(cliPath).href).catch((err) => {
  process.stderr.write(`[core-launcher] 無法載入 Pi 核心 ${cliPath}: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

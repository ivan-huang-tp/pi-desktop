// 下載並解出內建的 Pi 核心（resources/pi-core/dist）。
//
// resources/pi-core/ 只把 package.json / docs / examples 放進 git；dist/ 被 .gitignore 的 `dist/`
// 排除（23 MB 的建置產物不該進版控），所以新 clone 下來的 repo 沒有 cli.js，打包出來的 App 會
// 退回去找系統 PATH 上的 `pi`，直接下載安裝的使用者就跑不起來。打包前先跑這支補上。
//
// 版本以 resources/pi-core/package.json 為準，不會自己升級。
//
// 用法：node scripts/fetch-core.mjs [--force]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'resources', 'pi-core');
const distDir = path.join(coreDir, 'dist');
const marker = path.join(distDir, '.pi-core-version');
const cliPath = path.join(distDir, 'bundle', 'cli.js');

const pkg = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf-8'));
const spec = `${pkg.name}@${pkg.version}`;
const force = process.argv.includes('--force');

const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').trim() : null;
if (!force && current === pkg.version && fs.existsSync(cliPath)) {
  console.log(`[fetch-core] ${spec} 已存在，略過（--force 可重新下載）`);
  process.exit(0);
}

// Windows 上 npm 是 npm.cmd，execFile 需要 shell 才找得到
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-core-'));

try {
  console.log(`[fetch-core] 下載 ${spec} ...`);
  const out = execFileSync(npm, ['pack', spec, '--json', '--silent'], {
    cwd: tmp,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  const tarball = JSON.parse(out)[0].filename;

  // 只用相對路徑呼叫 tar：Windows 上 PATH 裡可能是 Git 附的 GNU tar，
  // 它會把 `C:\...` 的磁碟代號當成遠端主機名稱。
  execFileSync('tar', ['-xzf', tarball, 'package/dist'], { cwd: tmp, stdio: 'inherit' });

  const extracted = path.join(tmp, 'package', 'dist');
  if (!fs.existsSync(path.join(extracted, 'bundle', 'cli.js'))) {
    throw new Error(`tarball 內沒有 dist/bundle/cli.js：${tarball}`);
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.cpSync(extracted, distDir, { recursive: true });
  fs.writeFileSync(marker, `${pkg.version}\n`, 'utf-8');
  console.log(`[fetch-core] 完成：${path.relative(root, cliPath)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

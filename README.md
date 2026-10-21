# Pi-UI 🤖

> 一款現代化、三欄式設計的 **Pi Coding Agent** 桌面客戶端，基於 Electron、React 18 與 TypeScript 打造。提供直覺且專業的沉浸式 AI 輔助開發體驗。

---

## ✨ 核心特色

- **🏛️ 現代化三欄工作區 (Modern 3-Pane Layout)**
  - **左側欄 (Sidebar)**：管理本地與遠端工作專案、歷史會話瀏覽、會話操作（複製、重命名、匯出為 HTML/JSONL、刪除）、模型設定與上下文 Token 使用量儀表板。
  - **中間欄 (Chat Area)**：即時串流問答、思考鏈（Thinking Process）展開、對話分支切換（`< 1/N >` 歷史版本回溯）、上下文狀態管理（啟用/略過），以及豐富的工具呼叫視覺化介面（檔案差異 Diff 卡片、終端執行命令、Subagent 執行卡片）。
  - **右側欄 (Right Panel)**：
    - **檔案總管 (File Explorer)**：專案檔案樹檢視，支援快速預覽與即時導航。
    - **Monaco 程式碼編輯器 (Code Editor)**：內建與 VS Code 同源的 Monaco Editor，支援全語法高亮、行號標記與即時編輯存檔。
    - **整合終端機 (Interactive Terminal)**：基於 xterm.js 與 node-pty，提供完整的終端互動，支援本地 Shell 與遠端 SSH 終端。

- **🌐 SSH 遠端伺服器支援 (Remote SSH Integration)**
  - 支援遠端主機無縫連線與金鑰認證。
  - 直接在本地 UI 管理遠端伺服器上的 Pi 會話與專案環境。
  - 遠端終端機無縫接軌，即時監控遠端工作。

- **🔄 分支與 Context 粒度控制**
  - 多輪對話分支切換與對比。
  - 自由調整個別訊息是否計入 Context，精準控制 Token 消耗。

---

## 🛠️ 技術棧

- **核心架構**：[Electron](https://www.electronjs.org/) + [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **打包與建置**：[Vite](https://vitejs.dev/)
- **樣式設計**：[Tailwind CSS](https://tailwindcss.com/) + [Lucide Icons](https://lucide.dev/)
- **編輯器與終端**：[Monaco Editor](https://microsoft.github.io/monaco-editor/) + [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)
- **內容渲染**：[react-markdown](https://github.com/remarkjs/react-markdown) + [highlight.js](https://highlightjs.org/)

---

## 📥 Windows 直接下載

到 GitHub [Releases](../../releases) 下載 `PiAgentDesktop-Setup-<版本>-x64.exe`，執行後即可安裝（預設裝在使用者目錄，不需要管理員權限）。

- 安裝檔已內建 Pi 核心與執行環境，**不需要另外安裝 Node.js 或 Pi CLI**。
- 安裝檔目前沒有程式碼簽章，第一次執行時 Windows SmartScreen 會顯示「Windows 已保護您的電腦」，點「其他資訊 → 仍要執行」即可。
- SSH 遠端功能使用 Windows 內建的 OpenSSH 用戶端（Windows 10 1809 以上預設已安裝）。
- 介面裡的「更新核心」會呼叫 `npm`，沒裝 Node.js 的電腦無法使用此功能，請改為下載新版安裝檔。

### 發佈新版本（維護者）

1. 修改 `package.json` 的 `version`（例如 `0.2.0`）並 commit。
2. 推送同名 tag：`git tag v0.2.0 && git push origin v0.2.0`。
3. GitHub Actions（`.github/workflows/release-windows.yml`）會在 Windows runner 上建置安裝檔，並自動建立 Release 附上 `.exe`。

也可以在 Actions 頁面手動執行 workflow，只建置不發佈，安裝檔會出現在該次執行的 Artifacts。

在 Windows 本機自行打包：`npm ci && npm run dist:win`，產出在 `release/`。
（在 Linux 上只能用 `npm run pack:win` 產出免安裝的 `release/win-unpacked/`；NSIS 安裝檔需要 Wine。）

---

## 🚀 快速開始

### 環境需求

- [Node.js](https://nodejs.org/) (建議 v18 或以上版本)
- npm / yarn / pnpm
- 本地或遠端環境已安裝 [Pi Coding Agent](https://github.com/badlogic/pi-mono)

### 1. 安裝相依套件

```bash
git clone https://github.com/<your-username>/pi-ui.git
cd pi-ui
npm install
```

> **注意 (Windows 使用者)**：
> `node-pty` 1.1 起已附 Windows x64 / arm64 的預先編譯檔，一般不需要 C++ 建置工具。
>
> 內建的 Pi 核心（`resources/pi-core/dist/`）不在 git 裡，第一次開發前請執行 `npm run fetch-core` 下載；
> 沒有它時 App 會改用系統 PATH 上的 `pi`。

### 2. 開發模式啟動 (Dev Mode)

同時啟動 Vite 前端熱更新伺服器與 Electron 視窗：

```bash
npm run electron:dev
```

### 3. 編譯與打包 (Build)

編譯前端資產並檢查 TypeScript 型別：

```bash
npm run build
```

啟動編譯後的 Electron 應用程式：

```bash
npm run electron:start
```

---

## 📂 專案結構

```
pi-ui/
├── electron/                 # Electron 主程序與後端橋接
│   ├── main.cjs              # Electron 入口與視窗生命週期
│   ├── pi-bridge.cjs         # 與 Pi CLI / Agent 通訊的橋接核心
│   ├── core-launcher.cjs     # 用 App 內建的 Electron（Node 模式）啟動 Pi CLI
│   ├── terminal-manager.cjs  # 本地與遠端 PTY 終端機管理器
│   └── ssh-manager.cjs       # SSH 遠端連線與遠端專案管理
├── resources/pi-core/        # 內建 Pi 核心（dist/ 由 scripts/fetch-core.mjs 下載）
├── scripts/fetch-core.mjs    # 打包前下載內建核心
├── .github/workflows/        # Windows 安裝檔建置與發佈
├── src/                      # React 前端介面
│   ├── components/           # UI 元件（ChatArea, Sidebar, FileTree, Monaco...）
│   ├── types/                # 全域 TypeScript 介面定義
│   ├── App.tsx               # 主應用程式框架
│   └── main.tsx              # React 掛載入口
├── package.json
├── tailwind.config.js
└── vite.config.ts
```

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 授權。

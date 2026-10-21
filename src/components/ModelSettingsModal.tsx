import React, { useState, useEffect } from 'react';
import { ipcRenderer } from '../lib/ipc';
import {
  Cpu,
  Brain,
  Sliders,
  SlidersHorizontal,
  Key,
  Globe,
  Layers,
  Plus,
  Trash2,
  Check,
  X,
  Save,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Info,
  Eye,
  EyeOff
} from 'lucide-react';
import type {
  ModelsConfig,
  SettingsConfig,
  ModelDetailConfig,
  ProviderDetailConfig,
  ThinkingLevel
} from '../types';

interface ModelSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeConvId?: string;
  onModelChanged?: (modelName: string, thinkingLevel: string) => void;
}

const THINKING_LEVELS: { id: ThinkingLevel; label: string; desc: string }[] = [
  { id: 'off', label: 'Off', desc: '關閉思考模式，適合快速回覆' },
  { id: 'minimal', label: 'Minimal', desc: '極少思考 token' },
  { id: 'low', label: 'Low', desc: '輕量思考' },
  { id: 'medium', label: 'Medium', desc: '預設標準深度' },
  { id: 'high', label: 'High', desc: '深度邏輯分析與代碼重構' },
  { id: 'xhigh', label: 'Extra High', desc: '超深度推理（需模型支援）' },
  { id: 'max', label: 'Max', desc: '全開最大推理預算' },
];

const PRESET_MAX_TOKENS = [4096, 8192, 16384, 32768];
const PRESET_CONTEXT_WINDOWS = [
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
];

export const ModelSettingsModal: React.FC<ModelSettingsModalProps> = ({
  isOpen,
  onClose,
  activeConvId,
  onModelChanged,
}) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // 設定原始資料
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig>({ providers: {} });
  const [settingsConfig, setSettingsConfig] = useState<SettingsConfig>({});

  // 目前選中的 Provider 與 Model ID
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // 細項表單狀態（綁定當前選取之模型）
  const [maxTokens, setMaxTokens] = useState<number>(8192);
  const [contextWindow, setContextWindow] = useState<number>(128000);
  const [reasoning, setReasoning] = useState<boolean>(false);
  const [temperature, setTemperature] = useState<number>(0.0);
  const [topP, setTopP] = useState<number>(1.0);
  const [currentThinkingLevel, setCurrentThinkingLevel] = useState<ThinkingLevel>('medium');

  // Provider 端點設定狀態
  const [providerName, setProviderName] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);

  // 新增模型與 Provider 互動
  const [newModelInput, setNewModelInput] = useState<string>('');
  const [isAddingModel, setIsAddingModel] = useState<boolean>(false);
  const [applyToActiveSession, setApplyToActiveSession] = useState<boolean>(true);

  // 載入設定
  const loadConfig = async () => {
    if (!ipcRenderer) return;
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await ipcRenderer.invoke('model:get-config');
      if (res.success) {
        const mCfg: ModelsConfig = res.modelsConfig || { providers: {} };
        const sCfg: SettingsConfig = res.settingsConfig || {};

        setModelsConfig(mCfg);
        setSettingsConfig(sCfg);

        const activeProvider = sCfg.defaultProvider || Object.keys(mCfg.providers || {})[0] || '';
        const activeModel = sCfg.defaultModel || (activeProvider && mCfg.providers?.[activeProvider]?.models?.[0]?.id) || '';

        setSelectedProviderKey(activeProvider);
        setSelectedModelId(activeModel);
        setCurrentThinkingLevel(sCfg.defaultThinkingLevel || 'medium');

        if (activeProvider && mCfg.providers?.[activeProvider]) {
          const prov = mCfg.providers[activeProvider];
          setProviderName(prov.name || activeProvider);
          setBaseUrl(prov.baseUrl || '');
          setApiKey(prov.apiKey || '');

          const mObj = prov.models?.find((m) => m.id === activeModel) || prov.models?.[0];
          if (mObj) {
            setMaxTokens(mObj.maxTokens || 8192);
            setContextWindow(mObj.contextWindow || 128000);
            setReasoning(Boolean(mObj.reasoning));
            setTemperature(mObj.samplingParams?.temperature ?? 0.0);
            setTopP(mObj.samplingParams?.top_p ?? 1.0);
          }
        }
      } else {
        setStatusMessage({ text: `載入設定失敗: ${res.error}`, type: 'error' });
      }
    } catch (e: any) {
      setStatusMessage({ text: `錯誤: ${e.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadConfig();
    }
  }, [isOpen]);

  // 當切換 Provider
  const handleSelectProvider = (key: string) => {
    setSelectedProviderKey(key);
    const prov = modelsConfig.providers?.[key];
    if (prov) {
      setProviderName(prov.name || key);
      setBaseUrl(prov.baseUrl || '');
      setApiKey(prov.apiKey || '');
      const firstModel = prov.models?.[0]?.id || '';
      setSelectedModelId(firstModel);

      if (prov.models?.[0]) {
        const mObj = prov.models[0];
        setMaxTokens(mObj.maxTokens || 8192);
        setContextWindow(mObj.contextWindow || 128000);
        setReasoning(Boolean(mObj.reasoning));
        setTemperature(mObj.samplingParams?.temperature ?? 0.0);
        setTopP(mObj.samplingParams?.top_p ?? 1.0);
      }
    }
  };

  // 當切換 Model
  const handleSelectModel = (mId: string) => {
    setSelectedModelId(mId);
    const prov = modelsConfig.providers?.[selectedProviderKey];
    const mObj = prov?.models?.find((m) => m.id === mId);
    if (mObj) {
      setMaxTokens(mObj.maxTokens || 8192);
      setContextWindow(mObj.contextWindow || 128000);
      setReasoning(Boolean(mObj.reasoning));
      setTemperature(mObj.samplingParams?.temperature ?? 0.0);
      setTopP(mObj.samplingParams?.top_p ?? 1.0);
    }
  };

  // 新增模型到當前 Provider
  const handleAddModel = () => {
    const trimmed = newModelInput.trim();
    if (!trimmed || !selectedProviderKey) return;

    const prov = modelsConfig.providers[selectedProviderKey];
    if (!prov) return;

    const existingModels = prov.models || [];
    if (existingModels.some((m) => m.id === trimmed)) {
      setSelectedModelId(trimmed);
      setNewModelInput('');
      setIsAddingModel(false);
      return;
    }

    const newModelObj: ModelDetailConfig = {
      id: trimmed,
      name: trimmed.split('/').pop() || trimmed,
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
    };

    const updated = {
      ...modelsConfig,
      providers: {
        ...modelsConfig.providers,
        [selectedProviderKey]: {
          ...prov,
          models: [...existingModels, newModelObj],
        },
      },
    };

    setModelsConfig(updated);
    setSelectedModelId(trimmed);
    setMaxTokens(newModelObj.maxTokens || 8192);
    setContextWindow(newModelObj.contextWindow || 128000);
    setReasoning(false);
    setNewModelInput('');
    setIsAddingModel(false);
  };

  // 儲存設定
  const handleSave = async () => {
    if (!ipcRenderer) return;
    setSaving(true);
    setStatusMessage(null);

    try {
      // 複製一份並更新當前編輯中的模型細項與 Provider 連線資訊
      const nextModelsConfig: ModelsConfig = JSON.parse(JSON.stringify(modelsConfig));
      if (selectedProviderKey && nextModelsConfig.providers[selectedProviderKey]) {
        const prov = nextModelsConfig.providers[selectedProviderKey];
        prov.name = providerName;
        prov.baseUrl = baseUrl;
        prov.apiKey = apiKey;

        if (prov.models) {
          const mIdx = prov.models.findIndex((m) => m.id === selectedModelId);
          if (mIdx >= 0) {
            prov.models[mIdx] = {
              ...prov.models[mIdx],
              maxTokens: Number(maxTokens) || 8192,
              contextWindow: Number(contextWindow) || 128000,
              reasoning,
              samplingParams: {
                ...(prov.models[mIdx].samplingParams || {}),
                temperature: Number(temperature),
                top_p: Number(topP),
              },
            };
          }
        }
      }

      // 更新 settings.json
      const nextSettingsConfig: SettingsConfig = {
        ...settingsConfig,
        defaultProvider: selectedProviderKey,
        defaultModel: selectedModelId,
        defaultThinkingLevel: currentThinkingLevel,
      };

      const res = await ipcRenderer.invoke('model:save-config', {
        modelsConfig: nextModelsConfig,
        settingsConfig: nextSettingsConfig,
        applyToActiveSession,
        convId: activeConvId,
      });

      if (res.success) {
        setModelsConfig(nextModelsConfig);
        setSettingsConfig(nextSettingsConfig);
        setStatusMessage({ text: '設定已成功儲存並生效！', type: 'success' });
        if (onModelChanged) {
          onModelChanged(selectedModelId, currentThinkingLevel);
        }
        setTimeout(() => {
          onClose();
        }, 800);
      } else {
        setStatusMessage({ text: `儲存失敗: ${res.error}`, type: 'error' });
      }
    } catch (e: any) {
      setStatusMessage({ text: `儲存異常: ${e.message}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const currentProvider = modelsConfig.providers?.[selectedProviderKey];
  const modelList = currentProvider?.models || [];
  const isCurrentDefault =
    settingsConfig.defaultProvider === selectedProviderKey &&
    settingsConfig.defaultModel === selectedModelId;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#18181b] border border-zinc-700/80 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* 頂部標題 */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-950/70 border border-indigo-700/50 flex items-center justify-center text-indigo-400">
              <Cpu size={17} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100 flex items-center space-x-2">
                <span>模型與推論設定</span>
                {isCurrentDefault && (
                  <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-800/60">
                    預設啟用
                  </span>
                )}
              </h2>
              <p className="text-xs text-zinc-400">
                微調 Token 長度、思考推理深度 (Thinking Effort) 與端點金鑰
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
          >
            <X size={17} />
          </button>
        </div>

        {/* 狀態訊息橫幅 */}
        {statusMessage && (
          <div
            className={`px-6 py-2.5 text-xs flex items-center space-x-2 border-b ${
              statusMessage.type === 'success'
                ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
            }`}
          >
            {statusMessage.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* 主內容捲動區 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
          
          {/* 區塊 1：選擇供應商與模型 */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center space-x-1.5">
                <SlidersHorizontal size={13} className="text-indigo-400" />
                <span>模型選擇</span>
              </label>
              <span className="text-xs text-zinc-500 font-mono">
                {selectedProviderKey} / {selectedModelId}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Provider 選擇 */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5 font-medium">供應商 (Provider)</label>
                <select
                  value={selectedProviderKey}
                  onChange={(e) => handleSelectProvider(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg px-3 py-2 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500 transition"
                >
                  {Object.keys(modelsConfig.providers || {}).map((k) => (
                    <option key={k} value={k}>
                      {modelsConfig.providers[k]?.name || k} ({k})
                    </option>
                  ))}
                </select>
              </div>

              {/* Model 選擇 */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-zinc-400 font-medium">模型 (Model ID)</label>
                  {!isAddingModel && (
                    <button
                      onClick={() => setIsAddingModel(true)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 transition"
                    >
                      <Plus size={12} />
                      <span>新增模型</span>
                    </button>
                  )}
                </div>

                {!isAddingModel ? (
                  <select
                    value={selectedModelId}
                    onChange={(e) => handleSelectModel(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg px-3 py-2 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500 transition font-mono"
                  >
                    {modelList.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex items-center space-x-1.5">
                    <input
                      type="text"
                      placeholder="輸入新 Model ID，如 deepseek-ai/DeepSeek-V3"
                      value={newModelInput}
                      onChange={(e) => setNewModelInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                      className="flex-1 bg-zinc-900 border border-indigo-500/70 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none"
                      autoFocus
                    />
                    <button
                      onClick={handleAddModel}
                      className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition"
                    >
                      加入
                    </button>
                    <button
                      onClick={() => {
                        setIsAddingModel(false);
                        setNewModelInput('');
                      }}
                      className="px-2 py-1.5 text-zinc-400 hover:text-zinc-200 rounded-lg text-xs transition"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 區塊 2：思考與推理設定 (Thinking / Reasoning Effort) */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center space-x-1.5">
                <Brain size={13} className="text-indigo-400" />
                <span>思考與推理 (Thinking Effort)</span>
              </label>

              {/* 思考模式標記 */}
              <label className="flex items-center space-x-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={reasoning}
                  onChange={(e) => setReasoning(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                />
                <span className="text-xs text-zinc-400 font-medium">模型支援 Reasoning 標籤</span>
              </label>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-2">思考深度等級 (Thinking Level)：</div>
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                {THINKING_LEVELS.map((lvl) => {
                  const isSelected = currentThinkingLevel === lvl.id;
                  return (
                    <button
                      key={lvl.id}
                      type="button"
                      onClick={() => setCurrentThinkingLevel(lvl.id)}
                      title={lvl.desc}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium text-center transition border ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
                          : 'bg-zinc-900/80 text-zinc-400 border-zinc-700/60 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      {lvl.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-zinc-500 mt-2 font-mono">
                {THINKING_LEVELS.find((l) => l.id === currentThinkingLevel)?.desc}
              </p>
            </div>
          </div>

          {/* 區塊 3：長度與視窗限制 (Token Limits) */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center space-x-1.5">
              <Layers size={13} className="text-indigo-400" />
              <span>Token 限制與視窗容量</span>
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Max Tokens */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400 font-medium">最大輸出 (Max Tokens)</span>
                  <span className="text-xs text-zinc-500 font-mono">{maxTokens.toLocaleString()} tokens</span>
                </div>
                <input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Math.max(256, parseInt(e.target.value) || 0))}
                  className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500"
                />
                <div className="flex items-center space-x-1 pt-1">
                  {PRESET_MAX_TOKENS.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setMaxTokens(val)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition border ${
                        maxTokens === val
                          ? 'bg-zinc-700 border-zinc-600 text-zinc-100'
                          : 'bg-zinc-900/60 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {val.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Context Window */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400 font-medium">上下文容量 (Context Window)</span>
                  <span className="text-xs text-zinc-500 font-mono">{contextWindow.toLocaleString()} tokens</span>
                </div>
                <input
                  type="number"
                  value={contextWindow}
                  onChange={(e) => setContextWindow(Math.max(1024, parseInt(e.target.value) || 0))}
                  className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500"
                />
                <div className="flex items-center space-x-1 pt-1">
                  {PRESET_CONTEXT_WINDOWS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setContextWindow(preset.value)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition border ${
                        contextWindow === preset.value
                          ? 'bg-zinc-700 border-zinc-600 text-zinc-100'
                          : 'bg-zinc-900/60 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 區塊 4：採樣參數 (Sampling Parameters) */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center space-x-1.5">
              <Sliders size={13} className="text-indigo-400" />
              <span>採樣參數 (Sampling Params)</span>
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Temperature */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 font-medium">隨機性 (Temperature)</span>
                  <span className="font-mono text-indigo-400 font-semibold">{temperature.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
                <div className="flex justify-between text-[11px] text-zinc-500">
                  <span>0.0 (精確程式碼)</span>
                  <span>1.0 (高創造力)</span>
                </div>
              </div>

              {/* Top P */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 font-medium">核採樣 (Top P)</span>
                  <span className="font-mono text-indigo-400 font-semibold">{topP.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
                <div className="flex justify-between text-[11px] text-zinc-500">
                  <span>0.1 (聚焦)</span>
                  <span>1.0 (完整)</span>
                </div>
              </div>
            </div>
          </div>

          {/* 區塊 5：供應商連線與金鑰 (Provider Config) */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center space-x-1.5">
              <Key size={13} className="text-indigo-400" />
              <span>端點與認證 (Endpoint & Authentication)</span>
            </label>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1 font-medium">Base URL</label>
                <div className="relative flex items-center">
                  <Globe size={13} className="absolute left-3 text-zinc-500" />
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.siliconflow.com/v1"
                    className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1 font-medium">API Key</label>
                <div className="relative flex items-center">
                  <Key size={13} className="absolute left-3 text-zinc-500" />
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg pl-8 pr-9 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2.5 p-1 text-zinc-500 hover:text-zinc-300"
                  >
                    {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* 底部按鈕與狀態控制 */}
        <div className="px-6 py-3.5 border-t border-zinc-800 bg-zinc-900/70 flex items-center justify-between">
          <label className="flex items-center space-x-2 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={applyToActiveSession}
              onChange={(e) => setApplyToActiveSession(e.target.checked)}
              className="rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
            />
            <span className="text-xs text-zinc-400">同時套用至目前視窗的對話 Session</span>
          </label>

          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3.5 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition"
            >
              取消
            </button>

            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium flex items-center space-x-1.5 transition shadow"
            >
              {saving ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>儲存中...</span>
                </>
              ) : (
                <>
                  <Save size={13} />
                  <span>儲存並套用</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
